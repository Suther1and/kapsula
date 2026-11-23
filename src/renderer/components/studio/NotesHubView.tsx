import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import NumberFlow from '@number-flow/react';
import {
  CheckSquare,
  Copy,
  FileText,
  FolderSimple,
  List,
  MagnifyingGlass,
  NotePencil,
  Plus,
  PushPin,
  SidebarSimple,
  Swatches,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { FocusBoard, OrbitDef, VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { countChecklistStats, isAnyTextNote, isDedicatedNote, isUntitledPlaceholderTitle } from '@shared/item-helpers';
import {
  formatRelativeDate,
  stripLeadingTitle,
  stripMarkdownPreview,
} from '../../lib/format';
import { ContextMenuSurface, type ContextMenuEntry } from '../ui/ContextMenuSurface';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectMenu } from '../ui/SelectMenu';
import { TooltipHint } from '../ui/TooltipHint';
import { NoteStudio } from './NoteStudio';

type NoteScope = 'dedicated' | 'all_text';
type NoteSortMode = 'updated_desc' | 'created_desc' | 'title_asc';

interface NotesHubViewProps {
  items: VaultItem[];
  allItemsForLinks?: VaultItem[];
  defaultOrbitId?: string;
  defaultFocusBoardId?: string | null;
  orbits: OrbitDef[];
  focusBoards: FocusBoard[];
  globalSearchQuery: string;
  serverSearchIds: string[] | null;
  soundEnabled: boolean;
  createDraftTrigger?: number;
  onItemUpdated: (updated: VaultItem) => void;
  onDraftPersisted: (created: VaultItem) => void;
  onDeleteItem: (id: string) => void;
  onTogglePin: (item: VaultItem) => void;
  onToggleNotesHub?: (item: VaultItem, inNotesHub: boolean) => void;
  onMoveToOrbit: (itemId: string, orbitId: string) => void;
  onMoveToBoard: (itemId: string, boardId: string | null) => void;
  onDuplicateItem: (itemId: string) => void;
  onExportMarkdown: (itemId: string) => void;
  onOpenExternalItem: (item: VaultItem) => void;
  onOpenShotLightbox: (item: VaultItem) => void;
}

function makeInlineDraftItem(
  defaultOrbitId = '',
  defaultFocusBoardId: string | null = null
): VaultItem {
  const now = Date.now();
  return {
    id: '__draft__',
    dna: 'note',
    subKind: null,
    orbit: defaultOrbitId,
    modeCaptured: 'autopilot',
    focusBoardId: defaultFocusBoardId,
    title: '',
    body: '',
    summary: '',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: { inNotesHub: true },
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    hasEncryptedPayload: false,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: '',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    isDemo: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
  };
}

export const NotesHubView: React.FC<NotesHubViewProps> = ({
  items,
  allItemsForLinks,
  defaultOrbitId = '',
  defaultFocusBoardId = null,
  orbits,
  focusBoards,
  globalSearchQuery,
  serverSearchIds,
  soundEnabled,
  createDraftTrigger = 0,
  onItemUpdated,
  onDraftPersisted,
  onDeleteItem,
  onTogglePin,
  onToggleNotesHub,
  onMoveToOrbit,
  onMoveToBoard,
  onDuplicateItem,
  onExportMarkdown,
  onOpenExternalItem,
  onOpenShotLightbox,
}) => {
  const { t, locale, dateLocale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [scope, setScope] = useState<NoteScope>('dedicated');
  const [localFilter, setLocalFilter] = useState('');
  const [sortBy, setSortBy] = useState<NoteSortMode>('updated_desc');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [draftItem, setDraftItem] = useState<VaultItem | null>(null);
  const [listVisible, setListVisible] = useState(true);

  const orbitMap = useMemo(() => {
    const map = new Map<string, OrbitDef>();
    for (const o of orbits) map.set(o.id, o);
    return map;
  }, [orbits]);

  const dedicatedNotes = useMemo(() => items.filter(isDedicatedNote), [items]);
  const allTextNotes = useMemo(() => items.filter(isAnyTextNote), [items]);

  const filteredNotes = useMemo(() => {
    const base = scope === 'dedicated' ? dedicatedNotes : allTextNotes;
    const combinedQuery = (localFilter.trim() || globalSearchQuery.trim()).trim();
    const serverSet = !localFilter.trim() && serverSearchIds ? new Set(serverSearchIds) : null;

    const matched = combinedQuery
      ? base.filter((item) => {
          if (serverSet && serverSet.has(item.id)) return true;
          const hay = [item.title, item.summary, item.body, item.tags.join(' ')]
            .filter(Boolean)
            .join('\n');
          return matchesBilingualHaystack(hay, combinedQuery);
        })
      : base;

    const copy = [...matched];
    copy.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (sortBy === 'created_desc') return b.createdAt - a.createdAt;
      if (sortBy === 'title_asc') return (a.title || '').localeCompare(b.title || '', dateLocale);
      return (b.contentUpdatedAt || b.updatedAt) - (a.contentUpdatedAt || a.updatedAt);
    });
    return copy;
  }, [scope, dedicatedNotes, allTextNotes, localFilter, globalSearchQuery, serverSearchIds, sortBy, dateLocale]);

  const pinnedNotes = useMemo(() => filteredNotes.filter((n) => n.isPinned), [filteredNotes]);
  const regularNotes = useMemo(() => filteredNotes.filter((n) => !n.isPinned), [filteredNotes]);

  // Respond to external Ctrl+N trigger while inside Notes
  const lastHandledDraftTriggerRef = useRef(createDraftTrigger);
  useEffect(() => {
    if (createDraftTrigger > lastHandledDraftTriggerRef.current) {
      lastHandledDraftTriggerRef.current = createDraftTrigger;
      setDraftItem(makeInlineDraftItem(defaultOrbitId, defaultFocusBoardId));
      setSelectedNoteId(null);
    }
  }, [createDraftTrigger, defaultOrbitId, defaultFocusBoardId]);

  // Keep a valid note selected when list changes
  const activeNote = useMemo(() => {
    if (draftItem) return draftItem;
    if (selectedNoteId) {
      const exact = filteredNotes.find((n) => n.id === selectedNoteId);
      if (exact) return exact;
      const fromAll = items.find((n) => n.id === selectedNoteId && !n.isArchived);
      if (fromAll && (fromAll.dna === 'note' || fromAll.dna === 'snippet' || fromAll.dna === 'doc')) {
        return fromAll;
      }
    }
    return filteredNotes[0] ?? null;
  }, [draftItem, selectedNoteId, filteredNotes, items]);

  const handleStartNewDraft = () => {
    setDraftItem(makeInlineDraftItem(defaultOrbitId, defaultFocusBoardId));
    setSelectedNoteId(null);
  };

  const handleSelectRow = (note: VaultItem) => {
    setDraftItem(null);
    setSelectedNoteId(note.id);
  };

  const buildRowContextMenu = (note: VaultItem): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [
      {
        type: 'item',
        id: 'pin',
        label: note.isPinned ? t('ui.quickLook.unpin') : t('cards.ctx.pinTop'),
        icon: <PushPin weight={note.isPinned ? 'fill' : 'regular'} className="w-3.5 h-3.5" />,
        onSelect: () => onTogglePin(note),
      },
    ];

    if (note.dna === 'note' || note.dna === 'snippet') {
      const inNotes = isDedicatedNote(note);
      entries.push({
        type: 'item',
        id: 'toggle-notes-hub',
        label: inNotes ? t('notes.hub.removeFromNotes') : t('notes.hub.addToNotes'),
        icon: <NotePencil className="w-3.5 h-3.5" />,
        onSelect: () => {
          if (inNotes && scope === 'dedicated' && selectedNoteId === note.id) {
            setSelectedNoteId(null);
          }
          onToggleNotesHub?.(note, !inNotes);
        },
      });
    }

    if (orbits.length > 0) {
      entries.push({
        type: 'submenu',
        id: 'move-orbit',
        label: t('cards.ctx.moveToSection'),
        icon: <FolderSimple className="w-3.5 h-3.5" />,
        items: orbits.map((o) => ({
          type: 'item',
          id: `orbit-${o.id}`,
          label: o.name,
          dotColor: o.color,
          active: note.orbit === o.id,
          onSelect: () => onMoveToOrbit(note.id, o.id),
        })),
      });
    }

    if (focusBoards.length > 0) {
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
            active: !note.focusBoardId,
            onSelect: () => onMoveToBoard(note.id, null),
          },
          ...focusBoards.map((b) => ({
            type: 'item' as const,
            id: `board-${b.id}`,
            label: b.name,
            dotColor: b.color,
            active: note.focusBoardId === b.id,
            onSelect: () => onMoveToBoard(note.id, b.id),
          })),
        ],
      });
    }

    entries.push(
      { type: 'separator', id: 'sep-1' },
      {
        type: 'item',
        id: 'duplicate',
        label: t('cards.ctx.duplicate'),
        icon: <Copy className="w-3.5 h-3.5" />,
        onSelect: () => onDuplicateItem(note.id),
      },
      {
        type: 'item',
        id: 'export',
        label: t('cards.ctx.exportMd'),
        icon: <FileText className="w-3.5 h-3.5" />,
        onSelect: () => onExportMarkdown(note.id),
      },
      { type: 'separator', id: 'sep-2' },
      {
        type: 'item',
        id: 'delete',
        label: t('workspace.moveToTrash'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: () => {
          if (selectedNoteId === note.id) setSelectedNoteId(null);
          onDeleteItem(note.id);
        },
      }
    );

    return entries;
  };

  const renderNoteRow = (note: VaultItem) => {
    const isActive = !draftItem && activeNote?.id === note.id;
    const orbit = note.orbit ? orbitMap.get(note.orbit) : undefined;
    const rawPreview = stripMarkdownPreview(note.body || note.summary);
    const preview = stripLeadingTitle(rawPreview, note.title);
    const trulyEmpty = !rawPreview.trim() && isUntitledPlaceholderTitle(note.title);
    const checklist = countChecklistStats(note.body);

    return (
      <ContextMenuSurface key={note.id} entries={buildRowContextMenu(note)}>
        <button
          type="button"
          data-testid={`notes-list-item-${note.id}`}
          onClick={() => handleSelectRow(note)}
          className={`group relative w-full text-left rounded-[12px] px-3 py-2.5 cursor-pointer transition-colors duration-140 ${
            isActive
              ? 'text-[var(--k-ink-primary)]'
              : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)]/75 hover:text-[var(--k-ink-primary)]'
          }`}
        >
          {isActive ? (
            <motion.span
              layoutId="notes-active-row"
              transition={
                prefersReduced
                  ? { duration: 0.08 }
                  : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }
              }
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[12px] bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] shadow-[var(--k-shadow-card)]"
            />
          ) : null}

          <div className="relative z-10 flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {note.isPinned ? (
                <PushPin
                  weight="fill"
                  className="w-3 h-3 text-[var(--k-accent)] shrink-0"
                />
              ) : null}
              <span
                className={`text-[13px] leading-snug truncate ${
                  isActive ? 'font-semibold text-[var(--k-ink-primary)]' : 'font-medium text-[var(--k-ink-primary)]'
                }`}
              >
                {note.title || t('common.noTitle')}
              </span>
            </div>

            {preview ? (
              <div className="text-[11.5px] leading-[1.45] text-[var(--k-ink-secondary)] line-clamp-2 break-words">
                {preview}
              </div>
            ) : trulyEmpty ? (
              <div className="text-[11.5px] text-[var(--k-ink-muted)] italic">{t('notes.hub.emptyNote')}</div>
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-0.5 text-[10.5px] text-[var(--k-ink-muted)]">
              <div className="flex items-center gap-1.5 min-w-0">
                {!defaultOrbitId && orbit ? (
                  <span className="inline-flex items-center gap-1 max-w-[116px] truncate">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: orbit.color }}
                    />
                    <span className="truncate">{orbit.name}</span>
                  </span>
                ) : null}

                {checklist.total > 0 ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.25 rounded-md bg-[var(--k-bg-surface-2)] text-[10px] k-tabular shrink-0">
                    <CheckSquare className="w-2.5 h-2.5 text-[var(--k-accent)]" />
                    <span>
                      {checklist.done}/{checklist.total}
                    </span>
                  </span>
                ) : null}
              </div>

              <span className="shrink-0 k-tabular">
                {formatRelativeDate(note.contentUpdatedAt || note.createdAt, locale)}
              </span>
            </div>
          </div>
        </button>
      </ContextMenuSurface>
    );
  };

  return (
    <div
      data-testid="notes-hub-view"
      className="h-full w-full min-h-0 flex overflow-hidden bg-[var(--k-bg-canvas)]"
    >
      {/* Left Document List Pane (smoothly animates width into distraction-free writing mode) */}
      <motion.aside
        data-testid="notes-list-pane"
        initial={false}
        animate={
          listVisible
            ? { width: 304, opacity: 1 }
            : { width: 0, opacity: 0 }
        }
        transition={
          prefersReduced
            ? { duration: 0.08 }
            : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }
        }
        style={{ pointerEvents: listVisible ? 'auto' : 'none' }}
        className={`shrink-0 h-full min-h-0 bg-[var(--k-bg-rail)]/55 flex flex-col overflow-hidden ${
          listVisible ? 'border-r border-[var(--k-border-hairline)]' : ''
        }`}
      >
        <div className="w-[304px] h-full min-h-0 flex flex-col overflow-hidden">
          {/* Header + Create */}
          <div className="px-3.5 pt-3 pb-2.5 border-b border-[var(--k-border-hairline)] space-y-2.5 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[12.5px] font-semibold text-[var(--k-ink-secondary)] truncate">
                  {t('notes.hub.title')}
                </span>
                <span className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-[var(--k-bg-surface-2)] text-[11px] font-medium text-[var(--k-ink-muted)] k-tabular">
                  <NumberFlow value={filteredNotes.length} />
                </span>
              </div>

              <button
                type="button"
                data-testid="notes-new-btn"
                onClick={handleStartNewDraft}
                className="k-interactive k-focus-ring inline-flex items-center gap-1 h-7.5 px-2.5 rounded-[9px] bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0"
              >
                <Plus weight="bold" className="w-3.5 h-3.5" />
                <span>{t('notes.hub.newBtn')}</span>
              </button>
            </div>

            {/* Scope switch: clean authored/structured notes vs all text including short Telegram scraps */}
            <SegmentedControl<NoteScope>
              size="sm"
              fullWidth
              value={scope}
              onChange={(next) => {
                setScope(next);
                setDraftItem(null);
              }}
              options={[
                { value: 'dedicated', label: t('notes.hub.tabMy', { count: dedicatedNotes.length }) },
                { value: 'all_text', label: t('notes.hub.tabAllText', { count: allTextNotes.length }) },
              ]}
            />

            {/* Compact filter + sort */}
            <div className="flex items-center gap-1.5">
              <div className="flex-1 min-w-0 flex items-center gap-1.5 h-7.5 px-2.5 rounded-[9px] border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] focus-within:border-[var(--k-border-focus)] transition-colors">
                <MagnifyingGlass className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                <input
                  type="text"
                  data-testid="notes-list-search"
                  value={localFilter}
                  onChange={(e) => setLocalFilter(e.target.value)}
                  placeholder={t('notes.hub.filterPlaceholder')}
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
                />
                {localFilter ? (
                  <button
                    type="button"
                    aria-label={t('common.clearFilter')}
                    onClick={() => setLocalFilter('')}
                    className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                  >
                    <X weight="bold" className="w-3 h-3" />
                  </button>
                ) : null}
              </div>

              <SelectMenu
                size="sm"
                align="end"
                value={sortBy}
                onChange={(v) => setSortBy(v as NoteSortMode)}
                className="w-[108px] shrink-0"
                options={[
                  { value: 'updated_desc', label: t('notes.hub.sortRecent') },
                  { value: 'created_desc', label: t('notes.hub.sortNew') },
                  { value: 'title_asc', label: t('notes.hub.sortAlpha') },
                ]}
              />
            </div>
          </div>

          {/* Scrollable Notes List */}
          <div className="flex-1 min-h-0 overflow-y-auto k-scroll-stable p-2 space-y-1">
            {draftItem ? (
              <div
                data-testid="notes-draft-row"
                className="rounded-[12px] px-3 py-2.5 bg-[var(--k-accent-soft)] border border-[var(--k-accent)]/35"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-[var(--k-accent)] truncate">
                    {t('notes.hub.draftTitle')}
                  </span>
                  <span className="text-[10.5px] text-[var(--k-accent)]/80 shrink-0">{t('notes.hub.draftBadge')}</span>
                </div>
                <div className="text-[11px] text-[var(--k-ink-secondary)] mt-0.5">
                  {t('notes.hub.draftHint')}
                </div>
              </div>
            ) : null}

            {filteredNotes.length === 0 && !draftItem ? (
              <div className="px-3 py-10 text-center space-y-2.5">
                <div className="w-9 h-9 mx-auto rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-muted)] flex items-center justify-center">
                  <NotePencil className="w-4.5 h-4.5" />
                </div>
                <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                  {localFilter.trim() || globalSearchQuery.trim()
                    ? t('notes.hub.emptySearch')
                    : scope === 'dedicated'
                      ? t('notes.hub.emptyMy')
                      : t('notes.hub.emptyAll')}
                </div>
                <p className="m-0 text-[11.5px] leading-relaxed text-[var(--k-ink-muted)]">
                  {scope === 'dedicated' && allTextNotes.length > 0 && !localFilter.trim()
                    ? t('notes.hub.emptyHintMy')
                    : t('notes.hub.emptyHintAll')}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={handleStartNewDraft}
                    className="k-interactive inline-flex items-center justify-center gap-1 h-7.5 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11.5px] font-medium cursor-pointer"
                  >
                    <Plus weight="bold" className="w-3 h-3" />
                    <span>{t('workspace.createNote')}</span>
                  </button>
                  {scope === 'dedicated' && allTextNotes.length > 0 && !localFilter.trim() ? (
                    <button
                      type="button"
                      data-testid="notes-switch-all-text"
                      onClick={() => setScope('all_text')}
                      className="k-interactive inline-flex items-center justify-center h-7.5 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                    >
                      {t('notes.hub.allTextHeading', { count: allTextNotes.length })}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                {pinnedNotes.length > 0 ? (
                  <div className="space-y-1">
                    <div className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      {t('notes.hub.pinnedGroup')}
                    </div>
                    {pinnedNotes.map(renderNoteRow)}
                  </div>
                ) : null}

                {regularNotes.length > 0 ? (
                  <div className="space-y-1">
                    {pinnedNotes.length > 0 ? (
                      <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                        {t('notes.hub.otherGroup')}
                      </div>
                    ) : null}
                    {regularNotes.map(renderNoteRow)}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </motion.aside>

      {/* Right Full-Height Inline Document Editor */}
      <div data-testid="notes-editor-pane" className="flex-1 min-w-0 h-full min-h-0 flex flex-col">
        {activeNote ? (
          <NoteStudio
            item={activeNote}
            isDraft={Boolean(draftItem)}
            orbits={orbits}
            focusBoards={focusBoards}
            allItemsForLinks={allItemsForLinks ?? items}
            soundEnabled={soundEnabled}
            layoutMode={listVisible ? 'center' : 'full'}
            leadingBarSlot={
              <TooltipHint label={listVisible ? t('notes.hub.hideList') : t('notes.hub.showList')}>
                <button
                  type="button"
                  data-testid="notes-toggle-list-btn"
                  onClick={() => setListVisible((v) => !v)}
                  aria-label={listVisible ? t('notes.hub.hideList') : t('notes.hub.showList')}
                  className={`k-interactive inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg border cursor-pointer shrink-0 ${
                    listVisible
                      ? 'border-transparent text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                      : 'border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                  }`}
                >
                  <SidebarSimple className="w-4 h-4" />
                </button>
              </TooltipHint>
            }
            onItemUpdated={onItemUpdated}
            onDraftPersisted={(created) => {
              setDraftItem(null);
              setSelectedNoteId(created.id);
              onDraftPersisted(created);
            }}
            onCancelDraft={() => setDraftItem(null)}
            onSelectRelatedItem={(related) => {
              if (related.dna === 'note' || related.dna === 'snippet' || related.dna === 'doc') {
                setDraftItem(null);
                setSelectedNoteId(related.id);
                if (!isDedicatedNote(related) && scope === 'dedicated') {
                  setScope('all_text');
                }
              } else {
                onOpenExternalItem(related);
              }
            }}
            onDelete={(id) => {
              if (selectedNoteId === id) setSelectedNoteId(null);
              onDeleteItem(id);
            }}
            onOpenShotLightbox={onOpenShotLightbox}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-[var(--k-bg-surface-1)]/40">
            <div className="w-13 h-13 rounded-2xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center mb-3.5">
              <NotePencil weight="duotone" className="w-7 h-7" />
            </div>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-[var(--k-ink-primary)]">
              {t('notes.hub.stageTitle')}
            </h2>
            <p className="mt-1.5 mb-5 text-[13px] text-[var(--k-ink-secondary)] max-w-[380px] leading-relaxed">
              {t('notes.hub.stageDesc')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                data-testid="notes-empty-create-btn"
                onClick={handleStartNewDraft}
                className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer"
              >
                <Plus weight="bold" className="w-4 h-4" />
                <span>{t('workspace.createNote')}</span>
              </button>
              {scope === 'dedicated' && allTextNotes.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setScope('all_text')}
                  className="k-interactive inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                >
                  <span>{t('notes.hub.openImports', { count: allTextNotes.length })}</span>
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
