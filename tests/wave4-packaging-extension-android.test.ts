import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const req = createRequire(import.meta.url);
const { JSDOM } = req('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};
import { ClipperServer } from '@main/bridges/clipper-server';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';
import { isSelfUpdateAllowed } from '@mobile/lib/mobile-updater';
import { mobileBridge } from '@mobile/native/bridge';
import { isPaywallEnforced } from '@shared/entitlements';
import { en, ru } from '@shared/i18n';

const ROOT = process.cwd();
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix = 'kapsula-w4-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete (globalThis as { __KapsulaIgHelpers?: unknown }).__KapsulaIgHelpers;
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()!();
    } catch {
      // ignore cleanup failures
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function loadInstagramExtractorHelpers(): {
  cleanInstagramUrl: (href: string, origin?: string) => string;
  isSavedInstagramPath: (pathname: string) => boolean;
  isEligibleInstagramRoute: (pathname: string) => boolean;
  extractInstagramPostData: (
    doc: Document,
    loc?: { href: string; pathname: string; origin?: string }
  ) => { url: string; title: string; text: string; platform: string; tags: string[] };
  collectSavedPostItems: (
    doc: Document,
    loc?: { origin?: string }
  ) => Array<{ url: string; title: string; text: string; platform: string; tags: string[] }>;
} {
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'content-instagram.js'), 'utf8');
  const sandbox = {
    globalThis: {} as Record<string, unknown>,
    URL,
    chrome: undefined,
  };
  vm.runInNewContext(src, sandbox);
  return sandbox.globalThis.__KapsulaIgHelpers as ReturnType<typeof loadInstagramExtractorHelpers>;
}

describe('Wave 4 Packaging, Extension & Android Hardening', () => {
  it('narrows Chrome Extension manifest permissions and keeps Instagram injection strictly opt-in', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')
    ) as {
      permissions: string[];
      host_permissions: string[];
      optional_host_permissions?: string[];
      content_scripts?: unknown;
    };

    expect(manifest.host_permissions).toEqual([
      'http://127.0.0.1:47831/*',
      'http://127.0.0.1:47832/*',
      'http://127.0.0.1:47833/*',
      'http://127.0.0.1:47834/*',
      'http://127.0.0.1:47835/*',
    ]);
    expect(manifest.host_permissions).not.toContain('http://127.0.0.1/*');
    expect(manifest.host_permissions).not.toContain('https://www.instagram.com/*');
    expect(manifest.optional_host_permissions).toEqual(['https://www.instagram.com/*']);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.permissions).toEqual(['contextMenus', 'activeTab', 'scripting', 'storage']);

    const bgSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
    expect(bgSrc).toContain('registerContentScripts');
    expect(bgSrc).toContain('KAPSULA_CLIP_BATCH');
    expect(bgSrc).toContain('/api/clip-batch');
    expect(bgSrc).toContain('allowImage: isExtensionPage');
  });

  it('extracts Instagram captions cleanly without handle/UI pollution, ignores stale og:description on SPA nav, and deduplicates /saved/ up to 30', () => {
    const ig = loadInstagramExtractorHelpers();

    expect(ig.isEligibleInstagramRoute('/p/Cx123AbC/')).toBe(true);
    expect(ig.isEligibleInstagramRoute('/design_studio/reel/Dx999Zz/')).toBe(true);
    expect(ig.isEligibleInstagramRoute('/myuser/saved/all-posts/')).toBe(true);
    expect(ig.isEligibleInstagramRoute('/direct/inbox/')).toBe(false);
    expect(ig.isEligibleInstagramRoute('/accounts/login/')).toBe(false);
    expect(ig.isEligibleInstagramRoute('/')).toBe(false);

    // SPA navigation where document still has stale <meta property="og:*"> from previous post
    const dom = new JSDOM(`<!doctype html><html><head>
      <meta property="og:url" content="https://www.instagram.com/p/OLD_POST/" />
      <meta property="og:description" content="120 likes - old_user: &quot;Stale caption from previous post&quot;" />
    </head><body>
      <main>
        <article>
          <header>
            <a href="/shader_artist/">shader_artist</a>
            <button>Подписаться</button>
          </header>
          <div>
            <a href="/shader_artist/">shader_artist</a>
            <span dir="auto">shader_artist</span>
            <span dir="auto">Verified</span>
            <span dir="auto">Procedural glass caustics breakdown in Blender and Unreal Engine 5</span>
            <time>2 ч.</time>
          </div>
          <footer><button>Нравится</button></footer>
        </article>
      </main>
    </body></html>`);

    const post = ig.extractInstagramPostData(dom.window.document, {
      href: 'https://www.instagram.com/p/NEW_POST/?igsh=abc123&utm_source=ig_web_copy_link',
      pathname: '/p/NEW_POST/',
      origin: 'https://www.instagram.com',
    });

    expect(post.url).toBe('https://www.instagram.com/p/NEW_POST/');
    expect(post.title).toContain('@shader_artist');
    expect(post.text).toContain('Procedural glass caustics breakdown in Blender and Unreal Engine 5');
    expect(post.text).not.toContain('Stale caption from previous post');
    expect(post.text).not.toContain('Verified');
    expect(post.text).not.toContain('Подписаться');

    // Stale og:description without DOM caption must NOT leak into new SPA post
    const emptyDom = new JSDOM(`<!doctype html><html><head>
      <meta property="og:url" content="https://www.instagram.com/p/OLD_POST/" />
      <meta property="og:description" content="Stale SSR text" />
    </head><body><main><article></article></main></body></html>`);
    const postNoStale = ig.extractInstagramPostData(emptyDom.window.document, {
      href: 'https://www.instagram.com/reel/FRESH_REEL/?igsh=xyz',
      pathname: '/reel/FRESH_REEL/',
      origin: 'https://www.instagram.com',
    });
    expect(postNoStale.url).toBe('https://www.instagram.com/reel/FRESH_REEL/');
    expect(postNoStale.text).not.toContain('Stale SSR text');

    // Matching og:url DOES allow unwrapped og:description fallback
    const matchedDom = new JSDOM(`<!doctype html><html><head>
      <meta property="og:url" content="https://www.instagram.com/p/SSR_POST/" />
      <meta property="og:description" content="540 likes, 12 comments - studio on Nov 20: &quot;Clean unwrapped caption&quot;" />
    </head><body><main><article></article></main></body></html>`);
    const postMatched = ig.extractInstagramPostData(matchedDom.window.document, {
      href: 'https://www.instagram.com/p/SSR_POST/',
      pathname: '/p/SSR_POST/',
      origin: 'https://www.instagram.com',
    });
    expect(postMatched.text).toContain('Clean unwrapped caption');

    // /saved/ grid collector strips tracking query params, deduplicates, and caps at 30
    const linkTags = Array.from({ length: 36 }, (_, i) => {
      const idx = i < 2 ? 0 : i; // duplicate first item
      return `<a href="/p/POST_${idx}/?igsh=track${i}"><img alt="Design ref #${idx}" /></a>`;
    }).join('');
    const savedDom = new JSDOM(`<!doctype html><html><body><main>${linkTags}</main></body></html>`);
    const batch = ig.collectSavedPostItems(savedDom.window.document, {
      origin: 'https://www.instagram.com',
    });
    expect(batch).toHaveLength(30);
    expect(batch[0]?.url).toBe('https://www.instagram.com/p/POST_0/');
    expect(batch[0]?.title).toContain('Design ref #0');
  });

  it('serves authenticated POST /api/clip-batch on ClipperServer and blocks ghost mode in batch', async () => {
    const dir = makeTempDir('kapsula-w4-clip-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    const cryptoVault = new VaultCrypto(dir, null);
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });
    const clipper = new ClipperServer(pipeline, () => 'batch-tok-xyz');
    const port = await clipper.start();
    cleanups.push(async () => {
      await pipeline.waitForIdle();
      await clipper.stop();
      repo.close();
    });

    const unauth = await fetch(`http://127.0.0.1:${port}/api/clip-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ url: 'https://example.com/1', text: 'One' }] }),
    });
    expect(unauth.status).toBe(403);

    const ghostOnly = await fetch(`http://127.0.0.1:${port}/api/clip-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'batch-tok-xyz',
      },
      body: JSON.stringify({ items: [{ mode: 'ghost', text: 'super-secret' }] }),
    });
    expect(ghostOnly.status).toBe(400);

    const okBatch = await fetch(`http://127.0.0.1:${port}/api/clip-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'batch-tok-xyz',
      },
      body: JSON.stringify({
        items: [
          { url: 'https://www.instagram.com/p/A1/', title: 'Post A1', text: 'First IG post', platform: 'instagram' },
          { url: 'https://www.instagram.com/p/B2/', title: 'Post B2', text: 'Second IG post', platform: 'instagram' },
          { mode: 'ghost', text: 'blocked-secret-in-mixed-batch' },
        ],
      }),
    });
    expect(okBatch.status).toBe(200);
    const json = (await okBatch.json()) as { ok: boolean; saved: number; failed: number; total: number };
    expect(json.ok).toBe(true);
    expect(json.saved).toBe(2);
    expect(json.failed).toBe(1);
    expect(json.total).toBe(3);

    await pipeline.waitForIdle();
    const savedItems = repo.queryItems({ limit: 10 });
    expect(savedItems.map((i) => i.title)).toEqual(expect.arrayContaining(['Post A1', 'Post B2']));
    expect(savedItems.some((i) => i.body.includes('blocked-secret'))).toBe(false);
  });

  it('removes broken /clip bookmarklet from SettingsModal and preserves RU/EN i18n parity', () => {
    const settingsSrc = fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'components', 'modals', 'SettingsModal.tsx'),
      'utf8'
    );
    expect(settingsSrc).not.toContain('buildBookmarkletCode');
    expect(settingsSrc).not.toContain('copy-bookmarklet-btn');
    expect(settingsSrc).toContain('copy-clipper-pair-code-btn');
    expect(settingsSrc).toContain('enable-builtin-ai-btn');
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it('configures Android play/direct flavors, R8, fail-fast release signing, strict FileProvider & mandatory APK signature check', async () => {
    const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
    expect(gradle).toContain('buildConfig = true');
    expect(gradle).toContain('flavorDimensions += "distribution"');
    expect(gradle).toContain('play {');
    expect(gradle).toContain('direct {');
    expect(gradle).toContain('minifyEnabled true');
    expect(gradle).toContain('shrinkResources true');
    expect(gradle).not.toContain('signingConfigs.debug');

    const proguard = fs.readFileSync(path.join(ROOT, 'android', 'app', 'proguard-rules.pro'), 'utf8');
    expect(proguard).toContain('com.notesplus.kapsula.KapsulaNativePlugin');
    expect(proguard).toContain('com.getcapacitor.annotation.CapacitorPlugin');
    expect(proguard).toContain('androidx.biometric.**');
    expect(proguard).toContain('androidx.window.layout.**');

    const netSec = fs.readFileSync(
      path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'),
      'utf8'
    );
    expect(netSec).toContain('cleartextTrafficPermitted="false"');

    // Mobile bridge & updater channel/checksum enforcement
    const badShaRes = await mobileBridge.downloadAndInstallApk(
      'https://github.com/Suther1and/kapsula/releases/download/v1.0.5/Kapsula-1.0.5-android.apk',
      null
    );
    expect(badShaRes.ok).toBe(false);
    expect(badShaRes.error).toBeTruthy();

    expect(isSelfUpdateAllowed({ distChannel: 'play', allowSelfUpdate: false })).toBe(false);
    expect(isSelfUpdateAllowed({ distChannel: 'direct', allowSelfUpdate: false })).toBe(false);
    expect(isSelfUpdateAllowed({ distChannel: 'direct', allowSelfUpdate: true })).toBe(true);
  });

  it('keeps Desktop PE metadata clean, restricts media permissions to audio-only, defaults fresh AI to local, and keeps paywall off', () => {
    expect(isPaywallEnforced).toBe(false);

    const afterPackWin = req(path.join(ROOT, 'scripts', 'after-pack-win.cjs')) as {
      normalizePeVersion: (v: string) => string;
    };
    expect(afterPackWin.normalizePeVersion('1.0.4')).toBe('1.0.4.0');

    const afterPackSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-win.cjs'), 'utf8');
    expect(afterPackSrc).toContain('LegalCopyright');
    expect(afterPackSrc).toContain('OriginalFilename');
    expect(afterPackSrc).toContain('Kapsula.exe');

    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
    expect(mainSrc).toContain("else repo.setSetting('ai_provider', 'local');");
    expect(mainSrc).toContain("details?.mediaType !== 'video'");
    expect(mainSrc).toContain("mediaTypes.includes('video')");

    const buildMainSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-main.mjs'), 'utf8');
    expect(buildMainSrc).toContain('removeIfExists(distMacSwift)');
    expect(buildMainSrc).toContain('removeIfExists(distMacBin)');
    expect(buildMainSrc).toContain('removeIfExists(distWinRt)');

    const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      build: {
        files: string[];
        win: { asarUnpack: string[] };
        mac: { asarUnpack: string[] };
      };
    };
    expect(pkgJson.build.files).toEqual(
      expect.arrayContaining([
        '!node_modules/@capacitor{,/**/*}',
        '!node_modules/@types{,/**/*}',
        '!dist/main/*.swift',
        'LICENSE',
      ])
    );
    expect(pkgJson.build.files).not.toContain('extension/**/*');
    expect(pkgJson.build.win.asarUnpack).toContain('dist/main/winrt-ocr.ps1');
    expect(pkgJson.build.mac.asarUnpack).toContain('dist/main/macos-vision-ocr');
  });
});
