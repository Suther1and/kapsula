import { parseRussianEvent } from '@shared/russian-event-parser';
import type { AppLocale, ContentDna, OrbitDef } from '@shared/types';
import { sanitizeForCloudAi } from '../security/secret-shield';
import {
  postGeminiGenerateContent,
  postOpenRouterChatCompletions,
  type CloudAiProxyConfig,
} from './cloud-proxy';

export interface DecisionApiResult {
  orbit: string; // '' when unsorted / confidence below threshold
  dna: Exclude<ContentDna, 'secret'>;
  needsEnrichment: boolean;
  confidence: number;
  inputTokens: number;
  costUsd: number;
  modelUsed: string;
  fallbackToChat: boolean;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CONFIDENCE_THRESHOLD = 0.72;

function parseRouterJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function classifyWithDecisionApi(params: {
  provider: 'google_ai_studio' | 'openrouter';
  apiKey: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  accessToken?: string | null;
  text: string;
  domain: string | null;
  hasImage: boolean;
  allowPostCover?: boolean;
  orbits: OrbitDef[];
  fallbackOrbit: string;
  fallbackDna: Exclude<ContentDna, 'secret'>;
  locale?: AppLocale;
  fetchFn?: FetchLike;
}): Promise<DecisionApiResult> {
  const shielded = sanitizeForCloudAi(params.text, params.locale);
  if (!shielded.safe) {
    return {
      orbit: params.fallbackOrbit,
      dna: params.fallbackDna,
      needsEnrichment: false,
      confidence: 0,
      inputTokens: 0,
      costUsd: 0,
      modelUsed: 'local-secret-shield',
      fallbackToChat: true,
    };
  }
  const sanitizedInput = shielded.text.slice(0, 1400);
  const orbitLines =
    params.orbits.length > 0
      ? params.orbits.map((o) => `- ${o.id}: ${o.name} (${o.description})`).join('\n')
      : params.locale === 'en'
        ? '- (no user sections yet)'
        : '- (пока нет пользовательских разделов)';

  const systemPrompt = [
    'You are a fast JSON router for a personal knowledge vault.',
    'Return ONLY JSON: {"orbit":"<id>|unsorted","dna":"link|shot|snippet|note|voice|doc","confidence":0.0..1.0,"needs_enrichment":true|false}.',
    'Pick "unsorted" if no section matches strongly or if the text is short casual scratch.',
    `Available sections:\n${orbitLines}`,
  ].join('\n');

  const userPrompt = [
    params.domain ? `Domain: ${params.domain}` : '',
    params.hasImage ? 'Has attached image: true' : '',
    `Content:\n${sanitizedInput}`,
  ]
    .filter(Boolean)
    .join('\n');

  const validDna = new Set(['link', 'shot', 'snippet', 'note', 'voice', 'doc']);

  if (params.provider === 'google_ai_studio') {
    const model = 'gemini-2.5-flash-lite';
    try {
      const data = (await postGeminiGenerateContent({
        model,
        apiKey: params.apiKey,
        proxy: params.cloudProxy,
        accessToken: params.accessToken,
        timeoutMs: 7000,
        fetchFn: params.fetchFn,
        body: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 200,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
      })) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const rawText = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('');
      const parsed = parseRouterJson(rawText);
      const inTok =
        data.usageMetadata?.promptTokenCount ??
        Math.ceil((systemPrompt.length + userPrompt.length) / 3.5);
      const outTok = data.usageMetadata?.candidatesTokenCount ?? Math.ceil(rawText.length / 3.5);
      const costUsd = (inTok / 1_000_000) * 0.1 + (outTok / 1_000_000) * 0.4;

      if (!parsed) {
        return {
          orbit: params.fallbackOrbit,
          dna: params.fallbackDna,
          needsEnrichment: true,
          confidence: 0,
          inputTokens: inTok,
          costUsd,
          modelUsed: model,
          fallbackToChat: true,
        };
      }

      const conf = Number(parsed.confidence ?? 0.8);
      const pickedOrbit =
        typeof parsed.orbit === 'string' &&
        parsed.orbit !== 'unsorted' &&
        params.orbits.some((o) => o.id === parsed.orbit) &&
        conf >= CONFIDENCE_THRESHOLD
          ? parsed.orbit
          : '';
      const dnaCandidate =
        typeof parsed.dna === 'string' && validDna.has(parsed.dna)
          ? (parsed.dna as Exclude<ContentDna, 'secret'>)
          : params.fallbackDna;

      const parsedEventHint = Boolean(parseRussianEvent(params.text)?.isEventIntent);
      return {
        orbit: pickedOrbit,
        dna: (params.hasImage && !params.allowPostCover ? 'shot' : dnaCandidate) as Exclude<
          ContentDna,
          'secret'
        >,
        needsEnrichment: Boolean(parsed.needs_enrichment ?? true) || parsedEventHint,
        confidence: conf,
        inputTokens: inTok + outTok,
        costUsd,
        modelUsed: model,
        fallbackToChat: false,
      };
    } catch {
      return {
        orbit: params.fallbackOrbit,
        dna: params.fallbackDna,
        needsEnrichment: true,
        confidence: 0,
        inputTokens: 0,
        costUsd: 0,
        modelUsed: model,
        fallbackToChat: true,
      };
    }
  }

  const model = 'google/gemini-2.5-flash-lite';
  try {
    const data = (await postOpenRouterChatCompletions({
      apiKey: params.apiKey,
      proxy: params.cloudProxy,
      accessToken: params.accessToken,
      timeoutMs: 7000,
      fetchFn: params.fetchFn,
      body: {
        model,
        temperature: 0.1,
        max_tokens: 160,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const rawText = data.choices?.[0]?.message?.content ?? '';
    const parsed = parseRouterJson(rawText);
    const inTok =
      data.usage?.prompt_tokens ?? Math.ceil((systemPrompt.length + userPrompt.length) / 3.5);
    const outTok = data.usage?.completion_tokens ?? Math.ceil(rawText.length / 3.5);
    const costUsd =
      typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (inTok / 1_000_000) * 0.1 + (outTok / 1_000_000) * 0.4;

    if (!parsed) {
      return {
        orbit: params.fallbackOrbit,
        dna: params.fallbackDna,
        needsEnrichment: true,
        confidence: 0,
        inputTokens: inTok,
        costUsd,
        modelUsed: model,
        fallbackToChat: true,
      };
    }

    const conf = Number(parsed.confidence ?? 0.8);
    const pickedOrbit =
      typeof parsed.orbit === 'string' &&
      parsed.orbit !== 'unsorted' &&
      params.orbits.some((o) => o.id === parsed.orbit) &&
      conf >= CONFIDENCE_THRESHOLD
        ? parsed.orbit
        : '';
    const dnaCandidate =
      typeof parsed.dna === 'string' && validDna.has(parsed.dna)
        ? (parsed.dna as Exclude<ContentDna, 'secret'>)
        : params.fallbackDna;

    const parsedEventHint = Boolean(parseRussianEvent(params.text)?.isEventIntent);
    return {
      orbit: pickedOrbit,
      dna: (params.hasImage && !params.allowPostCover ? 'shot' : dnaCandidate) as Exclude<
        ContentDna,
        'secret'
      >,
      needsEnrichment: Boolean(parsed.needs_enrichment ?? true) || parsedEventHint,
      confidence: conf,
      inputTokens: inTok + outTok,
      costUsd,
      modelUsed: model,
      fallbackToChat: false,
    };
  } catch {
    return {
      orbit: params.fallbackOrbit,
      dna: params.fallbackDna,
      needsEnrichment: true,
      confidence: 0,
      inputTokens: 0,
      costUsd: 0,
      modelUsed: model,
      fallbackToChat: true,
    };
  }
}
