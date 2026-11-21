import React, { useState } from 'react';
import {
  Check,
  CloudCheck,
  Moon,
  Sparkle,
  Sun,
} from '@phosphor-icons/react';
import { ONBOARDING_PRESETS, type OnboardingOrbitPreset } from '@shared/note-templates';
import type { ThemeMode } from '@shared/types';
import { KapsulaEmblem } from '@renderer/components/ui/KapsulaEmblem';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';

interface MobileWelcomeSheetProps {
  open: boolean;
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  onComplete: (options: {
    selectedOrbits: OnboardingOrbitPreset[];
    createWelcomeNote: boolean;
  }) => Promise<void>;
  onOpenCloud: () => void;
  onSkip: () => void;
}

export const MOBILE_WELCOME_NOTE_BODY = [
  'Капсула держит под рукой всё важное — заметки, фото, ссылки, голосовые, задачи, календарь и защищённый Сейф.',
  '',
  '## С чего удобно начать',
  '- [ ] Создай первую заметку и добавь фото прямо в текст',
  '- [ ] Переключи вкладку «Задачи» в режим «Доска», чтобы раскладывать дела по колонкам',
  '- [ ] Запиши голосовую заметку и расшифруй её через ИИ',
  '- [ ] Сохрани карту, пароль или 2FA-код в защищённый «Сейф»',
  '- [ ] Настрой внешний вид и облачную синхронизацию в Настройках',
].join('\n');

export const MobileWelcomeSheet: React.FC<MobileWelcomeSheetProps> = ({
  open,
  isExpanded,
  hingeRightOffsetPx = 0,
  theme,
  onChangeTheme,
  onComplete,
  onOpenCloud,
  onSkip,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [createWelcomeNote, setCreateWelcomeNote] = useState(true);
  const [busy, setBusy] = useState(false);

  const togglePreset = (id: string) => {
    mobileBridge.haptic('light');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      const chosen = ONBOARDING_PRESETS.orbits.filter((o) => selectedIds.has(o.id));
      await onComplete({
        selectedOrbits: chosen,
        createWelcomeNote,
      });
      mobileBridge.haptic('success');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      title="Добро пожаловать в Kapsula"
      subtitle="Быстрая настройка пространства — можно пропустить"
      isExpanded={isExpanded}
      hingeRightOffsetPx={hingeRightOffsetPx}
      maxWidthClass="max-w-lg"
      onClose={onSkip}
      footer={
        <div className="px-4 py-3 flex items-center gap-2">
          <button
            type="button"
            data-testid="mobile-welcome-skip-btn"
            onClick={() => {
              mobileBridge.haptic('light');
              onSkip();
            }}
            className="k-tap px-4 h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] font-medium text-[var(--k-ink-secondary)]"
          >
            Пропустить
          </button>
          <button
            type="button"
            data-testid="mobile-welcome-start-btn"
            disabled={busy}
            onClick={() => void handleStart()}
            className="k-tap flex-1 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold disabled:opacity-50"
          >
            {busy
              ? 'Готовлю…'
              : selectedIds.size > 0 || createWelcomeNote
                ? 'Начать работу'
                : 'Начать с чистого листа'}
          </button>
        </div>
      }
    >
      <div data-testid="mobile-welcome-sheet" className="p-4 space-y-4">
        {/* Hero */}
        <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
          <div className="w-11 h-11 rounded-2xl bg-[var(--k-accent-soft)] border border-[var(--k-border-focus)] flex items-center justify-center shrink-0">
            <KapsulaEmblem size={26} />
          </div>
          <div className="min-w-0">
            <div className="text-[14.5px] font-bold text-[var(--k-ink-primary)]">
              Заметки, задачи, календарь и Сейф
            </div>
            <p className="text-[12px] leading-snug text-[var(--k-ink-secondary)] mt-0.5">
              Всё хранится локально и синхронизируется с ПК со сквозным шифрованием.
            </p>
          </div>
        </div>

        {/* Already have desktop? 1-tap jump to Cloud */}
        <button
          type="button"
          onClick={() => {
            mobileBridge.haptic('light');
            onOpenCloud();
          }}
          className="k-tap w-full flex items-center justify-between gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-left"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <CloudCheck weight="duotone" className="w-5 h-5 text-[var(--k-emerald)] shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--k-ink-primary)]">
                Уже пользуешься на компьютере?
              </div>
              <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                Войди в облако, чтобы загрузить свои записи
              </div>
            </div>
          </div>
          <span className="text-[12px] font-semibold text-[var(--k-accent)] shrink-0">Войти</span>
        </button>

        {/* Quick Theme Toggle */}
        <div className="space-y-1.5">
          <div className="text-[12px] font-semibold text-[var(--k-ink-secondary)] px-0.5">
            Оформление
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onChangeTheme('dark')}
              className={`k-tap flex items-center justify-center gap-1.5 h-10 rounded-xl border text-[12.5px] font-medium ${
                theme === 'dark'
                  ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                  : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
              }`}
            >
              <Moon weight="duotone" className="w-4 h-4" />
              Тёмная
            </button>
            <button
              type="button"
              onClick={() => onChangeTheme('light')}
              className={`k-tap flex items-center justify-center gap-1.5 h-10 rounded-xl border text-[12.5px] font-medium ${
                theme === 'light'
                  ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                  : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
              }`}
            >
              <Sun weight="duotone" className="w-4 h-4" />
              Светлая
            </button>
          </div>
        </div>

        {/* Optional Starter Sections (opt-in — zero clutter by default!) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[12px] font-semibold text-[var(--k-ink-secondary)]">
              Разделы по желанию
            </span>
            <span className="text-[11px] text-[var(--k-ink-muted)]">
              {selectedIds.size > 0 ? `Выбрано: ${selectedIds.size}` : 'Можно добавить позже'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ONBOARDING_PRESETS.orbits.map((preset) => {
              const active = selectedIds.has(preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => togglePreset(preset.id)}
                  className={`k-tap inline-flex items-center gap-1.5 px-3 h-9 rounded-xl border text-[12.5px] font-medium transition-colors ${
                    active
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                      : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: preset.color }}
                  />
                  <span>{preset.name}</span>
                  {active ? <Check weight="bold" className="w-3 h-3 text-[var(--k-accent)]" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional starter checklist note */}
        <button
          type="button"
          onClick={() => setCreateWelcomeNote((v) => !v)}
          className={`k-tap w-full flex items-center justify-between gap-2.5 p-3 rounded-2xl border text-left transition-colors ${
            createWelcomeNote
              ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)]'
              : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)]'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkle weight="duotone" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--k-ink-primary)]">
                Добавить заметку-шпаргалку с чек-листом
              </div>
              <div className="text-[11px] text-[var(--k-ink-muted)]">
                Поможет сразу попробовать задачи и доску
              </div>
            </div>
          </div>
          <span
            className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
              createWelcomeNote
                ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                : 'border-[var(--k-border-strong)]'
            }`}
          >
            {createWelcomeNote ? <Check weight="bold" className="w-3 h-3" /> : null}
          </span>
        </button>
      </div>
    </BottomSheet>
  );
};
