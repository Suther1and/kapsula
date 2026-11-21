import { DEFAULT_MONTHLY_CAP_USD } from '@shared/constants';
import type { AiProvider, AppLocale, TextTransformPreset, TextTransformResult } from '@shared/types';
import type { VaultRepository } from '../db/repository';
import { analyzeForSecret, detectCardBrand, passesLuhn, redactSecrets } from '../security/secret-shield';
import type { FetchLike } from './decision-router';
import { resolveAiRoute, type CloudAiProxyConfig } from './cloud-proxy';
import { callFlashLiteJson } from './enricher';

const ACTION_VERB_RE =
  /^(?:купить|заказать|позвонить|написать|отправить|сделать|проверить|оплатить|настроить|подготовить|добавить|обновить|прочитать|встретиться|созвониться|уточнить|забрать|посмотреть|изучить|доделать|исправить|перенести|напомнить|создать|удалить|починить|найти|выбрать|сравнить|согласовать|протестировать|выложить|опубликовать|todo|fix|check|send|buy|call|write|review|update|deploy|test|ask)(?=$|[\s,.;:!?—-])/iu;

const EXISTING_TASK_RE = /^\s*(?:[-*•]\s*(?:\\?\[[ xX]\\?\]\s*)?|\d+[.)]\s+)(.+)$/;

function restoreTokens(text: string, tokens: string[]): string {
  return text.replace(/\{\{KAPSULA_TOKEN_(\d+)\}\}/g, (_m, idx) => tokens[Number(idx)] ?? '');
}

function protectCodeAndUrls(raw: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const stash = (value: string) => {
    const idx = tokens.push(value) - 1;
    return `{{KAPSULA_TOKEN_${idx}}}`;
  };

  let masked = raw.replace(/```[\s\S]*?```/g, (m) => stash(m));
  masked = masked.replace(/`[^`\n]+`/g, (m) => stash(m));
  masked = masked.replace(/https?:\/\/[^\s)<>\]"']+/gi, (m) => stash(m));
  return { masked, tokens };
}

function applyRussianTypography(raw: string): string {
  const { masked, tokens } = protectCodeAndUrls(raw);

  let out = masked
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([ \t]){2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])([^\s\n\d"')»\]}])/g, '$1 $2')
    .replace(/[ \t]+--?[ \t]+/g, ' — ')
    .replace(/"([^"\n]{1,220})"/g, '«$1»')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Capitalize start of standalone lines/sentences cleanly (without touching lowercase list items unless needed)
  out = out.replace(/(^|[.!?]\s+)([а-яёa-z])/gu, (_m, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`);

  return restoreTokens(out, tokens);
}

function deriveTitleSuggestion(raw: string): string | undefined {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s*(?:\[[ xX]\]\s*)?/gm, '')
    .trim();
  if (!cleaned) return undefined;
  const firstLine = cleaned.split(/\n/)[0]?.trim() || cleaned;
  const firstClause = firstLine.split(/[.!?]|—|:/)[0]?.trim() || firstLine;
  const words = firstClause.split(/\s+/).filter(Boolean).slice(0, 7);
  if (words.length === 0) return undefined;
  const title = words.join(' ');
  return title.length > 56 ? `${title.slice(0, 53).trim()}…` : title;
}

function extractTaskCandidates(raw: string): { tasks: string[]; contextLines: string[] } {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);

  const tasks: string[] = [];
  const contextLines: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      contextLines.push(line);
      continue;
    }
    if (inFence) {
      contextLines.push(line);
      continue;
    }

    const listMatch = EXISTING_TASK_RE.exec(line);
    if (listMatch?.[1]) {
      const candidate = applyRussianTypography(listMatch[1].trim());
      if (candidate) tasks.push(candidate);
      continue;
    }

    // Split multi-sentence lines by `. ` / `; ` when scanning for actionable clauses
    const parts = line
      .split(/(?<=[.!?])\s+|;\s+/)
      .map((p) => p.replace(/[.]+$/, '').trim())
      .filter(Boolean);

    let lineHadTask = false;
    for (const part of parts) {
      if (ACTION_VERB_RE.test(part) || /^надо\s+|^нужно\s+|^не забыть\s+/i.test(part)) {
        const cleaned = part.replace(/^(?:надо|нужно|не забыть)\s+/i, '');
        const nice = applyRussianTypography(cleaned);
        if (nice) {
          tasks.push(nice);
          lineHadTask = true;
          continue;
        }
      }
      if (!lineHadTask || parts.length > 1) {
        if (ACTION_VERB_RE.test(part) || /^надо\s+|^нужно\s+|^не забыть\s+/i.test(part)) {
          continue;
        }
        contextLines.push(part);
      }
    }
    if (!lineHadTask && parts.length <= 1) {
      contextLines.push(line);
    }
  }

  return { tasks, contextLines };
}

function splitLongProseIntoParagraphs(text: string): string {
  const { masked, tokens } = protectCodeAndUrls(text);
  const blocks = masked.split(/\n{2,}/);
  const rebuilt: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Leave headings, lists, quotes, code placeholders untouched
    if (/^(?:#{1,6}\s|[-*]\s|\d+[.)]\s|>\s|\{\{KAPSULA_TOKEN_)/.test(trimmed)) {
      rebuilt.push(trimmed);
      continue;
    }

    const sentences = trimmed
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«\d])/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length <= 3 && trimmed.length < 240) {
      rebuilt.push(trimmed);
      continue;
    }

    for (let i = 0; i < sentences.length; i += 2) {
      rebuilt.push(sentences.slice(i, i + 2).join(' '));
    }
  }

  return restoreTokens(rebuilt.join('\n\n'), tokens);
}

export function formatNoteLocally(
  rawText: string,
  preset: TextTransformPreset,
  locale: AppLocale = 'ru'
): TextTransformResult {
  const raw = rawText.trim();
  if (!raw) {
    return { formattedText: '', extractedTasks: [], usedCloud: false };
  }
  const isEn = locale === 'en';
  const titleSuggestion = deriveTitleSuggestion(raw);

  if (preset === 'polish') {
    const formatted = applyRussianTypography(raw);
    return {
      titleSuggestion,
      formattedText: formatted,
      extractedTasks: extractTaskCandidates(formatted).tasks,
      usedCloud: false,
    };
  }

  if (preset === 'tasks') {
    const { tasks, contextLines } = extractTaskCandidates(raw);
    const finalTasks =
      tasks.length > 0
        ? tasks
        : raw
            .split(/\n+|(?<=[.!?])\s+|;\s+/)
            .map((s) => applyRussianTypography(s.replace(/^[-*•\d.)]+\s*/, '').trim()))
            .filter(Boolean);

    const formattedParts: string[] = [];
    if (contextLines.length > 0 && contextLines.join(' ').length > 10 && tasks.length > 0) {
      formattedParts.push(applyRussianTypography(contextLines.join(' ')));
    }
    if (finalTasks.length > 0) {
      formattedParts.push(finalTasks.map((t) => `- [ ] ${t}`).join('\n'));
    }

    return {
      titleSuggestion,
      formattedText: formattedParts.join('\n\n').trim() || applyRussianTypography(raw),
      extractedTasks: finalTasks,
      usedCloud: false,
    };
  }

  if (preset === 'summary') {
    const clean = applyRussianTypography(raw);
    const { tasks } = extractTaskCandidates(clean);
    const sentences = clean
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^#+\s*/gm, '')
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
      .filter((s) => s.length >= 6);

    const keyLines = sentences.slice(0, 4);
    const summaryText = keyLines.slice(0, 2).join(' ');
    const blocks: string[] = [];
    if (summaryText) {
      blocks.push(isEn ? `> **TL;DR:** ${summaryText}` : `> **Главное:** ${summaryText}`);
    }
    if (keyLines.length > 1) {
      blocks.push(
        (isEn ? '## Key Points\n' : '## Ключевые тезисы\n') +
          keyLines.map((l) => `- ${l}`).join('\n')
      );
    }
    if (tasks.length > 0) {
      blocks.push(
        (isEn ? '## Next Steps\n' : '## Следующие шаги\n') +
          tasks.map((t) => `- [ ] ${t}`).join('\n')
      );
    }

    return {
      titleSuggestion,
      formattedText: blocks.join('\n\n').trim() || clean,
      extractedTasks: tasks,
      summary: summaryText || titleSuggestion,
      usedCloud: false,
    };
  }

  // 'structure' preset: clean typography, split walls of text, elevate tasks cleanly, keep code blocks intact at bottom
  const clean = applyRussianTypography(raw);
  const { tasks, contextLines } = extractTaskCandidates(clean);

  const proseContext: string[] = [];
  const codeBlocks: string[] = [];
  let inFenceBlock = false;
  let currentFence: string[] = [];
  for (const cl of contextLines) {
    if (cl.startsWith('```') || cl.startsWith('~~~')) {
      if (!inFenceBlock) {
        inFenceBlock = true;
        currentFence = [cl];
      } else {
        currentFence.push(cl);
        codeBlocks.push(currentFence.join('\n'));
        currentFence = [];
        inFenceBlock = false;
      }
      continue;
    }
    if (inFenceBlock) {
      currentFence.push(cl);
    } else {
      proseContext.push(cl);
    }
  }
  if (currentFence.length > 0) codeBlocks.push(currentFence.join('\n'));

  let structuredBody = splitLongProseIntoParagraphs(
    tasks.length > 0 && proseContext.length > 0 ? proseContext.join('\n\n') : proseContext.length > 0 ? proseContext.join('\n\n') : ''
  );

  if (tasks.length === 0 && codeBlocks.length === 0) {
    structuredBody = splitLongProseIntoParagraphs(clean);
  } else {
    const sections: string[] = [];
    if (structuredBody) sections.push(structuredBody);
    if (tasks.length > 0) {
      sections.push(`${isEn ? '## Tasks' : '## Задачи'}\n${tasks.map((t) => `- [ ] ${t}`).join('\n')}`);
    }
    if (codeBlocks.length > 0) {
      sections.push(codeBlocks.join('\n\n'));
    }
    structuredBody = sections.join('\n\n').trim();
  }

  return {
    titleSuggestion,
    formattedText: structuredBody || clean,
    extractedTasks: tasks,
    usedCloud: false,
  };
}

const PRESET_PROMPT_RULES_RU: Record<TextTransformPreset, string> = {
  structure:
    'Разбей сплошной текст на логичные абзацы, оформи перечисления списками, а явные дела — чекбоксами `- [ ] ...`. Добавляй заголовки `## ...` только если в тексте реально 2+ разные темы.',
  tasks:
    'Выдели из текста все действия, договорённости и дела в чёткий Markdown-список чекбоксов `- [ ] ...`. Краткий контекст (если он нужен) оставь одной строкой выше.',
  polish:
    'Убери опечатки, слова-паразиты, лишние пробелы и причёши пунктуацию и кавычки «ёлочки» + длинное тире —. Исходный стиль, смысл и структуру сохрани.',
  summary:
    'Собери суть текста в короткую выжимку: сначала цитата `> **Главное:** ...`, затем ключевые тезисы списком `- ...` и при наличии — блок `- [ ] ...` с шагами.',
};

const PRESET_PROMPT_RULES_EN: Record<TextTransformPreset, string> = {
  structure:
    'Split walls of text into clear paragraphs, format lists cleanly, and convert action items into `- [ ] ...` checkboxes. Only add `## ...` headings if there are genuinely 2+ distinct topics.',
  tasks:
    'Extract all action items, commitments, and next steps into a crisp Markdown `- [ ] ...` checklist. Keep brief context above as a single short line if needed.',
  polish:
    'Fix typos, filler words, and awkward spacing while polishing punctuation cleanly. Preserve the original tone, facts, and structure.',
  summary:
    'Distill the essence concisely: start with `> **TL;DR:** ...`, then key bullet points `- ...`, and if applicable a `- [ ] ...` next-steps checklist.',
};

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
  /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function maskInlineSecretsForCloud(raw: string): {
  masked: string;
  secrets: string[];
  safeForCloud: boolean;
} {
  // Fast check: if neither redactSecrets nor analyzeForSecret flags anything, text is safe as-is
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

  // Basic auth credentials inside URLs and Bearer headers
  masked = masked.replace(/(https?:\/\/)([^\s/:@]+:[^\s/@]+)(@)/gi, (_m, p1: string, cred: string, p3: string) => {
    return `${p1}${stashSecret(cred)}${p3}`;
  });
  masked = masked.replace(/(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})\b/gi, (_m, p1: string, tok: string) => {
    return `${p1}${stashSecret(tok)}`;
  });

  // Labeled CVV/CVC/PIN codes
  masked = masked.replace(/(\b(?:cvv2?|cvc|pin|пин)\s*[:=-]?\s*)(\d{3,6})\b/gi, (_m, p1: string, code: string) => {
    return `${p1}${stashSecret(code)}`;
  });

  // Labeled password / token / secret / key values
  masked = masked.replace(
    /(^|[^\p{L}\p{N}_])((?:пароль|pass(?:word)?|pwd|pin(?:\s*[-]?\s*код)?|пин(?:\s*[-]?\s*код)?|token|токен|key|ключ|secret|секрет)\s*[:=\-—]\s*)([^\n\r·|;]+)/giu,
    (full, boundary: string, prefix: string, val: string) => {
      const trimmed = val.trim();
      if (!trimmed || /^\[REDACTED_SECRET_\d+\]$/.test(trimmed)) return full;
      // Only mask when redactSecrets would actually redact this field
      if (redactSecrets(`${prefix}${val}`) === `${prefix}${val}`) return full;
      return `${boundary}${prefix}${stashSecret(val)}`;
    }
  );

  // Compact email:password pairs
  masked = masked.replace(
    /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*(?::|->|\|)\s*)([^\s:]{4,})/g,
    (full, prefix: string, pass: string) => {
      if (/^\[REDACTED_SECRET_\d+\]$/.test(pass)) return full;
      return `${prefix}${stashSecret(pass)}`;
    }
  );

  // Luhn-valid bank cards
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

  // Strict defense-in-depth verification: if ANY secret remains unredacted, block cloud call!
  const residualRedacted = redactSecrets(masked);
  const residualAnalysis = analyzeForSecret(masked);
  const safeForCloud = residualRedacted === masked && !residualAnalysis.isSecret;

  return { masked, secrets, safeForCloud };
}

function restoreInlineSecrets(text: string, secrets: string[]): string {
  if (secrets.length === 0) return text;
  return text.replace(/\[REDACTED_SECRET_(\d+)\]/g, (_m, idx: string) => secrets[Number(idx)] ?? '');
}

export async function transformNoteText(params: {
  text: string;
  preset: TextTransformPreset;
  provider: AiProvider;
  apiKey?: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  capUsd?: number;
  repo?: VaultRepository;
  locale?: AppLocale;
  fetchFn?: FetchLike;
}): Promise<TextTransformResult> {
  const locale: AppLocale = params.locale ?? params.repo?.getLocale() ?? 'ru';
  const isEn = locale === 'en';
  const local = formatNoteLocally(params.text, params.preset, locale);
  if (!params.text.trim()) return local;

  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  if (route.mode === 'local' || route.provider === 'local') {
    return local;
  }

  // CRITICAL SECURITY GATE: Never transmit raw passwords, API keys, bank cards, or seed phrases to cloud AI
  const secretMask = maskInlineSecretsForCloud(params.text.slice(0, 12000));
  if (!secretMask.safeForCloud) {
    return local;
  }

  if (params.repo && route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) {
      return local;
    }
  }

  const systemPrompt = isEn
    ? [
        'You are a personal notes editor inside Kapsula.',
        PRESET_PROMPT_RULES_EN[params.preset],
        'MANDATORY RULES:',
        '- Never invent facts, numbers, dates, or tasks that are not in the user text.',
        '- Preserve URLs, fenced code blocks, commands, phone numbers, names, and [REDACTED_SECRET_0] placeholders untouched.',
        '- Write in crisp, natural English with zero boilerplate or meta commentary.',
        'Return strictly JSON without markdown fences:',
        '{"titleSuggestion":"short unquoted title","formattedText":"formatted Markdown","extractedTasks":["task 1"],"summary":"1 sentence TL;DR"}',
      ].join('\n')
    : [
        'Ты — редактор личных заметок в приложении Kapsula.',
        PRESET_PROMPT_RULES_RU[params.preset],
        'ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:',
        '- Никогда не выдумывай новые факты, цифры, даты или задачи, которых нет у пользователя.',
        '- Сохраняй без искажений URL-ссылки, код в тройных бэктиках, команды, телефоны, имена и служебные маркеры вида [REDACTED_SECRET_0].',
        '- Используй живую русскую типографику: кавычки «ёлочки» (не в коде), длинное тире —, без канцелярита.',
        '- Никакого технического жаргона или комментариев от себя в тексте результата.',
        'Верни строго JSON без markdown-обёртки:',
        '{"titleSuggestion":"короткий заголовок без кавычек","formattedText":"готовый Markdown","extractedTasks":["задача 1"],"summary":"1 фраза о главном"}',
      ].join('\n');

  try {
    const res = await callFlashLiteJson({
      provider: route.provider,
      apiKey: route.apiKey,
      cloudProxy: route.proxy,
      accessToken: route.accessToken,
      systemPrompt,
      userPrompt: secretMask.masked,
      maxTokens: 1600,
      fetchFn: params.fetchFn,
    });

    if (params.repo) {
      params.repo.logAiUsage(
        route.provider,
        res.model,
        res.inputTokens,
        res.outputTokens,
        res.costUsd
      );
    }

    const parsed = res.parsed;
    const rawFormatted =
      typeof parsed?.formattedText === 'string' && parsed.formattedText.trim()
        ? parsed.formattedText.trim()
        : '';

    if (!rawFormatted) return local;

    // If cloud dropped any masked secret placeholder, fall back locally so user data is never lost
    for (let i = 0; i < secretMask.secrets.length; i++) {
      if (!rawFormatted.includes(`[REDACTED_SECRET_${i}]`)) {
        return local;
      }
    }

    const formatted = restoreInlineSecrets(rawFormatted, secretMask.secrets);

    const tasks = Array.isArray(parsed?.extractedTasks)
      ? parsed.extractedTasks
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => restoreInlineSecrets(t.trim(), secretMask.secrets))
      : extractTaskCandidates(formatted).tasks;

    const titleSuggestion =
      typeof parsed?.titleSuggestion === 'string' && parsed.titleSuggestion.trim()
        ? restoreInlineSecrets(parsed.titleSuggestion.trim(), secretMask.secrets).slice(0, 70)
        : local.titleSuggestion;

    const summary =
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? restoreInlineSecrets(parsed.summary.trim(), secretMask.secrets)
        : local.summary;

    return {
      titleSuggestion,
      formattedText: formatted,
      extractedTasks: tasks,
      summary,
      usedCloud: true,
    };
  } catch {
    return local;
  }
}
