import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  DEFAULT_APPEARANCE_CONFIG,
  LIGHT_BG_PRESETS,
  computeThemeTokens,
  contrastRatio,
  hexToHsl,
  hslToHex,
  normalizeHex,
  relativeLuminance,
} from '@shared/color-engine';
import type { AppearanceConfig } from '@shared/types';

const SOLID_HEX_RE = /^#[0-9a-f]{6}$/;

describe('Color Engine (WCAG contrast, full hue sweep, solid opaque HUD)', () => {
  it('normalizes hex colors and computes accurate HSL and WCAG luminance/contrast', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('  e86a33 ')).toBe('#e86a33');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('not-a-hex')).toBeNull();

    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
    expect(contrastRatio('#e86a33', '#e86a33')).toBeCloseTo(1, 5);

    const hsl = hexToHsl('#4f86f7');
    expect(hsl.h).toBeGreaterThan(215);
    expect(hsl.h).toBeLessThan(225);
    expect(hslToHex(hsl.h, hsl.s, hsl.l)).toMatch(SOLID_HEX_RE);
  });

  it('preserves exact default Obsidian (dark) and elevated Porcelain (light) tokens with 100% opaque HUD', () => {
    const dark = computeThemeTokens('dark', DEFAULT_APPEARANCE_CONFIG);
    expect(dark.canvasHex).toBe('#0e0e11');
    expect(dark.hudHex).toBe('#131318');
    expect(dark.cssVars['--k-bg-hud']).toBe('#131318');
    expect(dark.cssVars['--k-bg-surface-1']).toBe('#17171c');
    expect(dark.accentHex).toBe('#d95826');
    expect(dark.inkOnAccent).toBe('#ffffff');
    expect(contrastRatio(dark.accentHex, dark.inkOnAccent)).toBeGreaterThanOrEqual(3.8);
    expect(contrastRatio(dark.cssVars['--k-ink-primary']!, dark.canvasHex)).toBeGreaterThanOrEqual(11);
    expect(contrastRatio(dark.cssVars['--k-ink-muted']!, dark.canvasHex)).toBeGreaterThanOrEqual(4.5);

    // Switching dark -> light with default obsidian bgPreset seamlessly maps to porcelain
    const light = computeThemeTokens('light', DEFAULT_APPEARANCE_CONFIG);
    expect(light.canvasHex).toBe('#f4f5f7');
    expect(light.cssVars['--k-bg-rail']).toBe('#eceef2');
    expect(light.hudHex).toBe('#f8f9fb');
    expect(light.cssVars['--k-bg-hud']).toBe('#f8f9fb');
    expect(light.cssVars['--k-bg-surface-1']).toBe('#ffffff');
    expect(light.accentHex).toBe('#c54914');
    expect(light.inkOnAccent).toBe('#ffffff');
    expect(contrastRatio(light.accentHex, light.inkOnAccent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.cssVars['--k-ink-primary']!, light.canvasHex)).toBeGreaterThanOrEqual(11);
    expect(contrastRatio(light.cssVars['--k-ink-muted']!, light.canvasHex)).toBeGreaterThanOrEqual(4.5);
  });

  it('provides distinct curated dark and light presets with clearly distinguishable 2-tone preview swatches', () => {
    const darkCanvases = new Set<string>();
    const darkPreviewCanvases = new Set<string>();
    const darkPreviewSurfaces = new Set<string>();
    for (const preset of DARK_BG_PRESETS) {
      expect(preset.previewCanvas).toMatch(SOLID_HEX_RE);
      expect(preset.previewSurface).toMatch(SOLID_HEX_RE);
      expect(preset.previewCanvas).not.toBe(preset.previewSurface);
      const res = computeThemeTokens('dark', { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: preset.id });
      expect(res.canvasHex).toMatch(SOLID_HEX_RE);
      expect(res.cssVars['--k-bg-surface-1']).toMatch(SOLID_HEX_RE);
      darkCanvases.add(res.canvasHex);
      darkPreviewCanvases.add(preset.previewCanvas);
      darkPreviewSurfaces.add(preset.previewSurface);
    }
    expect(darkCanvases.size).toBe(DARK_BG_PRESETS.length);
    expect(darkPreviewCanvases.size).toBe(DARK_BG_PRESETS.length);
    expect(darkPreviewSurfaces.size).toBe(DARK_BG_PRESETS.length);

    const lightCanvases = new Set<string>();
    const lightPreviewCanvases = new Set<string>();
    for (const preset of LIGHT_BG_PRESETS) {
      expect(preset.previewCanvas).toMatch(SOLID_HEX_RE);
      expect(preset.previewSurface).toMatch(SOLID_HEX_RE);
      expect(preset.previewCanvas).not.toBe(preset.previewSurface);
      const res = computeThemeTokens('light', { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: preset.id });
      expect(res.canvasHex).toMatch(SOLID_HEX_RE);
      lightCanvases.add(res.canvasHex);
      lightPreviewCanvases.add(preset.previewCanvas);
    }
    expect(lightCanvases.size).toBe(LIGHT_BG_PRESETS.length);
    expect(lightPreviewCanvases.size).toBe(LIGHT_BG_PRESETS.length);
  });

  it('guarantees WCAG contrast and opaque HUD across ALL curated accent & background presets', () => {
    expect(ACCENT_PRESETS.map((p) => p.id)).toEqual([
      'terracotta',
      'cobalt',
      'emerald',
      'violet',
      'amber',
      'rose',
    ]);

    for (const bg of DARK_BG_PRESETS) {
      for (const acc of ACCENT_PRESETS) {
        const res = computeThemeTokens('dark', {
          ...DEFAULT_APPEARANCE_CONFIG,
          accentMode: 'preset',
          accentPreset: acc.id,
          bgPreset: bg.id,
        });
        expect(res.hudHex).toMatch(SOLID_HEX_RE);
        expect(res.cssVars['--k-bg-hud']).toBe(res.hudHex);
        expect(contrastRatio(res.accentHex, res.inkOnAccent)).toBeGreaterThanOrEqual(3.5);
        expect(contrastRatio(res.cssVars['--k-ink-primary']!, res.canvasHex)).toBeGreaterThanOrEqual(11);
        expect(contrastRatio(res.cssVars['--k-ink-primary']!, res.cssVars['--k-bg-surface-1']!)).toBeGreaterThanOrEqual(11);
        expect(contrastRatio(res.cssVars['--k-ink-muted']!, res.canvasHex)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(res.cssVars['--k-ink-muted']!, res.cssVars['--k-bg-surface-1']!)).toBeGreaterThanOrEqual(4.5);
      }
    }

    for (const bg of LIGHT_BG_PRESETS) {
      for (const acc of ACCENT_PRESETS) {
        const res = computeThemeTokens('light', {
          ...DEFAULT_APPEARANCE_CONFIG,
          accentMode: 'preset',
          accentPreset: acc.id,
          bgPreset: bg.id,
        });
        expect(res.hudHex).toMatch(SOLID_HEX_RE);
        expect(res.cssVars['--k-bg-hud']).toBe(res.hudHex);
        expect(res.inkOnAccent).toBe('#ffffff');
        expect(contrastRatio(res.accentHex, res.inkOnAccent)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(res.cssVars['--k-ink-primary']!, res.canvasHex)).toBeGreaterThanOrEqual(11);
        expect(contrastRatio(res.cssVars['--k-ink-primary']!, res.cssVars['--k-bg-surface-1']!)).toBeGreaterThanOrEqual(11);
        expect(contrastRatio(res.cssVars['--k-ink-muted']!, res.canvasHex)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(res.cssVars['--k-ink-muted']!, res.cssVars['--k-bg-surface-1']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(res.cssVars['--k-ink-muted']!, res.cssVars['--k-bg-surface-2']!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('guarantees WCAG >= 4.5:1 accent contrast and >= 3.5:1 inkOnAccent across full 0..360 hue sweep in dark and light modes', () => {
    // Bright yellow custom accent falls back to dark ink (#09090d)
    const brightYellow = computeThemeTokens('dark', {
      ...DEFAULT_APPEARANCE_CONFIG,
      accentMode: 'custom',
      accentHex: '#facc15',
    });
    expect(brightYellow.inkOnAccent).toBe('#09090d');

    for (const mode of ['dark', 'light'] as const) {
      for (let hue = 0; hue < 360; hue += 5) {
        for (const inputLightness of [20, 50, 85]) {
          const customHex = hslToHex(hue, 88, inputLightness);
          const cfg: AppearanceConfig = {
            ...DEFAULT_APPEARANCE_CONFIG,
            accentMode: 'custom',
            accentHex: customHex,
            bgPreset: mode === 'dark' ? 'obsidian' : 'porcelain',
          };
          const res = computeThemeTokens(mode, cfg);
          expect(res.accentHex).toMatch(SOLID_HEX_RE);
          expect(res.hudHex).toMatch(SOLID_HEX_RE);
          expect(contrastRatio(res.accentHex, res.inkOnAccent)).toBeGreaterThanOrEqual(3.5);
          expect(contrastRatio(res.accentHex, res.canvasHex)).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(res.accentHex, res.cssVars['--k-bg-surface-1']!)
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('guarantees >= 11:1 primary ink, >= 4.5:1 muted ink, and solid opaque HUD across full 0..360 custom background sweep', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (let hue = 0; hue < 360; hue += 15) {
        for (const tint of [0, 50, 100]) {
          for (const lightness of [0, 50, 100]) {
            const cfg: AppearanceConfig = {
              ...DEFAULT_APPEARANCE_CONFIG,
              bgPreset: 'custom',
              bgHue: hue,
              bgTint: tint,
              bgLightness: lightness,
            };
            const res = computeThemeTokens(mode, cfg);
            expect(res.canvasHex).toMatch(SOLID_HEX_RE);
            expect(res.hudHex).toMatch(SOLID_HEX_RE);
            expect(res.cssVars['--k-bg-hud']).toBe(res.hudHex);
            expect(res.cssVars['--k-bg-hud']).not.toContain('rgba');
            expect(
              contrastRatio(res.cssVars['--k-ink-primary']!, res.canvasHex)
            ).toBeGreaterThanOrEqual(11);
            expect(
              contrastRatio(res.cssVars['--k-ink-primary']!, res.cssVars['--k-bg-surface-1']!)
            ).toBeGreaterThanOrEqual(11);
            expect(
              contrastRatio(res.cssVars['--k-ink-muted']!, res.canvasHex)
            ).toBeGreaterThanOrEqual(4.5);
            expect(
              contrastRatio(res.cssVars['--k-ink-muted']!, res.cssVars['--k-bg-surface-1']!)
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
});
