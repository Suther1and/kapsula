import {
  computeThemeTokens,
  DEFAULT_APPEARANCE_CONFIG,
  type ComputedThemeTokens,
} from '@shared/color-engine';
import type { AppearanceConfig, ThemeMode } from '@shared/types';
import { mobileBridge } from '../native/bridge';

const MOBILE_APPEARANCE_LS_KEY = 'kapsula_mobile_appearance_v8';

export function readInitialAppearance(): AppearanceConfig {
  try {
    const raw = localStorage.getItem(MOBILE_APPEARANCE_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppearanceConfig>;
      return { ...DEFAULT_APPEARANCE_CONFIG, ...parsed };
    }
    // Migrate legacy single-accent/density localStorage keys cleanly
    const legacyAccent = localStorage.getItem('kapsula.ui.accent');
    const legacyDensity = localStorage.getItem('kapsula.ui.density');
    return {
      ...DEFAULT_APPEARANCE_CONFIG,
      ...(legacyAccent &&
      ['terracotta', 'cobalt', 'emerald', 'violet', 'amber', 'rose'].includes(legacyAccent)
        ? { accentPreset: legacyAccent as AppearanceConfig['accentPreset'] }
        : {}),
      ...(legacyDensity === 'compact' || legacyDensity === 'comfortable'
        ? { density: legacyDensity }
        : {}),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

export function persistAppearanceLocal(config: AppearanceConfig): void {
  try {
    localStorage.setItem(MOBILE_APPEARANCE_LS_KEY, JSON.stringify(config));
    localStorage.setItem('kapsula.ui.accent', config.accentPreset);
    localStorage.setItem('kapsula.ui.density', config.density);
  } catch {
    // ignore storage quota errors
  }
}

export function applyMobileThemeAndAppearance(
  mode: ThemeMode,
  config: AppearanceConfig
): ComputedThemeTokens {
  const tokens = computeThemeTokens(mode, config);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
    root.setAttribute('data-accent', config.accentMode === 'preset' ? config.accentPreset : 'custom');
    root.setAttribute('data-density', config.density);

    for (const [varName, value] of Object.entries(tokens.cssVars)) {
      root.style.setProperty(varName, value);
    }

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', tokens.canvasHex);
    }
  }
  void mobileBridge.setSystemBarsTheme(mode, tokens.canvasHex);
  return tokens;
}
