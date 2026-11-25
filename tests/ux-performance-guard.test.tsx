// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { StudioWorkspace } from '@renderer/surfaces/StudioWorkspace';
import { CommandHudSurface } from '@renderer/surfaces/CommandHudSurface';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeOrbit,
  makeSettingsState,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

const ROOT = path.resolve(import.meta.dirname, '..');

describe('UX-First Speed & Visual Fidelity Guards (v1.1.4)', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens cards synchronously in 0ms without getVaultItem round-trip and queries full items', async () => {
    const note = makeVaultItem({
      id: 'instant-1',
      title: 'Мгновенная заметка',
      body: 'Полный текст заметки сразу на руках без лишней дозагрузки.',
    });
    const { api } = installMockKapsulaApi({
      queryVault: vi.fn(async () => [note]),
      getVaultItem: vi.fn(async () => note),
      listOrbits: vi.fn(async () => [makeOrbit()]),
    });

    renderWithI18n(
      <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
    );

    const card = await screen.findByTestId('memory-card-instant-1');
    // Must not request truncated card projection in UI feed
    for (const call of (api.queryVault as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]?.projection).not.toBe('card');
    }

    fireEvent.click(card);
    await screen.findByTestId('studio-document-modal-root');
    expect(api.getVaultItem).not.toHaveBeenCalled();
  });

  it('mounts CommandHudSurface TipTap editor immediately and patches autosave upserts in-place without reload storms', async () => {
    const note = makeVaultItem({
      id: 'hud-instant-1',
      title: 'Заметка в HUD',
      body: 'Готова к редактированию сразу по клику',
    });
    const { api, emit } = installMockKapsulaApi({
      queryVault: vi.fn(async () => [note]),
    });

    renderWithI18n(
      <CommandHudSurface settings={makeSettingsState()} onSettingsUpdated={vi.fn()} />
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="hud-right-editor"]')).not.toBeNull();
    });

    (api.queryVault as ReturnType<typeof vi.fn>).mockClear();
    act(() => {
      emit(
        'onVaultItemUpserted',
        makeVaultItem({ id: 'hud-instant-1', title: 'Обновлено без шторма', body: note.body })
      );
    });
    expect(api.queryVault).not.toHaveBeenCalled();
    expect((screen.getByTestId('hud-editor-title') as HTMLTextAreaElement).value).toBe(
      'Обновлено без шторма'
    );
  });

  it('preserves smooth blur transitions, immutable media caching, natural shot aspect ratios, and GPU BorderTrail', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
    expect(mainSrc).toContain('private, max-age=31536000, immutable');
    expect(mainSrc).not.toContain("const cacheHeader = 'no-store';");

    const studioSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/surfaces/StudioWorkspace.tsx'), 'utf8');
    expect(studioSrc).toContain("backdropFilter: 'blur(0px)'");
    expect(studioSrc).toContain("backdropFilter: 'blur(6px)'");
    expect(studioSrc).toContain('useMountOnce');

    const quickLookSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ui/QuickLookModal.tsx'), 'utf8');
    expect(quickLookSrc).toContain("backdropFilter: 'blur(0px)'");
    expect(quickLookSrc).toContain("backdropFilter: 'blur(6px)'");

    const shotSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/components/cards/VisualShotCard.tsx'), 'utf8');
    expect(shotSrc).not.toContain('aspect-[16/10]');

    const borderTrailSrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/components/motion-primitives/border-trail.tsx'),
      'utf8'
    );
    expect(borderTrailSrc).toContain('k-border-trail-spin');
    expect(borderTrailSrc).not.toContain('offsetDistance');
  });
});
