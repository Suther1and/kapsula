import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import {
  DEFAULT_HUD_SHORTCUT,
  DEFAULT_SNATCH_SHORTCUT,
  formatShortcutCompact,
  formatShortcutDisplay,
  keyboardEventToAccelerator,
  normalizeShortcutAccelerator,
} from '@shared/shortcuts';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

afterEach(() => {
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula v4: Customizable Global Shortcuts & Keyboard Chord Normalization', () => {
  it('normalizes valid Electron accelerators and rejects bare non-modified keys', () => {
    expect(normalizeShortcutAccelerator('ctrl + shift + s')).toBe('CommandOrControl+Shift+S');
    expect(normalizeShortcutAccelerator('alt + space')).toBe('Alt+Space');
    expect(normalizeShortcutAccelerator('Control+Alt+F9')).toBe('CommandOrControl+Alt+F9');
    expect(normalizeShortcutAccelerator('S')).toBeNull();
    expect(normalizeShortcutAccelerator('Ctrl+')).toBeNull();
    expect(normalizeShortcutAccelerator('')).toBeNull();
  });

  it('maps KeyboardEvent.code on Russian layouts to clean Latin accelerators', () => {
    expect(
      keyboardEventToAccelerator({
        key: 'ы', // Russian layout S key
        code: 'KeyS',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBe('CommandOrControl+Shift+S');

    expect(
      keyboardEventToAccelerator({
        key: ' ',
        code: 'Space',
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
      })
    ).toBe('Alt+Space');

    expect(
      keyboardEventToAccelerator({
        key: 'Shift',
        code: 'ShiftLeft',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBeNull();
  });

  it('formats human-readable labels consistently', () => {
    expect(formatShortcutDisplay(DEFAULT_HUD_SHORTCUT)).toBe('Alt + Пробел');
    expect(formatShortcutDisplay(DEFAULT_SNATCH_SHORTCUT)).toBe('Ctrl + Shift + S');
    expect(formatShortcutCompact('CommandOrControl+Shift+K')).toBe('Ctrl+Shift+K');
  });

  it('persists custom shortcuts safely in SQLite settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v4-test-'));
    tempDirs.push(dir);
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    expect(repo.getSetting('hud_shortcut')).toBeNull();
    repo.setSetting('hud_shortcut', normalizeShortcutAccelerator('Alt+K')!);
    repo.setSetting('snatch_shortcut', normalizeShortcutAccelerator('Ctrl+Shift+Y')!);

    expect(repo.getSetting('hud_shortcut')).toBe('Alt+K');
    expect(repo.getSetting('snatch_shortcut')).toBe('CommandOrControl+Shift+Y');
  });
});
