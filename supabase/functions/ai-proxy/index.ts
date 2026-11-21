import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

const MIN_COST_FLOOR_USD = 0.0001;

// USD per 1M tokens
const GEMINI_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'gemini-2.5-flash': { inPerM: 0.30, outPerM: 2.50 },
  'gemini-2.5-flash-lite': { inPerM: 0.10, outPerM: 0.40 },
  'gemini-2.0-flash': { inPerM: 0.10, outPerM: 0.40 },
  'gemini-2.0-flash-lite': { inPerM: 0.075, outPerM: 0.30 },
};

const OPENROUTER_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'google/gemini-2.5-flash': { inPerM: 0.30, outPerM: 2.50 },
  'google/gemini-2.5-flash-lite': { inPerM: 0.10, outPerM: 0.40 },
  'google/gemini-2.0-flash-001': { inPerM: 0.10, outPerM: 0.40 },
  'google/gemini-2.0-flash-lite-001': { inPerM: 0.075, outPerM: 0.30 },
  'openai/gpt-4o-mini': { inPerM: 0.15, outPerM: 0.60 },
  'openai/gpt-4.1-mini': { inPerM: 0.40, outPerM: 1.60 },
  'openai/gpt-4.1-nano': { inPerM: 0.10, outPerM: 0.40 },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function getCurrentMonthYm(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatUsdRu(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 1;
  return `$${safe.toFixed(2).replace('.', ',')}`;
}

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeQuota(raw: Record<string, unknown> | null | undefined) {
  return {
    spentUsd: toNum(raw?.spent_usd, 0),
    limitUsd: toNum(raw?.limit_usd, 1),
    remainingUsd: toNum(raw?.remaining_usd, 0),
    ...(raw && 'request_count' in raw ? { requestCount: toNum(raw.request_count, 0) } : {}),
  };
}

function buildDeniedResponse(reserve: Record<string, unknown>): Response {
  const reason = String(reserve.reason ?? 'user_quota_exceeded');
  const quota = normalizeQuota(reserve);

  if (reason === 'blocked') {
    return jsonResponse(
      {
        ok: false,
        code: 'blocked',
        error:
          'Доступ к общему ИИ для этого аккаунта ограничен. Можно добавить свой API-ключ в Настройках.',
        quota,
      },
      403,
    );
  }

  if (reason === 'rate_limit_exceeded') {
    return jsonResponse(
      {
        ok: false,
        code: 'rate_limit_exceeded',
        error: 'Слишком много запросов к ИИ за минуту — попробуй чуть позже.',
        quota,
      },
      429,
    );
  }

  if (reason === 'global_quota_exceeded') {
    return jsonResponse(
      {
        ok: false,
        code: 'global_quota_exceeded',
        error:
          'Общий месячный бюджет ИИ исчерпан. Можно добавить свой API-ключ в Настройках или дождаться 1-го числа.',
        quota,
      },
      429,
    );
  }

  return jsonResponse(
    {
      ok: false,
      code: 'user_quota_exceeded',
      error: `Месячный лимит общего ИИ (${formatUsdRu(quota.limitUsd)}) исчерпан. Можно добавить свой API-ключ в Настройках или дождаться 1-го числа.`,
      quota,
    },
    429,
  );
}

function computeTokenCost(
  inTokens: number,
  outTokens: number,
  pricing: { inPerM: number; outPerM: number },
): number {
  const raw = (Math.max(0, inTokens) / 1_000_000) * pricing.inPerM +
    (Math.max(0, outTokens) / 1_000_000) * pricing.outPerM;
  return Math.max(MIN_COST_FLOOR_USD, Number.isFinite(raw) ? raw : MIN_COST_FLOOR_USD);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Метод не поддерживается.' }, 405);
  }

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
  const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Серверная конфигурация облака не задана.' }, 500);
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const jwt = match?.[1]?.trim() ?? '';
  if (!jwt) {
    return jsonResponse(
      { ok: false, code: 'unauthorized', error: 'Требуется вход в облачный аккаунт Kapsula.' },
      401,
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userData?.user?.id) {
    return jsonResponse(
      { ok: false, code: 'unauthorized', error: 'Сессия облака недействительна — войди заново.' },
      401,
    );
  }

  const userId = userData.user.id;
  const monthYm = getCurrentMonthYm();
  const geminiApiKey = (Deno.env.get('KAPSULA_GEMINI_API_KEY') ?? '').trim();
  const openrouterApiKey = (Deno.env.get('KAPSULA_OPENROUTER_API_KEY') ?? '').trim();
  const providers = {
    google: Boolean(geminiApiKey),
    openrouter: Boolean(openrouterApiKey),
  };

  let payload: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ ok: false, error: 'Ожидался JSON-объект.' }, 400);
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return jsonResponse({ ok: false, error: 'Некорректный JSON в теле запроса.' }, 400);
    }
  }

  const action = req.method === 'GET' ? 'status' : String(payload.action ?? 'status').trim().toLowerCase();

  if (action === 'status') {
    const { data: statusData, error: statusErr } = await admin.rpc('get_ai_quota_status', {
      p_user_id: userId,
      p_month_ym: monthYm,
    });
    if (statusErr || !statusData) {
      return jsonResponse({ ok: false, error: 'Не удалось получить статус лимита ИИ.' }, 500);
    }
    const s = statusData as Record<string, unknown>;
    return jsonResponse({
      ok: true,
      spentUsd: toNum(s.spent_usd, 0),
      limitUsd: toNum(s.limit_usd, 1),
      remainingUsd: toNum(s.remaining_usd, 0),
      requestCount: toNum(s.request_count, 0),
      blocked: Boolean(s.blocked),
      globalExhausted: Boolean(s.global_exhausted),
      providers,
      month: monthYm,
    });
  }

  if (action === 'gemini') {
    const requestedModel = typeof payload.model === 'string' && payload.model.trim()
      ? payload.model.trim()
      : 'gemini-2.5-flash';
    if (!GEMINI_PRICING[requestedModel]) {
      return jsonResponse(
        {
          ok: false,
          code: 'invalid_model',
          error: 'Выбранная модель Gemini не поддерживается общим ИИ.',
        },
        400,
      );
    }

    const upstreamBody = payload.body;
    if (!upstreamBody || typeof upstreamBody !== 'object' || Array.isArray(upstreamBody)) {
      return jsonResponse({ ok: false, error: 'Поле body обязательно для запроса к Gemini.' }, 400);
    }

    if (!geminiApiKey) {
      return jsonResponse(
        { ok: false, code: 'provider_unavailable', error: 'Общий ИИ (Google) временно недоступен.' },
        503,
      );
    }

    const { data: reserveData, error: reserveErr } = await admin.rpc('check_and_reserve_ai_rate', {
      p_user_id: userId,
      p_month_ym: monthYm,
    });
    if (reserveErr || !reserveData) {
      return jsonResponse({ ok: false, error: 'Не удалось проверить лимит общего ИИ.' }, 500);
    }
    const reserve = reserveData as Record<string, unknown>;
    if (!reserve.allowed) {
      return buildDeniedResponse(reserve);
    }

    const callGeminiModel = (targetModel: string) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiApiKey,
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(55_000),
        },
      );

    let effectiveModel = requestedModel;
    let upstreamResp: Response;
    try {
      upstreamResp = await callGeminiModel(effectiveModel);
      // If a retired/unavailable alias (e.g. gemini-2.5-flash-lite / gemini-2.0-flash) returns 404,
      // transparently fall back to gemini-2.5-flash without double-counting rate limit.
      if (upstreamResp.status === 404 && effectiveModel !== 'gemini-2.5-flash') {
        try {
          await upstreamResp.body?.cancel();
        } catch {
          // ignore body cancel error
        }
        effectiveModel = 'gemini-2.5-flash';
        upstreamResp = await callGeminiModel(effectiveModel);
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      return jsonResponse(
        {
          ok: false,
          code: isTimeout ? 'upstream_timeout' : 'upstream_network_error',
          error: isTimeout
            ? 'Сервис ИИ не ответил вовремя — попробуй ещё раз.'
            : 'Не удалось связаться с сервисом ИИ.',
        },
        504,
      );
    }

    const rawText = await upstreamResp.text();
    let upstreamJson: Record<string, unknown> | null = null;
    try {
      upstreamJson = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      upstreamJson = null;
    }

    if (!upstreamResp.ok) {
      // Never leak upstream 401/403 as client 401 so clients don't log out the user
      const outStatus = upstreamResp.status === 400
        ? 400
        : upstreamResp.status === 429
        ? 429
        : 502;
      return jsonResponse(
        {
          ok: false,
          code: 'upstream_error',
          upstreamStatus: upstreamResp.status,
          error: upstreamResp.status === 429
            ? 'Сервер Google ИИ временно перегружен — попробуй чуть позже.'
            : 'Сервис ИИ вернул ошибку при обработке запроса.',
        },
        outStatus,
      );
    }

    const pricing = GEMINI_PRICING[effectiveModel] ?? GEMINI_PRICING['gemini-2.5-flash'];
    const usage = (upstreamJson?.usageMetadata ?? {}) as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
    const inTokens = Math.max(0, Math.round(toNum(usage.promptTokenCount, 0)));
    const outTokens = Math.max(
      0,
      Math.round(toNum(usage.candidatesTokenCount, 0) + toNum(usage.thoughtsTokenCount, 0)),
    );
    const costUsd = computeTokenCost(inTokens, outTokens, pricing);

    const { data: recorded } = await admin.rpc('record_ai_usage', {
      p_user_id: userId,
      p_month_ym: monthYm,
      p_cost_usd: costUsd,
      p_in_tokens: inTokens,
      p_out_tokens: outTokens,
    });

    const quota = recorded
      ? normalizeQuota(recorded as Record<string, unknown>)
      : normalizeQuota(reserve);

    return jsonResponse({
      ok: true,
      modelUsed: effectiveModel,
      data: upstreamJson,
      quota,
    });
  }

  if (action === 'openrouter') {
    const rawBody = payload.body;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return jsonResponse(
        { ok: false, error: 'Поле body обязательно для запроса к OpenRouter.' },
        400,
      );
    }

    const bodyObj = { ...(rawBody as Record<string, unknown>) };
    const model = typeof bodyObj.model === 'string' && bodyObj.model.trim()
      ? bodyObj.model.trim()
      : 'google/gemini-2.5-flash-lite';
    const pricing = OPENROUTER_PRICING[model];
    if (!pricing) {
      return jsonResponse(
        {
          ok: false,
          code: 'invalid_model',
          error: 'Выбранная модель OpenRouter не поддерживается общим ИИ.',
        },
        400,
      );
    }

    bodyObj.model = model;
    bodyObj.stream = false;

    if (!openrouterApiKey) {
      return jsonResponse(
        {
          ok: false,
          code: 'provider_unavailable',
          error: 'Резервный канал общего ИИ (OpenRouter) временно недоступен.',
        },
        503,
      );
    }

    const { data: reserveData, error: reserveErr } = await admin.rpc('check_and_reserve_ai_rate', {
      p_user_id: userId,
      p_month_ym: monthYm,
    });
    if (reserveErr || !reserveData) {
      return jsonResponse({ ok: false, error: 'Не удалось проверить лимит общего ИИ.' }, 500);
    }
    const reserve = reserveData as Record<string, unknown>;
    if (!reserve.allowed) {
      return buildDeniedResponse(reserve);
    }

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterApiKey}`,
          'HTTP-Referer': 'https://kapsula.app',
          'X-Title': 'Kapsula',
        },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(55_000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      return jsonResponse(
        {
          ok: false,
          code: isTimeout ? 'upstream_timeout' : 'upstream_network_error',
          error: isTimeout
            ? 'Сервис ИИ не ответил вовремя — попробуй ещё раз.'
            : 'Не удалось связаться с сервисом ИИ.',
        },
        504,
      );
    }

    const rawText = await upstreamResp.text();
    let upstreamJson: Record<string, unknown> | null = null;
    try {
      upstreamJson = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      upstreamJson = null;
    }

    if (!upstreamResp.ok) {
      const outStatus = upstreamResp.status === 400
        ? 400
        : upstreamResp.status === 429
        ? 429
        : 502;
      return jsonResponse(
        {
          ok: false,
          code: 'upstream_error',
          upstreamStatus: upstreamResp.status,
          error: upstreamResp.status === 429
            ? 'Сервер OpenRouter временно перегружен — попробуй чуть позже.'
            : 'Сервис ИИ вернул ошибку при обработке запроса.',
        },
        outStatus,
      );
    }

    const usage = (upstreamJson?.usage ?? {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
    const inTokens = Math.max(0, Math.round(toNum(usage.prompt_tokens, 0)));
    const outTokens = Math.max(0, Math.round(toNum(usage.completion_tokens, 0)));
    const reportedCost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : null;
    const costUsd = reportedCost !== null
      ? Math.max(MIN_COST_FLOOR_USD, reportedCost)
      : computeTokenCost(inTokens, outTokens, pricing);

    const { data: recorded } = await admin.rpc('record_ai_usage', {
      p_user_id: userId,
      p_month_ym: monthYm,
      p_cost_usd: costUsd,
      p_in_tokens: inTokens,
      p_out_tokens: outTokens,
    });

    const quota = recorded
      ? normalizeQuota(recorded as Record<string, unknown>)
      : normalizeQuota(reserve);

    return jsonResponse({
      ok: true,
      modelUsed: model,
      data: upstreamJson,
      quota,
    });
  }

  return jsonResponse({ ok: false, error: `Неизвестное действие: ${action}` }, 400);
});
