// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { GlobalSearchPopover } from '@renderer/components/ui/GlobalSearchPopover';
import { ProseCaretOverlay } from '@renderer/components/editor/ProseCaretOverlay';
import { WaveformAudioPlayer } from '@renderer/components/ui/WaveformAudioPlayer';
import { MobileAudioPlayer } from '@mobile/components/MobileAudioPlayer';
import { MobileMediaImage } from '@mobile/components/MobileMediaImage';
import { MobileMediaCacheContext } from '@mobile/lib/media-cache-context';
import { MobileI18nProvider } from '@mobile/lib/mobile-i18n';
import { mobileBridge } from '@mobile/native/bridge';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import {
  installJsdomPolyfills,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

describe('Wave 3 UI & Mobile Performance Guards', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps >40 mounted MobileMediaImage blob URLs alive via refcounts and evicts back to <=40 after unmount', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    let urlSeq = 0;
    const revokedUrls: string[] = [];
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob:kapsula-test/${++urlSeq}`);
    const revokeSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url: string) => {
        revokedUrls.push(url);
      });

    const names: string[] = [];
    const payload = new Uint8Array([137, 80, 78, 71]);
    for (let i = 0; i < 60; i += 1) {
      const name = `img-${i}.png`;
      names.push(name);
      await store.putMedia(name, 'image/png', payload);
    }

    const ensureMediaUrl = (localName?: string | null) => store.ensureMediaObjectUrl(localName);
    const ctxValue = {
      retainMediaUrl: (name?: string | null) => store.retainMediaUrl(name),
      releaseMediaUrl: (name?: string | null) => store.releaseMediaUrl(name),
    };

    const view = render(
      <MobileMediaCacheContext.Provider value={ctxValue}>
        <div>
          {names.map((n) => (
            <MobileMediaImage
              key={n}
              localName={n}
              ensureMediaUrl={ensureMediaUrl}
              alt={n}
            />
          ))}
        </div>
      </MobileMediaCacheContext.Provider>
    );

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(60);
    });
    expect(store.getMediaObjectUrlCacheSize()).toBe(60);
    expect(store.getActiveMediaUrlRefCount('img-0.png')).toBe(1);
    expect(revokeSpy).not.toHaveBeenCalled();

    view.unmount();

    await waitFor(() => {
      expect(store.getActiveMediaUrlRefCount('img-0.png')).toBe(0);
      expect(store.getMediaObjectUrlCacheSize()).toBe(40);
    });
    expect(revokedUrls.length).toBe(20);
  });

  it('caches versioned mobile snapshots and invalidates immediately on mutation', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const orbit = await store.createOrbit({ name: 'Media', color: '#4f86f7' });
    await store.createItem({ dna: 'note', title: 'First Note', body: 'Body', orbit: orbit.id });

    const snapA = store.listItems();
    const snapB = store.listItems();
    expect(snapA).toBe(snapB);

    const orbitsA = store.listOrbits();
    const orbitsB = store.listOrbits();
    expect(orbitsA).toBe(orbitsB);

    await store.createItem({ dna: 'note', title: 'Second Note', body: 'Body 2', orbit: orbit.id });
    const snapAfter = store.listItems();
    expect(snapAfter).not.toBe(snapA);
    expect(snapAfter.length).toBe(2);
    expect(store.listOrbits()).not.toBe(orbitsA);
  });

  it('defers <audio> creation in WaveformAudioPlayer and media resolution in MobileAudioPlayer until interaction', async () => {
    const desktopView = renderWithI18n(
      <WaveformAudioPlayer
        src="kapsula-media://local/voice-test.webm"
        fallbackDurationSec={18}
        seedKey="voice-1"
      />
    );
    expect(desktopView.container.querySelector('audio')).toBeNull();
    const playBtn = screen.getByRole('button', { name: /Воспроизвести|Play/i });
    fireEvent.click(playBtn);
    await waitFor(() => {
      expect(desktopView.container.querySelector('audio')).not.toBeNull();
    });
    desktopView.unmount();

    const ensureSpy = vi.fn().mockResolvedValue('blob:kapsula-audio-1');
    const mobileView = render(
      <MobileI18nProvider locale="ru" onLocaleChange={() => {}}>
        <MobileAudioPlayer
          mediaPath="voice-mobile.m4a"
          ensureMediaUrl={ensureSpy}
          durationSec={12}
        />
      </MobileI18nProvider>
    );
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(mobileView.container.querySelector('audio')).toBeNull();

    const mobilePlayBtn = screen.getByRole('button', { name: /Воспроизвести|Play/i });
    fireEvent.click(mobilePlayBtn);
    await waitFor(() => {
      expect(ensureSpy).toHaveBeenCalledWith('voice-mobile.m4a');
      expect(mobileView.container.querySelector('audio')).not.toBeNull();
    });
  });

  it('short-circuits GlobalSearchPopover when closed and avoids window capture scroll listeners in ProseCaretOverlay', () => {
    const items = [makeVaultItem({ id: 'i-1', title: 'Secretive Test', body: 'Hello' })];
    const { container } = renderWithI18n(
      <GlobalSearchPopover
        open={false}
        query="Test"
        items={items}
        calendarEvents={[]}
        tasks={[]}
        orbits={[]}
        serverSearchIds={null}
        onClose={() => {}}
        onOpenItem={() => {}}
        onOpenEvent={() => {}}
        onToggleTask={() => {}}
        onOpenNewNote={() => {}}
        onOpenTriage={() => {}}
        onOpenAssistant={() => {}}
        onOpenCalendarNew={() => {}}
      />
    );
    expect(container.querySelector('[data-testid="global-search-popover"]')).toBeNull();

    const addSpy = vi.spyOn(window, 'addEventListener');
    const host = document.createElement('div');
    host.className = 'overflow-y-auto';
    const editorDom = document.createElement('div');
    host.appendChild(editorDom);
    document.body.appendChild(host);

    const mockEditor = {
      isDestroyed: false,
      isFocused: false,
      view: {
        dom: editorDom,
        coordsAtPos: () => ({ left: 10, top: 10, bottom: 26, right: 10 }),
      },
      state: {
        selection: { from: 0, empty: true },
        doc: {
          textBetween: () => '',
        },
      },
      on: () => {},
      off: () => {},
    } as unknown as Editor;

    const caretView = render(<ProseCaretOverlay editor={mockEditor} containerEl={host} />);
    const scrollWindowCalls = addSpy.mock.calls.filter(
      ([ev, , capture]) => ev === 'scroll' && capture === true
    );
    expect(scrollWindowCalls.length).toBe(0);

    caretView.unmount();
    host.remove();
  });

  it('reads small base64 files and large stagedPath files cleanly in mobileBridge.readNativeFileBytes', async () => {
    const small = await mobileBridge.readNativeFileBytes({
      base64: btoa('hello'),
    });
    expect(new TextDecoder().decode(small)).toBe('hello');

    const expected = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => expected.buffer,
    } as Response);

    const large = await mobileBridge.readNativeFileBytes({
      stagedPath: '/data/user/0/com.notesplus.kapsula/cache/kapsula-staged/test-bin',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(large)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
