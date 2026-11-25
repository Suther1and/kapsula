import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { AnimateUIProvider } from '@animate-ui/react/provider';
import { Tooltip } from '@animate-ui/react/primitives/base-ui/tooltip';
import { Toaster } from 'sonner';
import type { SettingsState } from '@shared/types';
import { I18nProvider } from '@shared/i18n/react';
import {
  applyAppearanceToDocument,
  hydrateAppearanceFromSettings,
  subscribeAppearanceChanges,
} from './lib/appearance';
import { setGlobalTactileSoundEnabled } from './lib/tactileSound';

const loadStudioWorkspace = () =>
  import('./surfaces/StudioWorkspace').then((m) => ({ default: m.StudioWorkspace }));
const loadCommandHudSurface = () =>
  import('./surfaces/CommandHudSurface').then((m) => ({ default: m.CommandHudSurface }));

const StudioWorkspace = lazy(loadStudioWorkspace);
const CommandHudSurface = lazy(loadCommandHudSurface);

function getSurfaceKind(): 'vault' | 'hud' {
  if (typeof window === 'undefined') return 'vault';
  const params = new URLSearchParams(window.location.search);
  return params.get('surface') === 'hud' ? 'hud' : 'vault';
}

if (typeof window !== 'undefined') {
  void (getSurfaceKind() === 'hud' ? loadCommandHudSurface() : loadStudioWorkspace());
}

export const App: React.FC = () => {
  const surface = useMemo(getSurfaceKind, []);
  const [settings, setSettings] = useState<SettingsState | null>(null);

  useEffect(() => {
    document.body.classList.remove('k-surface-vault', 'k-surface-hud');
    document.body.classList.add(`k-surface-${surface}`);
  }, [surface]);

  useEffect(() => {
    const syncFocusAttr = (focused: boolean) => {
      document.documentElement.setAttribute('data-window-focused', focused ? 'true' : 'false');
    };
    syncFocusAttr(typeof document !== 'undefined' ? document.hasFocus() : true);
    const onFocus = () => syncFocusAttr(true);
    const onBlur = () => syncFocusAttr(false);
    const onVis = () => syncFocusAttr(!document.hidden && document.hasFocus());
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    const unsubNativeFocus = window.kapsula?.onWindowFocusChanged?.(syncFocusAttr);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      unsubNativeFocus?.();
    };
  }, []);

  useEffect(() => {
    window.kapsula.getSettings().then(setSettings).catch(() => {});
    return window.kapsula.onSettingsUpdated(setSettings);
  }, []);

  useEffect(() => {
    const theme = settings?.theme ?? 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    if (settings?.appearance) {
      hydrateAppearanceFromSettings(settings.appearance, theme);
    } else {
      applyAppearanceToDocument(undefined, undefined, theme);
    }
  }, [settings?.theme, settings?.appearance]);

  useEffect(() => {
    setGlobalTactileSoundEnabled(Boolean(settings?.soundTickEnabled));
  }, [settings?.soundTickEnabled]);

  useEffect(() => {
    applyAppearanceToDocument();
    return subscribeAppearanceChanges(() => applyAppearanceToDocument());
  }, []);

  if (!settings) {
    return null;
  }

  return (
    <I18nProvider locale={settings.locale ?? 'ru'}>
      <AnimateUIProvider reducedMotion="never">
        <MotionConfig reducedMotion="never">
          <Tooltip.Provider delay={280} closeDelay={80}>
            <Suspense fallback={null}>
              {surface === 'vault' ? (
                <StudioWorkspace settings={settings} onSettingsUpdated={setSettings} />
              ) : (
                <CommandHudSurface settings={settings} onSettingsUpdated={setSettings} />
              )}
            </Suspense>
            <Toaster
              position="bottom-right"
              visibleToasts={1}
              duration={2200}
              theme={settings.theme}
              toastOptions={{
                style: {
                  zIndex: 200,
                  background: 'var(--k-bg-elevated)',
                  color: 'var(--k-ink-primary)',
                  border: '1px solid var(--k-border-strong)',
                  borderRadius: '14px',
                  fontFamily: 'var(--k-font-sans)',
                },
              }}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </AnimateUIProvider>
    </I18nProvider>
  );
};
