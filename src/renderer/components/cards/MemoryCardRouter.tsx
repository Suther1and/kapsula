import React, { useState } from 'react';
import {
  ArrowCounterClockwise,
  Bell,
  Check,
  CheckSquareOffset,
  Copy,
  Eye,
  Files,
  FileText,
  FolderSimple,
  NotePencil,
  PencilSimple,
  Plus,
  PushPin,
  Swatches,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { FocusBoard, OrbitDef, VaultItem } from '@shared/types';
import { getRedundantCardTags, isDedicatedNote } from '@shared/item-helpers';
import { useI18n } from '@shared/i18n/react';
import { formatRelativeDate, formatReminderStamp } from '../../lib/format';
import { type ContextMenuEntry, ContextMenuSurface } from '../ui/ContextMenuSurface';
import { PopoverSurface } from '../ui/PopoverSurface';
import { SectionIcon } from '../ui/SectionIcon';
import { CodeSnippetCard } from './CodeSnippetCard';
import { CompactMemoryRow } from './CompactMemoryRow';
import { DocumentCard } from './DocumentCard';
import { RichNoteCard } from './RichNoteCard';
import { SmartLinkCard } from './SmartLinkCard';
import { VaultSecretCard } from './VaultSecretCard';
import { VisualShotCard } from './VisualShotCard';
import { VoiceMemoCard } from './VoiceMemoCard';

interface MemoryCardRouterProps {
  item: VaultItem;
  orbit?: OrbitDef;
  orbits?: OrbitDef[];
  focusBoards?: FocusBoard[];
  compactList?: boolean;
  vaultLocked: boolean;
  wipeSeconds: number;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelect?: (item: VaultItem, shiftKey: boolean) => void;
  onOpenStudio: (item: VaultItem) => void;
  onQuickLook?: (item: VaultItem) => void;
  onHoverItem?: (item: VaultItem | null) => void;
  onOpenSecretSheet?: (item: VaultItem) => void;
  onOpenShotLightbox: (item: VaultItem) => void;
  onDelete: (id: string) => void;
  onRestore?: (id: string) => void;
  onTogglePin: (item: VaultItem) => void;
  onToggleNotesHub?: (item: VaultItem, inNotesHub: boolean) => void;
  onMoveToOrbit?: (itemId: string, orbitId: string) => void;
  onMoveToBoard?: (itemId: string, boardId: string | null) => void;
  onDuplicate?: (itemId: string) => void;
  onExportMarkdown?: (itemId: string) => void;
  onUnlockVaultRequest: () => void;
  onToggleMarkdownTask?: (itemId: string, taskIndex: number, done: boolean) => void;
  onToggleVoiceAction?: (itemId: string, actionIdx: number, done: boolean) => void;
}

export const MemoryCardRouter: React.FC<MemoryCardRouterProps> = ({
  item,
  orbit,
  orbits = [],
  focusBoards = [],
  compactList = false,
  vaultLocked,
  wipeSeconds,
  selected = false,
  selectionMode = false,
  onToggleSelect,
  onOpenStudio,
  onQuickLook,
  onHoverItem,
  onOpenSecretSheet,
  onOpenShotLightbox,
  onDelete,
  onRestore,
  onTogglePin,
  onToggleNotesHub,
  onMoveToOrbit,
  onMoveToBoard,
  onDuplicate,
  onExportMarkdown,
  onUnlockVaultRequest,
  onToggleMarkdownTask,
  onToggleVoiceAction,
}) => {
  const { t, locale } = useI18n();
  const [orbitPopoverOpen, setOrbitPopoverOpen] = useState(false);

  const buildContextMenuEntries = (): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [
      {
        type: 'item',
        id: 'open',
        label: item.dna === 'secret' ? t('cards.ctx.openAndView') : t('cards.openNote'),
        icon: <PencilSimple className="w-3.5 h-3.5" />,
        onSelect: () => {
          if (item.dna === 'secret') {
            onOpenSecretSheet?.(item);
          } else {
            onOpenStudio(item);
          }
        },
      },
      ...(item.dna !== 'secret' && onQuickLook
        ? [
            {
              type: 'item' as const,
              id: 'quick-look',
              label: t('cards.quickLookShort'),
              shortcut: t('settings.shortcuts.space'),
              icon: <Eye className="w-3.5 h-3.5" />,
              onSelect: () => onQuickLook(item),
            },
          ]
        : []),
      {
        type: 'item',
        id: 'pin',
        label: item.isPinned ? t('ui.quickLook.unpin') : t('cards.ctx.pinTop'),
        icon: <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-3.5 h-3.5" />,
        onSelect: () => onTogglePin(item),
      },
    ];

    if (item.dna !== 'secret' && onToggleSelect) {
      entries.push({
        type: 'item',
        id: 'select',
        label: selected ? t('cards.ctx.unselect') : t('cards.ctx.selectMulti'),
        icon: <CheckSquareOffset className="w-3.5 h-3.5" />,
        onSelect: () => onToggleSelect(item, false),
      });
    }

    if ((item.dna === 'note' || item.dna === 'snippet') && !item.deletedAt && !item.isArchived && onToggleNotesHub) {
      const inNotes = isDedicatedNote(item);
      entries.push({
        type: 'item',
        id: 'toggle-notes-hub',
        label: inNotes ? t('notes.hub.removeFromNotes') : t('notes.hub.addToNotes'),
        icon: <NotePencil className="w-3.5 h-3.5" />,
        onSelect: () => onToggleNotesHub(item, !inNotes),
      });
    }

    if (onMoveToOrbit && orbits.length > 0) {
      entries.push({
        type: 'submenu',
        id: 'move-orbit',
        label: t('cards.ctx.moveToSection'),
        icon: <FolderSimple className="w-3.5 h-3.5" />,
        items: [
          {
            type: 'item',
            id: 'orbit-none',
            label: t('nav.noSection'),
            active: !item.orbit,
            onSelect: () => onMoveToOrbit(item.id, ''),
          },
          { type: 'separator', id: 'sep-orbs' },
          ...orbits.map<ContextMenuEntry>((orb) => ({
            type: 'item',
            id: `orb-${orb.id}`,
            label: orb.name,
            dotColor: orb.color,
            active: item.orbit === orb.id,
            onSelect: () => onMoveToOrbit(item.id, orb.id),
          })),
        ],
      });
    }

    if (onMoveToBoard && focusBoards.length > 0) {
      entries.push({
        type: 'submenu',
        id: 'move-board',
        label: t('cards.ctx.addToBoard'),
        icon: <Swatches className="w-3.5 h-3.5" />,
        items: [
          {
            type: 'item',
            id: 'board-none',
            label: t('cards.ctx.removeFromBoard'),
            active: !item.focusBoardId,
            onSelect: () => onMoveToBoard(item.id, null),
          },
          { type: 'separator', id: 'sep-boards' },
          ...focusBoards.map<ContextMenuEntry>((b) => ({
            type: 'item',
            id: `board-${b.id}`,
            label: b.name,
            dotColor: b.color,
            active: item.focusBoardId === b.id,
            onSelect: () => onMoveToBoard(item.id, b.id),
          })),
        ],
      });
    }

    entries.push({ type: 'separator', id: 'sep-actions' });

    if (item.dna !== 'secret') {
      entries.push({
        type: 'item',
        id: 'copy-text',
        label: item.url ? t('cards.copyLink') : t('cards.ctx.copyText'),
        icon: <Copy className="w-3.5 h-3.5" />,
        onSelect: () => {
          void window.kapsula.copyText(item.url || item.body || item.title);
          toast.success(t('common.copied'));
        },
      });
      if (onDuplicate) {
        entries.push({
          type: 'item',
          id: 'duplicate',
          label: t('cards.ctx.duplicate'),
          icon: <Files className="w-3.5 h-3.5" />,
          onSelect: () => onDuplicate(item.id),
        });
      }
      if (onExportMarkdown) {
        entries.push({
          type: 'item',
          id: 'export-md',
          label: t('cards.ctx.exportMd'),
          icon: <FileText className="w-3.5 h-3.5" />,
          onSelect: () => onExportMarkdown(item.id),
        });
      }
    }

    entries.push({ type: 'separator', id: 'sep-danger' });
    if (item.deletedAt && onRestore) {
      entries.push({
        type: 'item',
        id: 'restore',
        label: t('common.restore'),
        icon: <ArrowCounterClockwise className="w-3.5 h-3.5" />,
        onSelect: () => onRestore(item.id),
      });
    } else {
      entries.push({
        type: 'item',
        id: 'delete',
        label: t('common.delete'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: () => onDelete(item.id),
      });
    }

    return entries;
  };

  // Single uniform ~52px List row for ALL DNA types
  if (compactList) {
    return (
      <ContextMenuSurface entries={buildContextMenuEntries()}>
        <div>
          <CompactMemoryRow
            item={item}
            orbit={orbit}
            selected={selected}
            selectionMode={selectionMode}
            onToggleSelect={onToggleSelect}
            onOpen={(target) => {
              if (target.dna === 'secret') onOpenSecretSheet?.(target);
              else onOpenStudio(target);
            }}
            onToggleMarkdownTask={onToggleMarkdownTask}
          />
        </div>
      </ContextMenuSurface>
    );
  }

  if (item.dna === 'secret') {
    return (
      <ContextMenuSurface entries={buildContextMenuEntries()}>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/kapsula-item-id', item.id);
            e.dataTransfer.setData('text/kapsula-item-non-note', '1');
            e.dataTransfer.effectAllowed = 'move';
          }}
        >
          <VaultSecretCard
            item={item}
            compactList={false}
            vaultLocked={vaultLocked}
            wipeSeconds={wipeSeconds}
            onOpen={(sec) => onOpenSecretSheet?.(sec)}
            onDelete={onDelete}
            onUnlockRequest={onUnlockVaultRequest}
          />
        </div>
      </ContextMenuSurface>
    );
  }

  const renderBody = () => {
    switch (item.dna) {
      case 'shot':
        return (
          <VisualShotCard
            item={item}
            compactList={false}
            onZoom={onOpenShotLightbox}
          />
        );
      case 'snippet':
        return <CodeSnippetCard item={item} compactList={false} />;
      case 'link':
        return <SmartLinkCard item={item} compactList={false} />;
      case 'voice':
        return (
          <VoiceMemoCard
            item={item}
            compactList={false}
            onToggleVoiceAction={onToggleVoiceAction}
          />
        );
      case 'doc':
        return <DocumentCard item={item} compactList={false} />;
      default:
        return (
          <RichNoteCard
            item={item}
            compactList={false}
            onToggleMarkdownTask={onToggleMarkdownTask}
          />
        );
    }
  };

  const redundantTags = new Set<string>([...getRedundantCardTags(), t('ui.quickLook.pin').toLowerCase()]);
  if (item.dna === 'shot') {
    redundantTags.add('screenshot');
    redundantTags.add(t('dna.shot').toLowerCase());
  }
  if (item.dna === 'voice') {
    redundantTags.add('voice');
    redundantTags.add(t('dna.voice').toLowerCase());
  }
  if (item.platform) redundantTags.add(item.platform.toLowerCase());
  if (orbit?.name) redundantTags.add(orbit.name.toLowerCase());
  const visibleTags = item.tags
    .filter((tag) => tag && !redundantTags.has(tag.toLowerCase()))
    .slice(0, 2);

  return (
    <ContextMenuSurface entries={buildContextMenuEntries()}>
      <article
        data-testid={`memory-card-${item.id}`}
        data-selection-active={selectionMode || selected ? 'true' : undefined}
        draggable
        onMouseEnter={() => onHoverItem?.(item)}
        onMouseLeave={() => onHoverItem?.(null)}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/kapsula-item-id', item.id);
          if (item.dna === 'note' || item.dna === 'snippet') {
            e.dataTransfer.setData('text/kapsula-item-note', '1');
          } else {
            e.dataTransfer.setData('text/kapsula-item-non-note', '1');
          }
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={(e) => {
          if ((e.ctrlKey || e.metaKey || selectionMode) && onToggleSelect) {
            e.preventDefault();
            onToggleSelect(item, e.shiftKey);
            return;
          }
          onOpenStudio(item);
        }}
        style={{ padding: 'var(--k-card-pad)' }}
        className={`group relative k-card-surface k-card-lift rounded-2xl flex flex-col gap-3 cursor-pointer select-none ${
          selected ? 'ring-1 ring-[var(--k-accent)] !border-[var(--k-accent)] bg-[var(--k-accent-soft)]/14' : ''
        }`}
      >
        <div>{renderBody()}</div>

        {/* Clean divider-free Footer: interactive section pill + deduped tags on left, flush-right timestamp swapping cleanly with action capsule */}
        <div className="relative flex items-center justify-between gap-2 pt-1 min-h-[24px]">
          <div
            className={`flex items-center gap-1.5 min-w-0 flex-nowrap overflow-hidden flex-1 pr-1 transition-[mask-image] duration-140 group-hover:[mask-image:linear-gradient(to_right,black_0%,black_58%,transparent_94%)] group-focus-within:[mask-image:linear-gradient(to_right,black_0%,black_58%,transparent_94%)] ${
              selected || selectionMode ? 'pr-7' : ''
            }`}
          >
            {orbit ? (
              onMoveToOrbit && orbits.length > 0 ? (
                <div onClick={(e) => e.stopPropagation()} className="inline-flex shrink-0">
                  <PopoverSurface
                    open={orbitPopoverOpen}
                    onOpenChange={setOrbitPopoverOpen}
                    align="start"
                    side="bottom"
                    widthClass="w-[215px] !p-1.5"
                    trigger={
                      <button
                        type="button"
                        data-testid={`card-orbit-chip-${item.id}`}
                        title={t('cards.sectionChipTitle', { name: orbit.name })}
                        style={{
                          backgroundColor: `color-mix(in srgb, ${orbit.color} 12%, transparent)`,
                          borderColor: `color-mix(in srgb, ${orbit.color} 26%, transparent)`,
                        }}
                        className="k-interactive inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[7px] border text-[11px] font-medium text-[var(--k-ink-primary)] hover:brightness-105 max-w-[148px] truncate cursor-pointer"
                      >
                        <SectionIcon name={orbit.icon} className="w-3 h-3 shrink-0" color={orbit.color} />
                        <span className="truncate">{orbit.name}</span>
                      </button>
                    }
                  >
                    <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => {
                          setOrbitPopoverOpen(false);
                          onMoveToOrbit(item.id, '');
                        }}
                        className="k-interactive w-full text-left px-2.5 py-1.5 rounded-[7px] text-[12px] text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        {t('nav.noSection')}
                      </button>
                      {orbits.map((orb) => (
                        <button
                          key={orb.id}
                          type="button"
                          onClick={() => {
                            setOrbitPopoverOpen(false);
                            onMoveToOrbit(item.id, orb.id);
                          }}
                          className={`k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[7px] text-[12px] cursor-pointer ${
                            orb.id === item.orbit
                              ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                              : 'text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]'
                          }`}
                        >
                          <SectionIcon name={orb.icon} className="w-3.5 h-3.5 shrink-0" color={orb.color} />
                          <span className="truncate">{orb.name}</span>
                        </button>
                      ))}
                    </div>
                  </PopoverSurface>
                </div>
              ) : (
                <span
                  data-testid={`card-orbit-chip-${item.id}`}
                  style={{
                    backgroundColor: `color-mix(in srgb, ${orbit.color} 12%, transparent)`,
                    borderColor: `color-mix(in srgb, ${orbit.color} 26%, transparent)`,
                  }}
                  className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[7px] border text-[11px] font-medium text-[var(--k-ink-primary)] max-w-[148px] truncate"
                >
                  <SectionIcon name={orbit.icon} className="w-3 h-3 shrink-0" color={orbit.color} />
                  <span className="truncate">{orbit.name}</span>
                </span>
              )
            ) : null}

            {item.remindAt ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--k-amber-soft)] text-[11px] font-medium text-[var(--k-amber)]">
                <Bell weight="fill" className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate">{formatReminderStamp(item.remindAt, locale)}</span>
              </span>
            ) : null}

            {visibleTags.map((tag) => (
              <span
                key={tag}
                data-testid={`card-tag-${tag}`}
                className="inline-flex items-center gap-0.5 h-[20px] px-2 rounded-full border border-[var(--k-border-hairline)] bg-transparent text-[11px] text-[var(--k-ink-muted)] truncate max-w-[100px]"
              >
                <span className="opacity-65">#</span>
                <span className="truncate">{tag}</span>
              </span>
            ))}

            {!orbit && onMoveToOrbit && orbits.length > 0 ? (
              <div onClick={(e) => e.stopPropagation()} className="inline-flex shrink-0">
                <PopoverSurface
                  open={orbitPopoverOpen}
                  onOpenChange={setOrbitPopoverOpen}
                  align="start"
                  side="bottom"
                  widthClass="w-[215px] !p-1.5"
                  trigger={
                    <button
                      type="button"
                      className="k-interactive opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-140 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                    >
                      <Plus className="w-2.5 h-2.5" />
                      <span>{t('cards.sectionChipEmpty')}</span>
                    </button>
                  }
                >
                  <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                    {orbits.map((orb) => (
                      <button
                        key={orb.id}
                        type="button"
                        onClick={() => {
                          setOrbitPopoverOpen(false);
                          onMoveToOrbit(item.id, orb.id);
                        }}
                        className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[7px] text-[12px] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: orb.color }}
                        />
                        <span className="truncate">{orb.name}</span>
                      </button>
                    ))}
                  </div>
                </PopoverSurface>
              </div>
            ) : null}
          </div>

          <div className="relative flex items-center justify-end shrink-0 ml-auto h-6 min-w-[74px]">
            <div
              className={`flex items-center gap-1 whitespace-nowrap transition-opacity duration-140 ${
                selected || selectionMode
                  ? 'opacity-0 pointer-events-none'
                  : 'group-hover:opacity-0 group-hover:pointer-events-none'
              }`}
            >
              {item.isPinned ? (
                <PushPin weight="fill" className="w-3 h-3 text-[var(--k-accent)] shrink-0" />
              ) : null}
              <span
                data-testid={`card-timestamp-${item.id}`}
                className="text-[11px] text-[var(--k-ink-muted)] k-tabular whitespace-nowrap"
              >
                {formatRelativeDate(item.contentUpdatedAt || item.createdAt, locale)}
              </span>
            </div>

            {/* Unified bottom-right pill: clean circular checkbox + hover Pin/Trash over timestamp slot */}
            <div
              data-testid={onToggleSelect ? `card-select-badge-${item.id}` : undefined}
              onClick={(e) => e.stopPropagation()}
              className={`absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center gap-0.5 rounded-full transition-opacity duration-140 ease-[var(--k-ease-out)] h-6 ${
                selected || selectionMode
                  ? 'opacity-100 pointer-events-auto group-hover:bg-[var(--k-bg-surface-2)] group-hover:border group-hover:border-[var(--k-border-hairline)] group-hover:px-1 group-hover:shadow-sm'
                  : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] px-1 shadow-sm'
              }`}
            >
              {onQuickLook ? (
                <button
                  type="button"
                  title={t('cards.quickLookHint')}
                  onClick={() => onQuickLook(item)}
                  className={`k-interactive items-center justify-center w-5 h-5 rounded-full text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer ${
                    selected || selectionMode ? 'hidden group-hover:inline-flex' : 'inline-flex'
                  }`}
                >
                  <Eye className="w-3 h-3" />
                </button>
              ) : null}
              <button
                type="button"
                title={item.isPinned ? t('ui.quickLook.unpin') : t('ui.quickLook.pin')}
                onClick={() => onTogglePin(item)}
                className={`k-interactive items-center justify-center w-5 h-5 rounded-full text-[var(--k-ink-muted)] hover:text-[var(--k-accent)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer ${
                  selected || selectionMode ? 'hidden group-hover:inline-flex' : 'inline-flex'
                }`}
              >
                <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-3 h-3" />
              </button>
              <button
                type="button"
                title={t('common.delete')}
                onClick={() => onDelete(item.id)}
                className={`k-interactive items-center justify-center w-5 h-5 rounded-full text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer ${
                  selected || selectionMode ? 'hidden group-hover:inline-flex' : 'inline-flex'
                }`}
              >
                <Trash className="w-3 h-3" />
              </button>
              {onToggleSelect ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={t('cards.selectAria', { title: item.title })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(item, e.shiftKey);
                    if (e.detail > 0) e.currentTarget.blur();
                  }}
                  className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border transition-[background-color,border-color] duration-[110ms] ease-out cursor-pointer ${
                    selected
                      ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                      : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-accent)]'
                  }`}
                >
                  {selected ? <Check weight="bold" className="w-[11px] h-[11px]" /> : null}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </article>
    </ContextMenuSurface>
  );
};
