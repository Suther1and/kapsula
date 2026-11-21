const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

const LOOPBACK_REDIRECT_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/.*)?$/i;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Метод не поддерживается.' }, 405);
  }

  const clientId = (Deno.env.get('GCAL_CLIENT_ID') ?? '').trim();
  const clientSecret = (Deno.env.get('GCAL_CLIENT_SECRET') ?? '').trim();
  const enabled = Boolean(clientId && clientSecret);

  if (req.method === 'GET') {
    return jsonResponse({
      enabled,
      clientId: enabled ? clientId : null,
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ ok: false, error: 'Ожидался JSON-объект.' }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: 'Некорректный JSON в теле запроса.' }, 400);
  }

  const action = String(body.action ?? 'config').trim().toLowerCase();

  if (action === 'config') {
    return jsonResponse({
      enabled,
      clientId: enabled ? clientId : null,
    });
  }

  if (!enabled) {
    return jsonResponse(
      {
        ok: false,
        code: 'not_configured',
        error: 'Быстрый вход в Google Календарь пока не настроен на сервере.',
      },
      503,
    );
  }

  if (action === 'exchange') {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : '';
    const codeVerifier = typeof body.codeVerifier === 'string' ? body.codeVerifier.trim() : '';

    if (!code || !redirectUri) {
      return jsonResponse(
        { ok: false, error: 'Не переданы code или redirectUri.' },
        400,
      );
    }
    if (!LOOPBACK_REDIRECT_RE.test(redirectUri)) {
      return jsonResponse(
        { ok: false, error: 'Разрешён только локальный адрес возврата (127.0.0.1 или localhost).' },
        400,
      );
    }

    const form = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (codeVerifier) {
      form.set('code_verifier', codeVerifier);
    }

    let tokenResp: Response;
    try {
      tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return jsonResponse(
        { ok: false, error: 'Не удалось связаться с сервером авторизации Google.' },
        504,
      );
    }

    let tokenJson: Record<string, unknown> = {};
    try {
      tokenJson = (await tokenResp.json()) as Record<string, unknown>;
    } catch {
      tokenJson = {};
    }

    if (!tokenResp.ok || typeof tokenJson.access_token !== 'string') {
      return jsonResponse(
        {
          ok: false,
          error: 'Google не принял код авторизации.',
          googleError: typeof tokenJson.error === 'string' ? tokenJson.error : null,
        },
        400,
      );
    }

    return jsonResponse({
      ok: true,
      access_token: tokenJson.access_token,
      refresh_token: typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token : null,
      expires_in: typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : 3500,
      token_type: typeof tokenJson.token_type === 'string' ? tokenJson.token_type : 'Bearer',
      scope: typeof tokenJson.scope === 'string' ? tokenJson.scope : null,
    });
  }

  if (action === 'refresh') {
    const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
    if (!refreshToken) {
      return jsonResponse({ ok: false, error: 'Не передан refreshToken.' }, 400);
    }

    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    let tokenResp: Response;
    try {
      tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return jsonResponse(
        { ok: false, error: 'Не удалось обновить токен Google.' },
        504,
      );
    }

    let tokenJson: Record<string, unknown> = {};
    try {
      tokenJson = (await tokenResp.json()) as Record<string, unknown>;
    } catch {
      tokenJson = {};
    }

    if (!tokenResp.ok || typeof tokenJson.access_token !== 'string') {
      return jsonResponse(
        {
          ok: false,
          error: 'Не удалось обновить доступ к Google Календарю — войди заново.',
          googleError: typeof tokenJson.error === 'string' ? tokenJson.error : null,
        },
        401,
      );
    }

    return jsonResponse({
      ok: true,
      access_token: tokenJson.access_token,
      expires_in: typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : 3500,
      token_type: typeof tokenJson.token_type === 'string' ? tokenJson.token_type : 'Bearer',
      scope: typeof tokenJson.scope === 'string' ? tokenJson.scope : null,
    });
  }

  return jsonResponse({ ok: false, error: `Неизвестное действие: ${action}` }, 400);
});
