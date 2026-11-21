import crypto from 'node:crypto';
import { cleanBrokenTextArtifacts, cleanInstagramText, decodeHtmlEntities } from '@shared/html-entities';
import type {
  AiProvider,
  AskVaultCitation,
  AskVaultResult,
  ChatTurn,
  ContentDna,
  ExtractedAction,
  FocusBoard,
  OrbitDef,
  SynthesizeMode,
  SynthesizeNotesResult,
  TriageMergeProposal,
  TriageNewOrbitProposal,
  TriagePreviewResult,
  TriageSuggestion,
  VaultItem,
} from '@shared/types';
import { DEFAULT_MONTHLY_CAP_USD, SECTION_COLOR_PALETTE } from '@shared/constants';
import type { VaultRepository } from '../db/repository';
import { redactSecrets } from '../security/secret-shield';
import {
  AiHttpError,
  postGeminiGenerateContent,
  postOpenRouterChatCompletions,
  resolveAiRoute,
  type CloudAiProxyConfig,
} from './cloud-proxy';
import { classifyWithDecisionApi, type FetchLike } from './decision-router';
import { answerVaultLocally, LOCKED_SECRET_QUERY_RE } from './local-heuristic';
import { sanitizeIngestedText } from '../pipeline/html-cleaner';

export interface ParsedAiCalendarEvent {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  hasEndTime: boolean;
  location: string;
  notes: string;
}

export interface AiEnrichmentOutcome {
  orbit: string;
  suggestedNewSection?: string | null;
  dna: Exclude<ContentDna, 'secret'>;
  title: string;
  summary: string;
  tags: string[];
  calendarEvent?: ParsedAiCalendarEvent | null;
  confidence: number;
  usedCloud: boolean;
  fromCache: boolean;
  budgetBlocked: boolean;
}

function formatLocalIsoNow(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dow = d.toLocaleDateString('ru-RU', { weekday: 'long' });
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())} (${dow})`;
}

function parseIsoTimestampLocal(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const dt = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0, 0);
    return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
  }
  const dt = new Date(s);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
}

function parseAiCalendarEvent(raw: unknown): ParsedAiCalendarEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const startAt = parseIsoTimestampLocal(obj.startIso);
  if (startAt === null) return null;
  const allDay = Boolean(obj.allDay);
  const parsedEnd = parseIsoTimestampLocal(obj.endIso);
  const hasEndTime = !allDay && parsedEnd !== null && parsedEnd > startAt;
  const endAt = allDay
    ? startAt + 86_400_000 - 1000
    : hasEndTime
      ? parsedEnd!
      : startAt + 3_600_000;
  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 96) : 'Событие';
  const location = typeof obj.location === 'string' ? obj.location.trim().slice(0, 100) : '';
  const notes = typeof obj.notes === 'string' ? obj.notes.trim().slice(0, 280) : '';
  return { title, startAt, endAt, allDay, hasEndTime, location, notes };
}

function salvageTruncatedTriageJson(raw: string): Record<string, unknown> | null {
  const sugMatch = /"suggestions"\s*:\s*\[/i.exec(raw);
  if (!sugMatch) return null;
  let i = sugMatch.index + sugMatch[0].length;
  const suggestions: Record<string, unknown>[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let objStart = -1;

  for (; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try {
            const obj = JSON.parse(raw.slice(objStart, i + 1)) as unknown;
            if (obj && typeof obj === 'object') {
              suggestions.push(obj as Record<string, unknown>);
            }
          } catch {
            // Skip malformed object slice
          }
          objStart = -1;
        }
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  if (suggestions.length === 0) return null;
  return { suggestions, newOrbits: [], mergeGroups: [] };
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        const salvaged = salvageTruncatedTriageJson(cleaned.slice(start));
        if (salvaged) return salvaged;
      }
    }
    if (start >= 0) {
      return salvageTruncatedTriageJson(cleaned.slice(start));
    }
    return null;
  }
}

function extractGeminiTextFromCandidates(data: {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
}): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const nonThought = parts
    .filter((p) => !p.thought && typeof p.text === 'string' && p.text.length > 0)
    .map((p) => p.text!)
    .join('');
  if (nonThought.trim()) return nonThought;
  return parts.map((p) => p.text ?? '').join('');
}

export async function callFlashLiteJson(params: {
  provider: 'google_ai_studio' | 'openrouter';
  apiKey: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  accessToken?: string | null;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  modelOverride?: string;
  fetchFn?: FetchLike;
}): Promise<{
  parsed: Record<string, unknown> | null;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}> {
  const maxTokens = params.maxTokens ?? 320;
  const timeoutMs = params.timeoutMs ?? 20_000;

  const invokeGoogle = async (
    model: string,
    tokLimit = maxTokens,
    withThinkingZero = true
  ): Promise<{
    parsed: Record<string, unknown> | null;
    rawText: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    model: string;
  }> => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0.2,
      maxOutputTokens: tokLimit,
      responseMimeType: 'application/json',
    };
    if (withThinkingZero && /gemini-2\.5|gemini-3/i.test(model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    try {
      data = (await postGeminiGenerateContent({
        model,
        apiKey: params.apiKey,
        proxy: params.cloudProxy,
        accessToken: params.accessToken,
        timeoutMs,
        fetchFn: params.fetchFn,
        body: {
          systemInstruction: { parts: [{ text: params.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: params.userPrompt }] }],
          generationConfig,
        },
      })) as typeof data;
    } catch (err) {
      if (err instanceof AiHttpError && err.status === 400 && withThinkingZero) {
        return invokeGoogle(model, tokLimit, false);
      }
      throw err;
    }
    const rawText = extractGeminiTextFromCandidates(data);
    const inTok =
      data.usageMetadata?.promptTokenCount ??
      Math.ceil((params.systemPrompt.length + params.userPrompt.length) / 3.5);
    const outTok = data.usageMetadata?.candidatesTokenCount ?? Math.ceil(rawText.length / 3.5);
    const costUsd = (inTok / 1_000_000) * 0.1 + (outTok / 1_000_000) * 0.4;
    return {
      parsed: parseJsonObjectFromText(rawText),
      rawText,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd,
      model,
    };
  };

  const invokeOpenRouter = async (model: string, tokLimit = maxTokens) => {
    const data = (await postOpenRouterChatCompletions({
      apiKey: params.apiKey,
      proxy: params.cloudProxy,
      accessToken: params.accessToken,
      timeoutMs,
      fetchFn: params.fetchFn,
      body: {
        model,
        temperature: 0.2,
        max_tokens: tokLimit,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
      },
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const rawText = data.choices?.[0]?.message?.content ?? '';
    const inTok =
      data.usage?.prompt_tokens ??
      Math.ceil((params.systemPrompt.length + params.userPrompt.length) / 3.5);
    const outTok = data.usage?.completion_tokens ?? Math.ceil(rawText.length / 3.5);
    const costUsd =
      typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (inTok / 1_000_000) * 0.1 + (outTok / 1_000_000) * 0.4;

    return {
      parsed: parseJsonObjectFromText(rawText),
      rawText,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd,
      model,
    };
  };

  const primaryModel =
    params.modelOverride ||
    (params.provider === 'google_ai_studio' ? 'gemini-2.5-flash-lite' : 'google/gemini-2.5-flash-lite');
  const fallbackModel =
    params.provider === 'google_ai_studio' ? 'gemini-2.5-flash' : 'google/gemini-2.5-flash';

  const runModel = (model: string, tokLimit: number) =>
    params.provider === 'google_ai_studio'
      ? invokeGoogle(model, tokLimit, true)
      : invokeOpenRouter(model, tokLimit);

  try {
    const first = await runModel(primaryModel, maxTokens);
    if (first.parsed !== null || primaryModel === fallbackModel) {
      return first;
    }
    const retryTok = Math.max(maxTokens * 2, 3500);
    const second = await runModel(fallbackModel, retryTok);
    return second.parsed ? second : first;
  } catch (err) {
    // Do not retry bad auth key (`401`/`403`) or cloud quota exhaustion (`429`); fall back to full Flash once on transient errors
    if (
      err instanceof AiHttpError &&
      (err.status === 401 || err.status === 403 || (err.status === 429 && err.isQuotaMessage))
    ) {
      throw err;
    }
    if (primaryModel === fallbackModel) {
      throw err;
    }
    return runModel(fallbackModel, Math.max(maxTokens * 2, 3500));
  }
}

export async function runAiPipeline(params: {
  repo: VaultRepository;
  provider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  capUsd?: number;
  contentHash: string;
  rawText: string;
  domain: string | null;
  hasImage: boolean;
  allowPostCover?: boolean;
  orbits: OrbitDef[];
  localBaseline: {
    orbit: string;
    suggestedNewSection?: string | null;
    dna: Exclude<ContentDna, 'secret'>;
    title: string;
    summary: string;
    tags: string[];
  };
  fetchFn?: FetchLike;
  bypassCache?: boolean;
}): Promise<AiEnrichmentOutcome> {
  const capUsd = params.capUsd ?? DEFAULT_MONTHLY_CAP_USD;
  const cacheKey = `${params.provider}:${crypto
    .createHash('sha256')
    .update(`${params.contentHash}|${params.rawText}`)
    .digest('hex')}`;

  // 1. Always check local SHA-256 cache first ($0), unless explicitly bypassing on reprocess
  if (!params.bypassCache) {
    const cached = params.repo.getCachedAi(cacheKey) as AiEnrichmentOutcome | null;
    if (
      cached &&
      cached.usedCloud &&
      (cached.orbit === '' || params.orbits.some((o) => o.id === cached.orbit) || Boolean(cached.suggestedNewSection))
    ) {
      params.repo.logAiUsage(params.provider, 'cache_hit', 0, 0, 0);
      return { ...cached, fromCache: true };
    }
  }

  // 2. Resolve Priority 1 (personal key) -> Priority 2 (signed-in Cloud AI Proxy) -> local
  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });
  if (route.mode === 'local' || route.provider === 'local') {
    return {
      ...params.localBaseline,
      suggestedNewSection: params.localBaseline.suggestedNewSection ?? null,
      confidence: 0.72,
      usedCloud: false,
      fromCache: false,
      budgetBlocked: false,
    };
  }

  // 3. Enforce monthly USD hard budget cap for personal keys (cloud proxy enforces server-side $1/mo cap)
  if (route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(route.provider, capUsd, true);
    if (budget.limitReached) {
      return {
        ...params.localBaseline,
        suggestedNewSection: params.localBaseline.suggestedNewSection ?? null,
        confidence: 0.65,
        usedCloud: false,
        fromCache: false,
        budgetBlocked: true,
      };
    }
  }

  const cleanedInputText = sanitizeIngestedText(params.rawText, { stripCookieNoise: true });
  const sanitizedText = redactSecrets(cleanedInputText || params.rawText).slice(0, 1800);

  // 4. Tier 1: System-1 Decision Router
  const decision = await classifyWithDecisionApi({
    provider: route.provider,
    apiKey: route.apiKey,
    cloudProxy: route.proxy,
    accessToken: route.accessToken,
    text: sanitizedText,
    domain: params.domain,
    hasImage: params.hasImage,
    allowPostCover: params.allowPostCover,
    orbits: params.orbits,
    fallbackOrbit: params.localBaseline.orbit,
    fallbackDna: params.localBaseline.dna,
    fetchFn: params.fetchFn,
  });

  if (!decision.fallbackToChat && decision.inputTokens > 0) {
    params.repo.logAiUsage(
      route.provider,
      decision.modelUsed,
      decision.inputTokens,
      0,
      decision.costUsd
    );
  }

  let finalOutcome: AiEnrichmentOutcome = {
    orbit: decision.orbit,
    suggestedNewSection: decision.orbit ? null : params.localBaseline.suggestedNewSection ?? null,
    dna: decision.dna,
    title: params.localBaseline.title,
    summary: params.localBaseline.summary,
    tags: params.localBaseline.tags,
    confidence: decision.confidence || 0.8,
    usedCloud: !decision.fallbackToChat,
    fromCache: false,
    budgetBlocked: false,
  };

  // 5. Tier 2: Conditional Micro-Enrichment
  const updatedBudget =
    route.mode === 'personal'
      ? params.repo.getMonthBudgetSummary(route.provider, capUsd, true)
      : { limitReached: false };
  if ((decision.needsEnrichment || decision.fallbackToChat) && !updatedBudget.limitReached) {
    const orbitList =
      params.orbits.length > 0
        ? params.orbits.map((o) => `${o.id} (${o.name}): ${o.description}`).join('\n')
        : '(у пользователя пока нет разделов)';
    const topTags = params.repo.getExistingTagUniverse().slice(0, 35).join(', ');
    const systemPrompt = [
      'Ты — умный помощник личного хранилища Kapsula.',
      'Верни СТРОГО JSON без лишнего текста: {"title":"...", "summary":"...", "orbit":"id или unsorted", "suggestedNewSection": "Короткое русское название раздела 1-2 слова или null", "dna":"link|shot|snippet|note|voice|doc", "tags":["..."], "calendarEvent": null | {"title":"...","startIso":"YYYY-MM-DDTHH:mm","endIso":null,"allDay":false,"location":"","notes":""}}.',
      'Правила:',
      '1) title на естественном русском (или оригинальное имя сервиса/проекта + короткая суть) до 64 символов — без кавычек, HTML-мусора и пунктов меню сайта. Если это скриншот с шумным текстом экрана — опиши суть скриншота в 3-6 словах.',
      '2) summary — 1-2 ёмких предложения до 160 символов на живом русском: что это за ресурс, статья или заметка и зачем она полезна. Не дублируй заголовок, НИКОГДА не перечисляй пункты навигации, фильтры, промо-баннеры, cookie-уведомления или сырые пути (/academy-plan и т.п.). Для коротких личных заметок оставь "" (пустую строку).',
      '3) Выбирай orbit из списка ТОЛЬКО при высокой уверенности. Если ни один раздел не подходит или раздела ещё нет, укажи orbit="unsorted" и при явной теме заполни suggestedNewSection (например: "Финансы", "Контакты", "Код", "Дизайн", "Документы", "Покупки", "Поездки", "Чтение").',
      '4) Для случайных коротких фраз, цифр или теста ("Привет", "123123", "фывфыв") ставь orbit="unsorted" и suggestedNewSection=null.',
      `5) Сейчас у пользователя локальное время: ${formatLocalIsoNow()}. Если в тексте есть личная встреча, созвон, запись к врачу/мастеру, билет, доставка или напоминание с датой — заполни calendarEvent (startIso в локальном ISO без Z, endIso=null если конец не назван, location если указан адрес/ссылка). Для новостей, статей и обычных мыслей без личного события всегда ставь calendarEvent=null.`,
      `Разделы пользователя:\n${orbitList}`,
      topTags ? `Существующие теги: ${topTags}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = [
      params.domain ? `Домен: ${params.domain}` : '',
      params.hasImage ? 'Тип: изображение или скриншот' : '',
      `Текст:\n${sanitizedText}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const enriched = await callFlashLiteJson({
        provider: route.provider,
        apiKey: route.apiKey,
        cloudProxy: route.proxy,
        accessToken: route.accessToken,
        systemPrompt,
        userPrompt,
        fetchFn: params.fetchFn,
      });

      params.repo.logAiUsage(
        route.provider,
        enriched.model,
        enriched.inputTokens,
        enriched.outputTokens,
        enriched.costUsd
      );

      if (enriched.parsed) {
        const p = enriched.parsed;
        let validOrbit = finalOutcome.orbit;
        if (typeof p.orbit === 'string') {
          if (p.orbit === 'unsorted' || p.orbit === '') {
            validOrbit = '';
          } else if (params.orbits.some((o) => o.id === p.orbit)) {
            validOrbit = p.orbit;
          }
        }
        const suggestedNewSection =
          !validOrbit && typeof p.suggestedNewSection === 'string' && p.suggestedNewSection.trim().length >= 3
            ? p.suggestedNewSection.trim().slice(0, 28)
            : null;
        const validDna =
          (!params.hasImage || params.allowPostCover) &&
          typeof p.dna === 'string' &&
          ['link', 'shot', 'snippet', 'note', 'voice', 'doc'].includes(p.dna)
            ? (p.dna as Exclude<ContentDna, 'secret'>)
            : finalOutcome.dna;
        const nextTitle =
          typeof p.title === 'string' && p.title.trim().length >= 3
            ? p.title.trim().slice(0, 72)
            : finalOutcome.title;
        const nextSummary =
          typeof p.summary === 'string' ? p.summary.trim().slice(0, 200) : finalOutcome.summary;
        const nextTags = Array.isArray(p.tags)
          ? p.tags.filter((t): t is string => typeof t === 'string').slice(0, 4)
          : finalOutcome.tags;

        const calendarEvent = parseAiCalendarEvent(p.calendarEvent);

        finalOutcome = {
          orbit: validOrbit,
          suggestedNewSection,
          dna: validDna,
          title: nextTitle,
          summary: nextSummary,
          tags: nextTags.length > 0 ? nextTags : finalOutcome.tags,
          calendarEvent,
          confidence: 0.9,
          usedCloud: true,
          fromCache: false,
          budgetBlocked: false,
        };
      }
    } catch {
      // Fall back silently to Tier 1 + Local baseline
    }
  }

  // Only persist successful cloud enrichments so transient network failures never poison cache
  if (finalOutcome.usedCloud) {
    params.repo.setCachedAi(cacheKey, finalOutcome);
  }
  return finalOutcome;
}

export async function askVaultWithAi(params: {
  repo: VaultRepository;
  question: string;
  history?: ChatTurn[];
  provider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  capUsd?: number;
  vaultLocked?: boolean;
  fetchFn?: FetchLike;
}): Promise<AskVaultResult> {
  const vaultLocked = Boolean(params.vaultLocked);
  const inventory = params.repo.getVaultInventorySummary(Date.now(), vaultLocked);
  const candidates = params.repo.searchNonSecretForAsk(params.question, 10);

  if (vaultLocked && LOCKED_SECRET_QUERY_RE.test(params.question)) {
    return answerVaultLocally(params.question, candidates, inventory, true);
  }

  const isInventoryQuestion =
    /(?:карт|виза|visa|mastercard|мир\b|банк|сколько|всего|сейф|парол|ключ|статистик|сводк|напомин|раздел)/i.test(
      params.question
    );

  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  // Never hallucinate or stuff 25 random unrelated notes when nothing matches FTS
  if (route.mode === 'local' || route.provider === 'local') {
    return answerVaultLocally(params.question, candidates, inventory, vaultLocked);
  }

  if (candidates.length === 0 && !isInventoryQuestion && (!params.history || params.history.length === 0)) {
    return {
      answer:
        'Я не нашёл точных совпадений в твоих записях по этому вопросу. Уточни ключевое слово или спроси о сводке хранилища и сохранённых картах.',
      citations: [],
      usedProvider: route.provider,
      costUsd: 0,
    };
  }

  if (route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) {
      return answerVaultLocally(params.question, candidates, inventory, vaultLocked);
    }
  }

  const pool = candidates.slice(0, 10);
  const contextRows = pool.map((item, idx) => {
    let cleanTitle = decodeHtmlEntities(item.title || '');
    let cleanSummary = decodeHtmlEntities(item.summary || '');
    let cleanBody = decodeHtmlEntities(item.body || '');
    if (item.platform === 'instagram' || (item.domain || '').includes('instagram.com')) {
      const ig = cleanInstagramText(cleanTitle, cleanSummary || cleanBody);
      if (ig.cleanTitle) cleanTitle = ig.cleanTitle;
      if (ig.caption) cleanSummary = ig.caption;
    }
    const snippet = redactSecrets(
      [cleanTitle, cleanSummary, item.mediaMeta?.transcript, cleanBody, item.ocrText, item.url]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 380)
    );
    return `[#${idx + 1} id=${item.id} dna=${item.dna} orbit=${item.orbit || 'unsorted'}] ${snippet}`;
  });

  const asksFinanceOrCards = /(?:карт|виза|visa|mastercard|мир\b|банк|финанс)/i.test(
    params.question
  );
  const asksVaultInventory = /(?:сейф|парол|ключ|токен|сколько|всего|статистик|сводк)/i.test(
    params.question
  );

  const safeInventoryBlock = JSON.stringify({
    totalItems: inventory.totalItems,
    unassignedCount: inventory.unassignedCount,
    dueReminderCount: inventory.dueReminderCount,
    dueReminders: (inventory.dueReminders ?? []).slice(0, 5).map((r) => ({
      id: r.id,
      title: redactSecrets(r.title),
      remindAt: new Date(r.remindAt).toISOString(),
    })),
    sections: inventory.byOrbit,
    vaultLocked,
    bankCardCount:
      !vaultLocked && (asksFinanceOrCards || asksVaultInventory)
        ? inventory.bankCardCount
        : undefined,
    passwordCount: !vaultLocked && asksVaultInventory ? inventory.passwordCount : undefined,
    apiKeyCount: !vaultLocked && asksVaultInventory ? inventory.apiKeyCount : undefined,
  });

  const historyLines = (params.history ?? [])
    .slice(-6)
    .map((h) => `${h.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${redactSecrets(h.content).slice(0, 260)}`);

  const systemPrompt = [
    'Ты — ассистент личной памяти Kapsula. Отвечай на живом, понятном русском, кратко и на «ты».',
    'КРИТИЧЕСКИ ВАЖНО:',
    '- Используй ТОЛЬКО факты из сводки хранилища и приведённых записей. Ничего не выдумывай.',
    '- Если записи не найдены, прямо скажи об этом без домыслов.',
    '- Банковские карты и пароли НИКОГДА не раскрывай полностью — показывай только название, бренд и маску •••• 1234.',
    '- Никакого технического жаргона, системных метрик и ссылок в квадратных скобках вроде [#1]. Все ссылки указывай только в cited_ids.',
    'Верни строго JSON: {"answer":"...", "cited_ids":["id1","id2"]}.',
  ].join('\n');

  const userPrompt = [
    `Сводка хранилища (безопасные метаданные):\n${safeInventoryBlock}`,
    historyLines.length > 0 ? `Контекст диалога:\n${historyLines.join('\n')}` : '',
    `Вопрос пользователя: ${redactSecrets(params.question)}`,
    contextRows.length > 0 ? `Найденные записи:\n${contextRows.join('\n')}` : 'Найденные записи: (совпадений по поиску нет)',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await callFlashLiteJson({
      provider: route.provider,
      apiKey: route.apiKey,
      cloudProxy: route.proxy,
      accessToken: route.accessToken,
      systemPrompt,
      userPrompt,
      maxTokens: 650,
      fetchFn: params.fetchFn,
    });
    params.repo.logAiUsage(
      route.provider,
      res.model,
      res.inputTokens,
      res.outputTokens,
      res.costUsd
    );

    const parsed = res.parsed;
    const rawAnswer =
      typeof parsed?.answer === 'string' && parsed.answer.trim()
        ? parsed.answer.trim()
        : answerVaultLocally(params.question, pool, inventory, vaultLocked).answer;
    const answerText = rawAnswer
      .replace(/\s*\[#?\d+(?:,\s*#?\d+)*\]/g, '')
      .replace(/\s+\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const citedIds = Array.isArray(parsed?.cited_ids)
      ? new Set(parsed.cited_ids.filter((x): x is string => typeof x === 'string'))
      : new Set<string>();

    const pickedItems =
      citedIds.size > 0
        ? pool.filter((item) => citedIds.has(item.id))
        : pool.slice(0, 4);

    const citations: AskVaultCitation[] = pickedItems.slice(0, 5).map((i) => {
      const cleanTitle = cleanBrokenTextArtifacts(i.title || '', true);
      const ig =
        i.platform === 'instagram' || (i.domain || '').includes('instagram.com')
          ? cleanInstagramText(cleanTitle, i.summary || i.body)
          : null;
      return {
        id: i.id,
        title: cleanBrokenTextArtifacts(ig?.cleanTitle || cleanTitle, true),
        dna: i.dna,
        orbit: i.orbit,
        summary: cleanBrokenTextArtifacts(ig?.caption || i.summary || i.body || '', true).slice(0, 140),
        domain: i.domain,
        url: i.url,
        thumbPath: i.thumbPath,
        imagePath: i.imagePath,
      };
    });

    return {
      answer: cleanBrokenTextArtifacts(answerText, false),
      citations,
      usedProvider: route.provider,
      costUsd: res.costUsd,
    };
  } catch (err) {
    if (err instanceof AiHttpError && err.status === 429 && err.isQuotaMessage) {
      const localRes = answerVaultLocally(params.question, pool, inventory, vaultLocked);
      return {
        ...localRes,
        answer: `${err.message}\n\n${localRes.answer}`,
      };
    }
    return answerVaultLocally(params.question, pool, inventory, vaultLocked);
  }
}

// ==================== Vision AI Image Enrichment ====================

export interface VisionAnalysisOutcome {
  title: string | null;
  summary: string;
  bodyMarkdown: string;
  links: Array<{ label: string; url: string; description?: string }>;
  tags: string[];
  suggestedOrbitId: string;
  suggestedNewSection: string | null;
  calendarEvent?: ParsedAiCalendarEvent | null;
  usedCloud: boolean;
  costUsd: number;
}

export async function analyzeImageWithVision(params: {
  repo: VaultRepository;
  provider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  imageBase64: string;
  imageMime: string;
  captionHint?: string;
  ocrHint?: string;
  orbits: OrbitDef[];
  capUsd?: number;
  fetchFn?: FetchLike;
}): Promise<VisionAnalysisOutcome | null> {
  if (!params.imageBase64) return null;
  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });
  if (route.mode === 'local' || route.provider === 'local') {
    return null;
  }
  if (route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) return null;
  }

  const orbitLines =
    params.orbits.length > 0
      ? params.orbits.map((o) => `${o.id} (${o.name}): ${o.description}`).join('\n')
      : '(пока нет разделов)';

  const prompt = [
    'Ты — визуальный аналитик личной базы знаний Kapsula.',
    'Рассмотри изображение целиком (сайты, UI-библиотеки, скрины приложений, графики, заметки, код, референсы, рецепты, мемы, интерфейсы, билеты, записи ко врачу/мастеру, приглашения).',
    'Верни СТРОГО JSON без markdown-обёртки:',
    '{"title":"ёмкий заголовок на русском 3-7 слов","summary":"1-2 предложения сути что изображено","bodyMarkdown":"подробный полезный разбор в Markdown: список инструментов/сайтов с их официальными URL и кратким описанием, либо код/суть со скрина","links":[{"label":"Название","url":"https://...","description":"Зачем нужен / что делает"}],"tags":["тег1","тег2"],"orbit":"id раздела или unsorted","suggestedNewSection":"короткое название или null","calendarEvent":null | {"title":"...","startIso":"YYYY-MM-DDTHH:mm","endIso":null,"allDay":false,"location":"","notes":""}}',
    'ПРАВИЛА:',
    '- НИКОГДА не ставь title="image" и не копируй мусорный сырой OCR.',
    '- Если на изображении показаны сайты, сервисы, приложения или полезные инструменты — укажи их точные официальные URL (только если уверен в домене) и по 1 полезному предложению про каждый прямо в bodyMarkdown и в массиве links!',
    `- Сейчас у пользователя локальное время: ${formatLocalIsoNow()}. Если на скрине есть личная запись к врачу/мастеру, билет, бронь, встреча или созвон с датой/временем — заполни calendarEvent (startIso в локальном ISO без Z, endIso=null если окончание не указано, location если есть адрес/ссылка). Для обычных скриншотов и новостей оставляй calendarEvent=null.`,
    `Доступные разделы:\n${orbitLines}`,
    params.captionHint ? `Подпись пользователя: ${redactSecrets(params.captionHint).slice(0, 400)}` : '',
    params.ocrHint ? `Подсказка распознанного текста: ${redactSecrets(params.ocrHint).slice(0, 600)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    let rawText = '';
    let inTok = 400;
    let outTok = 220;
    let costUsd = 0.0003;
    let modelName = 'gemini-2.5-flash';

    if (route.provider === 'google_ai_studio') {
      const sendGoogleVision = async (targetModel: string, includeThinkingZero: boolean) => {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.2,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        };
        if (includeThinkingZero) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        return postGeminiGenerateContent({
          model: targetModel,
          apiKey: route.apiKey,
          proxy: route.proxy,
          accessToken: route.accessToken,
          timeoutMs: 22_000,
          fetchFn: params.fetchFn,
          body: {
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: params.imageMime || 'image/jpeg',
                      data: params.imageBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig,
          },
        });
      };

      let data: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      try {
        data = (await sendGoogleVision(modelName, true)) as typeof data;
      } catch (err) {
        if (err instanceof AiHttpError && err.status === 400) {
          data = (await sendGoogleVision(modelName, false)) as typeof data;
        } else {
          return null;
        }
      }
      rawText = extractGeminiTextFromCandidates(data);
      inTok = data.usageMetadata?.promptTokenCount ?? 450;
      outTok = data.usageMetadata?.candidatesTokenCount ?? Math.ceil(rawText.length / 3.5);
      costUsd = (inTok / 1_000_000) * 0.15 + (outTok / 1_000_000) * 0.6;
      if (!parseJsonObjectFromText(rawText)) {
        try {
          const backupData = (await sendGoogleVision('gemini-2.5-flash-lite', true)) as typeof data;
          const backupText = extractGeminiTextFromCandidates(backupData);
          if (parseJsonObjectFromText(backupText)) {
            modelName = 'gemini-2.5-flash-lite';
            rawText = backupText;
            inTok += backupData.usageMetadata?.promptTokenCount ?? 450;
            outTok += backupData.usageMetadata?.candidatesTokenCount ?? Math.ceil(backupText.length / 3.5);
          }
        } catch {
          // keep primary rawText
        }
      }
    } else {
      modelName = 'google/gemini-2.5-flash';
      const dataUrl = `data:${params.imageMime || 'image/jpeg'};base64,${params.imageBase64}`;
      const data = (await postOpenRouterChatCompletions({
        apiKey: route.apiKey,
        proxy: route.proxy,
        accessToken: route.accessToken,
        timeoutMs: 22_000,
        fetchFn: params.fetchFn,
        body: {
          model: modelName,
          temperature: 0.2,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        },
      })) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      rawText = data.choices?.[0]?.message?.content ?? '';
      inTok = data.usage?.prompt_tokens ?? 450;
      outTok = data.usage?.completion_tokens ?? Math.ceil(rawText.length / 3.5);
      costUsd =
        typeof data.usage?.cost === 'number'
          ? data.usage.cost
          : (inTok / 1_000_000) * 0.15 + (outTok / 1_000_000) * 0.6;
    }

    params.repo.logAiUsage(route.provider, modelName, inTok, outTok, costUsd);
    const parsed = parseJsonObjectFromText(rawText);
    if (!parsed) return null;

    const linksRaw = Array.isArray(parsed.links) ? parsed.links : [];
    const links: Array<{ label: string; url: string; description?: string }> = [];
    for (const l of linksRaw) {
      if (!l || typeof l !== 'object') continue;
      const obj = l as Record<string, unknown>;
      const urlVal = typeof obj.url === 'string' ? obj.url.trim() : '';
      if (!/^https?:\/\//i.test(urlVal)) continue;
      links.push({
        label: (typeof obj.label === 'string' ? obj.label.trim() : urlVal).slice(0, 48),
        url: urlVal,
        description:
          typeof obj.description === 'string' && obj.description.trim()
            ? obj.description.trim().slice(0, 160)
            : undefined,
      });
    }

    const orbitRaw = typeof parsed.orbit === 'string' ? parsed.orbit.trim() : '';
    const suggestedOrbitId =
      orbitRaw && orbitRaw !== 'unsorted' && params.orbits.some((o) => o.id === orbitRaw)
        ? orbitRaw
        : '';
    const suggestedNewSection =
      !suggestedOrbitId &&
      typeof parsed.suggestedNewSection === 'string' &&
      parsed.suggestedNewSection.trim().length >= 3
        ? parsed.suggestedNewSection.trim().slice(0, 28)
        : null;

    return {
      title:
        typeof parsed.title === 'string' && parsed.title.trim().length >= 3
          ? parsed.title.trim().slice(0, 72)
          : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 220) : '',
      bodyMarkdown: typeof parsed.bodyMarkdown === 'string' ? parsed.bodyMarkdown.trim() : '',
      links: links.slice(0, 8),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === 'string').slice(0, 4)
        : [],
      suggestedOrbitId,
      suggestedNewSection,
      calendarEvent: parseAiCalendarEvent(parsed.calendarEvent),
      usedCloud: true,
      costUsd,
    };
  } catch {
    return null;
  }
}

// ==================== Multi-Note Lossless Synthesis («✨ Свести в одну заметку») ====================

export async function synthesizeNotesWithAi(params: {
  repo: VaultRepository;
  items: VaultItem[];
  mode: SynthesizeMode;
  instruction?: string;
  provider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  orbits: OrbitDef[];
  capUsd?: number;
  fetchFn?: FetchLike;
}): Promise<SynthesizeNotesResult> {
  const safeItems = params.items.filter((i) => i.dna !== 'secret');
  const buildLocalFallback = (): SynthesizeNotesResult => {
    const firstOrbit = safeItems.find((i) => i.orbit)?.orbit || '';
    const mergedTags = Array.from(new Set(safeItems.flatMap((i) => i.tags))).slice(0, 5);
    const title =
      safeItems.length <= 2
        ? safeItems.map((i) => i.title).join(' + ').slice(0, 68)
        : `Сводка: ${safeItems[0]?.title.slice(0, 38)} (+${safeItems.length - 1})`;

    let body = '';
    if (params.mode === 'tasks') {
      const taskLines = safeItems.map((i) => {
        const detail = decodeHtmlEntities(i.body || i.summary || '').trim();
        return `- [ ] **${decodeHtmlEntities(i.title)}**${detail && detail !== i.title ? ` — ${detail}` : ''}`;
      });
      body = `## Сводный план действий\n\n${taskLines.join('\n')}`;
    } else if (params.mode === 'table') {
      const rows = safeItems.map((i) => {
        const cleanBody = decodeHtmlEntities(i.body || i.summary || i.url || '—').replace(/\s+/g, ' ').replace(/\|/g, '/');
        const tagsStr = i.tags.map((t) => `#${t}`).join(' ') || '—';
        return `| ${decodeHtmlEntities(i.title).replace(/\|/g, '/')} | ${cleanBody} | ${tagsStr} |`;
      });
      body = `| Тема | Детали и параметры | Теги |\n|---|---|---|\n${rows.join('\n')}`;
    } else {
      body = safeItems
        .map((i) => {
          const content = decodeHtmlEntities(i.body || i.summary || i.mediaMeta?.transcript || '').trim();
          const urlLine = i.url ? `\n\nСсылка: ${i.url}` : '';
          return `## ${decodeHtmlEntities(i.title)}\n\n${content || 'Без дополнительного текста'}${urlLine}`;
        })
        .join('\n\n---\n\n');
    }

    return {
      title,
      body,
      summary: `Объединено записей: ${safeItems.length}. Все исходные числа и детали сохранены.`,
      tags: mergedTags,
      orbit: firstOrbit,
      usedCloud: false,
      preservedDetailsCount: safeItems.length,
    };
  };

  if (safeItems.length === 0) {
    return {
      title: 'Новая сводная заметка',
      body: '',
      summary: '',
      tags: [],
      orbit: '',
      usedCloud: false,
      preservedDetailsCount: 0,
    };
  }

  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  if (route.mode === 'local' || route.provider === 'local') {
    return buildLocalFallback();
  }

  if (route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) return buildLocalFallback();
  }

  const modeRules: Record<SynthesizeMode, string> = {
    spec: 'Собери единую логичную спецификацию / структурированную заметку с подзаголовками `## ...` и списками.',
    tasks: 'Преврати все пункты в единый структурированный чек-лист задач `- [ ] ...` с короткими пояснениями параметров.',
    table: 'Оформи сравнительную или сводную Markdown-таблицу (`| Поле | Значение | ... |`) с выжимкой сверху.',
  };

  const sourceDump = safeItems
    .map((item, idx) =>
      redactSecrets(
        [
          `--- Источник #${idx + 1} (id=${item.id}) ---`,
          `Заголовок: ${decodeHtmlEntities(item.title)}`,
          item.url ? `URL: ${item.url}` : '',
          `Текст:\n${decodeHtmlEntities(item.body || item.summary || item.mediaMeta?.transcript || '')}`,
        ]
          .filter(Boolean)
          .join('\n')
      )
    )
    .join('\n\n')
    .slice(0, 14_000);

  const systemPrompt = [
    'Ты — редактор знаний в приложении Kapsula.',
    modeRules[params.mode],
    'АБСОЛЮТНОЕ ПРАВИЛО БЕЗ ПОТЕРЬ (LOSSLESS):',
    '- Сохрани 100% ВСЕХ точных чисел, сумм, дат, порогов, процентов, параметров, имён, ссылок и формулировок из каждого источника. НЕ округляй, НЕ обобщай в воду и НЕ выбрасывай детали!',
    '- Склей дубли только в структуре, сохранив каждую уникальную деталь.',
    'Верни строго JSON без markdown-обёртки:',
    '{"title":"ёмкий заголовок на русском","summary":"1-2 фразы сути","body":"готовый структурированный Markdown","tags":["тег1","тег2"]}',
  ].join('\n');

  const userPrompt = [
    params.instruction ? `Пожелание пользователя: ${redactSecrets(params.instruction)}` : '',
    `Исходные записи (${safeItems.length}):\n\n${sourceDump}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await callFlashLiteJson({
      provider: route.provider,
      apiKey: route.apiKey,
      cloudProxy: route.proxy,
      accessToken: route.accessToken,
      systemPrompt,
      userPrompt,
      maxTokens: 2400,
      timeoutMs: 35_000,
      fetchFn: params.fetchFn,
    });
    params.repo.logAiUsage(route.provider, res.model, res.inputTokens, res.outputTokens, res.costUsd);
    const p = res.parsed;
    if (!p || typeof p.body !== 'string' || !p.body.trim()) {
      return buildLocalFallback();
    }
    const firstOrbit = safeItems.find((i) => i.orbit)?.orbit || '';
    const mergedTags = Array.isArray(p.tags)
      ? p.tags.filter((t): t is string => typeof t === 'string').slice(0, 5)
      : Array.from(new Set(safeItems.flatMap((i) => i.tags))).slice(0, 5);

    return {
      title:
        typeof p.title === 'string' && p.title.trim()
          ? p.title.trim().slice(0, 82)
          : buildLocalFallback().title,
      body: p.body.trim(),
      summary:
        typeof p.summary === 'string' && p.summary.trim()
          ? p.summary.trim().slice(0, 220)
          : `Сведено из ${safeItems.length} записей`,
      tags: mergedTags,
      orbit: firstOrbit,
      usedCloud: true,
      preservedDetailsCount: safeItems.length,
    };
  } catch {
    return buildLocalFallback();
  }
}

// ==================== Context-Aware Flow Triage («✨ Разобрать») ====================

export async function previewSmartTriageWithAi(params: {
  repo: VaultRepository;
  items: VaultItem[];
  orbits: OrbitDef[];
  boards: FocusBoard[];
  provider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  capUsd?: number;
  fetchFn?: FetchLike;
}): Promise<TriagePreviewResult> {
  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  if (route.mode === 'local' || route.provider === 'local') {
    return {
      configured: false,
      usedCloud: false,
      message:
        'Для умного разбора войди в аккаунт во вкладке «Синхронизация» (встроенный ИИ) или добавь свой ключ в Настройках → ИИ — без ИИ Капсула не раскладывает записи наугад.',
      suggestions: [],
      newOrbits: [],
      mergeGroups: [],
    };
  }

  if (route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) {
      return {
        configured: true,
        usedCloud: false,
        message: 'Достигнут месячный лимит расходов на ИИ. Измени лимит в Настройках, чтобы продолжить разбор.',
        suggestions: [],
        newOrbits: [],
        mergeGroups: [],
      };
    }
  }

  // Strictly exclude secrets at query AND memory layers so vault items never reach cloud LLM
  const allItems = params.repo
    .queryItems({ includeSecrets: false, limit: 500 })
    .filter((it) => it.dna !== 'secret');
  const eligible = params.items.filter((i) => !i.isArchived && i.dna !== 'secret');
  const unsortedOrBuffer = eligible.filter((i) => !i.orbit || i.aiStatus === 'raw_buffer');
  const docsOrbitIds = new Set(
    params.orbits.filter((o) => o.name.toLowerCase().includes('документ')).map((o) => o.id)
  );
  const secondaryPool = eligible.filter(
    (i) =>
      i.orbit &&
      i.aiStatus !== 'raw_buffer' &&
      (i.aiStatus === 'local' ||
        i.aiStatus === 'pending' ||
        (docsOrbitIds.has(i.orbit) &&
          (i.platform === 'telegram' || (i.domain || '').toLowerCase() === 't.me')) ||
        (params.boards.length > 0 && !i.focusBoardId))
  );
  const dedupedAllIds = new Set<string>();
  const allCandidates: VaultItem[] = [];
  for (const item of [...unsortedOrBuffer, ...secondaryPool]) {
    if (dedupedAllIds.has(item.id)) continue;
    dedupedAllIds.add(item.id);
    allCandidates.push(item);
  }
  const targetPool = allCandidates.slice(0, 18);
  const remainingCount = Math.max(0, allCandidates.length - targetPool.length);

  if (targetPool.length === 0) {
    return {
      configured: true,
      usedCloud: false,
      message: 'Во «Всех записях» сейчас нет неразобранных записей — везде уже порядок.',
      suggestions: [],
      newOrbits: [],
      mergeGroups: [],
    };
  }

  // Feed up to 6 redacted non-secret example items inside every existing section & project
  const orbitExamples = params.orbits.map((o) => {
    const samples = allItems
      .filter((it) => it.dna !== 'secret' && it.orbit === o.id)
      .slice(0, 6)
      .map((it) => {
        const safeTitle = redactSecrets(cleanBrokenTextArtifacts(it.title || '', true));
        const safeSummary = it.summary
          ? redactSecrets(cleanBrokenTextArtifacts(it.summary, true)).slice(0, 60)
          : '';
        return `"${safeTitle}"${safeSummary ? ` (${safeSummary})` : ''}`;
      });
    return `- Раздел id="${o.id}" | имя="${redactSecrets(o.name)}" | описание="${redactSecrets(o.description)}" | живые примеры внутри: ${samples.length > 0 ? samples.join('; ') : 'пока пусто'}`;
  });

  const boardExamples = params.boards.map((b) => {
    const samples = allItems
      .filter((it) => it.dna !== 'secret' && it.focusBoardId === b.id)
      .slice(0, 6)
      .map((it) => {
        const safeTitle = redactSecrets(cleanBrokenTextArtifacts(it.title || '', true));
        const safeBody = it.body
          ? redactSecrets(cleanBrokenTextArtifacts(it.body, true)).slice(0, 50)
          : '';
        return `"${safeTitle}"${safeBody ? ` (${safeBody})` : ''}`;
      });
    return `- Подборка id="${b.id}" | имя="${redactSecrets(b.name)}" | описание="${redactSecrets(b.description || '')}" | живые примеры внутри: ${samples.length > 0 ? samples.join('; ') : 'пока пусто'}`;
  });

  const orbitNameLookup = new Map(params.orbits.map((o) => [o.id, o.name]));
  const inboxDump = targetPool.map((it) =>
    redactSecrets(
      JSON.stringify({
        id: it.id,
        dna: it.dna,
        currentOrbitId: it.orbit || null,
        currentOrbitName: it.orbit ? orbitNameLookup.get(it.orbit) ?? it.orbit : null,
        currentBoardId: it.focusBoardId ?? null,
        title: cleanBrokenTextArtifacts(it.title, true),
        snippet: cleanBrokenTextArtifacts(it.body || it.summary || it.url || '', true).slice(0, 150),
        tags: it.tags,
      })
    )
  );

  const systemPrompt = [
    'Ты — умный куратор базы знаний Kapsula. Разбери записи пользователя, опираясь НЕ только на названия разделов и подборок (например: «Работа», «Личное», «Идеи», «Обучение», «Проекты»), но и на ЖИВЫЕ ПРИМЕРЫ заметок, которые уже лежат внутри каждого раздела и подборки!',
    'Верни СТРОГО JSON:',
    '{"suggestions":[{"itemId":"...","targetOrbit":"id раздела или null","targetBoardId":"id подборки или null","suggestedTags":["тег"],"archive":false,"reason":"короткая причина по-русски","confidence":0.85}],"newOrbits":[{"name":"Название","description":"Зачем","color":"#E86A33","icon":"Folder","itemIds":["..."]}],"mergeGroups":[{"title":"Объединённый заголовок","itemIds":["id1","id2"],"reason":"Почему стоит свести в одну заметку"}]}',
    'ПРАВИЛА:',
    '- Проверяй текущее расположение (currentOrbitName / currentBoardId): если авто-сортировка ошиблась по смыслу (например, заметка по рабочему проекту попала в «Личное» или пост из соцсети лежит в «Документы») — ПЕРЕНЕСИ в правильный раздел и подходящую подборку.',
    '- НИКОГДА не предлагай пустые переносы без изменений (если targetOrbit совпадает с currentOrbitId И targetBoardId совпадает с currentBoardId И archive=false — пропусти запись).',
    '- Если уверенность < 0.72, НЕ угадывай наугад — оставь targetOrbit=null и не включай сомнительные ходы.',
    '- Если видишь 2 и более коротких заметок об одной теме, проекте или задаче, обязательно предложи объединить их в mergeGroups!',
    '- Предлагай archive=true только для явного разового тестового мусора.',
    `СУЩЕСТВУЮЩИЕ РАЗДЕЛЫ:\n${orbitExamples.join('\n') || '(нет)'}`,
    `СУЩЕСТВУЮЩИЕ ПОДБОРКИ:\n${boardExamples.join('\n') || '(нет)'}`,
  ].join('\n');

  try {
    const res = await callFlashLiteJson({
      provider: route.provider,
      apiKey: route.apiKey,
      cloudProxy: route.proxy,
      accessToken: route.accessToken,
      systemPrompt,
      userPrompt: `Записи для проверки (${targetPool.length}):\n${inboxDump.join('\n')}`,
      maxTokens: 4096,
      timeoutMs: 40_000,
      fetchFn: params.fetchFn,
    });
    params.repo.logAiUsage(route.provider, res.model, res.inputTokens, res.outputTokens, res.costUsd);

    const parsed = res.parsed;
    if (!parsed) {
      return {
        configured: true,
        usedCloud: true,
        message: 'Не удалось получить корректный разбор от модели. Попробуй ещё раз.',
        suggestions: [],
        newOrbits: [],
        mergeGroups: [],
      };
    }

    const itemMap = new Map(targetPool.map((i) => [i.id, i]));
    const orbitMap = new Map(params.orbits.map((o) => [o.id, o]));
    const boardMap = new Map(params.boards.map((b) => [b.id, b]));

    const suggestions: TriageSuggestion[] = [];
    if (Array.isArray(parsed.suggestions)) {
      for (const s of parsed.suggestions) {
        if (!s || typeof s !== 'object') continue;
        const obj = s as Record<string, unknown>;
        const itemId = typeof obj.itemId === 'string' ? obj.itemId : '';
        const item = itemMap.get(itemId);
        if (!item) continue;
        const conf = Number(obj.confidence ?? 0.8);
        if (conf < 0.72) continue;
        const rawOrb = typeof obj.targetOrbit === 'string' && orbitMap.has(obj.targetOrbit) ? obj.targetOrbit : null;
        const rawBoard = typeof obj.targetBoardId === 'string' && boardMap.has(obj.targetBoardId) ? obj.targetBoardId : null;
        const archive = Boolean(obj.archive);
        const orbitChanged = rawOrb !== null && rawOrb !== (item.orbit || null);
        const boardChanged = rawBoard !== null && rawBoard !== (item.focusBoardId || null);
        if (!orbitChanged && !boardChanged && !archive) continue;
        const effectiveOrbitId = rawOrb ?? (item.orbit || null);
        suggestions.push({
          itemId,
          itemTitle: cleanBrokenTextArtifacts(item.title || 'Без названия', true),
          currentOrbit: item.orbit,
          targetOrbit: effectiveOrbitId,
          targetOrbitName: effectiveOrbitId ? orbitMap.get(effectiveOrbitId)?.name ?? null : null,
          targetBoardId: rawBoard,
          targetBoardName: rawBoard ? boardMap.get(rawBoard)?.name ?? null : null,
          suggestedTags: Array.isArray(obj.suggestedTags)
            ? obj.suggestedTags.filter((t): t is string => typeof t === 'string').slice(0, 4)
            : [],
          archive,
          reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : 'Подходит по смыслу',
          confidence: conf,
        });
      }
    }

    const newOrbits: TriageNewOrbitProposal[] = [];
    if (Array.isArray(parsed.newOrbits)) {
      for (const no of parsed.newOrbits) {
        if (!no || typeof no !== 'object') continue;
        const obj = no as Record<string, unknown>;
        const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 28) : '';
        const ids = Array.isArray(obj.itemIds)
          ? obj.itemIds.filter((x): x is string => typeof x === 'string' && itemMap.has(x))
          : [];
        if (!name || ids.length < 2) continue;
        newOrbits.push({
          name,
          description: typeof obj.description === 'string' ? obj.description.trim().slice(0, 120) : name,
          color:
            typeof obj.color === 'string' && /^#[0-9a-f]{6}$/i.test(obj.color)
              ? obj.color
              : SECTION_COLOR_PALETTE[newOrbits.length % SECTION_COLOR_PALETTE.length]!,
          icon: typeof obj.icon === 'string' ? obj.icon : 'Folder',
          itemIds: ids,
        });
      }
    }

    const mergeGroups: TriageMergeProposal[] = [];
    if (Array.isArray(parsed.mergeGroups)) {
      for (const mg of parsed.mergeGroups) {
        if (!mg || typeof mg !== 'object') continue;
        const obj = mg as Record<string, unknown>;
        const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 72) : '';
        const ids = Array.isArray(obj.itemIds)
          ? obj.itemIds.filter((x): x is string => typeof x === 'string' && itemMap.has(x))
          : [];
        if (!title || ids.length < 2) continue;
        mergeGroups.push({
          title,
          itemIds: ids,
          reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 140) : 'Записи об одной теме',
        });
      }
    }

    const hasAnyAction = suggestions.length > 0 || newOrbits.length > 0 || mergeGroups.length > 0;
    return {
      configured: true,
      usedCloud: true,
      message: hasAnyAction
        ? remainingCount > 0
          ? `В эту партию взяты 18 приоритетных записей — оставшиеся (${remainingCount}) можно разобрать следующим шагом.`
          : undefined
        : 'Все проверенные записи уже лежат в подходящих разделах.',
      remainingCount,
      suggestions,
      newOrbits,
      mergeGroups,
    };
  } catch (err) {
    let message = 'Не удалось связаться с сервером ИИ — проверь интернет и настройки ИИ.';
    if (err instanceof AiHttpError) {
      if (err.status === 429 && err.isQuotaMessage) {
        message = err.message;
      } else if (err.status === 401 || err.status === 403) {
        message =
          route.mode === 'cloud_proxy'
            ? err.message
            : 'Ключ ИИ не принят провайдером — проверь его в Настройках → ИИ.';
      } else if (err.status === 429) {
        message = 'Провайдер временно ограничил число запросов — подожди минуту и повтори.';
      } else {
        message = 'Модель ИИ временно недоступна. Попробуй повторить через несколько секунд.';
      }
    } else if (
      err instanceof Error &&
      /timeout|abort/i.test(`${err.name} ${err.message}`)
    ) {
      message = 'Модель отвечает слишком долго. Попробуй ещё раз — записей разобрать можно за два захода.';
    }
    return {
      configured: true,
      usedCloud: false,
      message,
      suggestions: [],
      newOrbits: [],
      mergeGroups: [],
    };
  }
}

export async function testAiProviderConnection(params: {
  provider: AiProvider;
  apiKey: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  fetchFn?: FetchLike;
}): Promise<{ ok: boolean; message: string }> {
  if (params.provider === 'local') {
    return { ok: true, message: 'Локальный режим активен и не требует ключа.' };
  }
  const cleanKey = params.apiKey?.trim() || null;
  if (!cleanKey && !params.cloudProxy) {
    return { ok: false, message: 'Сначала вставь и сохрани ключ доступа.' };
  }
  try {
    const res = await callFlashLiteJson({
      provider: params.provider,
      apiKey: cleanKey,
      cloudProxy: cleanKey ? null : params.cloudProxy,
      systemPrompt: 'Return {"ok":true}',
      userPrompt: 'ping',
      maxTokens: 30,
      fetchFn: params.fetchFn,
    });
    return res.rawText
      ? {
          ok: true,
          message: cleanKey
            ? 'Подключение работает — личный ключ проверен.'
            : 'Встроенный ИИ Kapsula работает.',
        }
      : { ok: false, message: 'Провайдер вернул пустой ответ.' };
  } catch (err) {
    if (err instanceof AiHttpError && err.status === 429 && err.isQuotaMessage) {
      return { ok: false, message: err.message };
    }
    const raw = err instanceof Error ? err.message : '';
    if (raw.includes('401') || raw.includes('403')) {
      return { ok: false, message: 'Ключ отклонён — проверь, что скопировал его полностью.' };
    }
    if (raw.includes('429')) {
      return { ok: false, message: 'Лимит запросов исчерпан — попробуй чуть позже.' };
    }
    return { ok: false, message: 'Не удалось связаться с сервером модели.' };
  }
}
