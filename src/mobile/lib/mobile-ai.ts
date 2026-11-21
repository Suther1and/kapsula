import { DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY } from '@shared/sync-contract';
import type { AiProvider, TranscribeItemResult, VaultItem } from '@shared/types';
import {
  analyzeForSecret,
  detectCardBrand,
  passesLuhn,
  redactSecrets,
} from '../../main/security/secret-shield';
import type { MobileVaultStore } from '../storage/mobile-store';
import { bytesToBase64 } from '../sync/mobile-crypto';

export interface MobileAiCloudAuth {
  getActiveAccessToken(): Promise<string | null>;
  getSupabaseBaseUrl(): string;
  getSupabasePublishableKey?(): Promise<string>;
}

export interface MobileCloudAiQuota {
  ok: boolean;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  requestCount: number;
  blocked: boolean;
  globalExhausted: boolean;
  providers: { google: boolean; openrouter: boolean };
  month: string;
  error?: string;
}

export type ResolvedMobileAiTarget =
  | {
      mode: 'personal';
      provider: Exclude<AiProvider, 'local'>;
      apiKey: string;
    }
  | {
      mode: 'cloud_proxy';
      provider: 'google_ai_studio';
      proxyUrl: string;
      accessToken: string;
      publishableKey: string;
    };

export const MOBILE_CLOUD_AI_QUOTA_EXCEEDED_MSG =
  'Месячный лимит общего ИИ ($1,00) исчерпан. Можно добавить свой API-ключ в Настройках или дождаться 1-го числа.';

export function formatUsdRu(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return `$${safe.toFixed(2).replace('.', ',')}`;
}

const INLINE_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{32,}\b/g,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{24,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/g,
  /\bKAPS(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}\b/gi,
  /\botpauth:\/\/totp\/[^\s"'<>]+/gi,
  /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function maskMobileSecretsForCloud(raw: string): {
  masked: string;
  secrets: string[];
  safeForCloud: boolean;
} {
  if (redactSecrets(raw) === raw && !analyzeForSecret(raw).isSecret) {
    return { masked: raw, secrets: [], safeForCloud: true };
  }

  const secrets: string[] = [];
  const stashSecret = (value: string): string => {
    const idx = secrets.push(value) - 1;
    return `[REDACTED_SECRET_${idx}]`;
  };

  let masked = raw;
  for (const pat of INLINE_SECRET_PATTERNS) {
    masked = masked.replace(new RegExp(pat.source, pat.flags), (m) => stashSecret(m));
  }
  masked = masked.replace(
    /(https?:\/\/)([^\s/:@]+:[^\s/@]+)(@)/gi,
    (_m, p1: string, cred: string, p3: string) => `${p1}${stashSecret(cred)}${p3}`
  );
  masked = masked.replace(
    /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})\b/gi,
    (_m, p1: string, tok: string) => `${p1}${stashSecret(tok)}`
  );
  masked = masked.replace(
    /(\b(?:cvv2?|cvc|pin|пин)\s*[:=-]?\s*)(\d{3,6})\b/gi,
    (_m, p1: string, code: string) => `${p1}${stashSecret(code)}`
  );
  masked = masked.replace(
    /(^|[^\p{L}\p{N}_])((?:пароль|pass(?:word)?|pwd|pin(?:\s*[-]?\s*код)?|пин(?:\s*[-]?\s*код)?|код|token|токен|key|ключ|secret|секрет)\s*[:=\-—]\s*)([^\n\r·|;]+)/giu,
    (full, boundary: string, prefix: string, val: string) => {
      const trimmed = val.trim();
      if (!trimmed || /^\[REDACTED_SECRET_\d+\]$/.test(trimmed)) return full;
      if (redactSecrets(`${prefix}${val}`) === `${prefix}${val}`) return full;
      return `${boundary}${prefix}${stashSecret(val)}`;
    }
  );
  masked = masked.replace(
    /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*(?::|->|\|)\s*)([^\s:]{4,})/g,
    (full, prefix: string, pass: string) => {
      if (/^\[REDACTED_SECRET_\d+\]$/.test(pass)) return full;
      return `${prefix}${stashSecret(pass)}`;
    }
  );
  masked = masked.replace(
    /(?<!\d)(?:\d{4}(?:[ -]\d{4}){3}(?:[ -]\d{2,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19})(?!\d)/g,
    (candidate) => {
      const digits = candidate.replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits) && detectCardBrand(digits)) {
        return stashSecret(candidate);
      }
      return candidate;
    }
  );

  // Defense-in-depth verification: if ANY secret remains unredacted, block cloud call!
  const residualRedacted = redactSecrets(masked);
  const residualAnalysis = analyzeForSecret(masked);
  const safeForCloud = residualRedacted === masked && !residualAnalysis.isSecret;
  return { masked, secrets, safeForCloud };
}

function restoreMobileSecrets(text: string, secrets: string[]): string {
  if (secrets.length === 0) return text;
  return text.replace(/\[REDACTED_SECRET_(\d+)\]/g, (_m, idx: string) => secrets[Number(idx)] ?? '');
}

interface ParsedVoiceAiResponse {
  title?: string;
  transcript: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
}

const GENERIC_VOICE_TITLE_RE =
  /^(?:голосовая заметка|аудиозапись|новая запись|запись голоса|без названия)(?:\s*\([^)]*\))?$/i;

function extractGeminiNonThoughtText(json: unknown): string {
  const candidates = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> })?.candidates;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => !p?.thought && typeof p?.text === 'string')
    .map((p) => p.text!)
    .join('')
    .trim();
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return (fenced ? fenced[1] ?? '' : trimmed).trim();
}

function parseVoiceAiJson(raw: string): ParsedVoiceAiResponse | null {
  const cleaned = stripJsonCodeFences(raw);
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned) as Partial<ParsedVoiceAiResponse>;
    if (typeof parsed.transcript === 'string' && parsed.transcript.trim()) {
      return {
        title: typeof parsed.title === 'string' ? parsed.title.trim() : undefined,
        transcript: parsed.transcript.trim(),
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined,
        keyPoints: Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((x) => x.trim())
          : [],
        actionItems: Array.isArray(parsed.actionItems)
          ? parsed.actionItems.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((x) => x.trim())
          : [],
      };
    }
  } catch {
    // fallback: treat non-JSON model output as direct transcript if readable
    if (!cleaned.startsWith('{') && cleaned.length >= 2) {
      return { transcript: cleaned, keyPoints: [], actionItems: [] };
    }
  }
  return null;
}

function encodeAudioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = 1;
  const sampleRate = Math.min(16000, buffer.sampleRate || 16000);
  const ratio = buffer.sampleRate / sampleRate;
  const src = buffer.getChannelData(0);
  const length = Math.max(1, Math.floor(src.length / ratio));
  const wavBytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(wavBytes);
  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    const idx = Math.min(src.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, src[idx] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(wavBytes);
}

async function tryTranscodeToWav(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof AudioContext === 'undefined') return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = await ctx.decodeAudioData(copy as ArrayBuffer);
    return encodeAudioBufferToWav(decoded);
  } catch {
    return null;
  } finally {
    if (ctx) void ctx.close().catch(() => {});
  }
}

function normalizeAudioMime(mime: string | null | undefined, localName: string): string {
  const lower = (mime || '').toLowerCase().split(';')[0]!.trim();
  if (lower.startsWith('audio/')) return lower;
  const ext = localName.toLowerCase();
  if (ext.endsWith('.m4a') || ext.endsWith('.mp4')) return 'audio/mp4';
  if (ext.endsWith('.mp3')) return 'audio/mpeg';
  if (ext.endsWith('.wav')) return 'audio/wav';
  if (ext.endsWith('.ogg')) return 'audio/ogg';
  return 'audio/webm';
}

function mapAiHttpError(status: number, isCloudProxy = false, serverError?: string): string {
  const cleanServerErr =
    typeof serverError === 'string' &&
    /[а-яё]/i.test(serverError) &&
    !/(?:supabase|postgrest|postgres|jwt|sqlstate|deno|edge function)/i.test(serverError)
      ? serverError.trim()
      : '';
  if (status === 429) {
    if (isCloudProxy) {
      return cleanServerErr || MOBILE_CLOUD_AI_QUOTA_EXCEEDED_MSG;
    }
    return 'Превышен лимит запросов к ИИ — попробуй через минуту';
  }
  if (status === 401 || status === 403) {
    if (isCloudProxy) {
      return cleanServerErr || 'Сессия облака истекла — перезайди в аккаунт в Настройках → Облако';
    }
    return 'Ключ ИИ отклонён — проверь его в Настройках → Вид и Сейф';
  }
  if (status >= 500) {
    return cleanServerErr || 'Сервер ИИ временно недоступен — попробуй чуть позже';
  }
  if (cleanServerErr) return cleanServerErr;
  return isCloudProxy
    ? 'Не удалось выполнить запрос к встроенному ИИ — проверь интернет'
    : 'Не удалось выполнить запрос к ИИ — проверь ключ и интернет';
}

async function readProxyErrorText(resp: Response): Promise<string | undefined> {
  try {
    const json = (await resp.json()) as { error?: unknown; message?: unknown } | null;
    if (typeof json?.error === 'string' && json.error.trim()) return json.error.trim();
    if (typeof json?.message === 'string' && json.message.trim()) return json.message.trim();
  } catch {
    // ignore non-JSON error body
  }
  return undefined;
}

export async function resolveMobileAiTarget(
  store: MobileVaultStore,
  syncEngine?: MobileAiCloudAuth | null
): Promise<ResolvedMobileAiTarget | null> {
  const cfg = store.getMobileAiConfig();
  const googleKey = (await store.getMobileAiApiKey('google_ai_studio')).apiKey?.trim() || null;
  const openrouterKey = (await store.getMobileAiApiKey('openrouter')).apiKey?.trim() || null;

  // Priority 1: Personal API key (unlimited, direct provider call)
  if (cfg.provider === 'google_ai_studio' && googleKey) {
    return { mode: 'personal', provider: 'google_ai_studio', apiKey: googleKey };
  }
  if (cfg.provider === 'openrouter' && openrouterKey) {
    return { mode: 'personal', provider: 'openrouter', apiKey: openrouterKey };
  }
  if (googleKey) {
    return { mode: 'personal', provider: 'google_ai_studio', apiKey: googleKey };
  }
  if (openrouterKey) {
    return { mode: 'personal', provider: 'openrouter', apiKey: openrouterKey };
  }

  // Priority 2: Built-in shared Cloud AI proxy for signed-in Cloud Sync accounts
  if (syncEngine) {
    const accessToken = await syncEngine.getActiveAccessToken();
    if (accessToken) {
      const baseUrl = syncEngine.getSupabaseBaseUrl().replace(/\/+$/, '');
      const publishableKey =
        (await syncEngine.getSupabasePublishableKey?.()) || DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY;
      return {
        mode: 'cloud_proxy',
        provider: 'google_ai_studio',
        proxyUrl: `${baseUrl}/functions/v1/ai-proxy`,
        accessToken,
        publishableKey,
      };
    }
  }

  return null;
}

export async function fetchMobileCloudAiQuota(
  syncEngine: MobileAiCloudAuth | null | undefined
): Promise<MobileCloudAiQuota | null> {
  if (!syncEngine) return null;
  const accessToken = await syncEngine.getActiveAccessToken();
  if (!accessToken) return null;

  const baseUrl = syncEngine.getSupabaseBaseUrl().replace(/\/+$/, '');
  const publishableKey =
    (await syncEngine.getSupabasePublishableKey?.()) || DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(`${baseUrl}/functions/v1/ai-proxy`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: publishableKey,
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as Record<string, unknown> | null;
    if (!raw || raw.ok === false) return null;
    const spentUsd = Number(raw.spentUsd ?? raw.spent_usd ?? 0) || 0;
    const limitUsd = Number(raw.limitUsd ?? raw.limit_usd ?? 1) || 1;
    const remainingUsd = Math.max(
      0,
      Number(raw.remainingUsd ?? raw.remaining_usd ?? Math.max(0, limitUsd - spentUsd)) || 0
    );
    const providersRaw = (raw.providers as { google?: unknown; openrouter?: unknown } | undefined) ?? {};
    return {
      ok: true,
      spentUsd,
      limitUsd,
      remainingUsd,
      requestCount: Number(raw.requestCount ?? raw.request_count ?? 0) || 0,
      blocked: Boolean(raw.blocked),
      globalExhausted: Boolean(raw.globalExhausted ?? raw.global_exhausted),
      providers: {
        google: providersRaw.google !== false,
        openrouter: Boolean(providersRaw.openrouter),
      },
      month: typeof raw.month === 'string' ? raw.month : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callAiText(
  target: ResolvedMobileAiTarget,
  prompt: string,
  jsonMode = true
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    if (target.mode === 'cloud_proxy') {
      const resp = await fetch(target.proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.accessToken}`,
          apikey: target.publishableKey,
        },
        body: JSON.stringify({
          action: 'gemini',
          model: 'gemini-2.5-flash',
          body: geminiBody,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // If Gemini upstream is unavailable (502/503), fall back to proxy OpenRouter route
        if (resp.status === 502 || resp.status === 503) {
          const fallbackResp = await fetch(target.proxyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${target.accessToken}`,
              apikey: target.publishableKey,
            },
            body: JSON.stringify({
              action: 'openrouter',
              body: {
                model: 'google/gemini-2.5-flash',
                temperature: 0.2,
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }],
              },
            }),
            signal: controller.signal,
          });
          if (fallbackResp.ok) {
            const fbWrapped = (await fallbackResp.json()) as {
              ok?: boolean;
              data?: { choices?: Array<{ message?: { content?: string } }> };
              choices?: Array<{ message?: { content?: string } }>;
              error?: string;
            };
            if (fbWrapped?.ok !== false) {
              const fbUpstream = fbWrapped?.data ?? fbWrapped;
              const fbText = fbUpstream?.choices?.[0]?.message?.content?.trim() ?? '';
              if (fbText) return { ok: true, text: fbText };
            }
          } else if (fallbackResp.status === 429) {
            const fbErr = await readProxyErrorText(fallbackResp);
            return { ok: false, error: mapAiHttpError(429, true, fbErr) };
          }
        }
        const srvErr = await readProxyErrorText(resp);
        return { ok: false, error: mapAiHttpError(resp.status, true, srvErr) };
      }
      const wrapped = (await resp.json()) as { ok?: boolean; data?: unknown; error?: string };
      if (wrapped?.ok === false) {
        return { ok: false, error: mapAiHttpError(400, true, wrapped.error) };
      }
      const upstream = wrapped?.data ?? wrapped;
      const text = extractGeminiNonThoughtText(upstream);
      return text ? { ok: true, text } : { ok: false, error: 'ИИ вернул пустой ответ' };
    }

    if (target.provider === 'google_ai_studio') {
      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': target.apiKey,
          },
          body: JSON.stringify(geminiBody),
          signal: controller.signal,
        }
      );
      if (!resp.ok) return { ok: false, error: mapAiHttpError(resp.status, false) };
      const json = await resp.json();
      const text = extractGeminiNonThoughtText(json);
      return text ? { ok: true, text } : { ok: false, error: 'ИИ вернул пустой ответ' };
    }

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
        'HTTP-Referer': 'https://kapsula.app',
        'X-Title': 'Kapsula Mobile',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, error: mapAiHttpError(resp.status, false) };
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json?.choices?.[0]?.message?.content?.trim() ?? '';
    return text ? { ok: true, text } : { ok: false, error: 'ИИ вернул пустой ответ' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'ИИ не ответил вовремя — проверь интернет и попробуй снова' };
    }
    return { ok: false, error: 'Нет связи с сервисом ИИ — проверь подключение к интернету' };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAiAudioTranscription(
  target: ResolvedMobileAiTarget,
  bytes: Uint8Array,
  mimeType: string
): Promise<{ ok: boolean; parsed?: ParsedVoiceAiResponse; error?: string }> {
  const prompt = [
    'Расшифруй эту голосовую запись дословно и аккуратно, расставь знаки препинания и разбей на абзацы.',
    'Верни строго JSON без markdown-обёртки:',
    '{"title":"короткий заголовок до 6 слов","transcript":"полный чистый текст расшифровки","summary":"суть в 1 предложении","keyPoints":["тезис 1"],"actionItems":["конкретная задача, если есть в речи"]}',
    'Если задач в речи нет, верни actionItems: []. Язык ответа — язык речи (обычно русский).',
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    if (target.mode === 'cloud_proxy' || target.provider === 'google_ai_studio') {
      const base64 = bytesToBase64(bytes);
      const geminiBody = {
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      };

      if (target.mode === 'cloud_proxy') {
        const resp = await fetch(target.proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${target.accessToken}`,
            apikey: target.publishableKey,
          },
          body: JSON.stringify({
            action: 'gemini',
            model: 'gemini-2.5-flash',
            body: geminiBody,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const srvErr = await readProxyErrorText(resp);
          return { ok: false, error: mapAiHttpError(resp.status, true, srvErr) };
        }
        const wrapped = (await resp.json()) as { ok?: boolean; data?: unknown; error?: string };
        if (wrapped?.ok === false) {
          return { ok: false, error: mapAiHttpError(400, true, wrapped.error) };
        }
        const text = extractGeminiNonThoughtText(wrapped?.data ?? wrapped);
        const parsed = parseVoiceAiJson(text);
        if (!parsed) {
          return { ok: false, error: 'Не удалось разобрать расшифровку — попробуй ещё раз' };
        }
        return { ok: true, parsed };
      }

      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': target.apiKey,
          },
          body: JSON.stringify(geminiBody),
          signal: controller.signal,
        }
      );
      if (!resp.ok) return { ok: false, error: mapAiHttpError(resp.status, false) };
      const json = await resp.json();
      const text = extractGeminiNonThoughtText(json);
      const parsed = parseVoiceAiJson(text);
      if (!parsed) {
        return { ok: false, error: 'Не удалось разобрать расшифровку — попробуй ещё раз' };
      }
      return { ok: true, parsed };
    }

    // OpenRouter input_audio supports wav and mp3
    let format: 'wav' | 'mp3' = mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'wav';
    let audioBytes = bytes;
    if (!mimeType.includes('wav') && !mimeType.includes('mpeg') && !mimeType.includes('mp3')) {
      const wav = await tryTranscodeToWav(bytes);
      if (!wav) {
        return {
          ok: false,
          error:
            'Для расшифровки этого аудиоформата через OpenRouter переключи провайдера на Google AI в Настройках',
        };
      }
      audioBytes = wav;
      format = 'wav';
    }

    const base64 = bytesToBase64(audioBytes);
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
        'HTTP-Referer': 'https://kapsula.app',
        'X-Title': 'Kapsula Mobile',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0.15,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'input_audio', input_audio: { data: base64, format } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, error: mapAiHttpError(resp.status, false) };
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json?.choices?.[0]?.message?.content?.trim() ?? '';
    const parsed = parseVoiceAiJson(text);
    if (!parsed) {
      return { ok: false, error: 'Не удалось разобрать расшифровку — попробуй ещё раз' };
    }
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Расшифровка заняла слишком много времени — попробуй ещё раз' };
    }
    return { ok: false, error: 'Нет связи с сервисом ИИ — проверь подключение к интернету' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeMobileVoiceItem(
  store: MobileVaultStore,
  item: VaultItem,
  opts?: { extractTasks?: boolean },
  syncEngine?: MobileAiCloudAuth | null
): Promise<TranscribeItemResult> {
  if (item.dna === 'secret') {
    return { ok: false, error: 'Записи Сейфа не отправляются в облачный ИИ' };
  }
  const target = await resolveMobileAiTarget(store, syncEngine);
  if (!target) {
    return {
      ok: false,
      error:
        'Войди в Облако Kapsula для встроенного ИИ или добавь свой ключ в Настройках → Вид и Сейф',
    };
  }
  if (!item.mediaPath) {
    return { ok: false, error: 'У этой записи нет аудиофайла для расшифровки' };
  }

  const audioFile = await store.loadMediaFile(item.mediaPath);
  if (!audioFile || audioFile.bytes.byteLength === 0) {
    return { ok: false, error: 'Аудиофайл ещё не загружен на это устройство' };
  }

  const mime = normalizeAudioMime(item.mediaType || audioFile.mime, item.mediaPath);
  const res = await callAiAudioTranscription(target, audioFile.bytes, mime);
  if (!res.ok || !res.parsed) {
    return { ok: false, error: res.error || 'Не удалось расшифровать запись' };
  }

  const { transcript, title, summary, keyPoints, actionItems } = res.parsed;
  if (item.body.trim()) {
    await store.saveItemRevision(item.id, 'voice');
  }

  let nextBody = transcript;
  if (opts?.extractTasks && actionItems && actionItems.length > 0) {
    const checklist = actionItems.map((t) => `- [ ] ${t}`).join('\n');
    nextBody = `${transcript}\n\n## Задачи\n${checklist}`;
  }

  const currentTitle = (item.title || '').trim();
  const shouldUpdateTitle = Boolean(title) && (!currentTitle || GENERIC_VOICE_TITLE_RE.test(currentTitle));

  const updated = await store.updateItem(item.id, {
    ...(shouldUpdateTitle && title ? { title } : {}),
    body: nextBody,
    summary: summary || item.summary,
    aiStatus: 'enriched',
    mediaMeta: {
      ...(item.mediaMeta ?? {}),
      transcript,
      ...(keyPoints && keyPoints.length > 0 ? { keyPoints } : {}),
      ...(actionItems && actionItems.length > 0 ? { actionItems } : {}),
    },
  });

  return {
    ok: true,
    item: updated ?? undefined,
    transcript,
    extractedTasks: actionItems ?? [],
  };
}

export async function extractTasksFromMobileItem(
  store: MobileVaultStore,
  item: VaultItem,
  syncEngine?: MobileAiCloudAuth | null
): Promise<{ ok: boolean; tasks: string[]; item?: VaultItem; error?: string }> {
  if (item.dna === 'secret') {
    return { ok: false, tasks: [], error: 'Записи Сейфа не отправляются в облачный ИИ' };
  }
  const sourceText = (item.body || item.mediaMeta?.transcript || '').trim();
  if (!sourceText) {
    return { ok: false, tasks: [], error: 'Сначала расшифруй запись или добавь текст' };
  }

  const existingActionItems = (item.mediaMeta?.actionItems ?? []).filter((t) => t.trim().length > 0);
  let extracted: string[] = [];

  if (existingActionItems.length > 0) {
    extracted = existingActionItems;
  } else {
    const target = await resolveMobileAiTarget(store, syncEngine);
    if (!target) {
      return {
        ok: false,
        tasks: [],
        error:
          'Войди в Облако Kapsula для встроенного ИИ или добавь свой ключ в Настройках → Вид и Сейф',
      };
    }
    const sanitizedText = redactSecrets(sourceText).slice(0, 8000);
    if (analyzeForSecret(sanitizedText).isSecret) {
      return {
        ok: false,
        tasks: [],
        error: 'В заметке обнаружены конфиденциальные данные — отправка в облачный ИИ заблокирована',
      };
    }
    const prompt = [
      'Выдели из текста конкретные задачи и действия (до 8 штук).',
      'Верни строго JSON: {"tasks":["задача 1","задача 2"]}. Если задач нет, верни {"tasks":[]}.',
      '',
      sanitizedText,
    ].join('\n');
    const res = await callAiText(target, prompt, true);
    if (!res.ok || !res.text) {
      return { ok: false, tasks: [], error: res.error || 'Не удалось выделить задачи' };
    }
    try {
      const parsed = JSON.parse(stripJsonCodeFences(res.text)) as { tasks?: unknown };
      if (Array.isArray(parsed.tasks)) {
        extracted = parsed.tasks
          .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
          .map((x) => x.trim());
      }
    } catch {
      extracted = [];
    }
  }

  if (extracted.length === 0) {
    return { ok: false, tasks: [], error: 'В тексте не нашлось конкретных задач' };
  }

  const lowerBody = (item.body || '').toLowerCase();
  const toAppend = extracted.filter((t) => !lowerBody.includes(t.toLowerCase()));
  if (toAppend.length === 0) {
    return { ok: true, tasks: extracted, item };
  }

  await store.saveItemRevision(item.id, 'beautify');
  const checklist = toAppend.map((t) => `- [ ] ${t}`).join('\n');
  const nextBody = item.body.trim()
    ? `${item.body.trim()}\n\n## Задачи\n${checklist}`
    : `## Задачи\n${checklist}`;

  const updated = await store.updateItem(item.id, {
    body: nextBody,
    mediaMeta: {
      ...(item.mediaMeta ?? {}),
      actionItems: Array.from(new Set([...existingActionItems, ...extracted])),
    },
  });
  return { ok: true, tasks: toAppend, item: updated ?? undefined };
}

export async function polishMobileNoteText(
  store: MobileVaultStore,
  item: VaultItem,
  syncEngine?: MobileAiCloudAuth | null
): Promise<{ ok: boolean; item?: VaultItem; error?: string }> {
  if (item.dna === 'secret') {
    return { ok: false, error: 'Записи Сейфа не отправляются в облачный ИИ' };
  }
  const sourceText = (item.body || item.mediaMeta?.transcript || '').trim();
  if (!sourceText) {
    return { ok: false, error: 'Нет текста для обработки' };
  }
  const target = await resolveMobileAiTarget(store, syncEngine);
  if (!target) {
    return {
      ok: false,
      error:
        'Войди в Облако Kapsula для встроенного ИИ или добавь свой ключ в Настройках → Вид и Сейф',
    };
  }
  const { masked, secrets, safeForCloud } = maskMobileSecretsForCloud(sourceText);
  if (!safeForCloud) {
    return {
      ok: false,
      error: 'В заметке обнаружены конфиденциальные данные — отправка в облачный ИИ заблокирована',
    };
  }
  const prompt = [
    'Причеши и структурируй заметку в чистый Markdown: убери слова-паразиты, поправь пунктуацию, сохрани все факты, числа, ссылки, метки [REDACTED_SECRET_N] и чек-листы `- [ ]` без потерь.',
    'Верни только готовый Markdown-текст без пояснений.',
    '',
    masked.slice(0, 10000),
  ].join('\n');
  const res = await callAiText(target, prompt, false);
  if (!res.ok || !res.text) {
    return { ok: false, error: res.error || 'Не удалось причесать текст' };
  }
  await store.saveItemRevision(item.id, 'beautify');
  const restoredBody = restoreMobileSecrets(res.text.trim(), secrets);
  const updated = await store.updateItem(item.id, { body: restoredBody });
  return { ok: true, item: updated ?? undefined };
}
