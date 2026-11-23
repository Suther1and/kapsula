// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { VisualShotCard } from '@renderer/components/cards/VisualShotCard';
import { installJsdomPolyfills, installMockKapsulaApi, makeVaultItem, renderWithI18n } from './helpers/ui-test-harness';

describe('Wave 6: VisualShotCard Manual Edit Summary Behavior', () => {
  beforeAll(() => {
    installJsdomPolyfills();
    installMockKapsulaApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('replaces stale AI summary with user body preview when body is edited and omits generic screenshot summary', () => {
    const withEditedBody = makeVaultItem({
      id: 'shot-1',
      dna: 'shot',
      title: 'Референс меню',
      summary: 'Старое автоматическое описание от модели',
      body: 'Моя ручная заметка по композиции',
    });

    const { rerender } = renderWithI18n(
      React.createElement(VisualShotCard, {
        item: withEditedBody,
        compactList: false,
        onZoom: vi.fn(),
      })
    );

    expect(screen.getByText('Моя ручная заметка по композиции')).toBeTruthy();
    expect(screen.queryByText('Старое автоматическое описание от модели')).toBeNull();

    const withGenericSummary = makeVaultItem({
      id: 'shot-2',
      dna: 'shot',
      title: 'Макет окна',
      summary: 'Скриншот области экрана 1280x720',
      body: '',
    });

    rerender(
      React.createElement(VisualShotCard, {
        item: withGenericSummary,
        compactList: true,
        onZoom: vi.fn(),
      })
    );

    expect(screen.getByText('Макет окна')).toBeTruthy();
    expect(screen.queryByText(/Скриншот области экрана/)).toBeNull();
  });
});
