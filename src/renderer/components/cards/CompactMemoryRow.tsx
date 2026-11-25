import React from 'react';
import {
  ArrowSquareOut,
  Code,
  EyeSlash,
  FileText,
  GlobeSimple,
  ImageSquare,
  Microphone,
  NotePencil,
  PushPin,
  ShieldCheck,
  VideoCamera,
} from '@phosphor-icons/react';
import type { OrbitDef, VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts, truncateAtWordBoundary } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import { formatDateCompact, getDnaHumanLabel, getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { SectionIcon } from '../ui/SectionIcon';

interface CompactMemoryRowProps {
  item: VaultItem;
  orbit?: OrbitDef;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelect?: (item: VaultItem, shiftKey: boolean) => void;
  onOpen: (item: VaultItem) => void;
  onToggleMarkdownTask?: (itemId: string, taskIndex: number, done: boolean) => void;
}

const FIRST_TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/m;

function renderTypeBadge(item: VaultItem) {
  if (item.dna === 'secret') {
    return <ShieldCheck weight="fill" className="w-4 h-4 text-[var(--k-emerald)]" />;
  }
  if (item.subKind === 'video_ref') {
    return <VideoCamera weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />;
  }
  switch (item.dna) {
    case 'link':
      return <GlobeSimple weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />;
    case 'shot':
      return <ImageSquare weight="duotone" className="w-4 h-4 text-[var(--k-info)]" />;
    case 'voice':
      return <Microphone weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />;
    case 'snippet':
      return <Code weight="duotone" className="w-4 h-4 text-[var(--k-violet)]" />;
    case 'doc':
      return <FileText weight="duotone" className="w-4 h-4 text-[var(--k-amber)]" />;
    default:
      return <NotePencil weight="duotone" className="w-4 h-4 text-[var(--k-ink-secondary)]" />;
  }
}

export const CompactMemoryRow: React.FC<CompactMemoryRowProps> = React.memo(({
  item,
  orbit,
  selected = false,
  selectionMode = false,
  onToggleSelect,
  onOpen,
  onToggleMarkdownTask,
}) => {
  const { t, locale } = useI18n();
  const firstTask = item.dna === 'note' ? FIRST_TASK_RE.exec(item.body || '') : null;
  const isChecklistDone = firstTask ? firstTask[1]!.toLowerCase() === 'x' : false;
  const titleText = cleanBrokenTextArtifacts(item.title || getDnaHumanLabel(item, locale), true);
  const rawSnippet =
    item.dna === 'secret'
      ? item.secretMeta?.loginHint || t('dna.vaultRecord')
      : cleanBrokenTextArtifacts(
          truncateAtWordBoundary(stripMarkdownPreview(item.summary || item.body || item.url || ''), 120),
          true
        );
  const snippetText = truncateAtWordBoundary(stripLeadingTitle(rawSnippet, titleText), 90);
  const inlineThumbName =
    item.dna !== 'secret' && !item.thumbPath && !item.imagePath
      ? extractInlineMediaFilenames(item.body)[0] ?? null
      : null;
  const thumbUrl =
    item.dna !== 'secret'
      ? getMediaUrl(item.thumbPath || item.imagePath || inlineThumbName)
      : null;
  const hasInteractiveTaskBox = Boolean(firstTask && onToggleMarkdownTask);
  const showSelectInSlot = Boolean((selectionMode || selected) && item.dna !== 'secret' && onToggleSelect);

  return (
    <div
      data-testid={`compact-row-${item.id}`}
      data-muted={item.isMuted ? 'true' : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/kapsula-item-id', item.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        if ((e.ctrlKey || e.metaKey || selectionMode) && onToggleSelect && item.dna !== 'secret') {
          e.preventDefault();
          onToggleSelect(item, e.shiftKey);
          return;
        }
        onOpen(item);
      }}
      className={`group h-[52px] px-4 grid grid-cols-[28px_minmax(0,1fr)_auto_68px] items-center gap-3 cursor-pointer select-none transition-[background-color,border-color,opacity] duration-[145ms] ease-[var(--k-ease-out)] active:duration-[75ms] ${
        selected
          ? 'bg-[var(--k-accent-soft)]/55'
          : 'hover:bg-[var(--k-bg-surface-2)] active:bg-[color-mix(in_srgb,var(--k-bg-surface-2)_88%,var(--k-accent)_12%)]'
      } ${item.isMuted && !selected ? 'opacity-[0.52] hover:opacity-[0.9]' : ''}`}
    >
      {/* Fixed 28px slot on left: task checkbox stays permanently clickable when present; otherwise swaps media/type icon to selection checkbox on hover */}
      <div className="relative w-7 h-7 flex items-center justify-center shrink-0">
        {hasInteractiveTaskBox ? (
          <AnimatedCheckbox
            size="sm"
            checked={isChecklistDone}
            onChange={(next) => onToggleMarkdownTask!(item.id, 0, next)}
            label={t('cards.taskAria', { title: titleText })}
          />
        ) : showSelectInSlot ? (
          <AnimatedCheckbox
            size="sm"
            checked={selected}
            onChange={() => onToggleSelect!(item, false)}
            label={t('cards.selectAria', { title: titleText })}
          />
        ) : (
          <>
            <div
              className={`w-7 h-7 flex items-center justify-center transition-opacity duration-120 rounded-lg bg-[var(--k-bg-surface-2)] overflow-hidden ${
                onToggleSelect && item.dna !== 'secret' ? 'group-hover:opacity-0' : ''
              }`}
            >
              {thumbUrl ? (
                <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                renderTypeBadge(item)
              )}
            </div>
            {onToggleSelect && item.dna !== 'secret' ? (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-120">
                <AnimatedCheckbox
                  size="sm"
                  checked={selected}
                  onChange={() => onToggleSelect(item, false)}
                  label={t('cards.selectAria', { title: titleText })}
                />
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Single-line Title + Muted Snippet */}
      <div className="min-w-0 flex items-center gap-2.5 overflow-hidden">
        <span
          className={`text-[13px] font-medium text-[var(--k-ink-primary)] truncate ${
            snippetText && snippetText !== titleText ? 'shrink-0 max-w-[46%]' : 'min-w-0'
          }`}
        >
          {titleText}
        </span>
        {snippetText && snippetText !== titleText ? (
          <span className="text-[12px] text-[var(--k-ink-muted)] truncate min-w-0">
            · {snippetText}
          </span>
        ) : null}
      </div>

      {/* Section Chip + Pin */}
      <div className="flex items-center gap-2 shrink-0">
        {orbit ? (
          <span
            style={{
              backgroundColor: `color-mix(in srgb, ${orbit.color} 12%, transparent)`,
              borderColor: `color-mix(in srgb, ${orbit.color} 26%, transparent)`,
            }}
            className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[7px] border text-[11px] font-medium text-[var(--k-ink-primary)] max-w-[132px] truncate"
          >
            <SectionIcon name={orbit.icon} className="w-3 h-3 shrink-0" color={orbit.color} />
            <span className="truncate">{orbit.name}</span>
          </span>
        ) : null}
        {item.isMuted ? (
          <EyeSlash weight="fill" className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
        ) : null}
        {item.isPinned ? (
          <PushPin weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
        ) : null}
      </div>

      {/* Right-aligned Tabular Date (swaps cleanly to selection checkbox on task rows or open-link button without zero-opacity interception) */}
      <div className="relative flex items-center justify-end h-7 shrink-0">
        <span
          className={`k-mono k-tabular text-[11px] text-[var(--k-ink-muted)] text-right whitespace-nowrap transition-opacity duration-120 ${
            item.url || (hasInteractiveTaskBox && onToggleSelect && !showSelectInSlot)
              ? 'group-hover:opacity-0'
              : ''
          } ${showSelectInSlot && hasInteractiveTaskBox ? 'opacity-0' : ''}`}
        >
          {formatDateCompact(item.contentUpdatedAt || item.createdAt, locale)}
        </span>
        {hasInteractiveTaskBox && onToggleSelect ? (
          <div
            className={`absolute right-0 flex items-center justify-end transition-opacity duration-120 ${
              showSelectInSlot
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
            }`}
          >
            <AnimatedCheckbox
              size="sm"
              checked={selected}
              onChange={() => onToggleSelect(item, false)}
              label={t('cards.selectAria', { title: titleText })}
            />
          </div>
        ) : item.url ? (
          <button
            type="button"
            title={t('cards.openLink')}
            onClick={(e) => {
              e.stopPropagation();
              void window.kapsula.openExternal(item.url!);
            }}
            className="k-interactive opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto absolute right-0 inline-flex items-center gap-1 h-6 px-2 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11px] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)] cursor-pointer transition-opacity duration-120"
          >
            <ArrowSquareOut className="w-3 h-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
});
