import type { TaskBoardColumn, TaskBoardItemMeta, TaskPriority } from './types';

export type TaskColumnIconId =
  | 'tray'
  | 'flame'
  | 'clock'
  | 'check'
  | 'star'
  | 'flag'
  | 'lightning'
  | 'folder'
  | 'bookmark'
  | 'sparkles'
  | 'none';

export const TASK_COLUMN_ICONS: Array<{ id: TaskColumnIconId; label: string }> = [
  { id: 'tray', label: 'Входящие' },
  { id: 'flame', label: 'В работе' },
  { id: 'clock', label: 'Ожидание' },
  { id: 'check', label: 'Готово' },
  { id: 'star', label: 'Важное' },
  { id: 'flag', label: 'Приоритет' },
  { id: 'lightning', label: 'Срочно' },
  { id: 'folder', label: 'Проект' },
  { id: 'bookmark', label: 'Закладка' },
  { id: 'sparkles', label: 'Идеи' },
  { id: 'none', label: 'Без иконки' },
];

export const DEFAULT_TASK_BOARD_COLUMNS: TaskBoardColumn[] = [
  { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0, icon: 'tray' },
  { id: 'in_progress', title: 'В работе', color: '#E86A33', order: 1, icon: 'flame' },
  { id: 'waiting', title: 'Жду', color: '#F5A524', order: 2, icon: 'clock' },
  { id: 'done', title: 'Готово', color: '#2EA06B', order: 3, isDone: true, icon: 'check' },
];

const VALID_COLUMN_ICON_IDS = new Set<string>(TASK_COLUMN_ICONS.map((entry) => entry.id));

export function getDefaultColumnIcon(columnId: string, isDone?: boolean): TaskColumnIconId {
  if (columnId === 'inbox') return 'tray';
  if (columnId === 'in_progress') return 'flame';
  if (columnId === 'waiting') return 'clock';
  if (columnId === 'done' || isDone) return 'check';
  return 'folder';
}

export function resolveColumnIconId(
  icon: string | undefined,
  columnId: string,
  isDone?: boolean
): TaskColumnIconId {
  if (icon && VALID_COLUMN_ICON_IDS.has(icon)) {
    return icon as TaskColumnIconId;
  }
  return getDefaultColumnIcon(columnId, isDone);
}

const INLINE_MD_IMAGE_RE = /!\[[^\]]*\]\((?:kapsula-media:\/\/[^)\s]+|[^)\s]+)\)/gi;
const RAW_KAPSULA_MEDIA_URI_RE = /kapsula-media:\/\/[^\s)\]]+/gi;

/**
 * Strips inline Markdown image embeds (`![alt](kapsula-media://...)` and generic `![alt](url)`)
 * as well as stray raw `kapsula-media://` URIs so internal media links never leak onto Kanban or task cards.
 */
export function stripInlineMarkdownImages(raw: string): string {
  return (raw || '')
    .replace(INLINE_MD_IMAGE_RE, ' ')
    .replace(RAW_KAPSULA_MEDIA_URI_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeTaskSourceComparison(raw: string): string {
  return stripInlineMarkdownImages(raw || '')
    .toLowerCase()
    .replace(/…|\.\.\./g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true when a task belongs to a standalone single-task note whose title
 * mirrors the task text itself — used to suppress redundant self-referencing source chips.
 */
export function isStandaloneTaskSource(
  task: { itemTitle: string; text: string; sourceType: 'markdown' | 'voice_action' },
  tasksInSameItemCount: number
): boolean {
  if (task.sourceType !== 'markdown') return false;
  if (tasksInSameItemCount > 1) return false;
  const normTitle = normalizeTaskSourceComparison(task.itemTitle);
  const normTask = normalizeTaskSourceComparison(task.text);
  if (!normTitle || !normTask) return true;
  if (normTitle === normTask) return true;
  const minLen = Math.min(normTitle.length, normTask.length);
  if (minLen >= 16 && (normTask.startsWith(normTitle) || normTitle.startsWith(normTask))) {
    return true;
  }
  if (normTitle.length >= 24 && normTask.length >= 24 && normTitle.slice(0, 24) === normTask.slice(0, 24)) {
    return true;
  }
  return false;
}

export interface ParsedMarkdownTask {
  index: number;
  lineIndex: number;
  text: string;
  done: boolean;
  taskKey: string;
  textHash: string;
}

export interface ReconcilableTaskInput {
  taskKey: string;
  text: string;
  done: boolean;
  textHash?: string;
}

const MARKDOWN_TASK_RE = /^(\s*[-*•]\s+)(?:\\\[|\[)([ xX])(?:\\\]|\])(\s+)(.+)$/;
const FENCE_RE = /^\s*(```|~~~)/;

const VALID_PRIORITIES = new Set<TaskPriority>(['none', 'low', 'medium', 'high', 'urgent']);

/**
 * Computes a stable, deterministic hash for task text reconciliation across edits.
 * Uses dual 32-bit FNV-1a over normalized (lowercase, whitespace-collapsed) text.
 */
export function normalizeTaskTextHash(text: string): string {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code ^ ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Parses Markdown task list items (`- [ ]`, `* [x]`, `• [X]`, including escaped `\[ \]`)
 * while ignoring fenced code blocks (` ``` ` and `~~~`).
 */
export function parseMarkdownTasks(body: string): ParsedMarkdownTask[] {
  const lines = (body || '').split(/\r?\n/);
  const tasks: ParsedMarkdownTask[] = [];
  let activeFence: string | null = null;
  let index = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!activeFence) {
        activeFence = marker;
      } else if (activeFence === marker) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence) continue;

    const match = MARKDOWN_TASK_RE.exec(line);
    if (!match) continue;

    const text = stripInlineMarkdownImages(match[4] ?? '');
    if (!text) continue;

    tasks.push({
      index,
      lineIndex,
      text,
      done: (match[2] ?? '').toLowerCase() === 'x',
      taskKey: `md:${index}`,
      textHash: normalizeTaskTextHash(text),
    });
    index += 1;
  }

  return tasks;
}

/**
 * Toggles a single Markdown task line by its parsed task index while preserving
 * indentation, bullet symbol, and fenced code blocks.
 */
export function toggleMarkdownTaskInBody(
  body: string,
  taskIndex: number,
  nextDone?: boolean
): { body: string; done: boolean } | null {
  const tasks = parseMarkdownTasks(body);
  const target = tasks.find((t) => t.index === taskIndex);
  if (!target) return null;

  const lines = (body || '').split(/\r?\n/);
  const rawLine = lines[target.lineIndex];
  if (typeof rawLine !== 'string') return null;

  const match = MARKDOWN_TASK_RE.exec(rawLine);
  if (!match) return null;

  const resolvedDone = typeof nextDone === 'boolean' ? nextDone : !target.done;
  const mark = resolvedDone ? 'x' : ' ';
  lines[target.lineIndex] = `${match[1]}[${mark}]${match[3]}${match[4]}`;
  return {
    body: lines.join('\n'),
    done: resolvedDone,
  };
}

/**
 * Returns true if the specified column represents a completed ("Done") stage.
 */
export function isDoneColumn(
  columnId: string,
  columns: TaskBoardColumn[] = DEFAULT_TASK_BOARD_COLUMNS
): boolean {
  const effectiveCols = columns.length > 0 ? columns : DEFAULT_TASK_BOARD_COLUMNS;
  const found = effectiveCols.find((c) => c.id === columnId);
  if (!found) return columnId === 'done';
  return Boolean(found.isDone || found.id === 'done');
}

function parseNumericSuffix(taskKey: string): number {
  const colonIdx = taskKey.lastIndexOf(':');
  if (colonIdx < 0) return -1;
  const num = Number(taskKey.slice(colonIdx + 1));
  return Number.isFinite(num) ? num : -1;
}

function sanitizePriority(priority: unknown): TaskPriority {
  return typeof priority === 'string' && VALID_PRIORITIES.has(priority as TaskPriority)
    ? (priority as TaskPriority)
    : 'none';
}

/**
 * Reconciles per-task Kanban board metadata against a current list of parsed tasks:
 * 1. Matches unchanged tasks by exact `taskKey` + `textHash`.
 * 2. Matches relocated/reordered tasks by `textHash` (preferring nearest index when duplicates exist).
 * 3. Falls back to unclaimed `taskKey` (handles in-place text edits without losing column/priority).
 * 4. Enforces valid column IDs and the Done ↔ Done-Column invariant cleanly.
 */
export function reconcileTaskMeta(
  tasks: ReconcilableTaskInput[],
  existingTaskMeta?: Record<string, TaskBoardItemMeta> | null,
  columns: TaskBoardColumn[] = DEFAULT_TASK_BOARD_COLUMNS
): Record<string, TaskBoardItemMeta> {
  const effectiveCols = columns.length > 0 ? columns : DEFAULT_TASK_BOARD_COLUMNS;
  const sortedCols = [...effectiveCols].sort((a, b) => a.order - b.order);

  const columnIds = new Set(sortedCols.map((c) => c.id));
  const doneColumnIds = new Set(
    sortedCols.filter((c) => c.isDone || c.id === 'done').map((c) => c.id)
  );
  const doneColId =
    sortedCols.find((c) => c.isDone)?.id ??
    sortedCols.find((c) => c.id === 'done')?.id ??
    'done';
  const inboxColId =
    sortedCols.find((c) => !doneColumnIds.has(c.id))?.id ??
    sortedCols[0]?.id ??
    'inbox';

  const existingEntries = existingTaskMeta ? Object.entries(existingTaskMeta) : [];
  const existingMap = new Map<string, TaskBoardItemMeta>(existingEntries);
  const usedOldKeys = new Set<string>();
  const matchedMeta = new Array<TaskBoardItemMeta | null>(tasks.length).fill(null);
  const taskHashes = tasks.map((t) => t.textHash || normalizeTaskTextHash(t.text));

  // Pass 1: exact taskKey + matching textHash (or legacy meta without textHash)
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const prev = existingMap.get(task.taskKey);
    if (!prev) continue;
    if (!prev.textHash || prev.textHash === taskHashes[i]) {
      matchedMeta[i] = prev;
      usedOldKeys.add(task.taskKey);
    }
  }

  // Pass 2: match shifted/reordered tasks by textHash (closest original index wins)
  for (let i = 0; i < tasks.length; i += 1) {
    if (matchedMeta[i]) continue;
    const targetHash = taskHashes[i]!;
    const targetNum = parseNumericSuffix(tasks[i]!.taskKey);

    let bestKey: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [oldKey, meta] of existingEntries) {
      if (usedOldKeys.has(oldKey)) continue;
      if (!meta.textHash || meta.textHash !== targetHash) continue;
      const oldNum = parseNumericSuffix(oldKey);
      const dist =
        targetNum >= 0 && oldNum >= 0 ? Math.abs(targetNum - oldNum) : Number.MAX_SAFE_INTEGER;
      if (dist < bestDistance) {
        bestDistance = dist;
        bestKey = oldKey;
      }
    }

    if (bestKey) {
      matchedMeta[i] = existingMap.get(bestKey) ?? null;
      usedOldKeys.add(bestKey);
    }
  }

  // Pass 3: in-place text edit fallback (inherit unclaimed meta at exact same taskKey)
  for (let i = 0; i < tasks.length; i += 1) {
    if (matchedMeta[i]) continue;
    const task = tasks[i]!;
    if (!usedOldKeys.has(task.taskKey) && existingMap.has(task.taskKey)) {
      matchedMeta[i] = existingMap.get(task.taskKey) ?? null;
      usedOldKeys.add(task.taskKey);
    }
  }

  const result: Record<string, TaskBoardItemMeta> = {};

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const hash = taskHashes[i]!;
    const base = matchedMeta[i];

    const validPrevCol =
      base?.prevColumnId &&
      columnIds.has(base.prevColumnId) &&
      !doneColumnIds.has(base.prevColumnId)
        ? base.prevColumnId
        : undefined;

    const rawCol = base?.columnId && columnIds.has(base.columnId) ? base.columnId : undefined;

    let finalColumnId: string;
    let finalPrevColumnId: string | undefined = validPrevCol;

    if (task.done) {
      if (rawCol && doneColumnIds.has(rawCol)) {
        finalColumnId = rawCol;
      } else {
        if (rawCol && !doneColumnIds.has(rawCol)) {
          finalPrevColumnId = rawCol;
        }
        finalColumnId = doneColId;
      }
    } else {
      if (rawCol && !doneColumnIds.has(rawCol)) {
        finalColumnId = rawCol;
      } else {
        finalColumnId = validPrevCol ?? inboxColId;
      }
    }

    const boardOrder =
      typeof base?.boardOrder === 'number' && Number.isFinite(base.boardOrder)
        ? base.boardOrder
        : i * 1000;

    const entry: TaskBoardItemMeta = {
      columnId: finalColumnId,
      ...(finalPrevColumnId ? { prevColumnId: finalPrevColumnId } : {}),
      boardOrder,
      priority: sanitizePriority(base?.priority),
      dueAt: typeof base?.dueAt === 'number' && Number.isFinite(base.dueAt) ? base.dueAt : null,
      textHash: hash,
    };

    result[task.taskKey] = entry;
  }

  return result;
}

/**
 * Extracts unique `[[Title]]` wiki-link target titles from Markdown body text.
 * Ignores fenced code blocks (` ``` ` / `~~~`), inline code spans (`` `...` ``),
 * and backslash-escaped brackets (`\[[Title]]`).
 * Supports alias syntax `[[Target Title|Label]]` (returns `Target Title`).
 */
export function extractWikiLinkTitles(body: string | null | undefined): string[] {
  if (!body || !body.includes('[[')) return [];

  const lines = body.split(/\r?\n/);
  const seenLower = new Set<string>();
  const titles: string[] = [];
  let activeFence: string | null = null;

  for (const rawLine of lines) {
    const fenceMatch = FENCE_RE.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!activeFence) {
        activeFence = marker;
      } else if (activeFence === marker) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence) continue;

    // Strip inline code spans (`...` or ``...``) cleanly on this line
    const withoutInlineCode = rawLine.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));

    let pos = 0;
    while (pos < withoutInlineCode.length) {
      const openIdx = withoutInlineCode.indexOf('[[', pos);
      if (openIdx < 0) break;

      // Count preceding backslashes; odd count means escaped (e.g. `\[[Title]]`)
      let backslashes = 0;
      for (let k = openIdx - 1; k >= 0 && withoutInlineCode[k] === '\\'; k -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 1) {
        pos = openIdx + 2;
        continue;
      }

      const closeIdx = withoutInlineCode.indexOf(']]', openIdx + 2);
      if (closeIdx < 0) break;

      const rawInner = withoutInlineCode.slice(openIdx + 2, closeIdx);
      pos = closeIdx + 2;

      // Ignore nested brackets or empty tokens
      if (!rawInner || rawInner.includes('[') || rawInner.includes(']')) {
        continue;
      }

      const pipeIdx = rawInner.indexOf('|');
      const targetPart = pipeIdx >= 0 ? rawInner.slice(0, pipeIdx) : rawInner;
      const cleanTitle = targetPart.replace(/\\([[\]|])/g, '$1').trim();
      if (!cleanTitle) continue;

      const key = cleanTitle.toLowerCase();
      if (!seenLower.has(key)) {
        seenLower.add(key);
        titles.push(cleanTitle);
      }
    }
  }

  return titles;
}
