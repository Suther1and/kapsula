import {
  DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SYNC_SUPABASE_URL,
} from '@shared/sync-contract';
import type { AiProvider, CloudAiQuotaStatus } from '@shared/types';
import type { FetchLike } from './decision-router';

export const DEFAULT_CLOUD_AI_QUOTA_ERROR =
  'Месячный лимит общего ИИ ($1,00) исчерпан. Можно добавить свой API-ключ в Настройках или дождаться 1-го числа.';

export class AiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly isQuotaMessage = false
  ) {
    super(message);
    this.name = 'AiHttpError';
  }
}

export interface CloudAiProxyConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  getAccessToken: () => Promise<string | null>;
}

export interface ResolvedAiRoute {
  mode: 'personal' | 'cloud_proxy' | 'local';
  provider: AiProvider;
  apiKey: string | null;
  accessToken?: string | null;
  proxy?: CloudAiProxyConfig | null;
}

export async function resolveAiRoute(params: {
  provider: AiProvider;
  apiKey?: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
}): Promise<ResolvedAiRoute> {
  if (params.provider === 'local') {
    return { mode: 'local', provider: 'local', apiKey: null };
  }

  const primaryPersonalKey = params.apiKey?.trim() || null;
  const googleKey =
    params.googleAiKey?.trim() ||
    (params.provider === 'google_ai_studio' ? primaryPersonalKey : null);
  const openRouterKey =
    params.openRouterKey?.trim() ||
    (params.provider === 'openrouter' ? primaryPersonalKey : null);

  // Priority 1: Personal API key ALWAYS beats the shared cloud proxy (no $1/mo cap!)
  if (params.provider === 'google_ai_studio') {
    if (googleKey) {
      return { mode: 'personal', provider: 'google_ai_studio', apiKey: googleKey };
    }
    if (openRouterKey) {
      return { mode: 'personal', provider: 'openrouter', apiKey: openRouterKey };
    }
  } else if (params.provider === 'openrouter') {
    if (openRouterKey) {
      return { mode: 'personal', provider: 'openrouter', apiKey: openRouterKey };
    }
    if (googleKey) {
      return { mode: 'personal', provider: 'google_ai_studio', apiKey: googleKey };
    }
  }

  // Priority 2: Shared Kapsula Cloud AI Proxy when signed in without personal keys
  if (params.cloudProxy) {
    try {
      const accessToken = await params.cloudProxy.getAccessToken();
      if (accessToken && accessToken.trim()) {
        return {
          mode: 'cloud_proxy',
          provider: params.provider,
          apiKey: null,
          accessToken: accessToken.trim(),
          proxy: params.cloudProxy,
        };
      }
    } catch {
      // Fall through cleanly to local mode
    }
  }

  return { mode: 'local', provider: params.provider, apiKey: null };
}

function normalizeBaseUrl(rawUrl: string): string {
  return (rawUrl || DEFAULT_SYNC_SUPABASE_URL).trim().replace(/\/+$/, '');
}

function hasCyrillic(text: string): boolean {
  return /[а-яё]/i.test(text);
}

async function parseProxyErrorMessage(resp: Response): Promise<string> {
  try {
    const json = (await resp.json()) as { error?: unknown; message?: unknown };
    const candidate =
      typeof json?.error === 'string'
        ? json.error.trim()
        : typeof json?.message === 'string'
          ? json.message.trim()
          : '';
    return candidate;
  } catch {
    return '';
  }
}

export async function postGeminiGenerateContent(params: {
  model: string;
  body: Record<string, unknown>;
  apiKey?: string | null;
  proxy?: CloudAiProxyConfig | null;
  accessToken?: string | null;
  timeoutMs: number;
  fetchFn?: FetchLike;
}): Promise<Record<string, unknown>> {
  const fetchImpl = params.fetchFn ?? fetch;

  if (params.apiKey) {
    const resp = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': params.apiKey,
        },
        body: JSON.stringify(params.body),
        signal: AbortSignal.timeout(params.timeoutMs),
      }
    );
    if (!resp.ok) {
      throw new AiHttpError(resp.status, `Google AI Studio HTTP ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  const token = params.accessToken || (await params.proxy?.getAccessToken().catch(() => null));
  if (!params.proxy || !token) {
    throw new AiHttpError(401, 'Войди в аккаунт синхронизации или добавь свой API-ключ в Настройках.');
  }

  const endpoint = `${normalizeBaseUrl(params.proxy.supabaseUrl)}/functions/v1/ai-proxy`;
  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: params.proxy.supabasePublishableKey || DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({
      action: 'gemini',
      model: params.model,
      body: params.body,
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!resp.ok) {
    const serverMsg = await parseProxyErrorMessage(resp);
    if (resp.status === 429) {
      throw new AiHttpError(
        429,
        serverMsg && hasCyrillic(serverMsg) ? serverMsg : DEFAULT_CLOUD_AI_QUOTA_ERROR,
        true
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AiHttpError(
        resp.status,
        serverMsg && hasCyrillic(serverMsg)
          ? serverMsg
          : 'Сессия аккаунта истекла — перезайди во вкладке «Синхронизация».'
      );
    }
    throw new AiHttpError(
      resp.status,
      serverMsg && hasCyrillic(serverMsg)
        ? serverMsg
        : `Встроенный ИИ временно недоступен (${resp.status}).`
    );
  }

  const wrapped = (await resp.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
  return (wrapped?.data && typeof wrapped.data === 'object' ? wrapped.data : wrapped) as Record<
    string,
    unknown
  >;
}

export async function postOpenRouterChatCompletions(params: {
  body: Record<string, unknown>;
  apiKey?: string | null;
  proxy?: CloudAiProxyConfig | null;
  accessToken?: string | null;
  timeoutMs: number;
  fetchFn?: FetchLike;
}): Promise<Record<string, unknown>> {
  const fetchImpl = params.fetchFn ?? fetch;

  if (params.apiKey) {
    const resp = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
        'HTTP-Referer': 'https://kapsula.local',
        'X-Title': 'Kapsula',
      },
      body: JSON.stringify(params.body),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
    if (!resp.ok) {
      throw new AiHttpError(resp.status, `OpenRouter HTTP ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  const token = params.accessToken || (await params.proxy?.getAccessToken().catch(() => null));
  if (!params.proxy || !token) {
    throw new AiHttpError(401, 'Войди в аккаунт синхронизации или добавь свой API-ключ в Настройках.');
  }

  const endpoint = `${normalizeBaseUrl(params.proxy.supabaseUrl)}/functions/v1/ai-proxy`;
  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: params.proxy.supabasePublishableKey || DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({
      action: 'openrouter',
      body: params.body,
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!resp.ok) {
    const serverMsg = await parseProxyErrorMessage(resp);
    if (resp.status === 429) {
      throw new AiHttpError(
        429,
        serverMsg && hasCyrillic(serverMsg) ? serverMsg : DEFAULT_CLOUD_AI_QUOTA_ERROR,
        true
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AiHttpError(
        resp.status,
        serverMsg && hasCyrillic(serverMsg)
          ? serverMsg
          : 'Сессия аккаунта истекла — перезайди во вкладке «Синхронизация».'
      );
    }
    throw new AiHttpError(
      resp.status,
      serverMsg && hasCyrillic(serverMsg)
        ? serverMsg
        : `Встроенный ИИ временно недоступен (${resp.status}).`
    );
  }

  const wrapped = (await resp.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
  return (wrapped?.data && typeof wrapped.data === 'object' ? wrapped.data : wrapped) as Record<
    string,
    unknown
  >;
}

export async function fetchCloudAiQuota(params: {
  cloudProxy?: CloudAiProxyConfig | null;
  hasGoogleKey: boolean;
  hasOpenRouterKey: boolean;
  fetchFn?: FetchLike;
}): Promise<CloudAiQuotaStatus> {
  const usingPersonalKey = Boolean(params.hasGoogleKey || params.hasOpenRouterKey);
  const personalProvider: CloudAiQuotaStatus['personalProvider'] = params.hasGoogleKey
    ? 'google_ai_studio'
    : params.hasOpenRouterKey
      ? 'openrouter'
      : null;

  const token = params.cloudProxy
    ? await params.cloudProxy.getAccessToken().catch(() => null)
    : null;

  if (!params.cloudProxy || !token) {
    return {
      available: false,
      signedIn: false,
      spentUsd: 0,
      limitUsd: 1,
      remainingUsd: 1,
      requestCount: 0,
      blocked: false,
      globalExhausted: false,
      usingPersonalKey,
      personalProvider,
    };
  }

  const fetchImpl = params.fetchFn ?? fetch;
  const endpoint = `${normalizeBaseUrl(params.cloudProxy.supabaseUrl)}/functions/v1/ai-proxy`;

  try {
    const resp = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: params.cloudProxy.supabasePublishableKey || DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      const serverMsg = await parseProxyErrorMessage(resp);
      return {
        available: false,
        signedIn: resp.status !== 401,
        spentUsd: 0,
        limitUsd: 1,
        remainingUsd: 0,
        requestCount: 0,
        blocked: false,
        globalExhausted: false,
        usingPersonalKey,
        personalProvider,
        error:
          serverMsg && hasCyrillic(serverMsg)
            ? serverMsg
            : resp.status === 401
              ? 'Сессия истекла — перезайди в аккаунт синхронизации'
              : 'Не удалось получить статус встроенного ИИ',
      };
    }

    const raw = (await resp.json()) as Record<string, unknown>;
    const spentUsd = Number(raw.spentUsd ?? raw.spent_usd ?? 0) || 0;
    const limitUsd = Number(raw.limitUsd ?? raw.limit_usd ?? 1) || 1;
    const remainingUsd = Math.max(
      0,
      Number(raw.remainingUsd ?? raw.remaining_usd ?? Math.max(0, limitUsd - spentUsd)) || 0
    );
    const requestCount = Number(raw.requestCount ?? raw.request_count ?? 0) || 0;
    const blocked = Boolean(raw.blocked);
    const globalExhausted = Boolean(raw.globalExhausted ?? raw.global_exhausted);
    const providersObj =
      raw.providers && typeof raw.providers === 'object'
        ? (raw.providers as { google?: unknown; openrouter?: unknown })
        : undefined;
    const providers = providersObj
      ? { google: Boolean(providersObj.google), openrouter: Boolean(providersObj.openrouter) }
      : undefined;
    const hasAnyRemoteProvider = providers ? providers.google || providers.openrouter : true;

    return {
      available:
        Boolean(raw.ok ?? true) &&
        !blocked &&
        !globalExhausted &&
        remainingUsd > 0 &&
        hasAnyRemoteProvider,
      signedIn: true,
      spentUsd,
      limitUsd,
      remainingUsd,
      requestCount,
      blocked,
      globalExhausted,
      usingPersonalKey,
      personalProvider,
      providers,
      month: typeof raw.month === 'string' ? raw.month : undefined,
      error: null,
    };
  } catch {
    return {
      available: false,
      signedIn: true,
      spentUsd: 0,
      limitUsd: 1,
      remainingUsd: 0,
      requestCount: 0,
      blocked: false,
      globalExhausted: false,
      usingPersonalKey,
      personalProvider,
      error: 'Нет связи с облачным сервисом ИИ',
    };
  }
}
