import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AiProvider, AppLocale, ExtractedAction, VoiceDictationResult } from '@shared/types';
import {
  AiHttpError,
  postGeminiGenerateContent,
  postOpenRouterChatCompletions,
  resolveAiRoute,
  type CloudAiProxyConfig,
} from '../ai/cloud-proxy';
import { transformNoteText } from '../ai/text-studio';
import type { VaultRepository } from '../db/repository';
import { extractActionsFromText } from '../ocr/ocr-service';
import { redactSecrets } from '../security/secret-shield';

const execFileAsync = promisify(execFile);

const CLOUD_AUDIO_TIMEOUT_MS = 45_000;
const MAX_AUDIO_CLOUD_BYTES = 20 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function resolveFfmpegCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetFfmpeg = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (fs.existsSync(wingetFfmpeg)) return wingetFfmpeg;
  }
  if (platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'ffmpeg';
}

export function inferAudioMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'audio/ogg';
  if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return 'audio/mp4';
  return 'audio/webm';
}

export async function ensureWavBufferForCloud(
  buffer: Buffer,
  mime: string
): Promise<{ buffer: Buffer; format: 'wav' | 'mp3' } | null> {
  const lower = (mime || '').toLowerCase();
  if (lower.includes('wav')) return { buffer, format: 'wav' };
  if (lower.includes('mpeg') || lower.includes('mp3')) return { buffer, format: 'mp3' };

  const ext = lower.includes('ogg') || lower.includes('opus')
    ? 'ogg'
    : lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')
      ? 'm4a'
      : 'webm';
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `kapsula-in-${id}.${ext}`);
  const outPath = path.join(os.tmpdir(), `kapsula-out-${id}.wav`);

  try {
    fs.writeFileSync(inPath, buffer);
    await execFileAsync(
      resolveFfmpegCommand(),
      ['-y', '-loglevel', 'error', '-i', inPath, '-ac', '1', '-ar', '16000', '-f', 'wav', outPath],
      { timeout: 15_000, windowsHide: true }
    );
    if (!fs.existsSync(outPath)) return null;
    const wavBuf = fs.readFileSync(outPath);
    if (wavBuf.length < 44 || wavBuf.length > MAX_AUDIO_CLOUD_BYTES) return null;
    return { buffer: wavBuf, format: 'wav' };
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    } catch {
      // ignore temp cleanup failure
    }
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // ignore temp cleanup failure
    }
  }
}

export interface AudioIntelligenceResult {
  title: string;
  summary: string;
  transcript: string;
  keyPoints: string[];
  actionItems: string[];
  extractedActions: ExtractedAction[];
  tags: string[];
  suggestedSection: string | null;
  costUsd: number;
  usedCloud: boolean;
  transcriptError?: string;
}

export type AudioAiResult = AudioIntelligenceResult;

export function formatDurationCompact(seconds?: number | null): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function saveAudioAsset(
  mediaDir: string,
  fileStem: string,
  buffer: Buffer,
  mimeOrExt?: string
): { filename: string; mime: string; byteLength: number } {
  fs.mkdirSync(mediaDir, { recursive: true });
  const hint = (mimeOrExt || '').toLowerCase();
  let ext = 'webm';
  let mime = 'audio/webm';
  if (hint.includes('ogg') || hint.includes('oga') || hint.includes('opus')) {
    ext = 'ogg';
    mime = 'audio/ogg';
  } else if (hint.includes('mp3') || hint.includes('mpeg')) {
    ext = 'mp3';
    mime = 'audio/mpeg';
  } else if (hint.includes('m4a') || hint.includes('mp4') || hint.includes('aac')) {
    ext = 'm4a';
    mime = 'audio/mp4';
  } else if (hint.includes('wav')) {
    ext = 'wav';
    mime = 'audio/wav';
  }
  const filename = `voice_${fileStem}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, filename), buffer);
  return { filename, mime, byteLength: buffer.length };
}

function extractGeminiAudioText(json: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const nonThought = parts
    .filter((p) => !p.thought && typeof p.text === 'string' && p.text.length > 0)
    .map((p) => p.text!)
    .join('');
  return nonThought.trim();
}

function parseAiAudioJson(raw: string): Partial<AudioIntelligenceResult> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    const obj = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    return {
      title: typeof obj.title === 'string' ? obj.title.trim().slice(0, 100) : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 280) : undefined,
      transcript: typeof obj.transcript === 'string' ? obj.transcript.trim().slice(0, 24_000) : undefined,
      keyPoints: Array.isArray(obj.keyPoints)
        ? obj.keyPoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
        : undefined,
      actionItems: Array.isArray(obj.actionItems)
        ? obj.actionItems.map((x) => String(x).trim()).filter(Boolean).slice(0, 10)
        : undefined,
      tags: Array.isArray(obj.tags)
        ? obj.tags
            .map((x) => String(x).toLowerCase().trim().replace(/^#/, ''))
            .filter(Boolean)
            .slice(0, 4)
        : undefined,
      suggestedSection:
        typeof obj.suggestedSection === 'string' && obj.suggestedSection.trim()
          ? obj.suggestedSection.trim().slice(0, 32)
          : null,
    };
  } catch {
    return null;
  }
}

function extractLocalAudioInsights(
  raw: string,
  summaryText: string
): { keyPoints: string[]; actionItems: string[] } {
  if (!raw) return { keyPoints: [], actionItems: [] };
  const sentences = raw
    .split(/[.!?\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);

  const actionVerbHint =
    /(?:нужно|надо|необходимо|провер|утверд|отправ|позвон|оплат|подготов|созвон|сдела|купит|написат|записат|до\s+\d|к\s+(?:понедельн|вторн|сред|четверг|пятниц|суббот|воскресень|утру|вечеру|\d)|todo)/i;
  const modalSplitRe = /^(?:нужно|надо|необходимо|стоит|важно)\s+(.+?)\s+и\s+(.+)$/i;

  const actionItems: string[] = [];
  for (const s of sentences) {
    if (!actionVerbHint.test(s)) continue;
    const splitMatch = s.match(modalSplitRe);
    if (splitMatch && splitMatch[1] && splitMatch[2]) {
      const first = splitMatch[1].trim();
      const second = splitMatch[2].trim();
      if (first.length >= 6) {
        actionItems.push(first.charAt(0).toUpperCase() + first.slice(1));
      }
      if (second.length >= 6) {
        actionItems.push(second.charAt(0).toUpperCase() + second.slice(1));
      }
    } else {
      actionItems.push(s.replace(/^[-*•\d.)\s]+/, '').slice(0, 120));
    }
    if (actionItems.length >= 6) break;
  }

  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
  const sumNorm = norm(summaryText);
  const keyPoints = sentences
    .filter((s) => {
      const n = norm(s);
      return Boolean(n) && (!sumNorm || (n !== sumNorm && !sumNorm.includes(n)));
    })
    .slice(0, 3);

  return {
    keyPoints,
    actionItems: [...new Set(actionItems)].slice(0, 6),
  };
}

function buildFallbackTitle(fileName?: string, durationSec?: number | null, locale: AppLocale = 'ru'): string {
  const durLabel = durationSec && durationSec > 0 ? formatDurationCompact(durationSec) : null;
  const cleanName = fileName
    ? fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
    : '';
  const prettyCleanName = cleanName
    ? cleanName.charAt(0).toUpperCase() + cleanName.slice(1)
    : '';
  const baseLabel = locale === 'en' ? 'Voice note' : 'Голосовая заметка';
  return prettyCleanName || (durLabel ? `${baseLabel} · ${durLabel}` : baseLabel);
}

function mapCloudHttpError(status: number, locale: AppLocale = 'ru'): string {
  if (locale === 'en') {
    if (status === 401 || status === 403) {
      return 'AI key rejected by provider — check it in Settings → AI.';
    }
    if (status === 429) {
      return 'AI rate limit reached — try again in a minute.';
    }
    if (status >= 500) {
      return 'AI server temporarily unavailable — try again in a few seconds.';
    }
    return `Could not transcribe audio (service error ${status}). Please try again.`;
  }
  if (status === 401 || status === 403) {
    return 'Ключ ИИ отклонён провайдером — проверь его в Настройках → ИИ.';
  }
  if (status === 429) {
    return 'Превышен лимит запросов к ИИ — попробуй снова через минуту.';
  }
  if (status >= 500) {
    return 'Сервер ИИ временно недоступен — попробуй ещё раз через несколько секунд.';
  }
  return `Не удалось расшифровать аудио (ошибка сервиса ${status}). Попробуй ещё раз.`;
}

function mapNetworkError(err: unknown, locale: AppLocale = 'ru'): string {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  if (/timeout|abort/i.test(msg)) {
    return locale === 'en'
      ? 'Transcription timed out — please try again.'
      : 'Расшифровка заняла слишком много времени — попробуй ещё раз.';
  }
  return locale === 'en'
    ? 'Could not reach AI server — check your internet connection.'
    : 'Нет связи с сервером ИИ — проверь подключение к интернету.';
}

export interface TranscribeAudioFileParams {
  audioPath?: string;
  buffer?: Buffer;
  mime?: string;
  fileName?: string;
  durationSec?: number | null;
  contextHint?: string;
  wavBase64Fallback?: string;
  extractTasks?: boolean;
  aiProvider: AiProvider;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  budgetReached?: boolean;
  locale?: AppLocale;
  onSpendUsd?: (usd: number) => void;
  fetchFn?: FetchLike;
}

/**
 * Explicit cloud voice transcription entrypoint.
 * NEVER silently swallows errors — always returns `{ ok, result, error }` in active locale.
 */
export async function transcribeAudioFile(
  params: TranscribeAudioFileParams
): Promise<{ ok: boolean; result?: AudioAiResult; error?: string }> {
  const locale: AppLocale = params.locale ?? 'ru';
  const isEn = locale === 'en';
  if (params.aiProvider === 'local') {
    return {
      ok: false,
      error: isEn
        ? 'Enable Cloud AI in Settings → AI to transcribe voice notes.'
        : 'Включи облачный ИИ в Настройках → ИИ, чтобы расшифровывать голосовые.',
    };
  }

  const route = await resolveAiRoute({
    provider: params.aiProvider,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  if (route.mode === 'local' || route.provider === 'local') {
    return {
      ok: false,
      error: isEn
        ? 'Add an AI key in Settings → AI or sign in under Sync to transcribe voice notes.'
        : 'Добавь ключ ИИ в Настройках → ИИ или войди в аккаунт во вкладке «Синхронизация», чтобы расшифровывать голосовые.',
    };
  }

  if (route.mode === 'personal' && params.budgetReached) {
    return {
      ok: false,
      error: isEn
        ? 'Monthly AI spend cap reached. Raise it in Settings → AI.'
        : 'Достигнут месячный лимит расходов на ИИ. Измени лимит в Настройках → ИИ.',
    };
  }

  const googleKey = route.mode === 'personal' && route.provider === 'google_ai_studio' ? route.apiKey : null;
  const openRouterKey = route.mode === 'personal' && route.provider === 'openrouter' ? route.apiKey : null;
  const useProxy = route.mode === 'cloud_proxy';

  let audioBuffer = params.buffer ?? null;
  let audioMime = params.mime || '';

  if ((!audioBuffer || audioBuffer.length === 0) && params.audioPath) {
    try {
      if (fs.existsSync(params.audioPath)) {
        audioBuffer = fs.readFileSync(params.audioPath);
        if (!audioMime) {
          audioMime = inferAudioMimeFromPath(params.audioPath);
        }
      }
    } catch {
      return {
        ok: false,
        error: isEn
          ? 'Could not read audio file from disk.'
          : 'Не удалось прочитать аудиофайл с диска.',
      };
    }
  }

  if ((!audioBuffer || audioBuffer.length === 0) && params.wavBase64Fallback) {
    const cleaned = params.wavBase64Fallback.replace(/^data:audio\/[^;]+;base64,/, '').trim();
    if (cleaned) {
      audioBuffer = Buffer.from(cleaned, 'base64');
      audioMime = 'audio/wav';
    }
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return {
      ok: false,
      error: isEn ? 'Audio file not found or empty.' : 'Аудиофайл не найден или пустой.',
    };
  }

  if (audioBuffer.length > MAX_AUDIO_CLOUD_BYTES) {
    return {
      ok: false,
      error: isEn
        ? 'Audio recording is too large for cloud transcription (max 20 MB).'
        : 'Аудиозапись слишком большая для облачной расшифровки (максимум 20 МБ).',
    };
  }

  if (!audioMime) {
    audioMime = params.fileName ? inferAudioMimeFromPath(params.fileName) : 'audio/webm';
  }

  const contextText = (params.contextHint || '').trim();
  const safeContextText = contextText ? redactSecrets(contextText) : '';
  const fallbackTitle = buildFallbackTitle(params.fileName, params.durationSec, locale);
  const fetchImpl: FetchLike = params.fetchFn ?? fetch;

  const prompt = (
    isEn
      ? [
          'You help the user organize their personal Kapsula memory vault in English.',
          'Transcribe the audio verbatim with high accuracy, then summarize the key points in natural English (or match the spoken language when clear).',
          'Return STRICT JSON without markdown:',
          '{"title":"short meaningful title 2-7 words","summary":"1-2 sentence summary (or empty for a short phrase)","transcript":"exact verbatim transcript","keyPoints":["key point 1"],"actionItems":["concrete action step"],"tags":["tag1"],"suggestedSection":"Meetings | Work | Personal | Ideas | Finance | null"}',
          'CRITICAL:',
          '- Always return the full verbatim speech in `transcript`.',
          '- If the speech is short (under 15 words, a mic check, or one simple phrase) — set keyPoints: [] and build `title` directly from the spoken words without meta descriptions.',
          params.extractTasks
            ? '- Pay special attention to tasks, commitments, deadlines, and plans — list each concrete step in `actionItems` (concise, starting with an action verb).'
            : '',
          safeContextText ? `User caption context: ${safeContextText}` : '',
        ]
      : [
          'Ты помогаешь пользователю в личной базе памяти Kapsula на русском языке.',
          'Расшифруй аудио максимально точно дословно, затем выдели суть на естественном русском языке.',
          'Верни СТРОГО JSON без markdown:',
          '{"title":"короткий заголовок по смыслу 2-7 слов","summary":"1-2 предложения выжимки (или пусто для короткой фразы)","transcript":"точная дословная расшифровка","keyPoints":["тезис 1"],"actionItems":["конкретный шаг"],"tags":["тег1"],"suggestedSection":"Встречи | Работа | Личное | Идеи | Финансы | null"}',
          'КРИТИЧЕСКИ ВАЖНО:',
          '- Всегда возвращай полную дословную речь в поле `transcript`.',
          '- Если речь короткая (менее 15 слов, тест микрофона или одна простая фраза вроде «раз два три») — ставь keyPoints: [] и title ровно из сказанных слов, БЕЗ мета-описаний вроде «Повторение фразы ...».',
          params.extractTasks
            ? '- Особое внимание удели задачам, поручениям, дедлайнам и планам — перечисли каждый конкретный шаг в массиве `actionItems` (коротко, с глагола действия).'
            : '',
          safeContextText ? `Контекст подписи от пользователя: ${safeContextText}` : '',
        ]
  )
    .filter(Boolean)
    .join('\n');

  const finalizeAudioShape = (
    parsedTitle: string | undefined,
    parsedSummary: string | undefined,
    transcript: string,
    rawKeyPoints: string[] | undefined,
    rawActionItems: string[] | undefined,
    tags: string[] | undefined,
    suggestedSection: string | null | undefined,
    costUsd: number
  ): AudioAiResult => {
    const cleanTranscript = transcript.trim();
    const words = cleanTranscript.split(/\s+/).filter(Boolean);
    const isShort = words.length < 14;
    let finalTitle = (parsedTitle || '').trim();
    if (!finalTitle || /^(?:повторение|произнесение|проверка|запись чисел|счёт)/i.test(finalTitle)) {
      finalTitle = cleanTranscript ? cleanTranscript.slice(0, 62) : fallbackTitle;
    }
    const finalKeyPoints = isShort ? [] : (rawKeyPoints ?? []).slice(0, 5);
    const finalSummary = isShort
      ? ''
      : parsedSummary || cleanTranscript.slice(0, 220);

    let actionItems = (rawActionItems ?? []).filter(Boolean).slice(0, 10);
    if (params.extractTasks && actionItems.length === 0 && cleanTranscript) {
      actionItems = extractLocalAudioInsights(cleanTranscript, finalSummary).actionItems;
    }

    return {
      title: finalTitle,
      summary: finalSummary,
      transcript: cleanTranscript,
      keyPoints: finalKeyPoints,
      actionItems,
      extractedActions: extractActionsFromText(`${cleanTranscript}\n${contextText}`, locale),
      tags: tags?.length ? tags : [isEn ? 'voice' : 'голос'],
      suggestedSection: suggestedSection ?? null,
      costUsd,
      usedCloud: true,
    };
  };

  let lastError: string | undefined;

  // 1. Google AI Studio Gemini native audio understanding (personal key OR shared cloud proxy)
  const tryGoogle = Boolean(googleKey) || (useProxy && route.provider === 'google_ai_studio');
  if (tryGoogle) {
    const callGeminiAudio = async (includeThinkingZero: boolean) => {
      const generationConfig: Record<string, unknown> = {
        temperature: 0.15,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      };
      if (includeThinkingZero) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      return postGeminiGenerateContent({
        model: 'gemini-2.5-flash',
        apiKey: googleKey,
        proxy: useProxy ? route.proxy : null,
        accessToken: useProxy ? route.accessToken : null,
        timeoutMs: CLOUD_AUDIO_TIMEOUT_MS,
        fetchFn: fetchImpl,
        body: {
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: audioMime || 'audio/webm',
                    data: audioBuffer!.toString('base64'),
                  },
                },
              ],
            },
          ],
          generationConfig,
        },
      });
    };

    try {
      let json: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      try {
        json = (await callGeminiAudio(true)) as typeof json;
      } catch (err) {
        if (err instanceof AiHttpError && err.status === 400) {
          json = (await callGeminiAudio(false)) as typeof json;
        } else {
          throw err;
        }
      }

      const rawText = extractGeminiAudioText(json);
      const parsed = parseAiAudioJson(rawText);
      const tokensIn = json.usageMetadata?.promptTokenCount ?? 800;
      const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 220;
      const costUsd = (tokensIn * 0.0001 + tokensOut * 0.0004) / 1000;
      params.onSpendUsd?.(costUsd);

      if (parsed && (parsed.transcript?.trim() || parsed.summary?.trim())) {
        return {
          ok: true,
          result: finalizeAudioShape(
            parsed.title,
            parsed.summary,
            parsed.transcript || parsed.summary || contextText,
            parsed.keyPoints,
            parsed.actionItems,
            parsed.tags,
            parsed.suggestedSection,
            costUsd
          ),
        };
      }
      lastError = isEn
        ? 'Could not recognize speech in this recording — please try again.'
        : 'Не удалось распознать речь в этой записи — попробуй повторить ещё раз.';
    } catch (err) {
      if (err instanceof AiHttpError) {
        lastError =
          err.isQuotaMessage || /[а-яё]/i.test(err.message)
            ? err.message
            : mapCloudHttpError(err.status, locale);
      } else {
        lastError = mapNetworkError(err, locale);
      }
    }
  }

  // 2. OpenRouter audio-compatible input (WAV/MP3 native, ffmpeg transcode, or renderer WAV fallback)
  const tryOpenRouter =
    (Boolean(openRouterKey) || (useProxy && route.provider === 'openrouter')) && !tryGoogle;
  if (tryOpenRouter) {
    try {
      let cloudAudio = await ensureWavBufferForCloud(audioBuffer, audioMime);
      if (!cloudAudio && params.wavBase64Fallback) {
        const cleaned = params.wavBase64Fallback.replace(/^data:audio\/[^;]+;base64,/, '').trim();
        if (cleaned) {
          const fallbackBuf = Buffer.from(cleaned, 'base64');
          if (fallbackBuf.length >= 44 && fallbackBuf.length <= MAX_AUDIO_CLOUD_BYTES) {
            cloudAudio = { buffer: fallbackBuf, format: 'wav' };
          }
        }
      }

      if (!cloudAudio) {
        lastError = isEn
          ? 'Audio format is not supported without WAV conversion. Open the note and click "Transcribe with AI" again, or select Google AI Studio in Settings → AI.'
          : 'Формат аудио не поддерживается без конвертации в WAV. Открой заметку и нажми «Расшифровать через ИИ» ещё раз или выбери Google AI Studio в Настройках → ИИ.';
      } else {
        const json = (await postOpenRouterChatCompletions({
          apiKey: openRouterKey,
          proxy: useProxy ? route.proxy : null,
          accessToken: useProxy ? route.accessToken : null,
          timeoutMs: CLOUD_AUDIO_TIMEOUT_MS,
          fetchFn: fetchImpl,
          body: {
            model: 'google/gemini-2.5-flash',
            temperature: 0.15,
            max_tokens: 4096,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  {
                    type: 'input_audio',
                    input_audio: {
                      data: cloudAudio.buffer.toString('base64'),
                      format: cloudAudio.format,
                    },
                  },
                ],
              },
            ],
          },
        })) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };

        const rawText = json.choices?.[0]?.message?.content ?? '';
        const parsed = parseAiAudioJson(rawText);
        const costUsd = ((json.usage?.total_tokens ?? 1000) * 0.0002) / 1000;
        params.onSpendUsd?.(costUsd);

        if (parsed && (parsed.transcript?.trim() || parsed.summary?.trim())) {
          return {
            ok: true,
            result: finalizeAudioShape(
              parsed.title,
              parsed.summary,
              parsed.transcript || parsed.summary || contextText,
              parsed.keyPoints,
              parsed.actionItems,
              parsed.tags,
              parsed.suggestedSection,
              costUsd
            ),
          };
        }
        lastError = isEn
          ? 'Could not recognize speech in this recording — please try again.'
          : 'Не удалось распознать речь в этой записи — попробуй повторить ещё раз.';
      }
    } catch (err) {
      if (err instanceof AiHttpError) {
        lastError =
          err.isQuotaMessage || /[а-яё]/i.test(err.message)
            ? err.message
            : mapCloudHttpError(err.status, locale);
      } else {
        lastError = mapNetworkError(err, locale);
      }
    }
  }

  return {
    ok: false,
    error:
      lastError ||
      (isEn
        ? 'Add an AI key in Settings → AI to transcribe voice notes.'
        : 'Добавь ключ ИИ в Настройках → ИИ, чтобы расшифровывать голосовые.'),
  };
}

export async function processAudioIntelligence(params: {
  buffer: Buffer;
  mime: string;
  fileName?: string;
  durationSec?: number | null;
  contextHint?: string;
  wavBase64Fallback?: string;
  extractTasks?: boolean;
  aiProvider: AiProvider;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  budgetReached?: boolean;
  locale?: AppLocale;
  onSpendUsd?: (usd: number) => void;
  fetchFn?: FetchLike;
}): Promise<AudioIntelligenceResult> {
  const locale: AppLocale = params.locale ?? 'ru';
  const isEn = locale === 'en';
  const durLabel =
    params.durationSec && params.durationSec > 0
      ? formatDurationCompact(params.durationSec)
      : null;
  const fallbackTitle = buildFallbackTitle(params.fileName, params.durationSec, locale);
  const contextText = (params.contextHint || '').trim();

  const localResult = (transcriptError?: string): AudioIntelligenceResult => {
    const actions = extractActionsFromText(contextText, locale);
    const summary = contextText
      ? contextText.slice(0, 220)
      : durLabel
        ? isEn
          ? `Audio recording (${durLabel}). Ready for playback and search.`
          : `Аудиозапись длительностью ${durLabel}. Готова к прослушиванию и поиску.`
        : isEn
          ? 'Voice note saved and ready for playback.'
          : 'Голосовая заметка сохранена и готова к прослушиванию.';
    const insights = extractLocalAudioInsights(contextText, summary);
    return {
      title: fallbackTitle,
      summary,
      transcript: contextText,
      keyPoints: insights.keyPoints,
      actionItems: insights.actionItems,
      extractedActions: actions,
      tags: [isEn ? 'voice' : 'голос'],
      suggestedSection:
        params.durationSec && params.durationSec >= 90
          ? isEn
            ? 'Meetings'
            : 'Встречи'
          : null,
      costUsd: 0,
      usedCloud: false,
      transcriptError,
    };
  };

  const cloudAttempt = await transcribeAudioFile({
    buffer: params.buffer,
    mime: params.mime,
    fileName: params.fileName,
    durationSec: params.durationSec,
    contextHint: params.contextHint,
    wavBase64Fallback: params.wavBase64Fallback,
    extractTasks: params.extractTasks,
    aiProvider: params.aiProvider,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
    budgetReached: params.budgetReached,
    locale,
    onSpendUsd: params.onSpendUsd,
    fetchFn: params.fetchFn,
  });

  if (cloudAttempt.ok && cloudAttempt.result) {
    return cloudAttempt.result;
  }

  return localResult(cloudAttempt.error);
}

export async function dictateToNote(params: {
  buffer: Buffer;
  mime: string;
  durationSec?: number;
  mode?: 'smart' | 'raw';
  aiProvider: AiProvider;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  budgetReached?: boolean;
  capUsd?: number;
  repo?: VaultRepository;
  locale?: AppLocale;
  onSpendUsd?: (usd: number) => void;
  fetchFn?: FetchLike;
}): Promise<VoiceDictationResult> {
  const locale: AppLocale = params.locale ?? params.repo?.getLocale() ?? 'ru';
  const audioRes = await processAudioIntelligence({
    buffer: params.buffer,
    mime: params.mime,
    durationSec: params.durationSec ?? null,
    aiProvider: params.aiProvider,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
    budgetReached: params.budgetReached,
    locale,
    onSpendUsd: params.onSpendUsd,
    fetchFn: params.fetchFn,
  });

  const transcript = audioRes.transcript.trim();
  const mode = params.mode ?? 'smart';
  let formattedText = transcript;
  let titleSuggestion: string | undefined =
    audioRes.title &&
    !audioRes.title.startsWith('Голосовая заметка') &&
    !audioRes.title.startsWith('Voice note')
      ? audioRes.title
      : undefined;

  if (transcript && mode === 'smart') {
    const apiKey =
      params.aiProvider === 'google_ai_studio'
        ? params.googleAiKey
        : params.aiProvider === 'openrouter'
          ? params.openRouterKey
          : null;
    const transformed = await transformNoteText({
      text: transcript,
      preset: 'structure',
      provider: params.aiProvider,
      apiKey,
      googleAiKey: params.googleAiKey,
      openRouterKey: params.openRouterKey,
      cloudProxy: params.cloudProxy,
      capUsd: params.capUsd,
      repo: params.repo,
      locale,
      fetchFn: params.fetchFn,
    });
    formattedText = transformed.formattedText || transcript;
    titleSuggestion = titleSuggestion || transformed.titleSuggestion;
  }

  return {
    transcript,
    formattedText,
    titleSuggestion,
    keyPoints: audioRes.keyPoints,
    actionItems: audioRes.actionItems,
    durationSec: params.durationSec ?? 0,
    usedCloud: audioRes.usedCloud,
  };
}
