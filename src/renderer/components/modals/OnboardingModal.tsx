import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudCheck,
  Moon,
  Sparkle,
  Sun,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { AppearanceConfig, AppLocale, SettingsState, ThemeMode } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { getOnboardingPresets } from '@shared/note-templates';
import {
  getAccentPresets,
  getDarkBgPresets,
  getLightBgPresets,
  getSavedAppearance,
  hydrateAppearanceFromSettings,
  setSavedAppearance,
} from '../../lib/appearance';
import { friendlyErrorMessage } from '../../lib/format';
import { KapsulaEmblem } from '../ui/KapsulaEmblem';
import { ModalDialog } from '../ui/ModalDialog';
import { SectionIcon } from '../ui/SectionIcon';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SwitchToggle } from '../ui/SwitchToggle';

interface OnboardingModalProps {
  open: boolean;
  settings: SettingsState;
  onSettingsUpdated: (next: SettingsState) => void;
  onCompleted: (opts: { openSync: boolean }) => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  open,
  settings,
  onSettingsUpdated,
  onCompleted,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [selectedOrbitIds, setSelectedOrbitIds] = useState<string[]>([
    'work',
    'personal',
    'ideas',
  ]);
  const [createWelcomeNote, setCreateWelcomeNote] = useState(true);
  const [appearance, setAppearance] = useState<AppearanceConfig>(() => getSavedAppearance());
  const [busy, setBusy] = useState(false);

  const theme: ThemeMode = settings.theme;
  const presets = getOnboardingPresets(locale);
  const accentPresets = getAccentPresets(locale);
  const bgPresets = theme === 'dark' ? getDarkBgPresets(locale) : getLightBgPresets(locale);

  const handleLocaleChange = async (nextLocale: AppLocale) => {
    if (nextLocale === locale) return;
    onSettingsUpdated({ ...settings, locale: nextLocale });
    try {
      const updated = await window.kapsula.updateSettings({ locale: nextLocale });
      onSettingsUpdated(updated);
    } catch {
      // ignore
    }
  };

  const toggleOrbit = (id: string) => {
    setSelectedOrbitIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleThemeChange = async (nextTheme: ThemeMode) => {
    document.documentElement.setAttribute('data-theme', nextTheme);
    hydrateAppearanceFromSettings(appearance, nextTheme);
    try {
      const updated = await window.kapsula.updateSettings({ theme: nextTheme });
      onSettingsUpdated(updated);
    } catch {
      // ignore
    }
  };

  const updateAppearance = (next: AppearanceConfig) => {
    const applied = setSavedAppearance(next, { theme, immediate: true });
    setAppearance(applied);
  };

  const handleSkip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await window.kapsula.updateSettings({ onboarded: true });
      onSettingsUpdated(updated);
      onCompleted({ openSync: false });
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async (openSync: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const chosenOrbits = presets.orbits.filter((o) =>
        selectedOrbitIds.includes(o.id)
      );
      for (const orb of chosenOrbits) {
        await window.kapsula.createOrbit({
          name: orb.name,
          description: orb.description,
          color: orb.color,
          icon: orb.icon,
        });
      }

      if (createWelcomeNote) {
        const w = presets.welcomeNote;
        await window.kapsula.capture({
          title: w.title,
          text: w.body,
          tags: w.tags,
          source: 'vault_ui',
        });
      }

      const updated = await window.kapsula.updateSettings({
        onboarded: true,
        appearance,
      });
      onSettingsUpdated(updated);
      onCompleted({ openSync });
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('onboarding.finishErr'), locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) void handleSkip();
      }}
      hideHeader
      topAligned
      maxWidthClass="max-w-[600px]"
    >
      <div data-testid="onboarding-modal" className="p-6 flex flex-col gap-5">
        {/* Top brand bar + instant language switcher + step dots + Skip */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center shrink-0">
              <KapsulaEmblem size={18} />
            </div>
            <div className="min-w-0">
              <div className="k-display text-[15px] font-semibold leading-tight text-[var(--k-ink-primary)] truncate">
                {t('onboarding.title')}
              </div>
              <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                {t('onboarding.stepOf', { current: step + 1, total: 3 })}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div data-testid="onboarding-language-switcher">
              <SegmentedControl<AppLocale>
                size="sm"
                value={locale}
                onChange={(nextLocale) => void handleLocaleChange(nextLocale)}
                options={[
                  { value: 'ru', label: t('lang.name.ru') },
                  { value: 'en', label: t('lang.name.en') },
                ]}
              />
            </div>
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-[width,background-color] duration-180 ease-[var(--k-ease-out)] ${
                    step === i
                      ? 'w-5 bg-[var(--k-accent)]'
                      : i < step
                        ? 'w-2 bg-[var(--k-accent)]/45'
                        : 'w-2 bg-[var(--k-bg-surface-3)]'
                  }`}
                />
              ))}
            </div>
            <button
              type="button"
              data-testid="onboarding-skip-btn"
              disabled={busy}
              onClick={() => void handleSkip()}
              className="k-interactive text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--k-accent)] cursor-pointer disabled:opacity-50"
            >
              {t('common.skip')}
            </button>
          </div>
        </div>

        {/* Fixed-height animated step content */}
        <div className="min-h-[340px] flex flex-col justify-between">
          <AnimatePresence mode="wait" initial={false}>
            {step === 0 ? (
              <motion.div
                key="onboarding-step-0"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(14px, 0, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(-14px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col gap-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[14.5px] font-semibold text-[var(--k-ink-primary)]">
                      {t('onboarding.step1.title')}
                    </div>
                    <div className="text-[12.5px] text-[var(--k-ink-secondary)] mt-0.5">
                      {t('onboarding.step1.subtitle')}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="onboarding-clean-slate-btn"
                    onClick={() => setSelectedOrbitIds([])}
                    className={`k-interactive h-7.5 px-2.5 rounded-lg border text-[11.5px] font-medium cursor-pointer shrink-0 ${
                      selectedOrbitIds.length === 0
                        ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    {t('onboarding.step1.blankBtn')}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {presets.orbits.map((orb) => {
                    const selected = selectedOrbitIds.includes(orb.id);
                    return (
                      <button
                        key={orb.id}
                        type="button"
                        data-testid={`onboarding-orbit-${orb.id}`}
                        onClick={() => toggleOrbit(orb.id)}
                        className={`k-interactive flex items-start gap-2.5 rounded-xl border p-3 text-left cursor-pointer ${
                          selected
                            ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)]/55'
                            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 hover:border-[var(--k-border-strong)]'
                        }`}
                      >
                        <span
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                          style={{ backgroundColor: `${orb.color}22` }}
                        >
                          <SectionIcon name={orb.icon} color={orb.color} className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold text-[var(--k-ink-primary)]">
                              {orb.name}
                            </span>
                            <span
                              className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                                selected
                                  ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                                  : 'border-[var(--k-border-strong)]'
                              }`}
                            >
                              {selected ? <Check weight="bold" className="w-2.5 h-2.5" /> : null}
                            </span>
                          </div>
                          <div className="text-[11.5px] text-[var(--k-ink-secondary)] leading-snug mt-0.5">
                            {orb.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Sparkle weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)] shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                        {t('onboarding.step1.welcomeTitle')}
                      </div>
                      <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                        {t('onboarding.step1.welcomeDesc')}
                      </div>
                    </div>
                  </div>
                  <SwitchToggle
                    checked={createWelcomeNote}
                    onCheckedChange={setCreateWelcomeNote}
                  />
                </div>
              </motion.div>
            ) : step === 1 ? (
              <motion.div
                key="onboarding-step-1"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(14px, 0, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(-14px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col gap-4"
              >
                <div>
                  <div className="text-[14.5px] font-semibold text-[var(--k-ink-primary)]">
                    {t('onboarding.step2.title')}
                  </div>
                  <div className="text-[12.5px] text-[var(--k-ink-secondary)] mt-0.5">
                    {t('onboarding.step2.subtitle')}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                  <span className="text-[13px] font-medium">{t('onboarding.step2.themeLabel')}</span>
                  <SegmentedControl<ThemeMode>
                    value={theme}
                    onChange={(nextTheme) => void handleThemeChange(nextTheme)}
                    options={[
                      { value: 'dark', label: t('onboarding.step2.dark'), icon: <Moon className="w-3.5 h-3.5" /> },
                      { value: 'light', label: t('onboarding.step2.light'), icon: <Sun className="w-3.5 h-3.5" /> },
                    ]}
                  />
                </div>

                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 space-y-2.5">
                  <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                    {t('onboarding.step2.accent')}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {accentPresets.map((preset) => {
                      const active =
                        appearance.accentMode === 'preset' && appearance.accentPreset === preset.id;
                      const swatch = theme === 'light' ? preset.swatchLight : preset.swatchDark;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            updateAppearance({
                              ...appearance,
                              accentMode: 'preset',
                              accentPreset: preset.id,
                              accentHex: preset.swatchDark,
                            })
                          }
                          className={`k-interactive flex items-center gap-2 h-8.5 px-2.5 rounded-xl border cursor-pointer min-w-0 ${
                            active
                              ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-ink-primary)] font-medium'
                              : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:border-[var(--k-border-strong)]'
                          }`}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full shrink-0"
                            style={{ backgroundColor: swatch }}
                          />
                          <span className="text-[12px]">{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 space-y-2.5">
                  <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                    {t('onboarding.step2.bgPalette')}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {bgPresets.map((preset) => {
                      const active = appearance.bgPreset === preset.id;
                      const label = preset.id === 'paper' ? t('onboarding.step2.paperWarm') : preset.label;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            updateAppearance({
                              ...appearance,
                              bgPreset: preset.id,
                              bgHue: preset.bgHue,
                              bgTint: preset.bgTint,
                              bgLightness: preset.bgLightness,
                            })
                          }
                          className={`k-interactive flex items-center gap-2 px-2.5 py-2 rounded-xl border text-left cursor-pointer ${
                            active
                              ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-ink-primary)]'
                              : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:border-[var(--k-border-strong)]'
                          }`}
                        >
                          <span
                            className="w-4 h-4 rounded-full shrink-0 border border-[var(--k-border-strong)]"
                            style={{ backgroundColor: preset.previewHex }}
                          />
                          <span className="text-[12px] font-medium truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="onboarding-step-2"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(14px, 0, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(-14px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col items-center text-center py-6 gap-4"
              >
                <div className="w-14 h-14 rounded-2xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center">
                  <CloudCheck weight="duotone" className="w-8 h-8" />
                </div>
                <div className="space-y-1.5 max-w-[440px]">
                  <div className="text-[16px] font-semibold text-[var(--k-ink-primary)]">
                    {t('onboarding.step3.title')}
                  </div>
                  <p className="m-0 text-[13px] leading-relaxed text-[var(--k-ink-secondary)]">
                    {t('onboarding.step3.subtitle')}
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 pt-2 w-full">
                  <button
                    type="button"
                    data-testid="onboarding-connect-sync-btn"
                    disabled={busy}
                    onClick={() => void handleFinish(true)}
                    className="k-interactive h-10 px-5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 w-full sm:w-auto"
                  >
                    <CloudCheck className="w-4 h-4" />
                    <span>{t('onboarding.step3.connectSync')}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="onboarding-start-local-btn"
                    disabled={busy}
                    onClick={() => void handleFinish(false)}
                    className="k-interactive h-10 px-5 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] text-[13px] font-medium cursor-pointer disabled:opacity-60 w-full sm:w-auto"
                  >
                    {t('onboarding.step3.startLocal')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-3 border-t border-[var(--k-border-hairline)]">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s === 2 ? 1 : 0))}
              className="k-interactive inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{t('common.back')}</span>
            </button>
          ) : (
            <span className="text-[11.5px] text-[var(--k-ink-muted)]">
              {selectedOrbitIds.length > 0
                ? t('onboarding.step1.selectedCount', { count: selectedOrbitIds.length })
                : t('onboarding.step1.blankStatus')}
            </span>
          )}

          {step < 2 ? (
            <button
              type="button"
              autoFocus
              data-testid="onboarding-next-btn"
              onClick={() => setStep((s) => (s === 0 ? 1 : 2))}
              className="k-interactive inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--k-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--k-bg-surface-1)] cursor-pointer"
            >
              <span>{t('common.next')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
};
