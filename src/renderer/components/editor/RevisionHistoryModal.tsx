import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowCounterClockwise,
  Check,
  ClockCounterClockwise,
  Copy,
  Desktop,
  WarningCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { ItemRevision, ItemRevisionSource } from '@shared/types';
import { decodeHtmlEntities } from '@shared/html-entities';
import { formatRelativeDate } from '../../lib/format';
import { ModalDialog } from '../ui/ModalDialog';
import { SegmentedControl } from '../ui/SegmentedControl';

interface RevisionHistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisions: ItemRevision[];
  currentTitle: string;
  currentBody: string;
  onRestore: (revisionId: string) => Promise<void> | void;
  onCopyText?: (text: string) => Promise<void> | void;
  restoringId?: string | null;
}

interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
  currentNo: number | null;
  revisionNo: number | null;
}

function getRevisionSourceMeta(source: ItemRevisionSource): {
  label: string;
  badgeClass: string;
  isConflict?: boolean;
} {
  switch (source) {
    case 'auto':
      return {
        label: 'Авто',
        badgeClass: 'bg-[var(--k-bg-surface-3)] text-[var(--k-ink-secondary)] border-[var(--k-border-hairline)]',
      };
    case 'beautify':
      return {
        label: 'До ИИ',
        badgeClass: 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] border-[var(--k-accent)]/30',
      };
    case 'dictate':
    case 'voice':
      return {
        label: 'До диктовки',
        badgeClass: 'bg-[var(--k-amber-soft)] text-[var(--k-amber)] border-[var(--k-amber)]/30',
      };
    case 'sync_conflict':
      return {
        label: 'Конфликт синхронизации',
        badgeClass: 'bg-[var(--k-danger-soft)] text-[var(--k-danger)] border-[var(--k-danger)]/35',
        isConflict: true,
      };
    case 'restore':
      return {
        label: 'До отката',
        badgeClass: 'bg-[var(--k-bg-surface-3)] text-[var(--k-ink-secondary)] border-[var(--k-border-hairline)]',
      };
    case 'manual':
    default:
      return {
        label: 'Вручную',
        badgeClass: 'bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] border-[var(--k-emerald)]/30',
      };
  }
}

function formatExactStamp(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: new Date(ms).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function splitLines(text: string): string[] {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  if (!normalized) return [];
  return normalized.split('\n');
}

function formatDiffDisplayLine(raw: string): string {
  return decodeHtmlEntities(raw || '')
    .replace(/\u00A0/g, ' ')
    .replace(
      /!\[([^\]]*)\]\((?:kapsula-media:\/\/local\/[^)\s]+|blob:[^)\s]+|data:image\/[^)\s]+)\)/gi,
      (_m, alt: string) => {
        const cleanAlt = (alt || '').trim();
        return cleanAlt ? `[Фото: ${cleanAlt}]` : '[Фото]';
      }
    )
    .replace(/\\([\\_*[\]()~`>#+=|{}.!-])/g, '$1');
}

/**
 * Computes a readable line-by-line diff transforming `currentBody` -> `revisionBody`.
 * - `add` (+ green): lines present in the selected historical version that will be restored
 * - `remove` (- red): lines present in the current note that will be replaced
 */
function computeLineDiff(
  currentBody: string,
  revisionBody: string
): { lines: DiffLine[]; added: number; removed: number } {
  const a = splitLines(currentBody);
  const b = splitLines(revisionBody);

  // Trim identical prefix & suffix to keep DP matrix tiny on typical edits
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    out.push({ type: 'same', text: a[i]!, currentNo: i + 1, revisionNo: i + 1 });
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  let added = 0;
  let removed = 0;

  if (midA.length * midB.length <= 240_000) {
    const n = midA.length;
    const m = midB.length;
    const cols = m + 1;
    const dp = new Uint32Array((n + 1) * cols);

    for (let i = n - 1; i >= 0; i -= 1) {
      const rowOffset = i * cols;
      const nextRowOffset = (i + 1) * cols;
      for (let j = m - 1; j >= 0; j -= 1) {
        if (midA[i] === midB[j]) {
          dp[rowOffset + j] = (dp[nextRowOffset + j + 1] ?? 0) + 1;
        } else {
          const down = dp[nextRowOffset + j] ?? 0;
          const right = dp[rowOffset + j + 1] ?? 0;
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({
          type: 'same',
          text: midA[i]!,
          currentNo: prefix + i + 1,
          revisionNo: prefix + j + 1,
        });
        i += 1;
        j += 1;
      } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + j + 1] ?? 0)) {
        out.push({
          type: 'remove',
          text: midA[i]!,
          currentNo: prefix + i + 1,
          revisionNo: null,
        });
        removed += 1;
        i += 1;
      } else {
        out.push({
          type: 'add',
          text: midB[j]!,
          currentNo: null,
          revisionNo: prefix + j + 1,
        });
        added += 1;
        j += 1;
      }
    }
    while (i < n) {
      out.push({
        type: 'remove',
        text: midA[i]!,
        currentNo: prefix + i + 1,
        revisionNo: null,
      });
      removed += 1;
      i += 1;
    }
    while (j < m) {
      out.push({
        type: 'add',
        text: midB[j]!,
        currentNo: null,
        revisionNo: prefix + j + 1,
      });
      added += 1;
      j += 1;
    }
  } else {
    // Fast linear fallback for unusually huge notes
    for (let i = 0; i < midA.length; i += 1) {
      out.push({
        type: 'remove',
        text: midA[i]!,
        currentNo: prefix + i + 1,
        revisionNo: null,
      });
      removed += 1;
    }
    for (let j = 0; j < midB.length; j += 1) {
      out.push({
        type: 'add',
        text: midB[j]!,
        currentNo: null,
        revisionNo: prefix + j + 1,
      });
      added += 1;
    }
  }

  const tailStartA = a.length - suffix;
  const tailStartB = b.length - suffix;
  for (let k = 0; k < suffix; k += 1) {
    out.push({
      type: 'same',
      text: a[tailStartA + k]!,
      currentNo: tailStartA + k + 1,
      revisionNo: tailStartB + k + 1,
    });
  }

  return { lines: out, added, removed };
}

export const RevisionHistoryModal: React.FC<RevisionHistoryModalProps> = ({
  open,
  onOpenChange,
  revisions,
  currentTitle,
  currentBody,
  onRestore,
  onCopyText,
  restoringId = null,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'diff' | 'full'>('diff');
  const [copiedJustNow, setCopiedJustNow] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (revisions.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !revisions.some((r) => r.id === selectedId)) {
      setSelectedId(revisions[0]!.id);
    }
  }, [open, revisions, selectedId]);

  const selectedRev = useMemo(
    () => revisions.find((r) => r.id === selectedId) ?? revisions[0] ?? null,
    [revisions, selectedId]
  );

  const diff = useMemo(() => {
    if (!selectedRev) return { lines: [] as DiffLine[], added: 0, removed: 0 };
    return computeLineDiff(currentBody, selectedRev.content || '');
  }, [currentBody, selectedRev]);

  const titleChanged = Boolean(
    selectedRev &&
      selectedRev.title &&
      selectedRev.title.trim() !== (currentTitle || '').trim()
  );

  const isIdentical = Boolean(
    selectedRev && diff.added === 0 && diff.removed === 0 && !titleChanged
  );

  const handleCopy = async () => {
    if (!selectedRev) return;
    const payload = selectedRev.content || '';
    try {
      if (onCopyText) {
        await onCopyText(payload);
      } else {
        await window.kapsula.copyText(payload);
      }
      setCopiedJustNow(true);
      toast.success('Текст версии скопирован');
      window.setTimeout(() => setCopiedJustNow(false), 1600);
    } catch {
      toast.error('Не удалось скопировать текст');
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="История версий"
      subtitle={
        revisions.length > 0
          ? `Сохранено версий: ${revisions.length} · Сравни изменения перед восстановлением`
          : 'Снимки создаются автоматически при редактировании, работе с ИИ и синхронизации'
      }
      maxWidthClass="max-w-[920px]"
    >
      <div
        data-testid="revision-history-modal"
        className="flex flex-col h-[min(74vh,600px)] min-h-[380px] overflow-hidden"
      >
        {revisions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-8 text-center text-[var(--k-ink-muted)]">
            <ClockCounterClockwise weight="duotone" className="w-10 h-10 opacity-60" />
            <div className="text-[14px] font-medium text-[var(--k-ink-secondary)]">
              Пока нет сохранённых версий
            </div>
            <div className="text-[12.5px] max-w-[360px]">
              Версии сохраняются автоматически по мере изменений, перед оформлением через ИИ и при
              разрешении конфликтов синхронизации.
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {/* Left Column: Revision Timeline */}
              <div className="w-[272px] shrink-0 border-r border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] flex flex-col overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-[var(--k-border-hairline)] text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  Снимки ({revisions.length})
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5">
                  {revisions.map((rev) => {
                    const active = rev.id === selectedRev?.id;
                    const meta = getRevisionSourceMeta(rev.source);
                    const previewLine =
                      (rev.content || '')
                        .split(/\r?\n/)
                        .map((l) => formatDiffDisplayLine(l).trim())
                        .find(Boolean) || 'Пустой текст';

                    return (
                      <button
                        key={rev.id}
                        type="button"
                        data-testid={`revision-row-${rev.id}`}
                        onClick={() => setSelectedId(rev.id)}
                        className={`k-interactive w-full text-left rounded-xl border p-2.5 flex flex-col gap-1.5 cursor-pointer ${
                          active
                            ? 'border-[var(--k-accent)]/55 bg-[var(--k-accent-soft)]'
                            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10.5px] font-medium leading-none ${meta.badgeClass}`}
                          >
                            {meta.isConflict ? (
                              <WarningCircle weight="fill" className="w-3 h-3 shrink-0" />
                            ) : null}
                            {meta.label}
                          </span>
                          <span
                            title={formatExactStamp(rev.createdAt)}
                            className="k-tabular text-[11px] text-[var(--k-ink-muted)] shrink-0"
                          >
                            {formatRelativeDate(rev.createdAt)}
                          </span>
                        </div>

                        {rev.title ? (
                          <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)] truncate">
                            {rev.title}
                          </div>
                        ) : null}

                        <div className="text-[11.5px] text-[var(--k-ink-secondary)] line-clamp-2 leading-snug">
                          {previewLine}
                        </div>

                        <div className="flex items-center justify-between gap-2 text-[10.5px] text-[var(--k-ink-muted)]">
                          <span>{formatExactStamp(rev.createdAt)}</span>
                          {rev.deviceName ? (
                            <span className="inline-flex items-center gap-1 truncate max-w-[115px]">
                              <Desktop className="w-3 h-3 shrink-0" />
                              <span className="truncate">{rev.deviceName}</span>
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Diff / Full Preview */}
              <div className="flex-1 min-w-0 flex flex-col bg-[var(--k-bg-surface-1)] overflow-hidden">
                {selectedRev ? (
                  <>
                    <div className="px-4 py-2.5 border-b border-[var(--k-border-hairline)] flex flex-wrap items-center justify-between gap-2 shrink-0 bg-[var(--k-bg-surface-1)]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[12.5px] font-semibold text-[var(--k-ink-primary)] truncate">
                          {formatExactStamp(selectedRev.createdAt)}
                        </span>
                        {selectedRev.deviceName ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] text-[11px] text-[var(--k-ink-secondary)]">
                            <Desktop className="w-3 h-3" />
                            {selectedRev.deviceName}
                          </span>
                        ) : null}
                        <div className="inline-flex items-center gap-1.5 text-[11px] k-mono tabular-nums shrink-0">
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] tabular-nums whitespace-nowrap shrink-0">
                            +{diff.added}
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-[var(--k-danger-soft)] text-[var(--k-danger)] tabular-nums whitespace-nowrap shrink-0">
                            −{diff.removed}
                          </span>
                        </div>
                      </div>

                      <SegmentedControl<'diff' | 'full'>
                        size="sm"
                        value={viewMode}
                        onChange={setViewMode}
                        options={[
                          { value: 'diff', label: 'Сравнение' },
                          { value: 'full', label: 'Текст версии' },
                        ]}
                      />
                    </div>

                    {titleChanged ? (
                      <div className="px-4 py-2 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 flex flex-wrap items-center gap-2 text-[12px] shrink-0">
                        <span className="text-[var(--k-ink-muted)] font-medium">Заголовок:</span>
                        <span className="px-1.5 py-0.5 rounded bg-[var(--k-danger-soft)] text-[var(--k-danger)] line-through truncate max-w-[240px]">
                          {currentTitle || 'Без заголовка'}
                        </span>
                        <span className="text-[var(--k-ink-muted)]">→</span>
                        <span className="px-1.5 py-0.5 rounded bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] font-medium truncate max-w-[240px]">
                          {selectedRev.title}
                        </span>
                      </div>
                    ) : null}

                    {viewMode === 'diff' ? (
                      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                        <div className="px-4 py-1.5 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/40 flex items-center gap-4 text-[11px] text-[var(--k-ink-muted)] shrink-0">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-[var(--k-emerald)]" />
                            Вернётся из этой версии
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-[var(--k-danger)]" />
                            Будет заменено из текущей
                          </span>
                        </div>

                        {isIdentical ? (
                          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-[13px] text-[var(--k-ink-muted)]">
                            Эта версия полностью совпадает с текущим текстом заметки.
                          </div>
                        ) : (
                          <div
                            data-testid="revision-diff-viewer"
                            className="p-3 font-mono text-[12.5px] leading-[1.6] k-selectable flex flex-col gap-0.5"
                          >
                            {diff.lines.map((line, idx) => {
                              const isAdd = line.type === 'add';
                              const isRemove = line.type === 'remove';
                              const displayLine = formatDiffDisplayLine(line.text);
                              const shouldStrike =
                                isRemove &&
                                line.text.trim().length > 0 &&
                                displayLine.trim().length > 0;
                              return (
                                <div
                                  key={idx}
                                  className={`grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 rounded-md px-2.5 py-0.5 whitespace-pre-wrap break-words ${
                                    isAdd
                                      ? 'bg-[var(--k-emerald-soft)] text-[var(--k-ink-primary)] border-l-2 border-[var(--k-emerald)]'
                                      : isRemove
                                        ? 'bg-[var(--k-danger-soft)] text-[var(--k-ink-secondary)] border-l-2 border-[var(--k-danger)]'
                                        : 'text-[var(--k-ink-secondary)] border-l-2 border-transparent'
                                  }`}
                                >
                                  <span
                                    className={`select-none font-bold text-center ${
                                      isAdd
                                        ? 'text-[var(--k-emerald)]'
                                        : isRemove
                                          ? 'text-[var(--k-danger)]'
                                          : 'text-[var(--k-ink-muted)]/45'
                                    }`}
                                  >
                                    {isAdd ? '+' : isRemove ? '−' : ' '}
                                  </span>
                                  <span
                                    className={
                                      shouldStrike
                                        ? 'line-through decoration-[var(--k-danger)]/60'
                                        : undefined
                                    }
                                  >
                                    {displayLine || '\u00A0'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 min-h-0 overflow-y-auto p-4 k-selectable">
                        <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-[var(--k-ink-primary)]">
                          {formatDiffDisplayLine(selectedRev.content || '') || 'Пустая версия'}
                        </pre>
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-3 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] flex flex-wrap items-center justify-between gap-3 shrink-0">
              <span className="text-[11.5px] text-[var(--k-ink-muted)]">
                Перед восстановлением текущая версия сохранится автоматически
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!selectedRev}
                  onClick={() => void handleCopy()}
                  className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12.5px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-50"
                >
                  {copiedJustNow ? (
                    <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-emerald)]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedJustNow ? 'Скопировано' : 'Скопировать текст'}</span>
                </button>
                <button
                  type="button"
                  data-testid="revision-restore-btn"
                  disabled={!selectedRev || Boolean(restoringId)}
                  onClick={() => {
                    if (selectedRev) void onRestore(selectedRev.id);
                  }}
                  className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:opacity-55"
                >
                  <ArrowCounterClockwise weight="bold" className="w-3.5 h-3.5" />
                  <span>
                    {restoringId === selectedRev?.id
                      ? 'Восстанавливаю…'
                      : 'Восстановить эту версию'}
                  </span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </ModalDialog>
  );
};
