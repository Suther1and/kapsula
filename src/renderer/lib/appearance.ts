import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  DEFAULT_APPEARANCE_CONFIG,
  LIGHT_BG_PRESETS,
  computeScopedAccentTokens,
  computeThemeTokens,
  contrastRatio,
  getAccentPresets,
  getDarkBgPresets,
  getLightBgPresets,
  hexToHsl,
  hslToHex,
  normalizeHex,
  type AccentPresetMeta,
  type BackgroundPresetMeta,
  type ScopedAccentTokens,
} from '@shared/color-engine';
import type {
  AccentPresetId,
  AppearanceConfig,
  BackgroundPresetId,
  ThemeMode,
} from '@shared/types';

export {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  DEFAULT_APPEARANCE_CONFIG,
  LIGHT_BG_PRESETS,
  computeScopedAccentTokens,
  computeThemeTokens,
  contrastRatio,
  getAccentPresets,
  getDarkBgPresets,
  getLightBgPresets,
  hexToHsl,
  hslToHex,
  normalizeHex,
};
export type {
  AccentPresetId,
  AccentPresetMeta,
  AppearanceConfig,
  BackgroundPresetId,
  BackgroundPresetMeta,
  ScopedAccentTokens,
};
export type UiDensity = AppearanceConfig['density'];

const APPEARANCE_STORAGE_KEY = 'kapsula.ui.appearance.v8';
const ACCENT_STORAGE_KEY = 'kapsula.ui.accent';
const DENSITY_STORAGE_KEY = 'kapsula.ui.density';
const APPEARANCE_EVENT = 'kapsula-appearance-changed';

const VALID_BG_PRESETS = new Set<BackgroundPresetId>([
  'obsidian',
  'midnight',
  'espresso',
  'pine',
  'graphite',
  'oled',
  'porcelain',
  'paper',
  'ice',
  'sage',
  'sand',
  'custom',
]);

let persistTimer: number | null = null;
let lastAppliedVars: string[] = [];

function clampNumber(val: unknown, fallback: number, min: number, max: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function sanitizeAppearanceConfig(raw: Partial<AppearanceConfig> | null | undefined): AppearanceConfig {
  const base = DEFAULT_APPEARANCE_CONFIG;
  if (!raw || typeof raw !== 'object') return { ...base };

  const accentMode: AppearanceConfig['accentMode'] =
    raw.accentMode === 'custom' ? 'custom' : 'preset';
  const accentPreset: AccentPresetId = ACCENT_PRESETS.some((p) => p.id === raw.accentPreset)
    ? (raw.accentPreset as AccentPresetId)
    : base.accentPreset;
  const accentHex = normalizeHex(raw.accentHex ?? '') ?? base.accentHex;
  const sectionAccentEnabled =
    typeof raw.sectionAccentEnabled === 'boolean'
      ? raw.sectionAccentEnabled
      : base.sectionAccentEnabled !== false;
  const bgPreset: BackgroundPresetId =
    typeof raw.bgPreset === 'string' && VALID_BG_PRESETS.has(raw.bgPreset as BackgroundPresetId)
      ? (raw.bgPreset as BackgroundPresetId)
      : base.bgPreset;
  const bgHue = clampNumber(raw.bgHue, base.bgHue, 0, 360);
  const bgTint = clampNumber(raw.bgTint, base.bgTint, 0, 100);
  const bgLightness = clampNumber(raw.bgLightness, base.bgLightness, 0, 100);
  const density: UiDensity = raw.density === 'compact' ? 'compact' : 'comfortable';

  return {
    accentMode,
    accentPreset,
    accentHex,
    sectionAccentEnabled,
    bgPreset,
    bgHue,
    bgTint,
    bgLightness,
    density,
  };
}

export function getSavedAppearance(): AppearanceConfig {
  try {
    const rawJson = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as Partial<AppearanceConfig>;
      return sanitizeAppearanceConfig(parsed);
    }
  } catch {
    // ignore corrupted localStorage entry
  }

  // Migrate legacy accent/density keys cleanly
  const legacyAccent = getSavedAccent();
  const legacyDensity = getSavedDensity();
  const presetMeta = ACCENT_PRESETS.find((p) => p.id === legacyAccent) ?? ACCENT_PRESETS[0]!;
  return {
    ...DEFAULT_APPEARANCE_CONFIG,
    accentPreset: legacyAccent,
    accentHex: presetMeta.swatchDark,
    density: legacyDensity,
  };
}

export function getSavedAccent(): AccentPresetId {
  try {
    const rawJson = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as Partial<AppearanceConfig>;
      if (parsed.accentPreset && ACCENT_PRESETS.some((p) => p.id === parsed.accentPreset)) {
        return parsed.accentPreset as AccentPresetId;
      }
    }
    const raw = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (raw && ACCENT_PRESETS.some((p) => p.id === raw)) {
      return raw as AccentPresetId;
    }
  } catch {
    // ignore
  }
  return 'terracotta';
}

export function getSavedDensity(): UiDensity {
  try {
    const rawJson = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as Partial<AppearanceConfig>;
      if (parsed.density === 'compact' || parsed.density === 'comfortable') {
        return parsed.density;
      }
    }
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (raw === 'compact' || raw === 'comfortable') return raw;
  } catch {
    // ignore
  }
  return 'comfortable';
}

function getDocumentTheme(themeOverride?: ThemeMode): ThemeMode {
  if (themeOverride === 'light' || themeOverride === 'dark') return themeOverride;
  if (typeof document !== 'undefined') {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  return 'dark';
}

function writeAppearanceLocalStorage(config: AppearanceConfig): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(config));
    localStorage.setItem(ACCENT_STORAGE_KEY, config.accentPreset);
    localStorage.setItem(DENSITY_STORAGE_KEY, config.density);
  } catch {
    // ignore
  }
}

function persistAppearanceRemote(config: AppearanceConfig, immediate = false): void {
  if (typeof window === 'undefined') return;
  const api = (window as Window & { kapsula?: { updateSettings?: (patch: Record<string, unknown>) => Promise<unknown> } }).kapsula;
  if (!api?.updateSettings) return;

  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }

  const send = () => {
    persistTimer = null;
    void api.updateSettings?.({ appearance: config }).catch(() => {});
  };

  if (immediate) {
    send();
  } else {
    persistTimer = window.setTimeout(send, 160);
  }
}

export function applyAppearanceToDocument(
  accentOrConfig?: AccentPresetId | AppearanceConfig,
  density?: UiDensity,
  themeOverride?: ThemeMode
): void {
  if (typeof document === 'undefined') return;

  let config: AppearanceConfig;
  if (accentOrConfig && typeof accentOrConfig === 'object') {
    config = sanitizeAppearanceConfig(accentOrConfig);
  } else {
    const saved = getSavedAppearance();
    config = {
      ...saved,
      ...(typeof accentOrConfig === 'string'
        ? { accentMode: 'preset' as const, accentPreset: accentOrConfig }
        : {}),
      ...(density ? { density } : {}),
    };
  }

  const theme = getDocumentTheme(themeOverride);
  const root = document.documentElement;
  if (themeOverride) {
    root.setAttribute('data-theme', theme);
  }
  root.setAttribute('data-accent', config.accentMode === 'preset' ? config.accentPreset : 'custom');
  root.setAttribute('data-density', config.density);

  const tokens = computeThemeTokens(theme, config);
  const nextVarKeys = Object.keys(tokens.cssVars);

  for (const prevKey of lastAppliedVars) {
    if (!(prevKey in tokens.cssVars)) {
      root.style.removeProperty(prevKey);
    }
  }
  for (const [key, value] of Object.entries(tokens.cssVars)) {
    root.style.setProperty(key, value);
  }
  lastAppliedVars = nextVarKeys;
}

export function setSavedAppearance(
  next: AppearanceConfig,
  opts?: { theme?: ThemeMode; persistRemote?: boolean; immediate?: boolean }
): AppearanceConfig {
  const sanitized = sanitizeAppearanceConfig(next);
  writeAppearanceLocalStorage(sanitized);
  applyAppearanceToDocument(sanitized, undefined, opts?.theme);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: sanitized }));
  }
  if (opts?.persistRemote !== false) {
    persistAppearanceRemote(sanitized, Boolean(opts?.immediate));
  }
  return sanitized;
}

export function hydrateAppearanceFromSettings(
  appearance?: AppearanceConfig | null,
  theme?: ThemeMode
): AppearanceConfig {
  const effective = appearance ? sanitizeAppearanceConfig(appearance) : getSavedAppearance();
  if (appearance) {
    writeAppearanceLocalStorage(effective);
  }
  applyAppearanceToDocument(effective, undefined, theme);
  return effective;
}

export function setSavedAccent(accent: AccentPresetId): void {
  const current = getSavedAppearance();
  const preset = ACCENT_PRESETS.find((p) => p.id === accent) ?? ACCENT_PRESETS[0]!;
  setSavedAppearance(
    {
      ...current,
      accentMode: 'preset',
      accentPreset: accent,
      accentHex: preset.swatchDark,
    },
    { immediate: true }
  );
}

export function setSavedDensity(density: UiDensity): void {
  const current = getSavedAppearance();
  setSavedAppearance(
    {
      ...current,
      density,
    },
    { immediate: true }
  );
}

export function resetSavedAppearance(theme?: ThemeMode): AppearanceConfig {
  const effectiveTheme = getDocumentTheme(theme);
  const defaults: AppearanceConfig = {
    ...DEFAULT_APPEARANCE_CONFIG,
    bgPreset: effectiveTheme === 'light' ? 'porcelain' : 'obsidian',
  };
  return setSavedAppearance(defaults, { theme: effectiveTheme, immediate: true });
}

export function subscribeAppearanceChanges(cb: () => void): () => void {
  const onLocal = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (
      e.key === APPEARANCE_STORAGE_KEY ||
      e.key === ACCENT_STORAGE_KEY ||
      e.key === DENSITY_STORAGE_KEY
    ) {
      applyAppearanceToDocument();
      cb();
    }
  };
  window.addEventListener(APPEARANCE_EVENT, onLocal);
  window.addEventListener('storage', onStorage);

  let unsubIpc: (() => void) | undefined;
  const api = (
    window as Window & {
      kapsula?: {
        onSettingsUpdated?: (
          listener: (next: { theme?: ThemeMode; appearance?: AppearanceConfig }) => void
        ) => () => void;
      };
    }
  ).kapsula;
  if (api?.onSettingsUpdated) {
    unsubIpc = api.onSettingsUpdated((next) => {
      if (next?.appearance) {
        hydrateAppearanceFromSettings(next.appearance, next.theme);
        cb();
      } else if (next?.theme) {
        applyAppearanceToDocument(undefined, undefined, next.theme);
        cb();
      }
    });
  }

  return () => {
    window.removeEventListener(APPEARANCE_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
    unsubIpc?.();
  };
}
