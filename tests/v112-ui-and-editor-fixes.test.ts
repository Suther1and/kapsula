import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  HR_VARIANTS,
  KapsulaHighlight,
  KapsulaHorizontalRule,
  sanitizeHrVariant,
} from '../src/shared/tiptap-rich-marks';
import { stripMarkdownPreview } from '../src/renderer/lib/format';
import {
  computeTargetOverIndex,
  reorderArrayByIndex,
} from '../src/renderer/lib/use-pointer-sortable';

describe('Sidebar pointer sortable logic & boundary hysteresis', () => {
  it('reorders arrays cleanly for upward and downward moves', () => {
    expect(reorderArrayByIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderArrayByIndex(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderArrayByIndex(['a', 'b', 'c'], 1, 1)).toBeNull();
  });

  it('prevents jitter near slot midpoints via hysteresis and swaps cleanly past 50% overlap', () => {
    const rects = [
      { top: 0, bottom: 32, height: 32, centerY: 16 },
      { top: 36, bottom: 68, height: 32, centerY: 52 },
      { top: 72, bottom: 104, height: 32, centerY: 88 },
    ];
    // Midpoint between slot 0 (16) and slot 1 (52) is 34; deadzone is [30..38]
    expect(computeTargetOverIndex(rects, 0, 34, 4)).toBe(0);
    expect(computeTargetOverIndex(rects, 0, 38, 4)).toBe(0);
    // Crossing past midpoint + hysteresis (> 38) swaps cleanly to slot 1
    expect(computeTargetOverIndex(rects, 0, 39, 4)).toBe(1);
    // Moving back slightly inside deadzone (32) stays at 1 (zero oscillation)
    expect(computeTargetOverIndex(rects, 1, 32, 4)).toBe(1);
    // Crossing upward past midpoint - hysteresis (< 30) swaps cleanly back to slot 0
    expect(computeTargetOverIndex(rects, 1, 29, 4)).toBe(0);
  });
});

describe('KapsulaHorizontalRule styled divider markdown round-trip', () => {
  it('sanitizes variants safely and preserves default solid fallback', () => {
    expect(sanitizeHrVariant('dashed')).toBe('dashed');
    expect(sanitizeHrVariant('DOTS')).toBe('dots');
    expect(sanitizeHrVariant('fade')).toBe('fade');
    expect(sanitizeHrVariant('accent')).toBe('accent');
    expect(sanitizeHrVariant('bogus')).toBe('solid');
    expect(sanitizeHrVariant(null)).toBe('solid');
    expect(HR_VARIANTS).toHaveLength(5);
  });

  it('round-trips standard --- and styled <hr data-k-hr="..."> dividers losslessly', () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ horizontalRule: false }),
        KapsulaHorizontalRule,
        KapsulaHighlight,
        Markdown,
      ],
      content: 'До линии\n\n---\n\n<hr data-k-hr="dashed" />\n\n<hr data-k-hr="dots" />\n\n<hr data-k-hr="fade" />\n\n<hr data-k-hr="accent" />\n\nПосле линии',
      contentType: 'markdown',
    });

    const variants: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'horizontalRule') {
        variants.push(String(node.attrs.variant ?? 'solid'));
      }
      return true;
    });

    expect(variants).toEqual(['solid', 'dashed', 'dots', 'fade', 'accent']);

    const serialized = editor.getMarkdown();
    expect(serialized).toContain('---');
    expect(serialized).toContain('<hr data-k-hr="dashed" />');
    expect(serialized).toContain('<hr data-k-hr="dots" />');
    expect(serialized).toContain('<hr data-k-hr="fade" />');
    expect(serialized).toContain('<hr data-k-hr="accent" />');

    editor.destroy();
  });

  it('strips custom <hr data-k-hr="..."> tags from card text previews', () => {
    const preview = stripMarkdownPreview('Первый абзац\n\n<hr data-k-hr="dots" />\n\nВторой абзац');
    expect(preview).not.toContain('<hr');
    expect(preview).not.toContain('data-k-hr');
    expect(preview).toContain('Первый абзац');
    expect(preview).toContain('Второй абзац');
  });
});
