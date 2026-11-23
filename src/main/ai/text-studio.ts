import { DEFAULT_MONTHLY_CAP_USD } from '@shared/constants';
import type {
  AiProvider,
  AppLocale,
  TextTransformPreset,
  TextTransformResult,
} from '@shared/types';
import type { VaultRepository } from '../db/repository';
import { analyzeForSecret, detectCardBrand, passesLuhn, redactSecrets } from '../security/secret-shield';
import type { FetchLike } from './decision-router';
import { resolveAiRoute, type CloudAiProxyConfig } from './cloud-proxy';
import { callFlashLiteJson } from './enricher';

const ACTION_VERB_RE =
  /^(?:купить|заказать|позвонить|написать|отправить|сделать|проверить|оплатить|настроить|подготовить|добавить|обновить|прочитать|встретиться|созвониться|уточнить|забрать|посмотреть|изучить|доделать|исправить|перенести|напомнить|создать|удалить|починить|найти|выбрать|сравнить|согласовать|протестировать|выложить|опубликовать|todo|fix|check|send|buy|call|write|review|update|deploy|test|ask)(?=$|[\s,.;:!?—-])/iu;

const TASK_PREFIX_RE = /^(?:надо|нужно|не забыть)\s+/i;
const CHECKBOX_TASK_RE = /^\s*[-*•]\s*\\?\[([ xX])\\?\]\s+(.+)$/;
const PLAIN_LIST_ITEM_RE = /^\s*([-*•]|\d+[.)])\s+(.+)$/;
const TASKS_HEADING_RE = /^##\s+(?:Задачи|Tasks)\s*$/i;

const PRESET_ORDER: readonly TextTransformPreset[] = ['summary', 'structure', 'tasks', 'polish'];

interface ExtractedTaskEntry {
  text: string;
  done: boolean;
}

function normalizePresets(presetOrPresets?: TextTransformPreset | TextTransformPreset[]): TextTransformPreset[] {
  const rawList = Array.isArray(presetOrPresets)
    ? presetOrPresets
    : presetOrPresets
      ? [presetOrPresets]
      : ['structure' as TextTransformPreset];
  const validSet = new Set<TextTransformPreset>();
  for (const p of rawList) {
    if (p === 'structure' || p === 'tasks' || p === 'polish' || p === 'summary') {
      validSet.add(p);
    }
  }
  if (validSet.size === 0) return ['structure'];
  return PRESET_ORDER.filter((p) => validSet.has(p));
}

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
  masked = masked.replace(/!\[[^\]]*\]\([^)\n]+\)/g, (m) => stash(m));
  masked = masked.replace(/\[\[[^\]\n]+\]\]/g, (m) => stash(m));
  masked = masked.replace(/\[[^\]]+\]\([^)\n]+\)/g, (m) => stash(m));
  masked = masked.replace(/kapsula-media:\/\/[^\s)<>\]"']+/gi, (m) => stash(m));
  masked = masked.replace(/https?:\/\/[^\s)<>\]"']+/gi, (m) => stash(m));
  return { masked, tokens };
}

function applyRussianTypography(raw: string): string {
  const { masked, tokens } = protectCodeAndUrls(raw);

  let out = masked
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([^\s\n])[ \t]{2,}/g, '$1 ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])([^\s\n\d"')»\]}*_])/g, '$1 $2')
    .replace(/(?<=[^\s\n])[ \t]+--?[ \t]+/g, ' — ')
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
    .replace(/!\[[^\]]*\]\([^)\n]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)\n]+\)/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
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

function extractTaskCandidates(raw: string): {
  tasks: string[];
  taskEntries: ExtractedTaskEntry[];
  contextLines: string[];
} {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const rawLines = normalized.split('\n');

  const taskEntries: ExtractedTaskEntry[] = [];
  const contextLines: string[] = [];
  let inFence = false;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();

    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      contextLines.push(inFence ? line : rawLine.trimEnd());
      continue;
    }
    if (inFence) {
      contextLines.push(rawLine.trimEnd());
      continue;
    }

    if (!line) {
      if (contextLines.length > 0 && contextLines[contextLines.length - 1] !== '') {
        contextLines.push('');
      }
      continue;
    }

    // 1. Explicit checkbox tasks (- [ ], - [x], - \[ \]) preserve checked state
    const checkboxMatch = CHECKBOX_TASK_RE.exec(line);
    if (checkboxMatch?.[2]) {
      const done = (checkboxMatch[1] ?? '').toLowerCase() === 'x';
      const candidate = applyRussianTypography(checkboxMatch[2].trim());
      if (candidate) {
        taskEntries.push({ text: candidate, done });
      }
      continue;
    }

    // 2. Plain bullet or numbered list item: ONLY treat as a task if it starts with an action verb / prefix
    const plainListMatch = PLAIN_LIST_ITEM_RE.exec(line);
    if (plainListMatch?.[1] && plainListMatch[2]) {
      const prefix = plainListMatch[1];
      const itemText = plainListMatch[2].trim();
      if (ACTION_VERB_RE.test(itemText) || TASK_PREFIX_RE.test(itemText)) {
        const cleaned = itemText.replace(TASK_PREFIX_RE, '').trim();
        const candidate = applyRussianTypography(cleaned);
        if (candidate) {
          taskEntries.push({ text: candidate, done: false });
          continue;
        }
      }
      // Informational bullet / numbered point stays in contextLines untouched as a normal list item
      contextLines.push(`${prefix} ${itemText}`);
      continue;
    }

    // 3. Structural Markdown lines (headings, blockquotes, rules, standalone images/links) stay in context intact
    if (
      /^(?:#{1,6}\s|>\s*|(?:[-*_]\s*){3,}$|!\[[^\]]*\]\([^)\n]+\)$|\[\[[^\]\n]+\]\]$)/.test(line)
    ) {
      contextLines.push(line);
      continue;
    }

    // 4. Prose line: mask code/URLs/links/images before splitting into clauses for action detection
    const { masked, tokens } = protectCodeAndUrls(line);
    const parts = masked
      .split(/(?<=[.!?])\s+|;\s+/)
      .map((p) => restoreTokens(p, tokens).trim())
      .filter(Boolean);

    let lineHadTask = false;
    const nonTaskParts: string[] = [];
    for (const part of parts) {
      const bare = part.replace(/[.]+$/, '').trim();
      if (ACTION_VERB_RE.test(bare) || TASK_PREFIX_RE.test(bare)) {
        const cleaned = bare.replace(TASK_PREFIX_RE, '').trim();
        const nice = applyRussianTypography(cleaned);
        if (nice) {
          taskEntries.push({ text: nice, done: false });
          lineHadTask = true;
          continue;
        }
      }
      nonTaskParts.push(part);
    }

    if (!lineHadTask) {
      contextLines.push(line);
    } else if (nonTaskParts.length > 0) {
      contextLines.push(nonTaskParts.join(' '));
    }
  }

  return {
    tasks: taskEntries.map((entry) => entry.text),
    taskEntries,
    contextLines,
  };
}

function joinContextLinesCleanly(lines: string[]): string {
  const cleaned: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
        cleaned.push('');
      }
      continue;
    }
    cleaned.push(line);
  }
  while (cleaned.length > 0 && cleaned[0] === '') cleaned.shift();
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned.join('\n');
}

function splitLongProseIntoParagraphs(text: string): string {
  const { masked, tokens } = protectCodeAndUrls(text);
  const blocks = masked.split(/\n{2,}/);
  const rebuilt: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Leave headings, lists, quotes, or token lines untouched
    if (/^(?:#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s|\{\{KAPSULA_TOKEN_)/m.test(trimmed)) {
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

function preserveLocalMediaAssets(originalText: string, candidateText: string): string {
  let out = candidateText.replace(/(kapsula-media:)\s+(\/\/)/gi, '$1$2');
  const assetTokens: Array<{ token: string; url: string }> = [];
  const seenUrls = new Set<string>();

  for (const m of originalText.matchAll(/!\[[^\]]*\]\((kapsula-media:\/\/[^)\n]+)\)/gi)) {
    const token = m[0];
    const url = m[1] ?? '';
    if (url && !seenUrls.has(url)) {
      seenUrls.add(url);
      assetTokens.push({ token, url });
    }
  }

  for (const m of originalText.matchAll(/kapsula-media:\/\/[^\s)<>\]"']+/gi)) {
    const url = m[0];
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      assetTokens.push({ token: url, url });
    }
  }

  const missing = assetTokens
    .filter((entry) => !out.includes(entry.url))
    .map((entry) => entry.token);

  if (missing.length === 0) return out;
  return `${out.trimEnd()}\n\n${missing.join('\n')}`.trim();
}

function preserveWikiLinks(originalText: string, candidateText: string): string {
  let out = candidateText;
  const wikiMatches = originalText.match(/\[\[[^\]\n]+\]\]/g) ?? [];
  for (const token of wikiMatches) {
    if (out.includes(token)) continue;
    const inner = token.slice(2, -2).trim();
    if (!inner || inner.length < 2) continue;
    const escaped = inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plainRe = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`);
    if (plainRe.test(out)) {
      out = out.replace(plainRe, token);
    }
  }
  return out;
}

function extractSummaryPieces(text: string): { summaryText: string; keyLines: string[] } {
  const sentences = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)\n]+\)/g, '')
    .replace(/^>\s*\*\*(?:Главное|TL;DR):\*\*\s*/gim, '')
    .replace(/^#+\s*/gm, '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•]\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter((s) => s.length >= 6);

  const keyLines = sentences.slice(0, 4);
  const summaryText = keyLines.slice(0, 2).join(' ');
  return { summaryText, keyLines };
}

function renderTaskEntry(entry: ExtractedTaskEntry): string {
  return entry.done ? `- [x] ${entry.text}` : `- [ ] ${entry.text}`;
}

function splitProseAndCode(contextLines: string[]): { proseContext: string[]; codeBlocks: string[] } {
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
  return { proseContext, codeBlocks };
}

function applyTasksFormatting(
  working: string,
  allowLineFallback: boolean,
  withStructure: boolean,
  isEn: boolean
): { formattedText: string; extractedTasks: string[] } {
  const { taskEntries, contextLines } = extractTaskCandidates(working);
  const { proseContext, codeBlocks } = splitProseAndCode(contextLines);

  if (taskEntries.length === 0 && allowLineFallback) {
    const preservedContext: string[] = [];
    const fallbackTasks: ExtractedTaskEntry[] = [];
    let inFence = false;
    for (const rawLine of working.replace(/\r\n/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('```') || line.startsWith('~~~')) {
        inFence = !inFence;
        preservedContext.push(rawLine.trimEnd());
        continue;
      }
      if (inFence) {
        preservedContext.push(rawLine.trimEnd());
        continue;
      }
      if (!line) continue;
      if (/^(?:!\[[^\]]*\]\([^)\n]+\)|#{1,6}\s|>\s*|\[\[[^\]\n]+\]\]$)/.test(line)) {
        preservedContext.push(line);
        continue;
      }
      const { masked, tokens } = protectCodeAndUrls(line);
      for (const piece of masked.split(/(?<=[.!?])\s+|;\s+/)) {
        const restored = restoreTokens(piece, tokens)
          .replace(/^[-*•\d.)]+\s*/, '')
          .trim();
        const nice = applyRussianTypography(restored);
        if (nice) fallbackTasks.push({ text: nice, done: false });
      }
    }

    const parts: string[] = [];
    const contextText = joinContextLinesCleanly(preservedContext);
    if (contextText) parts.push(contextText);
    if (fallbackTasks.length > 0) {
      const checklist = fallbackTasks.map(renderTaskEntry).join('\n');
      parts.push(withStructure ? `${isEn ? '## Tasks' : '## Задачи'}\n${checklist}` : checklist);
    }
    return {
      formattedText: parts.join('\n\n').trim() || working,
      extractedTasks: fallbackTasks.map((t) => t.text),
    };
  }

  // Strip trailing standalone ## Задачи / ## Tasks from proseContext so it is never duplicated
  const trimmedProse = [...proseContext];
  while (trimmedProse.length > 0 && trimmedProse[trimmedProse.length - 1] === '') {
    trimmedProse.pop();
  }
  let hadExistingTasksHeading = false;
  const lastProse = trimmedProse[trimmedProse.length - 1];
  if (lastProse !== undefined && TASKS_HEADING_RE.test(lastProse)) {
    trimmedProse.pop();
    hadExistingTasksHeading = true;
    while (trimmedProse.length > 0 && trimmedProse[trimmedProse.length - 1] === '') {
      trimmedProse.pop();
    }
  }

  const proseJoined = joinContextLinesCleanly(trimmedProse);
  const structuredProse = proseJoined ? splitLongProseIntoParagraphs(proseJoined) : '';
  const nonEmptyLinesCount = working
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;

  if (taskEntries.length === 0 && codeBlocks.length === 0) {
    const plainFormatted = splitLongProseIntoParagraphs(working);
    return { formattedText: plainFormatted || working, extractedTasks: [] };
  }

  const sections: string[] = [];
  if (structuredProse) sections.push(structuredProse);
  if (taskEntries.length > 0) {
    const checklist = taskEntries.map(renderTaskEntry).join('\n');
    const shouldAddTasksHeading =
      withStructure &&
      (hadExistingTasksHeading ||
        Boolean(structuredProse) ||
        codeBlocks.length > 0 ||
        nonEmptyLinesCount >= 3);
    sections.push(
      shouldAddTasksHeading ? `${isEn ? '## Tasks' : '## Задачи'}\n${checklist}` : checklist
    );
  }
  if (codeBlocks.length > 0) {
    sections.push(codeBlocks.join('\n\n'));
  }

  return {
    formattedText: sections.join('\n\n').trim() || working,
    extractedTasks: taskEntries.map((t) => t.text),
  };
}

export function formatNoteLocally(
  rawText: string,
  presetOrPresets: TextTransformPreset | TextTransformPreset[],
  locale: AppLocale = 'ru'
): TextTransformResult {
  const raw = rawText.trim();
  if (!raw) {
    return { formattedText: '', extractedTasks: [], usedCloud: false, changed: false };
  }

  const presets = normalizePresets(presetOrPresets);
  const hasPolish = presets.includes('polish');
  const hasStructure = presets.includes('structure');
  const hasTasks = presets.includes('tasks');
  const hasSummary = presets.includes('summary');

  const isEn = locale === 'en';
  const titleSuggestion = deriveTitleSuggestion(raw);

  // Summary-only mode
  if (hasSummary && !hasPolish && !hasStructure && !hasTasks) {
    const clean = applyRussianTypography(raw);
    const { taskEntries, tasks } = extractTaskCandidates(clean);
    const { summaryText, keyLines } = extractSummaryPieces(clean);

    if (/^>\s*\*\*(?:Главное|TL;DR):\*\*/i.test(clean)) {
      return {
        titleSuggestion,
        formattedText: clean,
        extractedTasks: tasks,
        summary: summaryText || titleSuggestion,
        usedCloud: false,
        changed: clean.trim() !== raw,
      };
    }

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
    if (taskEntries.length > 0) {
      blocks.push(
        (isEn ? '## Next Steps\n' : '## Следующие шаги\n') +
          taskEntries.map(renderTaskEntry).join('\n')
      );
    }

    const formattedText = preserveLocalMediaAssets(raw, blocks.join('\n\n').trim() || clean);
    return {
      titleSuggestion,
      formattedText,
      extractedTasks: tasks,
      summary: summaryText || titleSuggestion,
      usedCloud: false,
      changed: formattedText.trim() !== raw,
    };
  }

  // Body transformation pipeline: polish -> structure / tasks -> optional prepended summary
  let working = hasPolish || hasStructure ? applyRussianTypography(raw) : raw;
  let extractedTasks: string[] = extractTaskCandidates(working).tasks;

  if (hasStructure || hasTasks) {
    const bodyRes = applyTasksFormatting(working, hasTasks, hasStructure, isEn);
    working = bodyRes.formattedText;
    extractedTasks = bodyRes.extractedTasks;
  }

  let summary: string | undefined;
  if (hasSummary) {
    const { summaryText } = extractSummaryPieces(working);
    summary = summaryText || titleSuggestion;
    if (summaryText && !/^>\s*\*\*(?:Главное|TL;DR):\*\*/i.test(working.trim())) {
      const callout = isEn ? `> **TL;DR:** ${summaryText}` : `> **Главное:** ${summaryText}`;
      working = `${callout}\n\n${working}`;
    }
  }

  const finalFormatted = preserveLocalMediaAssets(raw, working).trim() || raw;
  return {
    titleSuggestion,
    formattedText: finalFormatted,
    extractedTasks,
    ...(summary ? { summary } : {}),
    usedCloud: false,
    changed: finalFormatted.trim() !== raw,
  };
}

const PRESET_PROMPT_RULES_RU: Record<TextTransformPreset, string> = {
  polish:
    'Исправь только опечатки, слова-паразиты, лишние пробелы и причёши русскую пунктуацию и типографику (кавычки «ёлочки», длинное тире —). Исходный тон, факты, списки и структуру сохрани без переписывания.',
  structure:
    'Аккуратно оформи абзацы и списки; НЕ добавляй заголовки `## ...` в коротких однотемных заметках (< 3 строк); сохрани все факты, обычные информационные пункты (не превращай их в задачи) и уже отмеченные чекбоксы `- [x]`.',
  tasks:
    'Выдели из текста все реальные действия, договорённости и дела в чёткий список `- [ ] ...`, сохраняя уже выполненные `- [x] ...` и краткий контекст.',
  summary:
    'Собери суть текста в короткую выжимку `> **Главное:** ...` сверху, затем ключевые тезисы списком `- ...` и при наличии — шаги `- [ ] ...`.',
};

const PRESET_PROMPT_RULES_EN: Record<TextTransformPreset, string> = {
  polish:
    'Fix ONLY typos, filler words, awkward spacing, and punctuation cleanly. Preserve the original tone, facts, lists, and structure.',
  structure:
    'Format paragraphs and lists cleanly; do NOT add `##` headings to short single-topic notes (< 3 lines); preserve all facts, ordinary informational bullets (do not force them into tasks), and completed `- [x]` checkboxes.',
  tasks:
    'Extract actionable items, commitments, and next steps into `- [ ] ...` checkboxes while preserving completed `- [x] ...` checkboxes and brief context.',
  summary:
    'Distill the essence concisely: start with `> **TL;DR:** ...`, then key bullet points `- ...`, and if applicable `- [ ] ...` next steps.',
};

function buildCombinedPromptRules(presets: TextTransformPreset[], isEn: boolean): string {
  const dict = isEn ? PRESET_PROMPT_RULES_EN : PRESET_PROMPT_RULES_RU;
  const hasSummary = presets.includes('summary');
  const hasOther = presets.some((p) => p !== 'summary');

  const lines: string[] = [];
  for (const preset of presets) {
    if (preset === 'summary' && hasOther) {
      lines.push(
        isEn
          ? '- Add a concise `> **TL;DR:** ...` callout (1-2 sentences) at the very top, AND keep the full processed note body below it without discarding user content!'
          : '- Добавь в самое начало лаконичную цитату `> **Главное:** ...` (1–2 фразы), и обязательно сохрани весь обработанный текст заметки ниже неё, ничего не выбрасывая!'
      );
    } else if (hasSummary && !hasOther) {
      lines.push(`- ${dict[preset]}`);
    } else {
      lines.push(`- ${dict[preset]}`);
    }
  }
  return lines.join('\n');
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
  preset?: TextTransformPreset;
  presets?: TextTransformPreset[];
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
  const presets = normalizePresets(params.presets?.length ? params.presets : params.preset);
  const local = formatNoteLocally(params.text, presets, locale);
  if (!params.text.trim()) {
    return { ...local, changed: false, fallbackReason: null };
  }

  const route = await resolveAiRoute({
    provider: params.provider,
    apiKey: params.apiKey,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });

  if (route.mode === 'local' || route.provider === 'local') {
    return { ...local, fallbackReason: 'no_ai_key' };
  }

  // CRITICAL SECURITY GATE: Never transmit raw passwords, API keys, bank cards, or seed phrases to cloud AI
  const secretMask = maskInlineSecretsForCloud(params.text.slice(0, 12000));
  if (!secretMask.safeForCloud) {
    return { ...local, fallbackReason: 'secret_detected' };
  }

  if (params.repo && route.mode === 'personal') {
    const budget = params.repo.getMonthBudgetSummary(
      route.provider,
      params.capUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    if (budget.limitReached) {
      return { ...local, fallbackReason: 'budget_limit' };
    }
  }

  const combinedRules = buildCombinedPromptRules(presets, isEn);
  const systemPrompt = isEn
    ? [
        'You are a personal notes editor inside Kapsula.',
        'SELECTED MODES (apply together cleanly):',
        combinedRules,
        'MANDATORY RULES:',
        '- Never invent facts, numbers, dates, or tasks that are not in the user text.',
        '- Apply the selected modes genuinely and noticeably so the note becomes cleaner, better structured, and easier to scan.',
        '- Preserve every `![...](kapsula-media://...)` image, URL, fenced code block, command, `[[WikiLink]]`, phone number, name, and `[REDACTED_SECRET_0]` token verbatim.',
        '- Write in crisp, natural English with zero boilerplate or meta commentary.',
        'Return strictly JSON without markdown fences:',
        '{"titleSuggestion":"short unquoted title","formattedText":"formatted Markdown","extractedTasks":["task 1"],"summary":"1 sentence TL;DR"}',
      ].join('\n')
    : [
        'Ты — редактор личных заметок в приложении Kapsula.',
        'ВЫБРАННЫЕ РЕЖИМЫ (примени их согласованно):',
        combinedRules,
        'ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:',
        '- Никогда не выдумывай новые факты, цифры, даты или задачи, которых нет у пользователя.',
        '- Обязательно реально улучши оформление текста согласно выбранным режимам: разбей сплошной поток на читаемые абзацы/списки, исправь опечатки и пунктуацию, не возвращай неряшливый текст без правок.',
        '- Сохраняй дословно каждое изображение `![...](kapsula-media://...)`, URL-ссылки, код в тройных бэктиках, команды, `[[WikiLink]]`, телефоны, имена и служебные маркеры вида `[REDACTED_SECRET_0]`.',
        '- Используй живую русскую типографику: кавычки «ёлочки» (не в коде), длинное тире —, без канцелярита.',
        '- Никакого технического жаргона или комментариев от себя в тексте результата.',
        'Верни строго JSON без markdown-обёртки:',
        '{"titleSuggestion":"короткий заголовок без кавычек","formattedText":"готовый Markdown","extractedTasks":["задача 1"],"summary":"1 фраза о главном"}',
      ].join('\n');

  const maxTokens = Math.min(4096, Math.max(1600, Math.ceil(params.text.length * 1.4)));

  try {
    const res = await callFlashLiteJson({
      provider: route.provider,
      apiKey: route.apiKey,
      cloudProxy: route.proxy,
      accessToken: route.accessToken,
      systemPrompt,
      userPrompt: secretMask.masked,
      maxTokens,
      fetchFn: params.fetchFn,
    });

    if (params.repo) {
      params.repo.logAiUsage(
        route.provider,
        res.model,
        res.inputTokens,
        res.outputTokens,
        res.costUsd,
        route.mode === 'cloud_proxy'
      );
    }

    const parsed = res.parsed;
    const rawFormatted =
      typeof parsed?.formattedText === 'string' && parsed.formattedText.trim()
        ? parsed.formattedText.trim()
        : '';

    if (!rawFormatted) {
      return {
        ...local,
        formattedText: params.text,
        changed: false,
        usedCloud: false,
        fallbackReason: 'cloud_error',
      };
    }

    // If cloud dropped any masked secret placeholder, fall back locally so user data is never lost
    for (let i = 0; i < secretMask.secrets.length; i++) {
      if (!rawFormatted.includes(`[REDACTED_SECRET_${i}]`)) {
        return {
          ...local,
          formattedText: params.text,
          changed: false,
          usedCloud: false,
          fallbackReason: 'cloud_error',
        };
      }
    }

    const unmasked = restoreInlineSecrets(rawFormatted, secretMask.secrets);
    const formatted = preserveWikiLinks(
      params.text,
      preserveLocalMediaAssets(params.text, unmasked)
    );

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
      changed: formatted.trim() !== params.text.trim(),
      fallbackReason: null,
    };
  } catch {
    return {
      ...local,
      formattedText: params.text,
      changed: false,
      usedCloud: false,
      fallbackReason: 'cloud_error',
    };
  }
}
