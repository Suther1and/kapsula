// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  computeThemeTokens,
  DEFAULT_APPEARANCE_CONFIG,
} from '../src/shared/color-engine';
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
import { SmartLinkCard } from '@renderer/components/cards/SmartLinkCard';
import { SelectMenu } from '@renderer/components/ui/SelectMenu';
import { ContextMenuSurface } from '@renderer/components/ui/ContextMenuSurface';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

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
    expect(computeTargetOverIndex(rects, 0, 34, 4)).toBe(0);
    expect(computeTargetOverIndex(rects, 0, 38, 4)).toBe(0);
    expect(computeTargetOverIndex(rects, 0, 39, 4)).toBe(1);
    expect(computeTargetOverIndex(rects, 1, 32, 4)).toBe(1);
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
      content:
        'До линии\n\n---\n\n<hr data-k-hr="dashed" />\n\n<hr data-k-hr="dots" />\n\n<hr data-k-hr="fade" />\n\n<hr data-k-hr="accent" />\n\nПосле линии',
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

describe('Desktop UI Polish, SmartLinkCard Video Gating & Crisp Menu Highlights', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('SmartLinkCard hides video-download button for private Telegram, unavailable, and text-only X posts; shows private badge and refresh button for bare stubs', async () => {
    const reprocessMock = vi.fn(async () => null);
    installMockKapsulaApi({ reprocessItem: reprocessMock });

    // 1. Private Telegram link -> shows private badge, NO load-video button
    const privateTg = makeVaultItem({
      id: 'tg-private-1',
      dna: 'link',
      title: 'Закрытый пост Telegram',
      body: 'Пост из закрытого канала',
      url: 'https://t.me/c/123456/78',
      domain: 't.me',
      platform: 'telegram',
      mediaMeta: { linkAccess: 'private', hasVideo: false },
    });

    const { rerender } = renderWithI18n(
      React.createElement(SmartLinkCard, { item: privateTg })
    );
    expect(screen.getByTestId('smart-link-private-badge-tg-private-1')).toBeTruthy();
    expect(screen.queryByTestId('ensure-link-video-tg-private-1')).toBeNull();

    // 2. Text-only X post (hasVideo: false) -> NO load-video button
    const textOnlyX = makeVaultItem({
      id: 'x-text-1',
      dna: 'link',
      title: 'Author (@a): Short thought',
      body: 'Short thought without video',
      url: 'https://x.com/a/status/111222',
      domain: 'x.com',
      platform: 'x',
      mediaMeta: { linkAccess: 'public', hasVideo: false },
    });
    rerender(React.createElement(SmartLinkCard, { item: textOnlyX }));
    expect(screen.queryByTestId('ensure-link-video-x-text-1')).toBeNull();

    // 3. X post with video -> SHOWS load-video button
    const videoX = makeVaultItem({
      id: 'x-video-1',
      dna: 'link',
      title: 'Author (@a): Demo clip',
      body: 'Watch the demo',
      url: 'https://x.com/a/status/333444',
      domain: 'x.com',
      platform: 'x',
      mediaMeta: { linkAccess: 'public', hasVideo: true },
    });
    rerender(React.createElement(SmartLinkCard, { item: videoX }));
    expect(screen.getByTestId('ensure-link-video-x-video-1')).toBeTruthy();

    // 4. Bare un-unfurled stub link -> shows inline refresh button that calls reprocessItem
    const bareStub = makeVaultItem({
      id: 'bare-stub-1',
      dna: 'link',
      title: 'x.com',
      body: 'https://x.com/a/status/555666',
      summary: '',
      url: 'https://x.com/a/status/555666',
      domain: 'x.com',
      platform: 'x',
    });
    rerender(React.createElement(SmartLinkCard, { item: bareStub }));
    const refreshBtn = screen.getByTestId('smart-link-refresh-btn-bare-stub-1');
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn);
    expect(reprocessMock).toHaveBeenCalledWith('bare-stub-1');
  });

  it('SelectMenu & ContextMenuSurface use integer top/height hover highlights without translate3d GPU blur', () => {
    renderWithI18n(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(SelectMenu, {
          'data-testid': 'crisp-select',
          value: 'a',
          onChange: () => {},
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        }),
        React.createElement(ContextMenuSurface, {
          entries: [
            { type: 'item', id: 'one', label: 'Открыть', onSelect: () => {} },
            { type: 'item', id: 'two', label: 'Удалить', danger: true, onSelect: () => {} },
          ],
          children: React.createElement('div', { 'data-testid': 'ctx-trigger' }, 'Trigger'),
        })
      )
    );

    // SelectMenu highlight uses top/height (zero translate3d, zero layoutId)
    fireEvent.click(screen.getByTestId('crisp-select'));
    const popup = screen.getByTestId('crisp-select-popup');
    const betaOption = screen.getByText('Beta').closest('[role="option"]')!;
    fireEvent.mouseEnter(betaOption);

    const selHl = popup.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    expect(selHl).toBeTruthy();
    expect(selHl!.style.transform || '').not.toContain('translate3d');
    expect(selHl!.style.top).toMatch(/^\d+px$/);

    // Analogous NoteStudio EditorBlockContextMenu uses crisp integer top/height without translate3d or reduced-motion freeze
    const blockMenuSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/editor/EditorBlockContextMenu.tsx'),
      'utf8'
    );
    expect(blockMenuSrc).toContain('top: `${Math.round(hl.top)}px`');
    expect(blockMenuSrc).toContain('height: `${Math.round(hl.height)}px`');
    expect(blockMenuSrc).not.toContain('translate3d(0, ${hl.top}px, 0)');
    expect(blockMenuSrc).not.toContain("prefersReduced ? 'none'");
  });

  it('preserves opaque elevated menu tokens and continuous accent-harmonized <mark> selection styles', () => {
    const tokensCss = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/styles/tokens.css'),
      'utf8'
    );
    const editorCss = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/styles/editor.css'),
      'utf8'
    );

    // Strictly opaque elevated popover surface prevents Chromium LCD -> grayscale AA blur
    expect(tokensCss).toContain('--k-bg-elevated: #18181e;');
    expect(tokensCss).toContain('--k-bg-elevated: #ffffff;');
    // Harmonized <mark>::selection token
    expect(tokensCss).toContain(
      '--k-mark-selection-bg: color-mix(in srgb, var(--k-accent) 26%, rgba(244, 244, 246, 0.12));'
    );
    expect(tokensCss).toContain(
      '--k-mark-selection-bg: color-mix(in srgb, var(--k-accent) 22%, rgba(15, 23, 42, 0.06));'
    );
    // Tight mark padding avoids notch gaps across selection boundaries
    expect(editorCss).toContain('padding: 0.02em 0.05em;');
    expect(editorCss).toContain('background: var(--k-selection-bg);');

    // Runtime color-engine must also emit strictly opaque hex `--k-bg-elevated` (never rgba)
    // across classic and adaptive dark/light themes so appearance.ts never re-introduces menu AA blur.
    const configs = [
      { mode: 'dark' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'obsidian' as const } },
      { mode: 'light' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'porcelain' as const } },
      { mode: 'dark' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'midnight' as const } },
      { mode: 'light' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'paper' as const } },
      { mode: 'dark' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'custom' as const, bgHue: 210, bgTint: 40, bgLightness: 35 } },
      { mode: 'light' as const, cfg: { ...DEFAULT_APPEARANCE_CONFIG, bgPreset: 'custom' as const, bgHue: 40, bgTint: 35, bgLightness: 60 } },
    ];
    for (const { mode, cfg } of configs) {
      const tokens = computeThemeTokens(mode, cfg);
      const elevated = tokens.cssVars['--k-bg-elevated'] ?? '';
      expect(elevated).toMatch(/^#[0-9a-f]{6}$/i);
      expect(elevated.toLowerCase()).not.toContain('rgba');
    }
  });
});
