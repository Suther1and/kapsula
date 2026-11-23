// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE_CONFIG, computeThemeTokens } from '@shared/color-engine';
import { applyAppearanceToDocument, sanitizeAppearanceConfig } from '@renderer/lib/appearance';

describe('Wave 6: Glassmorphism Appearance Tokens, Validation & DOM Integration', () => {
  it('keeps default appearance glassPreset=off with solid opaque surfaces and zero glass tokens', () => {
    expect(DEFAULT_APPEARANCE_CONFIG.glassPreset).toBe('off');
    expect(DEFAULT_APPEARANCE_CONFIG.glassNativeMaterial).toBe('none');

    const darkOff = computeThemeTokens('dark', DEFAULT_APPEARANCE_CONFIG);
    expect(darkOff.cssVars['--k-bg-canvas']).toBe('#0e0e11');
    expect(darkOff.cssVars['--k-bg-hud']).toBe('#131318');
    expect(darkOff.cssVars['--k-glass-blur']).toBeUndefined();
    expect(darkOff.cssVars['--k-glass-surface']).toBeUndefined();
  });

  it('emits translucent glass CSS variables for subtle/frosted/liquid while keeping solid HUD hex', () => {
    for (const preset of ['subtle', 'frosted', 'liquid'] as const) {
      const darkTokens = computeThemeTokens('dark', {
        ...DEFAULT_APPEARANCE_CONFIG,
        glassPreset: preset,
      });
      expect(darkTokens.cssVars['--k-glass-blur']).toBeTruthy();
      expect(darkTokens.cssVars['--k-glass-sat']).toBeTruthy();
      expect(darkTokens.cssVars['--k-glass-surface']).toMatch(/^rgba\(/);
      expect(darkTokens.cssVars['--k-glass-rail']).toMatch(/^rgba\(/);
      expect(darkTokens.cssVars['--k-glass-header']).toMatch(/^rgba\(/);
      expect(darkTokens.cssVars['--k-bg-hud']).toBe('#131318');

      const lightTokens = computeThemeTokens('light', {
        ...DEFAULT_APPEARANCE_CONFIG,
        glassPreset: preset,
      });
      expect(lightTokens.cssVars['--k-glass-surface']).toMatch(/^rgba\(/);
      expect(lightTokens.cssVars['--k-bg-hud']).toBe('#f8f9fb');
    }
  });

  it('sanitizes invalid glassPreset/material values cleanly and applies data-glass to documentElement', () => {
    const sanitizedInvalid = sanitizeAppearanceConfig({
      glassPreset: 'invalid_preset' as never,
      glassNativeMaterial: 'vibrancy_bad' as never,
    });
    expect(sanitizedInvalid.glassPreset).toBe('off');
    expect(sanitizedInvalid.glassNativeMaterial).toBe('none');

    const sanitizedLiquid = sanitizeAppearanceConfig({
      glassPreset: 'liquid',
      glassNativeMaterial: 'acrylic',
    });
    expect(sanitizedLiquid.glassPreset).toBe('liquid');
    expect(sanitizedLiquid.glassNativeMaterial).toBe('acrylic');

    applyAppearanceToDocument(sanitizedLiquid, undefined, 'dark');
    expect(document.documentElement.getAttribute('data-glass')).toBe('liquid');
    expect(document.documentElement.style.getPropertyValue('--k-glass-blur')).toBe('30px');

    applyAppearanceToDocument(DEFAULT_APPEARANCE_CONFIG, undefined, 'dark');
    expect(document.documentElement.getAttribute('data-glass')).toBe('off');
    expect(document.documentElement.style.getPropertyValue('--k-glass-blur')).toBe('');
  });
});
