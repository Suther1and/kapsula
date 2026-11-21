import type { AccentPresetId, AppearanceConfig, BackgroundPresetId, ThemeMode } from './types';

export interface AccentPresetMeta {
  id: AccentPresetId;
  label: string;
  swatchDark: string;
  swatchLight: string;
}

export interface BackgroundPresetMeta {
  id: Exclude<BackgroundPresetId, 'custom'>;
  mode: ThemeMode;
  label: string;
  previewHex: string;
  /** Miniature 2-tone tile colors strictly for Settings preset buttons (slightly lifted so dark tones read clearly at small size). */
  previewCanvas: string;
  previewSurface: string;
  bgHue: number;
  bgTint: number;
  bgLightness: number;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

export interface ComputedThemeTokens {
  cssVars: Record<string, string>;
  canvasHex: string;
  hudHex: string;
  accentHex: string;
  inkOnAccent: string;
}

export const ACCENT_PRESETS: AccentPresetMeta[] = [
  { id: 'terracotta', label: 'Терракота', swatchDark: '#d95826', swatchLight: '#c54914' },
  { id: 'cobalt', label: 'Кобальт', swatchDark: '#4f86f7', swatchLight: '#2f6ae0' },
  { id: 'emerald', label: 'Изумруд', swatchDark: '#2db57d', swatchLight: '#168055' },
  { id: 'violet', label: 'Аметист', swatchDark: '#9a75f5', swatchLight: '#7a52dc' },
  { id: 'amber', label: 'Янтарь', swatchDark: '#e59f30', swatchLight: '#a8680a' },
  { id: 'rose', label: 'Гранат', swatchDark: '#e65d78', swatchLight: '#c93c59' },
];

export const DARK_BG_PRESETS: BackgroundPresetMeta[] = [
  {
    id: 'obsidian',
    mode: 'dark',
    label: 'Обсидиан',
    previewHex: '#0e0e11',
    previewCanvas: '#17171d',
    previewSurface: '#272731',
    bgHue: 240,
    bgTint: 12,
    bgLightness: 45,
  },
  {
    id: 'midnight',
    mode: 'dark',
    label: 'Полночь',
    previewHex: '#0b101b',
    previewCanvas: '#132240',
    previewSurface: '#213866',
    bgHue: 222,
    bgTint: 58,
    bgLightness: 36,
  },
  {
    id: 'espresso',
    mode: 'dark',
    label: 'Эспрессо',
    previewHex: '#130f0d',
    previewCanvas: '#2c1f19',
    previewSurface: '#432e25',
    bgHue: 22,
    bgTint: 38,
    bgLightness: 42,
  },
  {
    id: 'pine',
    mode: 'dark',
    label: 'Хвоя',
    previewHex: '#0b1310',
    previewCanvas: '#132b22',
    previewSurface: '#204538',
    bgHue: 156,
    bgTint: 40,
    bgLightness: 36,
  },
  {
    id: 'graphite',
    mode: 'dark',
    label: 'Графит',
    previewHex: '#16161a',
    previewCanvas: '#2b2c34',
    previewSurface: '#3f414d',
    bgHue: 240,
    bgTint: 10,
    bgLightness: 84,
  },
  {
    id: 'oled',
    mode: 'dark',
    label: 'OLED',
    previewHex: '#050507',
    previewCanvas: '#000000',
    previewSurface: '#141419',
    bgHue: 240,
    bgTint: 8,
    bgLightness: 4,
  },
];

export const LIGHT_BG_PRESETS: BackgroundPresetMeta[] = [
  {
    id: 'porcelain',
    mode: 'light',
    label: 'Фарфор',
    previewHex: '#f4f5f7',
    previewCanvas: '#e3e6ee',
    previewSurface: '#ffffff',
    bgHue: 220,
    bgTint: 10,
    bgLightness: 68,
  },
  {
    id: 'paper',
    mode: 'light',
    label: 'Бумага',
    previewHex: '#f7f3eb',
    previewCanvas: '#efe2ce',
    previewSurface: '#fffdf9',
    bgHue: 38,
    bgTint: 52,
    bgLightness: 64,
  },
  {
    id: 'ice',
    mode: 'light',
    label: 'Лёд',
    previewHex: '#eef4fa',
    previewCanvas: '#d2e4f7',
    previewSurface: '#ffffff',
    bgHue: 214,
    bgTint: 58,
    bgLightness: 60,
  },
  {
    id: 'sage',
    mode: 'light',
    label: 'Шалфей',
    previewHex: '#eff6f1',
    previewCanvas: '#d3eadd',
    previewSurface: '#ffffff',
    bgHue: 148,
    bgTint: 44,
    bgLightness: 60,
  },
  {
    id: 'sand',
    mode: 'light',
    label: 'Песок',
    previewHex: '#f2ece2',
    previewCanvas: '#e6d6bf',
    previewSurface: '#fefcf8',
    bgHue: 34,
    bgTint: 48,
    bgLightness: 38,
  },
];

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  accentMode: 'preset',
  accentPreset: 'terracotta',
  accentHex: '#d95826',
  bgPreset: 'obsidian',
  bgHue: 240,
  bgTint: 12,
  bgLightness: 45,
  density: 'comfortable',
};

const DARK_TO_LIGHT_BG_PAIR: Record<string, BackgroundPresetMeta['id']> = {
  obsidian: 'porcelain',
  midnight: 'ice',
  espresso: 'paper',
  pine: 'sage',
  graphite: 'sand',
  oled: 'porcelain',
};

const LIGHT_TO_DARK_BG_PAIR: Record<string, BackgroundPresetMeta['id']> = {
  porcelain: 'obsidian',
  ice: 'midnight',
  paper: 'espresso',
  sage: 'pine',
  sand: 'graphite',
};

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

function wrapHue(h: number): number {
  if (!Number.isFinite(h)) return 0;
  return ((h % 360) + 360) % 360;
}

/**
 * Normalizes a `#rgb`, `rgb`, `#rrggbb`, or `rrggbb` string to lowercase `#rrggbb`.
 * Returns `null` if invalid.
 */
export function normalizeHex(hex: string): string | null {
  if (typeof hex !== 'string') return null;
  const cleaned = hex.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(cleaned)) {
    const r = cleaned[0]!;
    const g = cleaned[1]!;
    const b = cleaned[2]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9a-f]{6}$/.test(cleaned)) {
    return `#${cleaned}`;
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const norm = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(norm.slice(1, 3), 16),
    g: parseInt(norm.slice(3, 5), 16),
    b: parseInt(norm.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Number(clamp(alpha, 0, 1).toFixed(3));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Converts a hex color (`#rgb` or `#rrggbb`) to HSL (`h ∈ [0, 360)`, `s ∈ [0, 100]`, `l ∈ [0, 100]`).
 */
export function hexToHsl(hex: string): HslColor {
  const { r: r255, g: g255, b: b255 } = hexToRgb(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) {
      h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
    } else if (max === g) {
      h = ((b - r) / delta + 2) * 60;
    } else {
      h = ((r - g) / delta + 4) * 60;
    }
  }

  return {
    h: Math.round(wrapHue(h) * 10) / 10,
    s: Math.round(clamp(s * 100, 0, 100) * 10) / 10,
    l: Math.round(clamp(l * 100, 0, 100) * 10) / 10,
  };
}

/**
 * Converts HSL (`h` degrees, `s` 0..100, `l` 0..100) to lowercase `#rrggbb`.
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = wrapHue(h) / 360;
  const sat = clamp(s, 0, 100) / 100;
  const lig = clamp(l, 0, 100) / 100;

  if (sat === 0) {
    const v = lig * 255;
    return rgbToHex(v, v, v);
  }

  const hue2rgb = (p: number, q: number, tIn: number): number => {
    let t = tIn;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;

  return rgbToHex(
    hue2rgb(p, q, hue + 1 / 3) * 255,
    hue2rgb(p, q, hue) * 255,
    hue2rgb(p, q, hue - 1 / 3) * 255
  );
}

/**
 * Computes WCAG 2.1 relative luminance (`0.0` black .. `1.0` white) for a hex color.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const linearize = (channel255: number): number => {
    const c = channel255 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Computes WCAG 2.1 contrast ratio (`1.0` .. `21.0`) between two hex colors.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_INK_ON_ACCENT = '#09090d';
const LIGHT_INK_ON_ACCENT = '#ffffff';

/**
 * Selects crisp white ink (`#ffffff`) whenever contrast >= 3.5:1 (covers rich terracotta,
 * cobalt, violet, rose, and all Light presets >= 4.5:1), falling back to deep dark ink (`#09090d`)
 * only for genuinely bright yellow/lime/pastel accents where white contrast drops below 3.5:1.
 */
function pickInkOnAccent(accentHex: string): string {
  const crWhite = contrastRatio(accentHex, LIGHT_INK_ON_ACCENT);
  return crWhite >= 3.5 ? LIGHT_INK_ON_ACCENT : DARK_INK_ON_ACCENT;
}

function resolveAccentPreset(id: string): AccentPresetMeta {
  const alias = id === 'ember' ? 'terracotta' : id === 'indigo' ? 'violet' : id;
  return ACCENT_PRESETS.find((p) => p.id === alias) ?? ACCENT_PRESETS[0]!;
}

interface SurfacePalette {
  canvas: string;
  rail: string;
  surface1: string;
  surface2: string;
  surface3: string;
  elevated: string;
  hud: string;
  glass: string;
  codeBg: string;
  secretBg: string;
  inkPrimary: string;
  inkSecondary: string;
  inkMuted: string;
  borderHairline: string;
  borderStrong: string;
}

function buildDarkSurfaceLadder(hue: number, tintPct: number, lightnessPct: number): SurfacePalette {
  const h = wrapHue(hue);
  const s0 = clamp(tintPct, 0, 100) * 0.28; // 0..28% (refined subtle dark tint from 51e079d)
  const l0 = 2.0 + (clamp(lightnessPct, 0, 100) / 100) * 7.5; // 2.0%..9.5%

  const canvas = hslToHex(h, s0, l0);
  const rail = hslToHex(h, s0 * 0.96, l0 + 1.8);
  const surface1 = hslToHex(h, s0 * 0.92, l0 + 3.6);
  const surface2 = hslToHex(h, s0 * 0.88, l0 + 6.8);
  const surface3 = hslToHex(h, s0 * 0.84, l0 + 10.6);
  const hud = hslToHex(h, s0 * 0.95, l0 + 2.2); // 100% solid opaque hex
  const elevatedBase = hslToHex(h, s0 * 0.9, l0 + 4.4);
  const glassBase = hslToHex(h, s0 * 0.95, l0 + 2.0);
  const codeBg = hslToHex(h, s0 * 0.96, l0 + 1.6);

  const inkSat = Math.min(s0 * 0.35, 10);
  let primaryL = 96;
  let inkPrimary = hslToHex(h, inkSat, primaryL);
  while (
    primaryL < 100 &&
    (contrastRatio(inkPrimary, canvas) < 11.2 || contrastRatio(inkPrimary, surface1) < 11.2)
  ) {
    primaryL = Math.min(100, primaryL + 1);
    inkPrimary = hslToHex(h, primaryL >= 99 ? 0 : inkSat * 0.5, primaryL);
  }
  if (contrastRatio(inkPrimary, canvas) < 11.0 || contrastRatio(inkPrimary, surface1) < 11.0) {
    inkPrimary = '#ffffff';
  }

  let secondaryL = 69;
  let inkSecondary = hslToHex(h, Math.min(s0 * 0.38, 11), secondaryL);
  while (
    secondaryL < 90 &&
    (contrastRatio(inkSecondary, canvas) < 6.5 || contrastRatio(inkSecondary, surface1) < 6.2)
  ) {
    secondaryL += 1;
    inkSecondary = hslToHex(h, Math.min(s0 * 0.35, 10), secondaryL);
  }

  let mutedL = 54;
  let inkMuted = hslToHex(h, inkSat, mutedL);
  while (
    mutedL < 82 &&
    (contrastRatio(inkMuted, canvas) < 4.7 || contrastRatio(inkMuted, surface1) < 4.6)
  ) {
    mutedL += 1;
    inkMuted = hslToHex(h, inkSat, mutedL);
  }

  return {
    canvas,
    rail,
    surface1,
    surface2,
    surface3,
    elevated: hexToRgba(elevatedBase, 0.96),
    hud,
    glass: hexToRgba(glassBase, 0.86),
    codeBg,
    secretBg: `linear-gradient(155deg, ${surface2} 0%, ${surface1} 100%)`,
    inkPrimary,
    inkSecondary,
    inkMuted,
    borderHairline: hexToRgba(inkPrimary, 0.08),
    borderStrong: hexToRgba(inkPrimary, 0.16),
  };
}

function buildLightSurfaceLadder(hue: number, tintPct: number, lightnessPct: number): SurfacePalette {
  const h = wrapHue(hue);
  const s0 = clamp(tintPct, 0, 100) * 0.36; // 0..36% tasteful character on paper/ice/sage/sand
  const l0 = 91.5 + (clamp(lightnessPct, 0, 100) / 100) * 6.5; // 91.5%..98.0%

  const canvas = hslToHex(h, s0, l0);
  const rail = hslToHex(h, Math.min(s0 * 1.1, 38), Math.max(87.0, l0 - 3.2));
  const surface1 = hslToHex(h, s0 * 0.14, Math.min(100, l0 + 4.8)); // Crisp luminous white / ivory card
  const surface2 = hslToHex(h, s0 * 0.85, Math.max(88.0, l0 - 2.2));
  const surface3 = hslToHex(h, Math.min(s0 * 0.98, 36), Math.max(83.0, l0 - 5.8));
  const hud = hslToHex(h, s0 * 0.24, Math.min(99.6, l0 + 2.4)); // 100% solid opaque hex
  const codeBg = hslToHex(h, s0 * 0.85, Math.max(88.0, l0 - 2.4));

  const inkSat = Math.min(s0 * 0.42, 12);
  let primaryL = 10.5;
  let inkPrimary = hslToHex(h, inkSat, primaryL);
  while (
    primaryL > 0 &&
    (contrastRatio(inkPrimary, canvas) < 11.2 ||
      contrastRatio(inkPrimary, surface1) < 11.2 ||
      contrastRatio(inkPrimary, rail) < 11.0)
  ) {
    primaryL = Math.max(0, primaryL - 1);
    inkPrimary = hslToHex(h, primaryL <= 2 ? 0 : inkSat * 0.5, primaryL);
  }
  if (
    contrastRatio(inkPrimary, canvas) < 11.0 ||
    contrastRatio(inkPrimary, surface1) < 11.0
  ) {
    inkPrimary = '#111827';
  }

  let secondaryL = 34;
  let inkSecondary = hslToHex(h, inkSat, secondaryL);
  while (
    secondaryL > 12 &&
    (contrastRatio(inkSecondary, canvas) < 6.2 || contrastRatio(inkSecondary, surface1) < 6.2)
  ) {
    secondaryL -= 1;
    inkSecondary = hslToHex(h, inkSat, secondaryL);
  }

  let mutedL = 42;
  let inkMuted = hslToHex(h, inkSat, mutedL);
  while (
    mutedL > 16 &&
    (contrastRatio(inkMuted, canvas) < 4.7 ||
      contrastRatio(inkMuted, surface1) < 4.65 ||
      contrastRatio(inkMuted, rail) < 4.55 ||
      contrastRatio(inkMuted, surface2) < 4.75)
  ) {
    mutedL -= 1;
    inkMuted = hslToHex(h, inkSat, mutedL);
  }

  return {
    canvas,
    rail,
    surface1,
    surface2,
    surface3,
    elevated: hexToRgba(surface1, 0.98),
    hud,
    glass: hexToRgba(canvas, 0.9),
    codeBg,
    secretBg: `linear-gradient(155deg, ${surface1} 0%, ${surface2} 100%)`,
    inkPrimary,
    inkSecondary,
    inkMuted,
    borderHairline: hexToRgba(inkPrimary, 0.08),
    borderStrong: hexToRgba(inkPrimary, 0.16),
  };
}

function resolveSurfacePalette(mode: ThemeMode, config: AppearanceConfig): SurfacePalette {
  const presetId = config.bgPreset;

  if (presetId === 'custom') {
    return mode === 'dark'
      ? buildDarkSurfaceLadder(config.bgHue, config.bgTint, config.bgLightness)
      : buildLightSurfaceLadder(config.bgHue, config.bgTint, config.bgLightness);
  }

  const effectivePresetId: BackgroundPresetMeta['id'] =
    mode === 'dark'
      ? LIGHT_TO_DARK_BG_PAIR[presetId] ??
        (DARK_BG_PRESETS.some((p) => p.id === presetId) ? (presetId as BackgroundPresetMeta['id']) : 'obsidian')
      : DARK_TO_LIGHT_BG_PAIR[presetId] ??
        (LIGHT_BG_PRESETS.some((p) => p.id === presetId) ? (presetId as BackgroundPresetMeta['id']) : 'porcelain');

  // Pixel-faithful pre-Phase-5 Obsidian dark tokens (with 100% solid opaque HUD & WCAG-safe muted ink)
  if (mode === 'dark' && effectivePresetId === 'obsidian') {
    return {
      canvas: '#0e0e11',
      rail: '#121216',
      surface1: '#17171c',
      surface2: '#1f1f26',
      surface3: '#282831',
      elevated: 'rgba(24, 24, 30, 0.96)',
      hud: '#131318',
      glass: 'rgba(18, 18, 22, 0.86)',
      codeBg: '#121216',
      secretBg: 'linear-gradient(155deg, #212129 0%, #15151a 100%)',
      inkPrimary: '#f4f4f6',
      inkSecondary: '#a2a2ad',
      inkMuted: '#828290',
      borderHairline: 'rgba(244, 244, 246, 0.075)',
      borderStrong: 'rgba(244, 244, 246, 0.155)',
    };
  }

  // Elevated crisp Apple/Linear-grade Porcelain light tokens
  if (mode === 'light' && effectivePresetId === 'porcelain') {
    return {
      canvas: '#f4f5f7',
      rail: '#eceef2',
      surface1: '#ffffff',
      surface2: '#eef0f4',
      surface3: '#e3e6ed',
      elevated: 'rgba(255, 255, 255, 0.98)',
      hud: '#f8f9fb',
      glass: 'rgba(244, 245, 247, 0.9)',
      codeBg: '#eef0f4',
      secretBg: 'linear-gradient(155deg, #ffffff 0%, #f1f3f7 100%)',
      inkPrimary: '#111827',
      inkSecondary: '#4b5563',
      inkMuted: '#5b6472',
      borderHairline: 'rgba(15, 23, 42, 0.08)',
      borderStrong: 'rgba(15, 23, 42, 0.16)',
    };
  }

  const presetList = mode === 'dark' ? DARK_BG_PRESETS : LIGHT_BG_PRESETS;
  const preset = presetList.find((p) => p.id === effectivePresetId) ?? presetList[0]!;
  return mode === 'dark'
    ? buildDarkSurfaceLadder(preset.bgHue, preset.bgTint, preset.bgLightness)
    : buildLightSurfaceLadder(preset.bgHue, preset.bgTint, preset.bgLightness);
}

function resolveAccentColors(
  mode: ThemeMode,
  config: AppearanceConfig,
  surfaces: SurfacePalette
): {
  accentHex: string;
  accentHover: string;
  inkOnAccent: string;
} {
  if (config.accentMode === 'preset') {
    const preset = resolveAccentPreset(config.accentPreset);
    const accentHex = mode === 'dark' ? preset.swatchDark : preset.swatchLight;
    const hsl = hexToHsl(accentHex);
    const accentHover =
      mode === 'dark'
        ? hslToHex(hsl.h, hsl.s, clamp(hsl.l + 6.5, 48, 82))
        : hslToHex(hsl.h, hsl.s, clamp(hsl.l - 5.5, 20, 48));
    return {
      accentHex,
      accentHover,
      inkOnAccent: pickInkOnAccent(accentHex),
    };
  }

  const parsedHex = normalizeHex(config.accentHex) ?? '#d95826';
  const rawHsl = hexToHsl(parsedHex);
  const sat = clamp(rawHsl.s, 18, 96);

  if (mode === 'dark') {
    let lig = clamp(rawHsl.l, 46, 72);
    let accentHex = hslToHex(rawHsl.h, sat, lig);
    while (
      lig < 78 &&
      (contrastRatio(accentHex, surfaces.canvas) < 4.5 ||
        contrastRatio(accentHex, surfaces.surface1) < 4.5)
    ) {
      lig = Math.min(78, lig + 1.5);
      accentHex = hslToHex(rawHsl.h, sat, lig);
    }
    const accentHover = hslToHex(rawHsl.h, sat, clamp(lig + 6.5, 50, 84));
    return {
      accentHex,
      accentHover,
      inkOnAccent: pickInkOnAccent(accentHex),
    };
  }

  let lig = clamp(rawHsl.l, 30, 52);
  let accentHex = hslToHex(rawHsl.h, sat, lig);
  while (
    lig > 18 &&
    (contrastRatio(accentHex, surfaces.canvas) < 4.5 ||
      contrastRatio(accentHex, surfaces.surface1) < 4.5)
  ) {
    lig = Math.max(18, lig - 1.5);
    accentHex = hslToHex(rawHsl.h, sat, lig);
  }
  const accentHover = hslToHex(rawHsl.h, sat, clamp(lig - 5.5, 14, 46));
  return {
    accentHex,
    accentHover,
    inkOnAccent: pickInkOnAccent(accentHex),
  };
}

/**
 * Deterministically computes a complete WCAG-verified CSS token set for Desktop & Mobile
 * from theme mode (`dark` | `light`) and `AppearanceConfig`.
 */
export function computeThemeTokens(
  mode: ThemeMode,
  config: AppearanceConfig = DEFAULT_APPEARANCE_CONFIG
): ComputedThemeTokens {
  const surfaces = resolveSurfacePalette(mode, config);
  const { accentHex, accentHover, inkOnAccent } = resolveAccentColors(mode, config, surfaces);

  const accentSoftAlpha = mode === 'dark' ? 0.15 : 0.11;
  const accentGlowAlpha = mode === 'dark' ? 0.25 : 0.19;
  const focusAlpha = mode === 'dark' ? 0.64 : 0.54;
  const sheenAlpha = mode === 'dark' ? 0.14 : 0.16;

  const cssVars: Record<string, string> = {
    '--k-bg-canvas': surfaces.canvas,
    '--k-bg-rail': surfaces.rail,
    '--k-bg-surface-1': surfaces.surface1,
    '--k-bg-surface-2': surfaces.surface2,
    '--k-bg-surface-3': surfaces.surface3,
    '--k-bg-elevated': surfaces.elevated,
    '--k-bg-hud': surfaces.hud,
    '--k-bg-glass': surfaces.glass,
    '--k-code-bg': surfaces.codeBg,
    '--k-secret-bg': surfaces.secretBg,
    '--k-ink-primary': surfaces.inkPrimary,
    '--k-ink-secondary': surfaces.inkSecondary,
    '--k-ink-muted': surfaces.inkMuted,
    '--k-ink-on-accent': inkOnAccent,
    '--k-border-hairline': surfaces.borderHairline,
    '--k-border-strong': surfaces.borderStrong,
    '--k-border-focus': hexToRgba(accentHex, focusAlpha),
    '--k-accent': accentHex,
    '--k-accent-hover': accentHover,
    '--k-accent-soft': hexToRgba(accentHex, accentSoftAlpha),
    '--k-accent-glow': hexToRgba(accentHex, accentGlowAlpha),
    '--k-secret-sheen': hexToRgba(accentHex, sheenAlpha),
  };

  return {
    cssVars,
    canvasHex: surfaces.canvas,
    hudHex: surfaces.hud,
    accentHex,
    inkOnAccent,
  };
}
