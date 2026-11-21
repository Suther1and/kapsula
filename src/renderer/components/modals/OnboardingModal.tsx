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
import type { AppearanceConfig, SettingsState, ThemeMode } from '@shared/types';
import { ONBOARDING_PRESETS } from '@shared/note-templates';
import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  LIGHT_BG_PRESETS,
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
  const bgPresets = theme === 'dark' ? DARK_BG_PRESETS : LIGHT_BG_PRESETS;

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
      toast.error(friendlyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async (openSync: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const chosenOrbits = ONBOARDING_PRESETS.orbits.filter((o) =>
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
        const w = ONBOARDING_PRESETS.welcomeNote;
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
      toast.error(friendlyErrorMessage(err, 'Не удалось завершить настройку'));
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
        {/* Top brand bar + step dots + Skip */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center">
              <KapsulaEmblem size={18} />
            </div>
            <div>
              <div className="k-display text-[15px] font-semibold leading-tight text-[var(--k-ink-primary)]">
                Добро пожаловать в Kapsula
              </div>
              <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                Шаг {step + 1} из 3
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
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
              Пропустить
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
                      Собери стартовые разделы
                    </div>
                    <div className="text-[12.5px] text-[var(--k-ink-secondary)] mt-0.5">
                      Выбери нужные разделы или начни с чистого листа — потом всё легко поменять
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
                    Чистый лист
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ONBOARDING_PRESETS.orbits.map((orb) => {
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
                        Создать вводную заметку с задачами
                      </div>
                      <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                        Короткий чек-лист сразу появится в «Заметках» и на Канбан-доске
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
                    Выбери визуальный стиль
                  </div>
                  <div className="text-[12.5px] text-[var(--k-ink-secondary)] mt-0.5">
                    Изменения применяются сразу — в Настройках доступны и тонкие ползунки цветов
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                  <span className="text-[13px] font-medium">Тема интерфейса</span>
                  <SegmentedControl<ThemeMode>
                    value={theme}
                    onChange={(nextTheme) => void handleThemeChange(nextTheme)}
                    options={[
                      { value: 'dark', label: 'Тёмная', icon: <Moon className="w-3.5 h-3.5" /> },
                      { value: 'light', label: 'Светлая', icon: <Sun className="w-3.5 h-3.5" /> },
                    ]}
                  />
                </div>

                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 space-y-2.5">
                  <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                    Акцентный цвет
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {ACCENT_PRESETS.map((preset) => {
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
                    Палитра фона
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {bgPresets.map((preset) => {
                      const active = appearance.bgPreset === preset.id;
                      const label = preset.id === 'paper' ? 'Тёплая бумага' : preset.label;
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
                    Синхронизируй между всеми устройствами
                  </div>
                  <p className="m-0 text-[13px] leading-relaxed text-[var(--k-ink-secondary)]">
                    Заметки, задачи, календарь, картинки и Сейф шифруются на твоём устройстве перед отправкой в облако. Можно подключить сейчас или спокойно работать полностью локально.
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
                    <span>Подключить облачную синхронизацию</span>
                  </button>
                  <button
                    type="button"
                    data-testid="onboarding-start-local-btn"
                    disabled={busy}
                    onClick={() => void handleFinish(false)}
                    className="k-interactive h-10 px-5 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] text-[13px] font-medium cursor-pointer disabled:opacity-60 w-full sm:w-auto"
                  >
                    Начать локально
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
              <span>Назад</span>
            </button>
          ) : (
            <span className="text-[11.5px] text-[var(--k-ink-muted)]">
              {selectedOrbitIds.length > 0
                ? `Выбрано разделов: ${selectedOrbitIds.length}`
                : 'Начнём с чистого листа'}
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
              <span>Далее</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
};
