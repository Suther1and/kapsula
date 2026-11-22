import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  CheckSquare,
  Copy,
  DotsThree,
  FolderSimple,
  NotePencil,
  Plus,
  PushPin,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { isAnyTextNote, isDedicatedNote } from '@shared/item-helpers';
import { parseMarkdownTasks } from '@shared/task-helpers';
import type { FocusBoard, ItemRevision, OrbitDef, VaultItem } from '@shared/types';
import { stripLeadingTitle } from '@renderer/lib/format';
import { useMobileI18n } from '../lib/mobile-i18n';
import { filterItemsByQuery, stripMobileInlineMarkdown } from '../lib/mobile-helpers';
import { mobileBridge } from '../native/bridge';
import { ItemActionSheet, type ActionSheetEntry } from './ItemActionSheet';
import {
  DRAFT_NOTE_ID,
  MobileNoteEditor,
  type MaterializeDraftInput,
  type NoteDraftBuffer,
} from './MobileNoteEditor';
import { MobilePickerSheet } from './MobilePickerSheet';
import { SwipeableRow } from './SwipeableRow';

interface NotesViewProps {
  items: VaultItem[];
  orbits: OrbitDef[];
  boards: FocusBoard[];
  isExpanded: boolean;
  hingeListWidthPx?: number | null;
  hingeRightOffsetPx?: number;
  searchQuery: string;
  selectedOrbitId: string | null;
  activeNoteId: string | null;
  noteDrafts: Record<string, NoteDraftBuffer>;
  ensureMediaUrl: (localName?: string | null) => Promise<string | null>;
  flushEditorRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onSelectOrbit: (id: string | null) => void;
  onSelectNote: (id: string | null) => void;
  onOpenImage: (src: string, caption?: string) => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
  onCreateBoard?: (name: string, color: string) => Promise<string>;
  onMaterializeDraft: (input: MaterializeDraftInput) => Promise<VaultItem>;
  onDraftChange: (itemId: string, draft: NoteDraftBuffer) => void;
  onDraftSaved: (itemId: string, savedRev: number) => void;
  onSaveNote: (
    itemId: string,
    patch: Partial<
      Pick<
        VaultItem,
        'title' | 'body' | 'orbit' | 'focusBoardId' | 'isPinned' | 'tags' | 'remindAt' | 'linksOut'
      >
    >
  ) => Promise<void>;
  onInsertInlinePhoto?: (source: 'camera' | 'gallery') => Promise<string | null>;
  onAttachPhoto: (itemId: string, source: 'camera' | 'gallery') => Promise<void>;
  listRevisions?: (itemId: string) => ItemRevision[];
  onRevertRevision?: (itemId: string, revisionId: string) => Promise<VaultItem | null>;
  onTranscribeVoice?: (item: VaultItem) => Promise<void>;
  onExtractTasks?: (item: VaultItem) => Promise<void>;
  onPolishNote?: (item: VaultItem) => Promise<void>;
  onOpenExternalItem?: (itemId: string) => void;
  onDeleteNote: (itemId: string) => Promise<void>;
}

const MOBILE_PAGE_SIZE = 60;

function makeVirtualDraftItem(orbitId: string): VaultItem {
  const now = Date.now();
  return {
    id: DRAFT_NOTE_ID,
    dna: 'note',
    subKind: null,
    orbit: orbitId,
    modeCaptured: 'autopilot',
    focusBoardId: null,
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
    mediaMeta: null,
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
    syncVersion: 1,
  };
}

export const NotesView: React.FC<NotesViewProps> = ({
  items,
  orbits,
  boards,
  isExpanded,
  hingeListWidthPx,
  hingeRightOffsetPx = 0,
  searchQuery,
  selectedOrbitId,
  activeNoteId,
  noteDrafts,
  ensureMediaUrl,
  flushEditorRef,
  onSelectOrbit,
  onSelectNote,
  onOpenImage,
  onCreateOrbit,
  onCreateBoard,
  onMaterializeDraft,
  onDraftChange,
  onDraftSaved,
  onSaveNote,
  onInsertInlinePhoto,
  onAttachPhoto,
  listRevisions,
  onRevertRevision,
  onTranscribeVoice,
  onExtractTasks,
  onPolishNote,
  onOpenExternalItem,
  onDeleteNote,
}) => {
  const { t, formatDateCompact } = useMobileI18n();
  const prefersReduced = useReducedMotion();
  const [scope, setScope] = useState<'dedicated' | 'all_text'>('dedicated');
  const [actionNote, setActionNote] = useState<VaultItem | null>(null);
  const [orbitPickerNote, setOrbitPickerNote] = useState<VaultItem | null>(null);
  const activeNoteIdRef = useRef(activeNoteId);
  activeNoteIdRef.current = activeNoteId;

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);

  const notes = useMemo(() => {
    let list = items.filter((it) => {
      if (it.id === activeNoteId && it.dna !== 'secret') return true;
      return scope === 'dedicated' ? isDedicatedNote(it) : isAnyTextNote(it);
    });
    if (selectedOrbitId) {
      list = list.filter((it) => it.orbit === selectedOrbitId || it.id === activeNoteId);
    }
    return filterItemsByQuery(list, searchQuery);
  }, [items, scope, selectedOrbitId, searchQuery, activeNoteId]);

  const [visibleCount, setVisibleCount] = useState(MOBILE_PAGE_SIZE);
  const notesSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(MOBILE_PAGE_SIZE);
  }, [scope, selectedOrbitId, searchQuery]);

  const renderedNotes = useMemo(
    () => notes.slice(0, visibleCount),
    [notes, visibleCount]
  );

  useEffect(() => {
    if (visibleCount >= notes.length) return;
    const el = notesSentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) => Math.min(notes.length, prev + MOBILE_PAGE_SIZE));
        }
      },
      { rootMargin: '300px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, notes.length]);

  const virtualDraft = useMemo(
    () => makeVirtualDraftItem(selectedOrbitId || ''),
    [selectedOrbitId]
  );

  const activeNote = useMemo(() => {
    if (!activeNoteId) return null;
    if (activeNoteId === DRAFT_NOTE_ID) return virtualDraft;
    return items.find((it) => it.id === activeNoteId && it.dna !== 'secret') ?? null;
  }, [items, activeNoteId, virtualDraft]);

  // On expanded Fold screen, auto-select the first note in the right pane if none is selected
  useEffect(() => {
    if (isExpanded && !activeNote && notes.length > 0) {
      onSelectNote(notes[0]!.id);
    }
  }, [isExpanded, activeNote, notes, onSelectNote]);

  // Deferred creation: opens virtual empty draft WITHOUT writing anything to store/cloud!
  const handleNewNote = () => {
    mobileBridge.haptic('light');
    onSelectNote(DRAFT_NOTE_ID);
  };

  const buildNoteActions = (note: VaultItem): ActionSheetEntry[] => [
    {
      id: 'pin',
      label: note.isPinned ? t('common.unpin') : t('common.pinTop'),
      icon: <PushPin weight={note.isPinned ? 'fill' : 'regular'} className="w-5 h-5" />,
      accent: note.isPinned,
      onSelect: () => {
        void onSaveNote(note.id, { isPinned: !note.isPinned });
        toast(note.isPinned ? t('common.unpinnedToast') : t('common.pinnedToast'));
      },
    },
    {
      id: 'orbit',
      label: t('feed.moveToOrbit'),
      subtitle: note.orbit ? orbitMap.get(note.orbit)?.name : t('common.noOrbit'),
      icon: <FolderSimple className="w-5 h-5" />,
      onSelect: () => setOrbitPickerNote(note),
    },
    {
      id: 'copy',
      label: t('feed.copyText'),
      icon: <Copy className="w-5 h-5" />,
      onSelect: () => {
        const text = [note.title, note.body].filter(Boolean).join('\n\n');
        void mobileBridge.copyPlain(text);
        toast.success(t('common.copied'));
      },
    },
    {
      id: 'delete',
      label: t('notes.deleteNote'),
      icon: <Trash className="w-5 h-5" />,
      danger: true,
      onSelect: () => {
        if (activeNoteId === note.id) {
          const next = notes.find((n) => n.id !== note.id);
          onSelectNote(isExpanded ? next?.id ?? null : null);
        }
        void onDeleteNote(note.id);
      },
    },
  ];

  const showListPane = isExpanded || !activeNote;
  const showEditorPane = isExpanded || Boolean(activeNote);

  return (
    <div data-testid="mobile-notes-view" className="flex h-full min-h-0">
      {/* Left / Compact Notes List */}
      <div
        data-testid="notes-list-pane"
        style={
          isExpanded && hingeListWidthPx
            ? { width: `${Math.max(240, Math.min(420, hingeListWidthPx))}px` }
            : undefined
        }
        className={`${showListPane ? 'flex' : 'hidden'} flex-col h-full min-h-0 ${
          isExpanded
            ? `${hingeListWidthPx ? '' : 'w-[285px] lg:w-[320px]'} shrink-0 border-r border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)]`
            : 'flex-1 min-w-0'
        }`}
      >
        <div className="px-3.5 pt-2.5 pb-2 space-y-2 border-b border-[var(--k-border-hairline)] shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex p-0.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
              {(
                [
                  { id: 'dedicated', label: t('notes.modeDedicated') },
                  { id: 'all_text', label: t('notes.modeAllText') },
                ] as const
              ).map((s) => {
                const active = scope === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setScope(s.id);
                    }}
                    className={`relative px-2.5 py-1 rounded-[10px] text-[12px] font-medium transition-colors ${
                      active ? 'text-[var(--k-ink-primary)]' : 'text-[var(--k-ink-muted)]'
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="k-notes-scope-pill"
                        transition={
                          prefersReduced
                            ? { duration: 0.01 }
                            : { type: 'spring', stiffness: 480, damping: 35 }
                        }
                        className="absolute inset-0 rounded-[10px] bg-[var(--k-bg-surface-1)] shadow-xs"
                      />
                    ) : null}
                    <span className="relative z-10">{s.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              data-testid="notes-create-btn"
              onClick={handleNewNote}
              className="k-tap inline-flex items-center gap-1 px-3 h-8 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold"
            >
              <Plus weight="bold" className="w-3.5 h-3.5" />
              {t('notes.newShort')}
            </button>
          </div>

          {orbits.length > 0 ? (
            <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar k-scroll-fade-r pr-4 pb-0.5">
              <button
                type="button"
                onClick={() => onSelectOrbit(null)}
                className={`k-tap px-2.5 py-1 rounded-xl text-[11.5px] font-medium shrink-0 border ${
                  selectedOrbitId === null
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                }`}
              >
                {t('notes.allOrbits')}
              </button>
              {orbits.map((orbit) => (
                <button
                  key={orbit.id}
                  type="button"
                  onClick={() => onSelectOrbit(selectedOrbitId === orbit.id ? null : orbit.id)}
                  className={`k-tap inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11.5px] font-medium shrink-0 border ${
                    selectedOrbitId === orbit.id
                      ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: orbit.color }} />
                  {orbit.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex-1 min-h-0 k-scroll p-3 pb-28 k-m-list">
          {notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-14 px-5">
              <NotePencil weight="duotone" className="w-8 h-8 text-[var(--k-ink-muted)] mb-2.5" />
              <div className="text-[14.5px] font-semibold text-[var(--k-ink-primary)]">
                {t('notes.emptyTitle')}
              </div>
              <p className="text-[12.5px] text-[var(--k-ink-muted)] mt-1">
                {t('notes.emptyHint')}
              </p>
              <button
                type="button"
                onClick={handleNewNote}
                className="k-tap mt-4 inline-flex items-center gap-1.5 px-4 h-10 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold"
              >
                <Plus weight="bold" className="w-4 h-4" />
                {t('notes.createNote')}
              </button>
            </div>
          ) : (
            renderedNotes.map((note) => {
              const draft = noteDrafts[note.id];
              const displayBody = draft?.body ?? note.body ?? '';
              const explicitTitle = (draft?.title ?? note.title ?? '').trim();
              const displayTitle =
                explicitTitle ||
                displayBody.trim().split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 80) ||
                t('common.untitledNote');
              const snippet = stripLeadingTitle(stripMobileInlineMarkdown(displayBody), displayTitle);
              const mdTasks = !snippet ? parseMarkdownTasks(displayBody) : [];
              const mdDoneCount = mdTasks.filter((task) => task.done).length;
              const voiceActions = !snippet ? note.mediaMeta?.actionItems ?? [] : [];
              const voiceDoneCount = (note.mediaMeta?.checkedActionIndices ?? []).length;
              const totalTasksCount = mdTasks.length + voiceActions.length;
              const doneTasksCount = mdDoneCount + voiceDoneCount;
              const hasAttachment = Boolean(
                note.imagePath || note.mediaPath || /!\[[^\]]*\]\(/.test(displayBody)
              );
              const orbit = note.orbit ? orbitMap.get(note.orbit) : null;
              const selected = activeNote?.id === note.id;

              return (
                <SwipeableRow
                  key={note.id}
                  onLongPress={() => setActionNote(note)}
                  leftAction={{
                    label: note.isPinned ? t('common.unpin') : t('common.pin'),
                    icon: <PushPin weight="fill" className="w-4 h-4" />,
                    bgClass: 'bg-[var(--k-accent)]',
                    textClass: 'text-[var(--k-ink-on-accent)]',
                    onTrigger: () => {
                      void onSaveNote(note.id, { isPinned: !note.isPinned });
                      toast(note.isPinned ? t('common.unpinnedToast') : t('common.pinnedToast'));
                    },
                  }}
                  rightAction={{
                    label: t('common.delete'),
                    icon: <Trash weight="fill" className="w-4 h-4" />,
                    bgClass: 'bg-[var(--k-danger)]',
                    onTrigger: () => {
                      if (activeNoteId === note.id) {
                        const next = notes.find((n) => n.id !== note.id);
                        onSelectNote(isExpanded ? next?.id ?? null : null);
                      }
                      void onDeleteNote(note.id);
                    },
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    data-testid={`note-row-${note.id}`}
                    onClick={() => onSelectNote(note.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectNote(note.id);
                      }
                    }}
                    className={`w-full text-left rounded-2xl k-m-card border transition-colors cursor-pointer ${
                      selected && isExpanded
                        ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-focus)]'
                        : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                        {displayTitle}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--k-ink-muted)] shrink-0">
                        {note.isPinned ? (
                          <PushPin weight="fill" className="w-3 h-3 text-[var(--k-accent)]" />
                        ) : null}
                        {formatDateCompact(note.contentUpdatedAt || note.createdAt)}
                        <button
                          type="button"
                          data-testid={`note-row-more-${note.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            mobileBridge.haptic('light');
                            setActionNote(note);
                          }}
                          aria-label={t('notes.actionsAria')}
                          className="inline-flex items-center justify-center w-9 h-9 -mr-2 -my-1.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]"
                        >
                          <DotsThree weight="bold" className="w-4 h-4" />
                        </button>
                      </span>
                    </div>

                    {snippet ? (
                      <p className="text-[12.5px] text-[var(--k-ink-secondary)] line-clamp-2 leading-snug">
                        {snippet}
                      </p>
                    ) : totalTasksCount > 0 ? (
                      <p className="inline-flex items-center gap-1.5 text-[12px] text-[var(--k-ink-secondary)]">
                        <CheckSquare className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                        <span>
                          {totalTasksCount === 1
                            ? doneTasksCount === 1
                              ? t('notes.taskDone')
                              : t('notes.taskOpen')
                            : t('notes.tasksProgress', { done: doneTasksCount, total: totalTasksCount })}
                        </span>
                      </p>
                    ) : hasAttachment ? (
                      <p className="text-[12px] text-[var(--k-ink-muted)]">{t('common.attachment')}</p>
                    ) : (
                      <p className="text-[12px] text-[var(--k-ink-muted)] italic">{t('notes.emptyNoteItalic')}</p>
                    )}

                    {orbit ? (
                      <div className="mt-2 flex items-center gap-1.5">
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10.5px] font-medium text-[var(--k-ink-primary)]"
                          style={{
                            background: `color-mix(in srgb, ${orbit.color} 13%, transparent)`,
                            borderColor: `color-mix(in srgb, ${orbit.color} 28%, transparent)`,
                          }}
                        >
                          <FolderSimple
                            weight="fill"
                            className="w-3 h-3 shrink-0"
                            style={{ color: orbit.color }}
                          />
                          {orbit.name}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </SwipeableRow>
              );
            })
          )}
          {visibleCount < notes.length ? (
            <div ref={notesSentinelRef} aria-hidden="true" className="h-4 w-full" />
          ) : null}
        </div>
      </div>

      {/* Continuous Single-Mount Editor Pane (never unmounts on Fold compact <-> expanded!) */}
      <div
        data-testid={
          !isExpanded && activeNote
            ? 'mobile-notes-fullscreen-editor'
            : 'notes-editor-split-pane'
        }
        className={`${showEditorPane ? 'flex flex-col' : 'hidden'} flex-1 min-w-0 h-full min-h-0 overflow-hidden`}
      >
        {activeNote ? (
          <MobileNoteEditor
            item={activeNote}
            allItems={items}
            draft={noteDrafts[activeNote.id]}
            orbits={orbits}
            boards={boards}
            showBackButton={!isExpanded}
            isExpanded={isExpanded}
            hingeRightOffsetPx={hingeRightOffsetPx}
            ensureMediaUrl={ensureMediaUrl}
            flushRef={flushEditorRef}
            onOpenImage={onOpenImage}
            onOpenItem={(targetId) => {
              const target = items.find((i) => i.id === targetId);
              if (target && target.dna !== 'secret') {
                onSelectNote(target.id);
              } else if (onOpenExternalItem) {
                onOpenExternalItem(targetId);
              }
            }}
            onCreateOrbit={onCreateOrbit}
            onCreateBoard={onCreateBoard}
            onMaterializeDraft={async (input) => {
              const created = await onMaterializeDraft(input);
              if (activeNoteIdRef.current === DRAFT_NOTE_ID) {
                onSelectNote(created.id);
              }
              return created;
            }}
            onDraftChange={onDraftChange}
            onDraftSaved={onDraftSaved}
            onSave={onSaveNote}
            onInsertInlinePhoto={onInsertInlinePhoto}
            onAttachPhoto={onAttachPhoto}
            listRevisions={listRevisions}
            onRevertRevision={onRevertRevision}
            onTranscribeVoice={onTranscribeVoice}
            onExtractTasks={onExtractTasks}
            onPolishNote={onPolishNote}
            onDelete={async (id) => {
              await onDeleteNote(id);
              const next = notes.find((n) => n.id !== id);
              onSelectNote(isExpanded ? next?.id ?? null : null);
            }}
            onBack={() => onSelectNote(null)}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[var(--k-ink-muted)]">
            <NotePencil weight="duotone" className="w-10 h-10 mb-3 opacity-70" />
            <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
              {t('notes.selectPrompt')}
            </div>
            <button
              type="button"
              onClick={handleNewNote}
              className="k-tap mt-4 inline-flex items-center gap-1.5 px-4 h-10 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold"
            >
              <Plus weight="bold" className="w-4 h-4" />
              {t('notes.newFull')}
            </button>
          </div>
        )}
      </div>

      {/* Long-Press Action Sheet */}
      <ItemActionSheet
        open={Boolean(actionNote)}
        title={actionNote?.title || t('notes.fallbackTitle')}
        actions={actionNote ? buildNoteActions(actionNote) : []}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setActionNote(null)}
      />

      {/* Move to Section Sheet */}
      <MobilePickerSheet
        open={Boolean(orbitPickerNote)}
        title={t('feed.moveToOrbit')}
        value={orbitPickerNote?.orbit || ''}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateOrbit)}
        createPlaceholder={t('common.orbitNamePlaceholder')}
        onCreateNew={onCreateOrbit}
        options={[
          { value: '', label: t('common.noOrbit') },
          ...orbits.map((o) => ({
            value: o.id,
            label: o.name,
            color: o.color,
            count: o.itemCount,
          })),
        ]}
        onSelect={(val) => {
          if (!orbitPickerNote) return;
          void onSaveNote(orbitPickerNote.id, { orbit: val });
          toast.success(t('common.orbitUpdated'));
        }}
        onClose={() => setOrbitPickerNote(null)}
      />
    </div>
  );
};
