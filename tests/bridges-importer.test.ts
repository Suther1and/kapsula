import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importArchiveJson } from '@main/bridges/archive-importer';
import { ClipperServer } from '@main/bridges/clipper-server';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-bridge-test-'));
  tempDirs.push(dir);
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
  cleanups.push(() => repo.close());
  return { repo, pipeline };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Instagram/Telegram Archive Importer & ClipperServer', () => {
  it('imports Instagram saved_posts.json and Telegram Desktop result.json idempotently', async () => {
    const { repo, pipeline } = makePipeline();

    const igJson = JSON.stringify({
      saved_saved_media: [
        {
          title: 'design_curator',
          string_map_data: {
            'Saved on': { href: 'https://www.instagram.com/p/Cdemo123/', timestamp: 1700000000 },
          },
        },
        {
          title: 'ui_motion',
          string_map_data: {
            'Saved on': { href: 'https://www.instagram.com/reel/Rdemo456/', timestamp: 1700000500 },
          },
        },
      ],
    });

    const r1 = await importArchiveJson(igJson, pipeline, repo);
    expect(r1.format).toBe('instagram_json');
    expect(r1.imported).toBe(2);
    expect(r1.skippedDuplicates).toBe(0);

    const r1Again = await importArchiveJson(igJson, pipeline, repo);
    expect(r1Again.imported).toBe(0);
    expect(r1Again.skippedDuplicates).toBe(2);

    const tgJson = JSON.stringify({
      messages: [
        { id: 101, type: 'message', date_unixtime: '1700001000', text: ['Полезный репо: ', { text: 'GitHub', href: 'https://github.com/vercel/next.js' }] },
        { id: 102, type: 'service', text: 'Pinned message' },
      ],
    });
    const r2 = await importArchiveJson(tgJson, pipeline, repo);
    expect(r2.format).toBe('telegram_json');
    expect(r2.imported).toBe(1);

    // Multi-chat export with identical message id across chats & empty date_unixtime
    const multiChatTg = JSON.stringify({
      chats: {
        list: [
          {
            id: 10,
            name: 'Saved A',
            messages: [{ id: 1, type: 'message', date_unixtime: '', text: 'Note from chat A' }],
          },
          {
            id: 20,
            name: 'Saved B',
            messages: [{ id: 1, type: 'message', date_unixtime: '', text: 'Note from chat B' }],
          },
        ],
      },
    });
    const r3 = await importArchiveJson(multiChatTg, pipeline, repo);
    expect(r3.format).toBe('telegram_json');
    expect(r3.imported).toBe(2);
    await pipeline.waitForIdle();
  });

  it('serves /health, enforces strict /api/handshake & /api/clip auth/CSRF, and salts multi-selection clips', async () => {
    const { pipeline, repo } = makePipeline();
    const pairedOrigins = new Set<string>();
    const server = new ClipperServer(
      pipeline,
      () => 'secret-tok-123',
      undefined,
      undefined,
      undefined,
      {
        getPairingCode: () => '654321',
        isOriginPaired: (o) => pairedOrigins.has(o),
        onPairOrigin: (o) => {
          pairedOrigins.add(o);
        },
      }
    );
    const port = await server.start();
    cleanups.push(() => server.stop());

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const hJson = (await health.json()) as { ok: boolean; app: string };
    expect(hJson.ok).toBe(true);
    expect(hJson.app).toBe('kapsula');

    // GET handshake blocked with 405; POST handshake blocked without valid extension Origin
    const hsGet = await fetch(`http://127.0.0.1:${port}/api/handshake`);
    expect(hsGet.status).toBe(405);

    const hsNoOrigin = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: { 'X-Kapsula-Client': 'ext-v1' },
    });
    expect(hsNoOrigin.status).toBe(403);

    const hsNullOrigin = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: { 'X-Kapsula-Client': 'ext-v1', Origin: 'null' },
    });
    expect(hsNullOrigin.status).toBe(403);

    const hsWebOrigin = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: { 'X-Kapsula-Client': 'ext-v1', Origin: 'https://evil.example' },
    });
    expect(hsWebOrigin.status).toBe(403);

    const hsShortOrigin = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Pair-Code': '654321',
        Origin: 'chrome-extension://abcdefghijklmnop',
      },
    });
    expect(hsShortOrigin.status).toBe(403);

    const validExtOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const hsUnpaired = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        Origin: validExtOrigin,
      },
    });
    expect(hsUnpaired.status).toBe(403);
    const hsUnpairedJson = (await hsUnpaired.json()) as { code: string };
    expect(hsUnpairedJson.code).toBe('pairing_required');

    const hsPaired = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Pair-Code': '654321',
        Origin: validExtOrigin,
      },
    });
    expect(hsPaired.status).toBe(200);
    const hsJson = (await hsPaired.json()) as { token: string };
    expect(hsJson.token).toBe('secret-tok-123');

    const hsRepeat = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        Origin: validExtOrigin,
      },
    });
    expect(hsRepeat.status).toBe(200);

    const unauth = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(unauth.status).toBe(403);

    // Tokenless request with X-Kapsula-Client: ext-v1 is ALSO rejected
    const forgedExtHeader = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Client': 'ext-v1',
      },
      body: JSON.stringify({ url: 'https://example.com/bypass' }),
    });
    expect(forgedExtHeader.status).toBe(403);

    // Cross-site request with valid token is rejected
    const crossSite = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'secret-tok-123',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ url: 'https://example.com/csrf' }),
    });
    expect(crossSite.status).toBe(403);

    // Multiple distinct text selections on same URL create distinct items
    const clipA = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'secret-tok-123',
      },
      body: JSON.stringify({
        url: 'https://www.instagram.com/p/TestPost1/',
        title: 'Instagram UI Card',
        text: 'First selected caption',
        platform: 'instagram',
      }),
    });
    expect(clipA.status).toBe(200);

    const clipB = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'secret-tok-123',
      },
      body: JSON.stringify({
        url: 'https://www.instagram.com/p/TestPost1/',
        title: 'Instagram UI Card',
        text: 'Second selected caption',
        platform: 'instagram',
      }),
    });
    expect(clipB.status).toBe(200);

    const badPixel = await fetch(
      `http://127.0.0.1:${port}/clip-pixel?token=bad-tok&url=${encodeURIComponent('https://example.org/bm')}`
    );
    expect(badPixel.status).toBe(403);

    const ghostPixel = await fetch(
      `http://127.0.0.1:${port}/clip-pixel?token=secret-tok-123&mode=ghost&text=secret`
    );
    expect(ghostPixel.status).toBe(403);

    const pixel = await fetch(
      `http://127.0.0.1:${port}/clip-pixel?token=secret-tok-123&url=${encodeURIComponent('https://example.org/bm')}&title=BM`
    );
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toContain('image/gif');

    await pipeline.waitForIdle();
    expect(repo.queryItems({ limit: 10 }).length).toBeGreaterThanOrEqual(3);

    // Query ?token= must NOT authenticate GET /api/orbits
    const orbitsQueryRes = await fetch(`http://127.0.0.1:${port}/api/orbits?token=secret-tok-123`);
    expect(orbitsQueryRes.status).toBe(403);

    // Verify GET /api/orbits returns live sections cleanly when authorized via header
    const orb = repo.createOrbit({ name: 'Дизайн', description: 'Референсы и макеты' });
    const orbitsRes = await fetch(`http://127.0.0.1:${port}/api/orbits`, {
      headers: { 'X-Kapsula-Token': 'secret-tok-123' },
    });
    expect(orbitsRes.status).toBe(200);
    const orbitsJson = (await orbitsRes.json()) as {
      ok: boolean;
      orbits: Array<{ id: string; name: string; color: string }>;
    };
    expect(orbitsJson.ok).toBe(true);
    expect(orbitsJson.orbits.some((o) => o.id === orb.id && o.name === 'Дизайн')).toBe(true);
  });

  it('imports Telegram Desktop messages.html idempotently with forwarded channel and code blocks', async () => {
    const { pipeline, repo } = makePipeline();
    const htmlExport = `<!DOCTYPE html>
<html>
  <body>
    <div class="history">
      <div class="message default clearfix" id="message42">
        <div class="body">
          <div class="pull_right date details" title="12.11.2026 14:25:00 UTC+03:00">14:25</div>
          <div class="forwarded body">
            <div class="from_name">Dev Channel <span class="date details" title="11.11.2026 10:00:00"></span></div>
            <div class="text">Полезная команда для проверки:<br><pre>npx vitest run</pre></div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;

    const first = await importArchiveJson(htmlExport, pipeline, repo);
    expect(first.format).toBe('telegram_html');
    expect(first.imported).toBe(1);
    expect(first.skippedDuplicates).toBe(0);

    const second = await importArchiveJson(htmlExport, pipeline, repo);
    expect(second.format).toBe('telegram_html');
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(1);

    await pipeline.waitForIdle();
    const items = repo.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]?.subKind).toBe('post');
    expect(items[0]?.mediaMeta?.forwardAuthor).toBe('Dev Channel');
    expect(items[0]?.body).toContain('```');
    expect(items[0]?.body).toContain('npx vitest run');
  });

  it('preserves nested <div> blocks inside Telegram HTML message text', async () => {
    const { pipeline, repo } = makePipeline();
    const nestedHtml = `<!DOCTYPE html>
<html>
  <body>
    <div class="history">
      <div class="message default clearfix" id="message99">
        <div class="body">
          <div class="pull_right date details" title="12.11.2026 15:10:00 UTC+03:00">15:10</div>
          <div class="forwarded body">
            <div class="from_name">Nested Channel</div>
            <div class="text">Первая часть поста <div class="nested"><span>внутри блока</span></div> и хвост после блока<br><pre>echo ok</pre></div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;

    const res = await importArchiveJson(nestedHtml, pipeline, repo);
    expect(res.format).toBe('telegram_html');
    expect(res.imported).toBe(1);
    await pipeline.waitForIdle();

    const items = repo.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]?.body).toContain('Первая часть поста');
    expect(items[0]?.body).toContain('внутри блока');
    expect(items[0]?.body).toContain('и хвост после блока');
    expect(items[0]?.body).toContain('echo ok');
  });
});
