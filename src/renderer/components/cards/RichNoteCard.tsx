import React, { useMemo } from 'react';
import { ImageSquare } from '@phosphor-icons/react';
import type { VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import { getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';

interface RichNoteCardProps {
  item: VaultItem;
  compactList?: boolean;
  onToggleMarkdownTask?: (itemId: string, taskIndex: number, done: boolean) => void;
}

const TASK_RE = /^\s*[-*•]\s+(?:\\\[|\[)([ xX])(?:\\\]|\])\s+(.+)$/;

function cleanInlineTaskLabel(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^()\s]+(?:\([^)]*\))*)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

function extractCardTasks(body: string) {
  const lines = (body || '').split(/\r?\n/);
  const tasks: Array<{ taskIndex: number; done: boolean; text: string }> = [];
  let inFence = false;
  let taskIndex = 0;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TASK_RE.exec(line);
    if (!m) continue;
    tasks.push({
      taskIndex,
      done: (m[1] ?? '').toLowerCase() === 'x',
      text: cleanInlineTaskLabel(m[2] ?? ''),
    });
    taskIndex += 1;
  }
  return tasks;
}

export const RichNoteCard: React.FC<RichNoteCardProps> = React.memo(({
  item,
  compactList = false,
  onToggleMarkdownTask,
}) => {
  const { t, locale, pluralNoun } = useI18n();
  const tasks = useMemo(() => extractCardTasks(item.body), [item.body]);
  const cleanTitle = cleanBrokenTextArtifacts(item.title || t('dna.note'), true);

  const inlineMediaFiles = useMemo(
    () => (!item.thumbPath && !item.imagePath ? extractInlineMediaFilenames(item.body) : []),
    [item.body, item.thumbPath, item.imagePath]
  );
  const inlineThumbUrl = inlineMediaFiles[0] ? getMediaUrl(inlineMediaFiles[0]) : null;

  const cleanPreview = useMemo(() => {
    const withoutTasks = (item.body || '')
      .split(/\r?\n/)
      .filter((line) => !TASK_RE.test(line))
      .filter(
        (line) =>
          !(
            tasks.length > 0 &&
            /^\s*#{1,6}\s*(?:Задачи|Следующие шаги|Дела|Tasks|Next steps|Action items)\s*$/i.test(line)
          )
      )
      .join('\n');
    const summaryFallback = tasks.length > 0 ? '' : item.summary || '';
    const text = stripLeadingTitle(stripMarkdownPreview(withoutTasks || summaryFallback), cleanTitle);
    return cleanBrokenTextArtifacts(text, true);
  }, [item.body, item.summary, cleanTitle, tasks.length]);

  const compactSubline = cleanPreview || tasks.map((t) => t.text).join(' · ');

  if (compactList) {
    return (
      <div className="min-w-0 flex-1 flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] truncate">
              {cleanTitle}
            </span>
            {tasks.length > 0 ? (
              <span className="k-tabular text-[11px] px-1.5 py-0.5 rounded-md bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
                {tasks.filter((t) => t.done).length}/{tasks.length}
              </span>
            ) : null}
          </div>
          {compactSubline ? (
            <div className="text-[12px] text-[var(--k-ink-secondary)] truncate mt-0.5">
              {compactSubline}
            </div>
          ) : null}
        </div>
        {inlineThumbUrl ? (
          <div className="w-9 h-9 rounded-lg overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] shrink-0">
            <img
              src={inlineThumbUrl}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover block"
            />
          </div>
        ) : null}
      </div>
    );
  }

  const isCompactShortThought =
    !cleanPreview &&
    !inlineThumbUrl &&
    (item.body || '').trim().length <= 140 &&
    !(item.body || '').includes('\n');

  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <h3
          className={`m-0 text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--k-ink-primary)] leading-snug ${
            isCompactShortThought ? 'line-clamp-3' : 'line-clamp-2'
          }`}
        >
          {cleanTitle}
        </h3>
      </div>

      {inlineThumbUrl ? (
        <div className="relative rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]">
          <img
            src={inlineThumbUrl}
            alt=""
            loading="lazy"
            className="w-full h-[132px] object-cover block"
          />
          {inlineMediaFiles.length > 1 ? (
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/74 text-white text-[10.5px] font-medium k-tabular">
              <ImageSquare weight="fill" className="w-3 h-3" />
              +{inlineMediaFiles.length - 1}
            </span>
          ) : null}
        </div>
      ) : null}

      {cleanPreview ? (
        <p className="m-0 text-[12.5px] text-[var(--k-ink-secondary)] leading-relaxed line-clamp-4">
          {cleanPreview}
        </p>
      ) : null}

      {tasks.length > 0 ? (
        <div className="flex flex-col gap-1.5 pt-1">
          {tasks.slice(0, 4).map((t) => (
            <div
              key={t.taskIndex}
              data-testid={`card-task-row-${item.id}-${t.taskIndex}`}
              className="flex items-start gap-2 text-left text-[12px]"
            >
              <span
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-5 h-5 -ml-0.5 -mt-0.5 inline-flex items-center justify-center shrink-0"
              >
                <AnimatedCheckbox
                  size="sm"
                  checked={t.done}
                  data-testid={`card-task-checkbox-${item.id}-${t.taskIndex}`}
                  label={t.text}
                  onChange={(next) => onToggleMarkdownTask?.(item.id, t.taskIndex, next)}
                />
              </span>
              <span
                data-testid={`card-task-text-${item.id}-${t.taskIndex}`}
                className={`leading-snug line-clamp-2 transition-colors duration-150 ${
                  t.done
                    ? 'line-through text-[var(--k-ink-muted)]'
                    : 'text-[var(--k-ink-primary)]'
                }`}
              >
                {t.text}
              </span>
            </div>
          ))}
          {tasks.length > 4 ? (
            <span className="text-[11px] text-[var(--k-ink-muted)] k-tabular">
              {t('cards.moreTasks', {
                count: tasks.length - 4,
                word: pluralNoun(tasks.length - 4, 'task').replace(/^\d+\s+/, ''),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
