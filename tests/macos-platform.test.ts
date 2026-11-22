import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { parseOcrJsonOutput, runMacOsVisionOcr } from '@main/ocr/ocr-service';
import { resolveFfmpegCommand } from '@main/pipeline/audio-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';
import { SyncEngine } from '@main/sync/sync-engine';
import {
  DEFAULT_HUD_SHORTCUT,
  DEFAULT_SNATCH_SHORTCUT,
  DEFAULT_SNATCH_SHORTCUT_MAC,
  formatShortcutCompact,
  formatShortcutDisplay,
  getDefaultSnatchShortcut,
  isMacPlatform,
  keyboardEventToAccelerator,
  normalizeShortcutAccelerator,
} from '@shared/shortcuts';

const ROOT = process.cwd();
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

describe('Kapsula v7 macOS Platform Support (.dmg + E2EE Sync)', () => {
  it('formats shortcuts natively with macOS symbols, preserves Control (⌃) vs Command (⌘), and avoids Cmd+Shift+S hijack', () => {
    expect(isMacPlatform('darwin')).toBe(true);
    expect(isMacPlatform('win32')).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);

    expect(getDefaultSnatchShortcut('darwin')).toBe(DEFAULT_SNATCH_SHORTCUT_MAC);
    expect(getDefaultSnatchShortcut('win32')).toBe(DEFAULT_SNATCH_SHORTCUT);

    expect(formatShortcutDisplay(DEFAULT_HUD_SHORTCUT, 'darwin')).toBe('⌥ + Пробел');
    expect(formatShortcutDisplay(DEFAULT_SNATCH_SHORTCUT_MAC, 'darwin')).toBe('⌥ + ⇧ + S');
    expect(formatShortcutCompact('CommandOrControl+Shift+K', 'darwin')).toBe('⌘+⇧+K');
    expect(formatShortcutCompact('Alt+Space', 'darwin')).toBe('⌥+Пробел');

    // Control stays distinct from Command on macOS so ⌃+Space doesn't collide with Spotlight (⌘+Space)
    expect(
      keyboardEventToAccelerator(
        { key: ' ', code: 'Space', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        'darwin'
      )
    ).toBe('Control+Space');
    expect(formatShortcutDisplay('Control+Space', 'darwin')).toBe('⌃ + Пробел');
    expect(normalizeShortcutAccelerator('Super+K', 'darwin')).toBe('CommandOrControl+K');

    // Backwards-compatible Windows defaults
    expect(formatShortcutDisplay(DEFAULT_HUD_SHORTCUT, 'win32')).toBe('Alt + Пробел');
    expect(formatShortcutDisplay(DEFAULT_SNATCH_SHORTCUT, 'win32')).toBe('Ctrl + Shift + S');
    expect(formatShortcutCompact('CommandOrControl+Shift+K', 'win32')).toBe('Ctrl+Shift+K');
  });

  it('ships an Apple HIG compliant ICNS bundle (824/1024 squircle + Retina slots) and analytic menu bar template icons', () => {
    const icnsPath = path.join(ROOT, 'build', 'icon.icns');
    expect(fs.existsSync(icnsPath)).toBe(true);
    const buf = fs.readFileSync(icnsPath);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(buf.readUInt32BE(4)).toBe(buf.length);

    const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const foundTypes = new Map<string, Buffer>();
    let offset = 8;
    while (offset + 8 <= buf.length) {
      const osType = buf.subarray(offset, offset + 4).toString('ascii');
      const chunkLen = buf.readUInt32BE(offset + 4);
      expect(chunkLen).toBeGreaterThan(16);
      expect(offset + chunkLen).toBeLessThanOrEqual(buf.length);
      const payload = buf.subarray(offset + 8, offset + chunkLen);
      expect(payload.subarray(0, 8).equals(pngSig)).toBe(true);
      foundTypes.set(osType, payload);
      offset += chunkLen;
    }
    expect(offset).toBe(buf.length);
    for (const required of ['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']) {
      expect(foundTypes.has(required)).toBe(true);
    }

    // Verify Apple HIG squircle fill ratio (~80.5%, 100px margins) on 1024x1024 ic10 slot
    const ic10 = foundTypes.get('ic10')!;
    const w = ic10.readUInt32BE(16);
    const h = ic10.readUInt32BE(20);
    expect(w).toBe(1024);
    expect(h).toBe(1024);
    const idatChunks: Buffer[] = [];
    let po = 33;
    while (po + 12 <= ic10.length) {
      const len = ic10.readUInt32BE(po);
      const type = ic10.subarray(po + 4, po + 8).toString('ascii');
      if (type === 'IDAT') idatChunks.push(ic10.subarray(po + 8, po + 8 + len));
      po += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    let minX = w;
    let maxX = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const a = raw[y * (w * 4 + 1) + 1 + x * 4 + 3] ?? 0;
        if (a > 200) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    const fillRatio = (maxX - minX + 1) / w;
    expect(fillRatio).toBeGreaterThanOrEqual(0.79);
    expect(fillRatio).toBeLessThanOrEqual(0.82);

    const tpl1x = fs.readFileSync(path.join(ROOT, 'build', 'trayTemplate.png'));
    const tpl2x = fs.readFileSync(path.join(ROOT, 'build', 'trayTemplate@2x.png'));
    expect(tpl1x.subarray(0, 8).equals(pngSig)).toBe(true);
    expect(tpl2x.subarray(0, 8).equals(pngSig)).toBe(true);
    expect(tpl1x.readUInt32BE(16)).toBe(18);
    expect(tpl1x.readUInt32BE(20)).toBe(18);
    expect(tpl2x.readUInt32BE(16)).toBe(36);
    expect(tpl2x.readUInt32BE(20)).toBe(36);
  });

  it('parses Apple Vision / WinRT JSON OCR payloads cleanly and honors EXIF + reading order in Swift source', async () => {
    expect(
      parseOcrJsonOutput(JSON.stringify({ text: 'Привет мир\nPROMO-2026', lines: ['Привет мир', 'PROMO-2026'] }))
    ).toEqual({
      text: 'Привет мир\nPROMO-2026',
      lines: ['Привет мир', 'PROMO-2026'],
    });

    expect(parseOcrJsonOutput(JSON.stringify({ lines: 'Single line' }))).toEqual({
      text: 'Single line',
      lines: ['Single line'],
    });

    expect(parseOcrJsonOutput('not valid json')).toEqual({ text: '', lines: [] });
    expect(parseOcrJsonOutput('')).toEqual({ text: '', lines: [] });

    const missing = await runMacOsVisionOcr(path.join(os.tmpdir(), 'non-existent-kapsula-image.png'));
    expect(missing).toEqual({ text: '', lines: [] });

    const swiftSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ocr', 'macos-vision-ocr.swift'), 'utf8');
    expect(swiftSource).toContain('VNRecognizeTextRequest');
    expect(swiftSource).toContain('VNImageRequestHandler(url:');
    expect(swiftSource).toContain('boundingBox');
    expect(swiftSource).toContain('write(contentsOf:');
    expect(swiftSource).toContain('"ru-RU"');
    expect(swiftSource).toContain('"en-US"');
  });

  it('configures macOS packaging, entitlements, universal-safe afterPack hook, and GitHub Actions workflow', async () => {
    expect(typeof resolveFfmpegCommand('darwin')).toBe('string');
    expect(resolveFfmpegCommand('linux')).toBe('ffmpeg');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      build: {
        afterPack?: string;
        files: string[];
        asarUnpack?: string[];
        win: {
          files?: string[];
          asarUnpack?: string[];
        };
        mac: {
          icon: string;
          files?: string[];
          asarUnpack?: string[];
          extendInfo: Record<string, unknown>;
          target: Array<{ target: string; arch: string[] }>;
        };
        dmg: { icon: string; contents: Array<{ type?: string }> };
      };
    };

    expect(pkg.scripts['pack:mac']).toContain('pack-mac.mjs');
    expect(pkg.scripts['pack:mac:universal']).toContain('--arch=universal');
    expect(['scripts/after-pack-mac.cjs', 'scripts/after-pack-win.cjs']).toContain(
      pkg.build.afterPack
    );
    expect(pkg.build.files).not.toContain('extension/**/*');
    expect(pkg.build.files).toContain('LICENSE');
    expect(pkg.build.files).toContain('!dist/main/*.swift');
    expect(pkg.build.win.files).toContain('!dist/main/macos-vision-ocr*');
    expect(pkg.build.win.asarUnpack).toEqual(['dist/main/winrt-ocr.ps1']);
    expect(pkg.build.mac.files).toContain('!dist/main/winrt-ocr.ps1');
    expect(pkg.build.mac.files).toContain('build/icon.icns');
    expect(pkg.build.mac.files).toContain('build/trayTemplate.png');
    expect(pkg.build.mac.files).toContain('build/trayTemplate@2x.png');
    expect(pkg.build.mac.asarUnpack).toContain('dist/main/macos-vision-ocr');
    expect(pkg.build.mac.asarUnpack).toContain('build/trayTemplate*.png');
    expect(pkg.build.mac.icon).toBe('build/icon.icns');
    expect(pkg.build.dmg.icon).toBe('build/icon.icns');
    expect(pkg.build.dmg.contents[0]?.type).toBe('file');
    expect(pkg.build.mac.extendInfo.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(pkg.build.mac.extendInfo.LSMinimumSystemVersion).toBe('12.0');
    expect(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy();
    expect(pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription).toBeTruthy();
    expect(pkg.build.mac.extendInfo.NSAppleEventsUsageDescription).toBeTruthy();

    const entitlements = fs.readFileSync(path.join(ROOT, 'build', 'entitlements.mac.plist'), 'utf8');
    expect(entitlements).toContain('com.apple.security.device.audio-input');
    expect(entitlements).toContain('com.apple.security.automation.apple-events');
    expect(entitlements).not.toContain('com.apple.security.cs.disable-library-validation');

    const inheritEntitlements = fs.readFileSync(
      path.join(ROOT, 'build', 'entitlements.mac.inherit.plist'),
      'utf8'
    );
    expect(inheritEntitlements).toContain('com.apple.security.cs.allow-jit');
    expect(inheritEntitlements).not.toContain('com.apple.security.device.audio-input');
    expect(inheritEntitlements).not.toContain('com.apple.security.automation.apple-events');
    expect(inheritEntitlements).not.toContain('com.apple.security.cs.disable-library-validation');

    // Verify afterPack hook skips universal temp dirs and non-darwin platforms without running codesign
    const req = createRequire(import.meta.url);
    const afterPackMac = req(path.join(ROOT, 'scripts', 'after-pack-mac.cjs')) as (ctx: {
      electronPlatformName: string;
      appOutDir: string;
    }) => Promise<void>;
    await expect(
      afterPackMac({ electronPlatformName: 'win32', appOutDir: '/tmp/win-unpacked' })
    ).resolves.toBeUndefined();
    await expect(
      afterPackMac({ electronPlatformName: 'darwin', appOutDir: '/tmp/mac-universal-arm64-temp' })
    ).resolves.toBeUndefined();
    await expect(
      afterPackMac({ electronPlatformName: 'darwin', appOutDir: '/tmp/mac-universal-x64-temp' })
    ).resolves.toBeUndefined();

    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-macos.yml'), 'utf8');
    expect(workflow).toContain('runs-on: macos-latest');
    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain('scripts/pack-mac.mjs');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('ls release/*-mac-apple-silicon.dmg');
    expect(workflow).toContain('ls release/*-mac-intel.dmg');
    expect(workflow).not.toContain('SHA256SUMS-');
  });

  it('survives macOS Keychain denial in SyncEngine without crashing DEK caching or session storage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-mac-sync-'));
    tempDirs.push(dir);
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const vaultCrypto = new VaultCrypto(dir, null);

    const denyingSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('User denied macOS Keychain access');
      },
      decryptString: () => {
        throw new Error('User denied macOS Keychain access');
      },
    };

    const engine = new SyncEngine({
      dataDir: dir,
      mediaDir: path.join(dir, 'media'),
      repo,
      vaultCrypto,
      safeStorage: denyingSafeStorage,
      isPackaged: true,
      disableTimers: true,
      disableRealtime: true,
    });

    // DEK caching must NOT throw and must NOT write plaintext/fallback DEK when Keychain denies
    expect(() => {
      (engine as unknown as { saveCachedDek: (uid: string, dek: Buffer) => void }).saveCachedDek(
        'test-user-mac',
        Buffer.alloc(32, 7)
      );
    }).not.toThrow();

    const secretsFile = path.join(dir, '.sync-secrets.json');
    expect(fs.existsSync(secretsFile)).toBe(false);

    // Non-DEK session storage (e.g. Supabase auth token) must NOT crash when Keychain denies
    const secureStore = (engine as unknown as {
      secureStore: { set: (k: string, v: string) => void; get: (k: string) => string | null };
    }).secureStore;
    expect(() => secureStore.set('supabase.auth.token', 'session-json')).not.toThrow();
    expect(secureStore.get('supabase.auth.token')).toBe('session-json');

    engine.dispose();
  });
});
