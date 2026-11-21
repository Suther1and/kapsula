import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  FolderPlus,
  Gear,
  GitMerge,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type {
  OrbitDef,
  TriageMergeProposal,
  TriageNewOrbitProposal,
  TriagePreviewResult,
  TriageSuggestion,
} from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { friendlyErrorMessage } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { ModalDialog } from '../ui/ModalDialog';
import { SelectMenu } from '../ui/SelectMenu';

interface SmartTriageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orbits: OrbitDef[];
  onApplied: () => Promise<void> | void;
  onOpenAiSettings: () => void;
  onRequestMergeGroup?: (group: TriageMergeProposal) => void;
}

export const SmartTriageModal: React.FC<SmartTriageModalProps> = ({
  open,
  onOpenChange,
  orbits,
  onApplied,
  onOpenAiSettings,
  onRequestMergeGroup,
}) => {
  const { t, locale, pluralNoun } = useI18n();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<TriagePreviewResult | null>(null);
  const [selectedMoveIds, setSelectedMoveIds] = useState<Set<string>>(new Set());
  const [orbitOverrides, setOrbitOverrides] = useState<Record<string, string>>({});
  const [selectedNewOrbits, setSelectedNewOrbits] = useState<Set<string>>(new Set());

  const runPreview = async () => {
    setLoading(true);
    try {
      const res = await window.kapsula.previewSmartTriage();
      setPreview(res);
      const moveSet = new Set<string>();
      const overrides: Record<string, string> = {};
      for (const s of res.suggestions) {
        moveSet.add(s.itemId);
        overrides[s.itemId] = s.targetOrbit ?? s.currentOrbit ?? '';
      }
      setSelectedMoveIds(moveSet);
      setOrbitOverrides(overrides);
      setSelectedNewOrbits(new Set(res.newOrbits.map((o) => o.name)));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('triage.previewErr'), locale));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void runPreview();
    }
  }, [open]);

  const handleApply = async () => {
    if (!preview || applying) return;
    setApplying(true);
    try {
      const moves = preview.suggestions
        .filter((s: TriageSuggestion) => selectedMoveIds.has(s.itemId))
        .map((s) => ({
          itemId: s.itemId,
          orbit: orbitOverrides[s.itemId] ?? s.targetOrbit ?? undefined,
          focusBoardId: s.targetBoardId ?? undefined,
          tags: s.suggestedTags,
          archive: s.archive,
        }));
      const createOrbits: TriageNewOrbitProposal[] = preview.newOrbits.filter((o) =>
        selectedNewOrbits.has(o.name)
      );

      const res = await window.kapsula.applySmartTriage({ moves, createOrbits });
      await onApplied();
      onOpenChange(false);
      toast.success(t('triage.appliedToast', { count: res.applied }));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('triage.applyErr'), locale));
    } finally {
      setApplying(false);
    }
  };

  const orbitOptions = [
    { value: '', label: t('nav.leaveWithoutSection') },
    ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
  ];
  const orbitNameMap = new Map(orbits.map((o) => [o.id, o.name]));

  const totalActions =
    selectedMoveIds.size +
    (preview?.newOrbits.filter((o) => selectedNewOrbits.has(o.name)).length ?? 0);

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      topAligned
      title={t('triage.title')}
      subtitle={t('triage.subtitle')}
      maxWidthClass="max-w-[700px]"
    >
      <div className="p-5 flex flex-col gap-4 max-h-[76vh] overflow-y-auto k-scroll-stable">
        {loading ? (
          <div className="py-2 flex flex-col gap-2.5">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--k-ink-secondary)] px-1">
              <Sparkle weight="fill" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
              <span>{t('triage.analyzing')}</span>
            </div>
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="h-14 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] animate-pulse px-4 flex items-center justify-between gap-4"
              >
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-48 rounded bg-[var(--k-bg-surface-3)]" />
                  <div className="h-2.5 w-72 rounded bg-[var(--k-bg-surface-3)]/70" />
                </div>
                <div className="h-7 w-32 rounded-lg bg-[var(--k-bg-surface-3)] shrink-0" />
              </div>
            ))}
          </div>
        ) : preview && !preview.configured ? (
          <div className="rounded-2xl border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] p-5 flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--k-ink-primary)]">
              <WarningCircle weight="fill" className="w-5 h-5 text-[var(--k-amber)] shrink-0" />
              <span>{t('triage.needAiTitle')}</span>
            </div>
            <p className="m-0 text-[13px] text-[var(--k-ink-secondary)] leading-relaxed">
              {preview.message && !/регулярк/i.test(preview.message)
                ? preview.message
                : t('triage.needAiFallback')}
            </p>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onOpenAiSettings();
              }}
              className="k-interactive inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer"
            >
              <Gear className="w-4 h-4" />
              <span>{t('triage.openAiSettings')}</span>
            </button>
          </div>
        ) : preview ? (
          <>
            {preview.message &&
            preview.suggestions.length === 0 &&
            preview.newOrbits.length === 0 &&
            preview.mergeGroups.length === 0 ? (
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-5 flex flex-col items-center gap-3 text-center">
                <div className="text-[13px] text-[var(--k-ink-secondary)]">{preview.message}</div>
                {preview.remainingCount && preview.remainingCount > 0 ? (
                  <div className="text-[12px] text-[var(--k-ink-muted)]">
                    {t('triage.remainingNotice', {
                      count: preview.remainingCount,
                      word: pluralNoun(preview.remainingCount, 'item').replace(/^\d+\s+/, ''),
                    })}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void runPreview()}
                  className="k-interactive h-8 px-3.5 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[12.5px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-accent)] cursor-pointer"
                >
                  {t('triage.retryBtn')}
                </button>
              </div>
            ) : null}

            {preview.message &&
            (preview.suggestions.length > 0 ||
              preview.newOrbits.length > 0 ||
              preview.mergeGroups.length > 0) ? (
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2 text-[12px] text-[var(--k-ink-secondary)]">
                {preview.message}
              </div>
            ) : preview.remainingCount &&
              preview.remainingCount > 0 &&
              (preview.suggestions.length > 0 ||
                preview.newOrbits.length > 0 ||
                preview.mergeGroups.length > 0) ? (
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2 text-[12px] text-[var(--k-ink-secondary)]">
                {t('triage.batchNotice', { count: preview.remainingCount })}
              </div>
            ) : null}

            {/* Move Suggestions */}
            {preview.suggestions.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  {t('triage.suggestionsHeader', { count: preview.suggestions.length })}
                </div>
                {preview.suggestions.map((s) => {
                  const checked = selectedMoveIds.has(s.itemId);
                  const prevOrbitName = s.currentOrbit ? orbitNameMap.get(s.currentOrbit) : null;
                  const chosenOrbit = orbitOverrides[s.itemId] ?? s.targetOrbit ?? s.currentOrbit ?? '';
                  const changedOrbit = Boolean(prevOrbitName && chosenOrbit !== s.currentOrbit);
                  return (
                    <div
                      key={s.itemId}
                      className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5"
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <AnimatedCheckbox
                          size="sm"
                          checked={checked}
                          onChange={(next) => {
                            setSelectedMoveIds((prev) => {
                              const copy = new Set(prev);
                              if (next) copy.add(s.itemId);
                              else copy.delete(s.itemId);
                              return copy;
                            });
                          }}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] font-medium truncate text-[var(--k-ink-primary)] max-w-full">
                              {s.itemTitle}
                            </span>
                            {s.targetBoardName ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--k-accent-soft)] text-[10.5px] font-medium text-[var(--k-accent)] shrink-0">
                                {t('triage.addBoardLabel', { name: s.targetBoardName })}
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate mt-0.5">
                            {s.archive
                              ? t('triage.suggestedArchive')
                              : changedOrbit
                                ? t('triage.fromSection', { name: prevOrbitName || '' })
                                : ''}
                            {s.reason}
                          </div>
                        </div>
                      </div>

                      {!s.archive ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <ArrowRight className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                          <SelectMenu
                            size="sm"
                            value={chosenOrbit}
                            onChange={(val) =>
                              setOrbitOverrides((prev) => ({ ...prev, [s.itemId]: val }))
                            }
                            options={orbitOptions}
                            className="min-w-[165px]"
                          />
                        </div>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md bg-[var(--k-amber-soft)] text-[11px] font-medium text-[var(--k-amber)]">
                          {t('triage.archiveOption')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* New Section Proposals */}
            {preview.newOrbits.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  {t('triage.newSectionsHeader')}
                </div>
                {preview.newOrbits.map((no) => {
                  const checked = selectedNewOrbits.has(no.name);
                  return (
                    <div
                      key={no.name}
                      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <AnimatedCheckbox
                          size="sm"
                          checked={checked}
                          onChange={(next) => {
                            setSelectedNewOrbits((prev) => {
                              const copy = new Set(prev);
                              if (next) copy.add(no.name);
                              else copy.delete(no.name);
                              return copy;
                            });
                          }}
                        />
                        <FolderPlus className="w-4 h-4 shrink-0" style={{ color: no.color }} />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium truncate">{no.name}</div>
                          <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                            {t('triage.newSectionCount', { desc: no.description, count: no.itemIds.length })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Merge Groups */}
            {preview.mergeGroups.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  {t('triage.mergeHeader')}
                </div>
                {preview.mergeGroups.map((mg) => (
                  <div
                    key={mg.title}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-accent)]/25 bg-[var(--k-accent-soft)]/50 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{mg.title}</div>
                      <div className="text-[11.5px] text-[var(--k-ink-secondary)] truncate">
                        {t('triage.mergeReason', {
                          count: mg.itemIds.length,
                          word: pluralNoun(mg.itemIds.length, 'item').replace(/^\d+\s+/, ''),
                          reason: mg.reason,
                        })}
                      </div>
                    </div>
                    {onRequestMergeGroup ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          onRequestMergeGroup(mg);
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium shrink-0 cursor-pointer"
                      >
                        <GitMerge className="w-3.5 h-3.5" />
                        <span>{t('triage.mergeBtn')}</span>
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--k-border-hairline)]">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
              >
                {t('common.close')}
              </button>
              <button
                type="button"
                disabled={applying || totalActions === 0}
                onClick={() => void handleApply()}
                className="k-interactive inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
              >
                <Sparkle weight="fill" className="w-3.5 h-3.5" />
                <span>{applying ? t('common.applying') : t('triage.applyBtn', { count: totalActions })}</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </ModalDialog>
  );
};
