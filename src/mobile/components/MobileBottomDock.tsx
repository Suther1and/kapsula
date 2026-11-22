import React, { useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CalendarBlank,
  CheckSquare,
  CloudCheck,
  CloudSlash,
  GearSix,
  NotePencil,
  Plus,
  ShieldCheck,
  Sparkle,
} from '@phosphor-icons/react';
import type { MobileDictKey } from '@shared/i18n/mobile-dict';
import type { SyncStatus } from '@shared/sync-contract';
import { KapsulaEmblem } from '@renderer/components/ui/KapsulaEmblem';
import type { MobileTabId } from '../lib/mobile-helpers';
import { useMobileI18n } from '../lib/mobile-i18n';
import { mobileBridge } from '../native/bridge';

export const MOBILE_NAV_TABS: Array<{
  id: MobileTabId;
  labelKey: MobileDictKey;
  icon: typeof Sparkle;
}> = [
  { id: 'feed', labelKey: 'nav.feed', icon: Sparkle },
  { id: 'notes', labelKey: 'nav.notes', icon: NotePencil },
  { id: 'tasks', labelKey: 'nav.tasks', icon: CheckSquare },
  { id: 'calendar', labelKey: 'nav.calendar', icon: CalendarBlank },
  { id: 'vault', labelKey: 'nav.vault', icon: ShieldCheck },
];

interface MobileBottomDockProps {
  visible: boolean;
  activeTab: MobileTabId;
  activeTasksCount: number;
  showCaptureOrb: boolean;
  onSelectTab: (tab: MobileTabId) => void;
  onQuickCapture: () => void;
  onQuickVoiceCapture?: () => void;
}

/**
 * Flagship Floating Glass Capsule Dock + Paired Inline Quick-Capture Orb:
 * - Zero flat full-width box, zero FAB floating over content!
 * - Active tab glides smoothly via spring `layoutId` pill revealing full Russian label;
 *   inactive tabs stay ultra-clean icon targets (>= 40x44px) so narrow Galaxy Z Fold cover screens
 *   (344-412dp) NEVER clip or crowd Russian labels.
 * - Automatically glides out when Android soft keyboard opens or in fullscreen note editor.
 */
export const MobileBottomDock: React.FC<MobileBottomDockProps> = ({
  visible,
  activeTab,
  activeTasksCount,
  showCaptureOrb,
  onSelectTab,
  onQuickCapture,
  onQuickVoiceCapture,
}) => {
  const { t } = useMobileI18n();
  const prefersReduced = useReducedMotion();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleOrbPointerDown = () => {
    longPressedRef.current = false;
    clearLongPress();
    if (!onQuickVoiceCapture) return;
    longPressTimerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      mobileBridge.haptic('medium');
      onQuickVoiceCapture();
    }, 440);
  };

  const handleOrbClick = () => {
    clearLongPress();
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    mobileBridge.haptic('light');
    onQuickCapture();
  };

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="kapsula-floating-dock-wrap"
          initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
          animate={
            prefersReduced
              ? { opacity: 1 }
              : {
                  opacity: 1,
                  y: 0,
                  transition: { type: 'spring', stiffness: 480, damping: 36, mass: 0.75 },
                }
          }
          exit={
            prefersReduced
              ? { opacity: 0, transition: { duration: 0.01 } }
              : { opacity: 0, y: 20, transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] } }
          }
          className="fixed inset-x-0 bottom-0 z-30 pointer-events-none"
        >
          {/* Smooth opaque fade scrim so scrolled cards vanish cleanly behind the floating dock & orb gap */}
          <div
            aria-hidden="true"
            style={{ background: 'var(--k-scrim-bottom)' }}
            className="absolute inset-x-0 bottom-0 h-[104px] pointer-events-none"
          />

          <div className="relative px-2 pb-2.5 pt-2 flex items-center justify-center gap-1.5">
            {/* Detached Floating Glass Capsule */}
            <nav
              data-testid="fold-bottom-nav"
              aria-label={t('nav.bottomNavAria')}
              style={{
                background: 'var(--k-dock-bg)',
                borderColor: 'var(--k-dock-border)',
                boxShadow: 'var(--k-dock-shadow)',
              }}
              className={`pointer-events-auto h-[54px] p-1 rounded-[27px] border backdrop-blur-md flex items-center justify-between gap-0.5 ${
                showCaptureOrb ? 'flex-1 min-w-0 max-w-[344px]' : 'w-full max-w-[360px]'
              }`}
            >
              {MOBILE_NAV_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                const tabLabel = t(tab.labelKey);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    data-testid={`nav-tab-${tab.id}`}
                    aria-label={tabLabel}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      if (tab.id !== activeTab) mobileBridge.haptic('light');
                      onSelectTab(tab.id);
                    }}
                    className={`k-tap relative h-[44px] rounded-[22px] flex items-center justify-center transition-colors outline-none ${
                      active
                        ? 'flex-1 min-w-0 px-2.5 text-[var(--k-accent)]'
                        : 'w-[38px] shrink-0 text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="k-dock-active-pill"
                        transition={
                          prefersReduced
                            ? { duration: 0.01 }
                            : { type: 'spring', stiffness: 540, damping: 38, mass: 0.7 }
                        }
                        className="absolute inset-0 rounded-[22px] bg-[var(--k-accent-soft)] border border-[color-mix(in_srgb,var(--k-accent)_32%,transparent)]"
                      />
                    ) : null}

                    <span className="relative z-10 inline-flex items-center justify-center gap-1.5 min-w-0">
                      <Icon
                        weight={active ? 'fill' : 'regular'}
                        className="w-[18px] h-[18px] shrink-0"
                      />
                      {active ? (
                        <span
                          data-testid="dock-active-label"
                          className="text-[11.5px] font-semibold leading-none tracking-[-0.01em] whitespace-nowrap"
                        >
                          {tabLabel}
                        </span>
                      ) : null}
                      {active && tab.id === 'tasks' && activeTasksCount > 0 ? (
                        <span className="min-w-[16px] h-[16px] px-1 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[9.5px] font-bold inline-flex items-center justify-center shrink-0">
                          {activeTasksCount > 99 ? '99+' : activeTasksCount}
                        </span>
                      ) : null}
                    </span>

                    {!active && tab.id === 'tasks' && activeTasksCount > 0 ? (
                      <span className="pointer-events-none absolute z-20 top-1.5 right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[9px] font-bold flex items-center justify-center shadow-xs">
                        {activeTasksCount > 99 ? '99+' : activeTasksCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>

            {/* Paired Inline Quick-Capture Orb (aligned with dock baseline — ZERO content overlap!) */}
            <AnimatePresence initial={false}>
              {showCaptureOrb ? (
                <motion.button
                  key="k-paired-capture-orb"
                  type="button"
                  data-testid="compact-quick-capture-fab"
                  initial={prefersReduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }}
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : {
                          opacity: 1,
                          scale: 1,
                          transition: { type: 'spring', stiffness: 500, damping: 34 },
                        }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0, transition: { duration: 0.01 } }
                      : { opacity: 0, scale: 0.72, transition: { duration: 0.11, ease: 'easeOut' } }
                  }
                  onPointerDown={handleOrbPointerDown}
                  onPointerUp={clearLongPress}
                  onPointerCancel={clearLongPress}
                  onPointerLeave={clearLongPress}
                  onClick={handleOrbClick}
                  aria-label={t('nav.quickCaptureAria')}
                  title={t('nav.quickCaptureHint')}
                  style={{ boxShadow: 'var(--k-orb-shadow)' }}
                  className="k-tap pointer-events-auto shrink-0 w-[50px] h-[50px] rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] flex items-center justify-center border border-white/15"
                >
                  <Plus weight="bold" className="w-[22px] h-[22px]" />
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};

interface MobileNavRailProps {
  activeTab: MobileTabId;
  activeTasksCount: number;
  syncStatus: SyncStatus;
  syncDotColor: string;
  onSelectTab: (tab: MobileTabId) => void;
  onQuickCapture: () => void;
  onOpenSettings: () => void;
}

/** Expanded Galaxy Z Fold Left Navigation Rail with fluid spring pill indicator */
export const MobileNavRail: React.FC<MobileNavRailProps> = ({
  activeTab,
  activeTasksCount,
  syncStatus,
  syncDotColor,
  onSelectTab,
  onQuickCapture,
  onOpenSettings,
}) => {
  const { t } = useMobileI18n();
  const prefersReduced = useReducedMotion();

  return (
    <nav
      data-testid="fold-nav-rail"
      aria-label={t('nav.mainNavAria')}
      className="w-[78px] shrink-0 h-full flex flex-col items-center justify-between py-3 px-2 border-r border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)]"
    >
      <div className="flex flex-col items-center gap-2.5 w-full">
        <button
          type="button"
          onClick={() => onSelectTab('feed')}
          aria-label="Kapsula"
          className="k-tap w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] flex items-center justify-center shadow-xs"
        >
          <KapsulaEmblem size={24} />
        </button>

        <button
          type="button"
          data-testid="rail-quick-capture-btn"
          onClick={() => {
            mobileBridge.haptic('light');
            onQuickCapture();
          }}
          aria-label={t('nav.quickCapture')}
          style={{ boxShadow: 'var(--k-orb-shadow)' }}
          className="k-tap w-11 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] flex items-center justify-center"
        >
          <Plus weight="bold" className="w-5 h-5" />
        </button>

        <div className="w-8 h-[1px] bg-[var(--k-border-hairline)] my-0.5" />

        <div className="flex flex-col items-center gap-1 w-full">
          {MOBILE_NAV_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`nav-tab-${tab.id}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (tab.id !== activeTab) mobileBridge.haptic('light');
                  onSelectTab(tab.id);
                }}
                className={`k-tap relative w-full py-2 rounded-2xl flex flex-col items-center justify-center gap-1 transition-colors ${
                  active
                    ? 'text-[var(--k-accent)]'
                    : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                }`}
              >
                {active ? (
                  <motion.span
                    layoutId="k-rail-active-pill"
                    transition={
                      prefersReduced
                        ? { duration: 0.01 }
                        : { type: 'spring', stiffness: 480, damping: 34 }
                    }
                    className="absolute inset-0 rounded-2xl bg-[var(--k-accent-soft)] border border-[color-mix(in_srgb,var(--k-accent)_32%,transparent)]"
                  />
                ) : null}
                <Icon
                  weight={active ? 'fill' : 'regular'}
                  className="relative z-10 w-5 h-5"
                />
                <span className="relative z-10 text-[10px] font-semibold leading-none">
                  {t(tab.labelKey)}
                </span>
                {tab.id === 'tasks' && activeTasksCount > 0 ? (
                  <span className="absolute z-20 top-1 right-2 min-w-[16px] h-4 px-1 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[9.5px] font-bold flex items-center justify-center">
                    {activeTasksCount > 99 ? '99+' : activeTasksCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          data-testid="cloud-settings-btn"
          onClick={onOpenSettings}
          aria-label={t('nav.cloudAndSettings')}
          className="k-tap relative w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] flex items-center justify-center text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
        >
          {syncStatus.state === 'synced' ? (
            <CloudCheck weight="duotone" className="w-5 h-5 text-[var(--k-emerald)]" />
          ) : syncStatus.state === 'offline' || syncStatus.state === 'error' ? (
            <CloudSlash weight="duotone" className="w-5 h-5 text-[var(--k-amber)]" />
          ) : (
            <GearSix weight="duotone" className="w-5 h-5" />
          )}
          <span
            className="absolute top-2 right-2 w-2 h-2 rounded-full"
            style={{ background: syncDotColor }}
          />
        </button>
      </div>
    </nav>
  );
};
