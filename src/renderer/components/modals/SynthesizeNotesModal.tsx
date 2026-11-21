import React, { useEffect, useState } from 'react';
import { Check, FileText, ListChecks, Sparkle, Table } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { OrbitDef, SynthesizeMode, VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { friendlyErrorMessage } from '../../lib/format';
import { ModalDialog } from '../ui/ModalDialog';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectMenu } from '../ui/SelectMenu';
import { SwitchToggle } from '../ui/SwitchToggle';

interface SynthesizeNotesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: VaultItem[];
  orbits: OrbitDef[];
  activeOrbitId?: string | null;
  activeFocusBoardId?: string | null;
  onCreated: (created: VaultItem, archiveSources: boolean) => void;
}

export const SynthesizeNotesModal: React.FC<SynthesizeNotesModalProps> = ({
  open,
  onOpenChange,
  items,
  orbits,
  activeOrbitId,
  activeFocusBoardId,
  onCreated,
}) => {
  const { t, locale, pluralNoun } = useI18n();
  const [mode, setMode] = useState<SynthesizeMode>('spec');
  const [instruction, setInstruction] = useState('');
  const [targetOrbit, setTargetOrbit] = useState('');
  const [archiveSources, setArchiveSources] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [usedCloud, setUsedCloud] = useState(false);

  const validItems = items.filter((i) => i.dna !== 'secret');

  const runPreview = async (nextMode = mode, customInstr = instruction) => {
    if (validItems.length === 0) return;
    setGenerating(true);
    try {
      const res = await window.kapsula.synthesizeNotes({
        itemIds: validItems.map((i) => i.id),
        mode: nextMode,
        instruction: customInstr.trim() || undefined,
        save: false,
      });
      setDraftTitle(res.preview.title);
      setDraftBody(res.preview.body);
      setUsedCloud(res.preview.usedCloud);
      if (!targetOrbit && res.preview.orbit) {
        setTargetOrbit(res.preview.orbit);
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('synth.errGenerate'), locale));
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setTargetOrbit(activeOrbitId || validItems.find((i) => i.orbit)?.orbit || '');
    setArchiveSources(false);
    void runPreview(mode, instruction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    if (validItems.length === 0 || !draftBody.trim() || saving) return;
    setSaving(true);
    try {
      const res = await window.kapsula.synthesizeNotes({
        itemIds: validItems.map((i) => i.id),
        mode,
        instruction: instruction.trim() || undefined,
        orbit: targetOrbit,
        focusBoardId: activeFocusBoardId ?? null,
        archiveSources,
        save: true,
        overrideTitle: draftTitle.trim(),
        overrideBody: draftBody.trim(),
      });
      if (res.savedItem) {
        onCreated(res.savedItem, archiveSources);
        onOpenChange(false);
        toast.success(
          archiveSources
            ? t('synth.toastSavedArchived', { count: validItems.length })
            : t('synth.toastSaved', { count: validItems.length })
        );
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('synth.errSave'), locale));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      topAligned
      title={t('synth.title')}
      subtitle={t('synth.subtitle', {
        count: validItems.length,
        word: pluralNoun(validItems.length, 'item').replace(/^\d+\s+/, ''),
      })}
      maxWidthClass="max-w-[720px]"
    >
      <div className="p-5 flex flex-col gap-3.5 max-h-[78vh] overflow-y-auto k-scroll-stable">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <SegmentedControl<SynthesizeMode>
            value={mode}
            onChange={(next) => {
              setMode(next);
              void runPreview(next, instruction);
            }}
            size="sm"
            options={[
              { value: 'spec', label: t('synth.mode.spec'), icon: <FileText className="w-3.5 h-3.5" /> },
              { value: 'tasks', label: t('synth.mode.tasks'), icon: <ListChecks className="w-3.5 h-3.5" /> },
              { value: 'table', label: t('synth.mode.table'), icon: <Table className="w-3.5 h-3.5" /> },
            ]}
          />

          <SelectMenu
            size="sm"
            value={targetOrbit}
            onChange={setTargetOrbit}
            options={[
              { value: '', label: t('nav.noSection') },
              ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
            ]}
          />
        </div>

        {/* Optional Prompt Guidance */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runPreview(mode, instruction);
                }
              }}
              placeholder={t('synth.instructionPlaceholder')}
              className="flex-1 h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none focus:border-[var(--k-border-focus)]"
            />
            <button
              type="button"
              disabled={generating}
              onClick={() => void runPreview(mode, instruction)}
              className="k-interactive inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[12px] font-medium cursor-pointer disabled:border-[var(--k-border-hairline)] disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
            >
              <Sparkle weight="fill" className="w-3.5 h-3.5" />
              <span>{generating ? t('synth.generating') : t('synth.rebuild')}</span>
            </button>
          </div>
          {!usedCloud && instruction.trim() ? (
            <div className="text-[11px] text-[var(--k-ink-muted)] px-1">
              {t('synth.localHint')}
            </div>
          ) : null}
        </div>

        {/* Editable Lossless Preview */}
        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder={t('synth.titlePlaceholder')}
              className="flex-1 bg-transparent border-none outline-none text-[15px] font-semibold text-[var(--k-ink-primary)]"
            />
            <span className="text-[11px] text-[var(--k-ink-muted)] shrink-0">
              {usedCloud ? t('synth.badgeCloud') : t('synth.badgeLocal')}
            </span>
          </div>
          <textarea
            rows={10}
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            className="w-full rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] p-3 text-[12.5px] leading-relaxed k-selectable resize-none outline-none focus:border-[var(--k-border-focus)]"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="inline-flex items-center gap-2.5 text-[12.5px] text-[var(--k-ink-secondary)] cursor-pointer select-none">
            <SwitchToggle checked={archiveSources} onCheckedChange={setArchiveSources} />
            <span>{t('synth.archiveOriginals')}</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="synthesize-save-btn"
              disabled={saving || generating || !draftBody.trim()}
              onClick={() => void handleSave()}
              className="k-interactive inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
            >
              <Check weight="bold" className="w-4 h-4" />
              <span>{saving ? t('common.saving') : t('synth.createBtn')}</span>
            </button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
};
