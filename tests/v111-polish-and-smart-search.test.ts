import { describe, expect, it } from 'vitest';
import {
  damerauDistanceWithin,
  extractMatchedSnippet,
  matchesBilingualHaystack,
  scoreBilingualFields,
  splitHighlightSegments,
} from '../src/shared/bilingual-search';
import { computeThemeTokens, DEFAULT_APPEARANCE_CONFIG } from '../src/shared/color-engine';
import { extractImageFilesFromDataTransfer } from '../src/renderer/components/editor/KapsulaImageNode';

describe('v1.1.1 clipboard image paste deduplication', () => {
  it('returns only 1 file when Windows clipboard exposes the same image in both items and files with different lastModified', () => {
    const fileA = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', {
      type: 'image/png',
      lastModified: 1700000000001,
    });
    const fileB = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', {
      type: 'image/png',
      lastModified: 1700000000002,
    });

    const dt = {
      items: [
        {
          kind: 'file',
          getAsFile: () => fileA,
        },
      ],
      files: [fileB],
    } as unknown as DataTransfer;

    const extracted = extractImageFilesFromDataTransfer(dt);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(fileA);
  });

  it('falls back to dt.files when dt.items contains no images', () => {
    const file = new File([new Uint8Array([9, 8, 7])], 'shot.png', {
      type: 'image/png',
      lastModified: 1700000000010,
    });
    const dt = {
      items: [],
      files: [file],
    } as unknown as DataTransfer;

    const extracted = extractImageFilesFromDataTransfer(dt);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(file);
  });
});

describe('v1.1.1 smart search (typo tolerance, relevance scoring, snippets, highlights)', () => {
  it('matches case-insensitively, handles ё/е, and tolerates typos via Damerau-Levenshtein', () => {
    expect(damerauDistanceWithin('капсула', 'капусла', 2)).toBe(1);
    expect(matchesBilingualHaystack('Новая заметка Kapsula про Выделение', 'kapsula')).toBe(true);
    expect(matchesBilingualHaystack('Новая заметка про Выделение текста', 'выдление')).toBe(true);
    expect(matchesBilingualHaystack('Закреплённые карточки', 'закрепленные')).toBe(true);
    expect(matchesBilingualHaystack('Референсы в Instagram', 'инстагарм')).toBe(true);
  });

  it('ranks title matches above body-only matches and supports #tag + section names', () => {
    const titleScore = scoreBilingualFields(
      {
        title: 'Kapsula баги релиза',
        body: 'короткий список',
        orbitName: 'Kapsula',
        tags: ['релиз'],
        updatedAt: Date.now() - 10_000,
      },
      'капсула #релиз'
    );
    const bodyOnlyScore = scoreBilingualFields(
      {
        title: 'Разные мысли',
        body: 'Тут в конце упомянута kapsula и ещё пару слов',
        tags: ['релиз'],
        updatedAt: Date.now(),
      },
      'капсула #релиз'
    );
    expect(titleScore).toBeGreaterThan(bodyOnlyScore);
    expect(bodyOnlyScore).toBeGreaterThan(0);

    const missingTagScore = scoreBilingualFields(
      {
        title: 'Kapsula баги релиза',
        tags: ['другое'],
      },
      'капсула #релиз'
    );
    expect(missingTagScore).toBe(0);
  });

  it('extracts a contextual snippet around the match and highlights matched ranges', () => {
    const longText =
      'Очень длинное вступление о совершенно других вещах, которое занимает много символов и уходит далеко вправо. А вот здесь спряталось нужное слово Прозрачность окна для проверки сниппета.';
    const snippet = extractMatchedSnippet(longText, 'прозрачность', 72);
    expect(snippet.toLowerCase()).toContain('прозрачность');
    expect(snippet.startsWith('…')).toBe(true);

    const segments = splitHighlightSegments('Настройки прозрачности окна', 'прозрачн');
    expect(segments.some((s) => s.hit && s.text.toLowerCase() === 'прозрачн')).toBe(true);
  });
});

describe('v1.1.1 glassmorphism canvas alpha tokens', () => {
  it('emits translucent --k-glass-canvas variable when glassPreset is enabled', () => {
    const frosted = computeThemeTokens('dark', {
      ...DEFAULT_APPEARANCE_CONFIG,
      glassPreset: 'frosted',
      glassNativeMaterial: 'acrylic',
    });
    expect(frosted.cssVars['--k-glass-canvas']).toMatch(/^rgba\(/);
    expect(frosted.cssVars['--k-glass-rail']).toMatch(/^rgba\(/);

    const off = computeThemeTokens('dark', {
      ...DEFAULT_APPEARANCE_CONFIG,
      glassPreset: 'off',
    });
    expect(off.cssVars['--k-glass-canvas']).toBeUndefined();
  });
});
