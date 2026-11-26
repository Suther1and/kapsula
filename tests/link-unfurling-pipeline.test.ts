import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import {
  CapturePipeline,
  isLinkStubTitle,
  isStubLinkItem,
  needsLocalOgDownload,
} from '@main/pipeline/capture-pipeline';
import {
  classifyPrivateTelegramUrl,
  isSafeResolvedHost,
  safeFetchWithRedirects,
  unfurlUrl,
} from '@main/pipeline/unfurler';
import { VaultCrypto } from '@main/security/vault-crypto';
import { cleanInstagramText } from '@shared/html-entities';
import {
  isPrivateOrLocalHostname,
  isSafeExternalUrl,
  isSafeResolvedIpForPublicDomain,
  isTunFakeIpAddress,
} from '@shared/url-safety';
import {
  classifyMobilePrivateTelegramUrl,
  isMobileLinkStubBody,
  unfurlMobileLink,
  type MobileFetchTextFn,
} from '@mobile/lib/mobile-link-unfurl';
import { mobileBridge } from '@mobile/native/bridge';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makePipelineEnv(overrides?: {
  enableUrlUnfurl?: boolean;
  activeMode?: 'autopilot' | 'buffer' | 'ghost';
  aiProvider?: 'local' | 'google_ai_studio' | 'openrouter';
  apiKey?: string | null;
  fetchFn?: typeof fetch;
  prepareVisionImage?: () => Promise<{ base64: string; mimeType: string } | null>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-unfurl-test-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  const cryptoVault = new VaultCrypto(dir, null);
  const pipeline = new CapturePipeline({
    repo,
    cryptoVault,
    dataDir: dir,
    fetchFn: overrides?.fetchFn,
    prepareVisionImage: overrides?.prepareVisionImage,
    getConfig: () => ({
      activeMode: overrides?.activeMode ?? 'autopilot',
      activeFocusBoardId: null,
      aiProvider: overrides?.aiProvider ?? 'local',
      apiKey: overrides?.apiKey ?? null,
      monthlyCapUsd: 1.5,
      enableAutoOcr: false,
      enableUrlUnfurl: overrides?.enableUrlUnfurl ?? true,
    }),
  });
  cleanups.push(async () => {
    await pipeline.waitForIdle();
    repo.close();
  });
  return { dir, repo, cryptoVault, pipeline };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SSRF & TUN Fake-IP URL safety invariants', () => {
  it('blocks literal private, loopback, metadata, local, and 198.18.x.x IP URLs', () => {
    expect(isTunFakeIpAddress('198.18.0.5')).toBe(true);
    expect(isTunFakeIpAddress('198.19.255.1')).toBe(true);
    expect(isTunFakeIpAddress('::ffff:198.18.1.2')).toBe(true);
    expect(isTunFakeIpAddress('198.20.0.1')).toBe(false);

    // Literal 198.18.x.x must remain blocked in URL & hostname validators
    for (const unsafeUrl of [
      'http://198.18.0.1/admin',
      'https://198.19.12.34/',
      'http://127.0.0.1:8080/',
      'http://localhost:3000/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.5/',
      'http://[::1]/',
      'http://localhost./',
      'http://foo.local./',
      'http://meta.internal./',
      'http://nas.home.arpa/',
      'http://router.lan/',
      'http://service.internal/',
      'file:///etc/passwd',
    ]) {
      expect(isSafeExternalUrl(unsafeUrl)).toBe(false);
    }
    expect(isPrivateOrLocalHostname('198.18.0.1')).toBe(true);
    expect(isSafeExternalUrl('https://api.fxtwitter.com/user/status/123')).toBe(true);
  });

  it('allows RFC 2544 198.18.0.0/15 strictly for DNS resolution of public domains while blocking literal 198.18.x.x and loopback DNS rebinding', async () => {
    expect(isSafeResolvedIpForPublicDomain('198.18.0.12')).toBe(true);
    expect(isSafeResolvedIpForPublicDomain('::ffff:198.18.0.12')).toBe(true);
    expect(isSafeResolvedIpForPublicDomain('127.0.0.1')).toBe(false);
    expect(isSafeResolvedIpForPublicDomain('10.0.0.5')).toBe(false);
    expect(isSafeResolvedIpForPublicDomain('169.254.169.254')).toBe(false);

    // Literal 198.18.0.1 MUST be rejected by isSafeResolvedHost even without DNS
    expect(await isSafeResolvedHost('198.18.0.1')).toBe(false);
    expect(await isSafeResolvedHost('127.0.0.1')).toBe(false);

    // Public domain resolving to TUN Fake-IP (v2rayN/Clash) passes
    const lookupSpy = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '198.18.0.42', family: 4 }] as never);
    expect(await isSafeResolvedHost('api.fxtwitter.com')).toBe(true);

    // Public domain resolving to loopback/metadata is still blocked
    lookupSpy.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    expect(await isSafeResolvedHost('rebind.example.com')).toBe(false);

    lookupSpy.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    expect(await isSafeResolvedHost('metadata.example.com')).toBe(false);
  });

  it('blocks redirects hopping to private or literal 198.18.x.x targets', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('redirect-local')) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret' },
        });
      }
      if (target.includes('redirect-fakeip')) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://198.18.0.1/internal' },
        });
      }
      return new Response('ok', { status: 200 });
    });

    expect(
      await safeFetchWithRedirects('https://example.com/redirect-local', {
        fetchImpl: mockFetch as unknown as typeof fetch,
      })
    ).toBeNull();
    expect(
      await safeFetchWithRedirects('https://example.com/redirect-fakeip', {
        fetchImpl: mockFetch as unknown as typeof fetch,
      })
    ).toBeNull();
  });
});

describe('Desktop Unfurler — X/Twitter 4-tier, Telegram public/private & Instagram crawler UA', () => {
  it('classifies private Telegram t.me/c/ and invite links offline with zero video flag', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const privPost = classifyPrivateTelegramUrl('https://t.me/c/2147483647/512', 'ru');
    expect(privPost).toBeTruthy();
    expect(privPost?.linkAccess).toBe('private');
    expect(privPost?.hasVideo).toBe(false);
    expect(privPost?.title).toContain('Закрытый пост');

    const invite = classifyPrivateTelegramUrl('https://t.me/+AbCdEfGhIj1234', 'en');
    expect(invite).toBeTruthy();
    expect(invite?.linkAccess).toBe('private');
    expect(invite?.hasVideo).toBe(false);
    expect(invite?.title).toContain('Private Telegram');

    // Also via unfurlUrl without any network calls
    const unfurled = await unfurlUrl('https://t.me/c/12345678/99');
    expect(unfurled.linkAccess).toBe('private');
    expect(unfurled.hasVideo).toBe(false);
    expect(unfurled.platform).toBe('telegram');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('extracts X Article + Quote via FxTwitter (Tier 1) and falls through Syndication -> VxTwitter -> oEmbed', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.9', family: 4 }] as never);

    // Tier 1: FxTwitter with article + quote + photo (no video)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('api.fxtwitter.com')) {
        return new Response(
          JSON.stringify({
            tweet: {
              text: 'Main tweet text',
              author: { name: 'Ada Lovelace', screen_name: 'ada' },
              article: {
                title: 'Notes on the Analytical Engine',
                preview_text: 'Detailed essay about computing machines.',
                cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/media/cover.jpg' } },
              },
              quote: {
                text: 'Quoted insight',
                author: { name: 'Charles', screen_name: 'charles' },
              },
              media: {
                photos: [{ url: 'https://pbs.twimg.com/media/photo1.jpg' }],
                videos: [],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const r1 = await unfurlUrl('https://mobile.x.com/ada/status/1900000001?s=09');
    expect(r1.platform).toBe('x');
    expect(r1.canonicalUrl).toBe('https://x.com/ada/status/1900000001');
    expect(r1.title).toContain('Notes on the Analytical Engine');
    expect(r1.bodyMarkdown).toContain('Detailed essay about computing machines');
    expect(r1.bodyMarkdown).toContain('Quoted insight');
    expect(r1.ogImageUrl).toBe('https://pbs.twimg.com/media/cover.jpg');
    expect(r1.hasVideo).toBe(false);

    // Tier 2: FxTwitter fails (503) -> Syndication succeeds with video
    fetchSpy.mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('api.fxtwitter.com')) return new Response('down', { status: 503 });
      if (s.includes('cdn.syndication.twimg.com')) {
        return new Response(
          JSON.stringify({
            text: 'Watch this demo video!',
            user: { name: 'Demo Dev', screen_name: 'demodev' },
            video: {
              poster: 'https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg',
              variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/demo.mp4' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const r2 = await unfurlUrl('https://x.com/demodev/status/1900000002');
    expect(r2.author).toContain('Demo Dev');
    expect(r2.title).toContain('Watch this demo video!');
    expect(r2.bodyMarkdown).toContain('Watch this demo video!');
    expect(r2.hasVideo).toBe(true);
    expect(r2.videoUrl).toBe('https://video.twimg.com/demo.mp4');

    // Tier 3: FxTwitter + Syndication fail -> VxTwitter succeeds
    fetchSpy.mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('api.vxtwitter.com')) {
        return new Response(
          JSON.stringify({
            text: 'Text-only tweet via VxTwitter',
            user_name: 'Vx Author',
            user_screen_name: 'vxauthor',
            media_extended: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 502 });
    });

    const r3 = await unfurlUrl('https://twitter.com/vxauthor/status/1900000003');
    expect(r3.author).toContain('Vx Author');
    expect(r3.title).toContain('Text-only tweet via VxTwitter');
    expect(r3.bodyMarkdown).toContain('Text-only tweet via VxTwitter');
    expect(r3.hasVideo).toBe(false);

    // Tier 4: All JSON APIs fail -> official oEmbed succeeds
    fetchSpy.mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('publish.twitter.com/oembed')) {
        return new Response(
          JSON.stringify({
            author_name: 'OEmbed Writer',
            html: '<blockquote><p>Fallback tweet body from oEmbed</p></blockquote>',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 502 });
    });

    const r4 = await unfurlUrl('https://x.com/oembedwriter/status/1900000004');
    expect(r4.author).toContain('OEmbed Writer');
    expect(r4.title).toContain('Fallback tweet body from oEmbed');
    expect(r4.bodyMarkdown).toContain('Fallback tweet body from oEmbed');
    expect(r4.hasVideo).toBe(false);
  });

  it('falls back across 3 tiers for public Telegram posts and extracts Instagram Reel metadata with crawler UA', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '149.154.167.99', family: 4 }] as never);

    // Public Telegram: ?embed=1 returns 500, /s/ returns valid post HTML
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('embed=1')) return new Response('', { status: 500 });
      if (s.includes('/s/design_channel/42')) {
        return new Response(
          `<html><body>
            <div class="tgme_widget_message" data-post="design_channel/42">
              <div class="tgme_widget_message_author"><a class="tgme_widget_message_author_name">Design Daily</a></div>
              <div class="tgme_widget_message_text">Свежий разбор типографики и сеток</div>
              <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.telesco.pe/file/photo.jpg')"></a>
            </div>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const tgRes = await unfurlUrl('https://t.me/design_channel/42');
    expect(tgRes.platform).toBe('telegram');
    expect(tgRes.linkAccess).toBe('public');
    expect(tgRes.hasVideo).toBe(false);
    expect(tgRes.author).toBe('Design Daily');
    expect(tgRes.title).toContain('Свежий разбор типографики');
    expect(tgRes.bodyMarkdown).toContain('Свежий разбор типографики');
    expect(tgRes.ogImageUrl).toBe('https://cdn4.telesco.pe/file/photo.jpg');

    // Public Telegram Tier 3: both ?embed=1 and /s/ fail -> plain OG page succeeds
    fetchSpy.mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('embed=1') || s.includes('/s/')) return new Response('', { status: 503 });
      return new Response(
        `<html><head>
          <meta property="og:title" content="Telegram: View @fallback_ch" />
          <meta property="og:description" content="Заметка о векторной графике и контрасте" />
          <meta property="og:image" content="https://cdn4.telesco.pe/file/tier3.jpg" />
        </head><body></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    });
    const tgTier3 = await unfurlUrl('https://t.me/fallback_ch/77');
    expect(tgTier3.platform).toBe('telegram');
    expect(tgTier3.linkAccess).toBe('public');
    expect(tgTier3.title).toContain('Заметка о векторной графике');
    expect(tgTier3.ogImageUrl).toBe('https://cdn4.telesco.pe/file/tier3.jpg');

    // Instagram Reel crawler-UA extraction
    let seenUserAgent = '';
    fetchSpy.mockImplementation(async (_u, init) => {
      const hdrs = init?.headers as Record<string, string> | undefined;
      seenUserAgent = hdrs?.['User-Agent'] || '';
      return new Response(
        `<html><head>
          <meta property="og:title" content="studio_kapsula on Instagram: &quot;Liquid glass shader breakdown&quot;" />
          <meta property="og:description" content="12K likes, 44 comments - studio_kapsula March 10, 2026: &quot;Liquid glass shader breakdown for mobile&quot;" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/v/reel_thumb.jpg" />
        </head><body></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    });

    const igRes = await unfurlUrl('https://www.instagram.com/reel/CxReel12345/');
    expect(seenUserAgent).toContain('facebookexternalhit');
    expect(igRes.platform).toBe('instagram');
    expect(igRes.hasVideo).toBe(true);
    expect(igRes.title).toContain('Liquid glass shader breakdown');
    expect(igRes.title).not.toContain('likes');
    expect(igRes.ogImageUrl).toBe('https://scontent.cdninstagram.com/v/reel_thumb.jpg');
  });
});

describe('Synced Stub-Link Auto-Healing & Mobile Link Unfurler', () => {
  it('detects stub links, auto-heals synced stubs once, and never overwrites user-authored titles/bodies', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.15', family: 4 }] as never);
    const { repo, pipeline } = makePipelineEnv();

    const stubItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-stub-1',
      title: 'x.com',
      body: 'https://x.com/builder/status/999111',
      url: 'https://x.com/builder/status/999111',
      domain: 'x.com',
      platform: 'x',
      source: 'vault_ui',
    });

    const userEditedItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-user-edited-1',
      title: 'Моя личная заметка про дизайн',
      body: 'Сохранил для референса по меню и карточкам',
      url: 'https://x.com/builder/status/999222',
      domain: 'x.com',
      platform: 'x',
      source: 'vault_ui',
    });

    const privateItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-private-tg-1',
      title: 'Закрытый пост Telegram',
      body: 'Пост из закрытого канала',
      url: 'https://t.me/c/987654/12',
      domain: 't.me',
      platform: 'telegram',
      mediaMeta: { linkAccess: 'private', hasVideo: false },
      source: 'vault_ui',
    });

    expect(isStubLinkItem(stubItem)).toBe(true);
    expect(isStubLinkItem(userEditedItem)).toBe(false);
    expect(isStubLinkItem(privateItem)).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('api.fxtwitter.com/builder/status/999111')) {
        return new Response(
          JSON.stringify({
            tweet: {
              text: 'Shipped faster link unfurling today!',
              author: { name: 'Builder', screen_name: 'builder' },
              media: { photos: [], videos: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const queued = pipeline.scanAndEnrichStubLinks(12);
    expect(queued).toBe(1);
    await pipeline.waitForIdle();

    const healed = repo.getItemById(stubItem.id)!;
    expect(healed.title).toContain('Shipped faster link unfurling today!');
    expect(healed.body).toContain('Shipped faster link unfurling today!');
    expect(healed.mediaMeta?.hasVideo).toBe(false);

    // User-authored item stays untouched
    const untouched = repo.getItemById(userEditedItem.id)!;
    expect(untouched.title).toBe('Моя личная заметка про дизайн');
    expect(untouched.body).toBe('Сохранил для референса по меню и карточкам');

    // Per-session retry cap: re-enqueueing the same stub ID does not fire duplicate fetches
    const callsBefore = fetchSpy.mock.calls.length;
    expect(pipeline.enqueueSyncedLinkEnrichment(stubItem.id)).toBe(false);
    await pipeline.waitForIdle();
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  it('unfurls X, public Telegram, private Telegram, and blocks unsafe URLs in mobile-link-unfurl', async () => {
    // Unsafe private URL returns null immediately
    expect(await unfurlMobileLink('http://127.0.0.1:8080/test', 'ru')).toBeNull();
    expect(await unfurlMobileLink('http://198.18.0.1/test', 'ru')).toBeNull();

    // Private Telegram classifies synchronously without fetch
    const priv = classifyMobilePrivateTelegramUrl('https://t.me/c/123456/78', 'ru');
    expect(priv?.linkAccess).toBe('private');
    expect(priv?.hasVideo).toBe(false);
    expect(priv?.title).toContain('Закрытый пост');

    // X fallback on mobile: FxTwitter 500 -> Syndication 200
    const mockFetchText: MobileFetchTextFn = async ({ url }) => {
      if (url.includes('api.fxtwitter.com')) {
        return { ok: false, status: 500, finalUrl: url, contentType: '', body: '' };
      }
      if (url.includes('cdn.syndication.twimg.com')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: 'application/json',
          body: JSON.stringify({
            text: 'Mobile Android share unfurled cleanly',
            user: { name: 'Mobile Tester', screen_name: 'mtester' },
            photos: [{ url: 'https://pbs.twimg.com/media/mobile_thumb.jpg' }],
          }),
        };
      }
      return { ok: false, status: 404, finalUrl: url, contentType: '', body: '' };
    };

    const res = await unfurlMobileLink(
      'https://x.com/mtester/status/555666?s=20',
      'ru',
      mockFetchText
    );
    expect(res).toBeTruthy();
    expect(res?.platform).toBe('x');
    expect(res?.title).toContain('Mobile Tester');
    expect(res?.body).toContain('Mobile Android share unfurled cleanly');
    expect(res?.ogImageUrl).toBe('https://pbs.twimg.com/media/mobile_thumb.jpg');
    expect(res?.hasVideo).toBe(false);
  });

  it('narrows stub title/body heuristics so user titles like "Ссылка для бухгалтерии" or "LinkedIn" and foreign URLs are never overwritten', () => {
    expect(isLinkStubTitle('Ссылка для бухгалтерии', 'nalog.ru', 'https://nalog.ru/doc', null)).toBe(false);
    expect(isLinkStubTitle('LinkedIn', 'linkedin.com', 'https://linkedin.com/in/user', null)).toBe(false);
    expect(isLinkStubTitle('Link — Custom Name', 'example.com', 'https://example.com/a', null)).toBe(false);

    // Genuine stubs still match
    expect(isLinkStubTitle('Ссылка', 'x.com', 'https://x.com/u/status/1', 'x')).toBe(true);
    expect(isLinkStubTitle('Ссылка: x.com', 'x.com', 'https://x.com/u/status/1', 'x')).toBe(true);
    expect(isLinkStubTitle('Link — example.com', 'example.com', 'https://example.com/a', null)).toBe(true);

    // Mobile stub body matches ONLY the item's own URL (ignoring trailing slash & case)
    expect(isMobileLinkStubBody('https://x.com/a/status/1/', 'https://x.com/a/status/1')).toBe(true);
    expect(isMobileLinkStubBody('https://other-site.example/notes', 'https://x.com/a/status/1')).toBe(false);
  });

  it('downloads local cover for Android-enriched links with ogImageUrl without modifying title, body, summary, or orbit', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.21', family: 4 }] as never);
    const { repo, pipeline } = makePipelineEnv();

    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=',
      'base64'
    );
    const orbit = repo.createOrbit({ name: 'Дизайн', description: 'Рефы' });
    const androidEnriched = repo.createItem({
      dna: 'link',
      orbit: orbit.id,
      modeCaptured: 'autopilot',
      contentHash: 'hash-android-og-only-1',
      title: 'Отличная статья про сетки',
      summary: 'Краткое описание с Android',
      body: 'Подробный текст поста, уже распарсенный на Android',
      url: 'https://example.com/grids',
      domain: 'example.com',
      ogImageUrl: 'https://cdn.example.com/cover.png',
      source: 'vault_ui',
    });

    expect(isStubLinkItem(androidEnriched)).toBe(false);
    expect(needsLocalOgDownload(androidEnriched)).toBe(true);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      if (String(u) === 'https://cdn.example.com/cover.png') {
        return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    });

    expect(pipeline.enqueueSyncedLinkEnrichment(androidEnriched)).toBe(true);
    await pipeline.waitForIdle();

    const after = repo.getItemById(androidEnriched.id)!;
    expect(after.imagePath).toBeTruthy();
    expect(fs.existsSync(path.join(pipeline.getMediaDir(), after.imagePath!))).toBe(true);
    expect(needsLocalOgDownload(after)).toBe(false);
    expect(after.title).toBe('Отличная статья про сетки');
    expect(after.summary).toBe('Краткое описание с Android');
    expect(after.body).toBe('Подробный текст поста, уже распарсенный на Android');
    expect(after.orbit).toBe(orbit.id);
  });

  it('chains scanAndEnrichStubLinks across >6 synced links and respects buffer/ghost capture modes', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.22', family: 4 }] as never);
    const cloudBodies: string[] = [];
    const cloudAiSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      cloudBodies.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    });
    const { repo, pipeline } = makePipelineEnv({
      aiProvider: 'google_ai_studio',
      apiKey: 'fake-key-for-guard',
      fetchFn: cloudAiSpy as unknown as typeof fetch,
    });

    // Create 8 autopilot stub links (>6 threshold) + 1 buffer stub + 1 ghost stub
    const autoIds: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const it = repo.createItem({
        dna: 'link',
        orbit: '',
        modeCaptured: 'autopilot',
        contentHash: `hash-batch-${i}`,
        title: 'x.com',
        body: `https://x.com/batch/status/${1000 + i}`,
        url: `https://x.com/batch/status/${1000 + i}`,
        domain: 'x.com',
        platform: 'x',
        source: 'vault_ui',
      });
      autoIds.push(it.id);
    }

    const bufferItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'buffer',
      contentHash: 'hash-buffer-stub',
      title: 'x.com',
      body: 'https://x.com/bufferuser/status/2001',
      url: 'https://x.com/bufferuser/status/2001',
      domain: 'x.com',
      platform: 'x',
      aiStatus: 'raw_buffer',
      source: 'vault_ui',
    });

    const ghostItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'ghost',
      contentHash: 'hash-ghost-stub',
      title: 'x.com',
      body: 'https://x.com/ghostuser/status/3001',
      url: 'https://x.com/ghostuser/status/3001',
      domain: 'x.com',
      platform: 'x',
      source: 'vault_ui',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      const m = /api\.fxtwitter\.com\/([^/]+)\/status\/(\d+)/.exec(s);
      if (m) {
        return new Response(
          JSON.stringify({
            tweet: {
              text: `Unfurled post ${m[2]}`,
              author: { name: m[1], screen_name: m[1] },
              media: { photos: [], videos: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    });

    // Request chunk size 3 -> must chain through all 8 autopilot + 1 buffer items, skipping ghost
    const firstBatch = pipeline.scanAndEnrichStubLinks(3);
    expect(firstBatch).toBe(3);
    await pipeline.waitForIdle();

    for (let i = 0; i < autoIds.length; i++) {
      const healed = repo.getItemById(autoIds[i]!)!;
      expect(healed.body).toContain(`Unfurled post ${1001 + i}`);
    }

    // Buffer item enriched preview locally, kept raw_buffer & empty orbit
    const bufAfter = repo.getItemById(bufferItem.id)!;
    expect(bufAfter.body).toContain('Unfurled post 2001');
    expect(bufAfter.aiStatus).toBe('raw_buffer');
    expect(bufAfter.orbit).toBe('');

    // Ghost item was NEVER touched, and neither buffer nor ghost items were sent to cloud AI
    const ghostAfter = repo.getItemById(ghostItem.id)!;
    expect(ghostAfter.title).toBe('x.com');
    expect(ghostAfter.body).toBe('https://x.com/ghostuser/status/3001');
    const allCloudPayloads = cloudBodies.join('\n');
    expect(allCloudPayloads).not.toContain('bufferuser');
    expect(allCloudPayloads).not.toContain('ghostuser');
    expect(allCloudPayloads).not.toContain('Unfurled post 2001');
  });

  it('never sends legacy private Telegram invite URLs to Vision or cloud AI during background enrichment', async () => {
    const cloudAiSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const visionSpy = vi.fn(async () => ({ base64: 'abc', mimeType: 'image/png' }));
    const { repo, pipeline } = makePipelineEnv({
      aiProvider: 'google_ai_studio',
      apiKey: 'fake-cloud-key',
      fetchFn: cloudAiSpy as unknown as typeof fetch,
      prepareVisionImage: visionSpy,
    });

    const legacyInvite = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-legacy-tg-invite',
      title: 't.me',
      body: 'https://t.me/+VerySecretPrivateInviteToken99',
      url: 'https://t.me/+VerySecretPrivateInviteToken99',
      domain: 't.me',
      platform: 'telegram',
      source: 'vault_ui',
    });

    const res = await pipeline.reprocessItem(legacyInvite.id);
    await pipeline.waitForIdle();

    expect(res).toBeTruthy();
    expect(res?.mediaMeta?.linkAccess).toBe('private');
    expect(res?.mediaMeta?.hasVideo).toBe(false);
    expect(res?.aiStatus).toBe('local');
    expect(cloudAiSpy).not.toHaveBeenCalled();
    expect(visionSpy).not.toHaveBeenCalled();
  });

  it('reports manual refresh failures cleanly (null) on unreachable sites or disabled unfurl, and updates cover image when ogImageUrl changes', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.25', family: 4 }] as never);

    // 1. Disabled unfurl -> reprocessItem returns null for link items
    const disabledEnv = makePipelineEnv({ enableUrlUnfurl: false });
    const disabledLink = disabledEnv.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-disabled-unfurl',
      title: 'example.com',
      body: 'https://example.com/page',
      url: 'https://example.com/page',
      domain: 'example.com',
      source: 'vault_ui',
    });
    expect(await disabledEnv.pipeline.reprocessItem(disabledLink.id)).toBeNull();

    // 2. Unreachable site (500) -> reprocessItem returns null
    const env = makePipelineEnv({ enableUrlUnfurl: true });
    const failingLink = env.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-dead-link',
      title: 'dead.example.com',
      body: 'https://dead.example.com/post',
      url: 'https://dead.example.com/post',
      domain: 'dead.example.com',
      source: 'vault_ui',
    });

    const pngA = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=',
      'base64'
    );
    const pngB = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAAD416D8AAAAEklEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('dead.example.com')) return new Response('', { status: 500 });
      if (s === 'https://example.com/article') {
        return new Response(
          `<html><head>
            <meta property="og:title" content="Updated Article Title" />
            <meta property="og:description" content="Fresh summary after cover update" />
            <meta property="og:image" content="https://cdn.example.com/new-cover.png" />
          </head><body><article><p>Fresh summary after cover update</p></article></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (s === 'https://cdn.example.com/new-cover.png') {
        return new Response(pngB, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    });

    expect(await env.pipeline.reprocessItem(failingLink.id)).toBeNull();

    // 3. Cover image refresh replaces old cover when ogImageUrl changed & removes old file
    const mediaDir = env.pipeline.getMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'old_cover.png'), pngA);
    fs.writeFileSync(path.join(mediaDir, 'old_thumb.jpg'), pngA);
    const coverLink = env.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-cover-refresh-1',
      title: 'Old Title',
      body: 'Existing body text',
      url: 'https://example.com/article',
      domain: 'example.com',
      ogImageUrl: 'https://cdn.example.com/old-cover.png',
      imagePath: 'old_cover.png',
      thumbPath: 'old_thumb.jpg',
      source: 'vault_ui',
    });

    const refreshed = await env.pipeline.reprocessItem(coverLink.id);
    expect(refreshed).toBeTruthy();
    expect(refreshed?.ogImageUrl).toBe('https://cdn.example.com/new-cover.png');
    expect(refreshed?.imagePath).not.toBe('old_cover.png');
    expect(fs.existsSync(path.join(mediaDir, 'old_cover.png'))).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('skips Telegram Tier 2 when exact data-post is missing, rejects Instagram login redirect to fall through to /embed/captioned/, routes GitHub issue URLs to OG, and blocks unsafe web redirects', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '149.154.167.99', family: 4 }] as never);

    // 1. Desktop & Mobile Telegram Tier 2 missing exact data-post -> falls through to Tier 3 plain OG
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s.includes('embed=1')) return new Response('', { status: 500 });
      if (s.includes('/s/news_chan/999')) {
        return new Response(
          `<html><body>
            <div class="tgme_widget_message" data-post="news_chan/100">
              <div class="tgme_widget_message_text">UNRELATED OLDER POST</div>
            </div>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (s === 'https://t.me/news_chan/999') {
        return new Response(
          `<html><head>
            <meta property="og:title" content="News Channel — Post 999" />
            <meta property="og:description" content="Actual post 999 via Tier 3 OG" />
          </head><body></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const desktopTg = await unfurlUrl('https://t.me/news_chan/999');
    expect(desktopTg.bodyMarkdown).toContain('Actual post 999 via Tier 3 OG');
    expect(desktopTg.bodyMarkdown).not.toContain('UNRELATED OLDER POST');

    const mobileTgFetch: MobileFetchTextFn = async ({ url }) => {
      if (url.includes('embed=1')) return { ok: false, status: 500, finalUrl: url, contentType: '', body: '' };
      if (url.includes('/s/news_chan/999')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: 'text/html',
          body: `<div class="tgme_widget_message" data-post="news_chan/100"><div class="tgme_widget_message_text">UNRELATED OLDER POST</div></div>`,
        };
      }
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        body: `<html><head><meta property="og:title" content="News Channel — Post 999" /><meta property="og:description" content="Actual post 999 via Tier 3 OG" /></head></html>`,
      };
    };
    const mobileTg = await unfurlMobileLink('https://t.me/news_chan/999', 'ru', mobileTgFetch);
    expect(mobileTg?.body).toContain('Actual post 999 via Tier 3 OG');
    expect(mobileTg?.body).not.toContain('UNRELATED OLDER POST');

    // 2. Desktop & Mobile Instagram /accounts/login redirect -> falls through to /embed/captioned/
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      if (s === 'https://www.instagram.com/reel/LoginWall1/') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://www.instagram.com/accounts/login/?next=/reel/LoginWall1/' },
        });
      }
      if (s.includes('/accounts/login/')) {
        return new Response(
          `<html><head>
            <title>Login • Instagram</title>
            <meta property="og:description" content="Create an account or log in to Instagram" />
            <meta property="og:image" content="https://static.cdninstagram.com/rsrc.php/login-logo.png" />
          </head></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (s.includes('/reel/LoginWall1/embed/captioned/')) {
        return new Response(
          `<html><body>
            <span class="UsernameText">motion_lab</span>
            <div class="Caption">motion_lab Smooth spring choreography breakdown</div>
            <img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/v/real_embed.jpg" />
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    });

    const desktopIg = await unfurlUrl('https://www.instagram.com/reel/LoginWall1/');
    expect(desktopIg.title).toContain('Smooth spring choreography breakdown');
    expect(desktopIg.ogImageUrl).toBe('https://scontent.cdninstagram.com/v/real_embed.jpg');

    const mobileIgFetch: MobileFetchTextFn = async ({ url }) => {
      if (url.includes('/embed/captioned/')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: 'text/html',
          body: `<span class="UsernameText">motion_lab</span><div class="Caption">motion_lab Smooth spring choreography breakdown</div><img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/v/real_embed.jpg" />`,
        };
      }
      return {
        ok: true,
        status: 200,
        finalUrl: 'https://www.instagram.com/accounts/login/?next=/reel/LoginWall1/',
        contentType: 'text/html',
        body: `<title>Instagram</title><meta property="og:description" content="Create an account or log in to Instagram" />`,
      };
    };
    const mobileIg = await unfurlMobileLink('https://www.instagram.com/reel/LoginWall1/', 'ru', mobileIgFetch);
    expect(mobileIg?.title).toContain('Smooth spring choreography breakdown');
    expect(mobileIg?.ogImageUrl).toBe('https://scontent.cdninstagram.com/v/real_embed.jpg');

    // 3. GitHub issue URL on mobile falls through to generic OG instead of calling /repos/owner/repo
    const ghCalls: string[] = [];
    const mobileGhFetch: MobileFetchTextFn = async ({ url }) => {
      ghCalls.push(url);
      if (url === 'https://github.com/acme/widget/issues/123') {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: 'text/html',
          body: `<html><head><meta property="og:title" content="Fix Enter key on Android · Issue #123 · acme/widget" /><meta property="og:description" content="Repro steps for issue 123" /></head></html>`,
        };
      }
      return { ok: false, status: 404, finalUrl: url, contentType: '', body: '' };
    };
    const ghIssue = await unfurlMobileLink('https://github.com/acme/widget/issues/123', 'ru', mobileGhFetch);
    expect(ghCalls.some((u) => u.includes('api.github.com/repos/'))).toBe(false);
    expect(ghIssue?.title).toContain('Issue #123');

    // 4. mobileBridge.fetchExternalText web fallback blocks redirect to loopback 127.0.0.1
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9222/json' } })
    );
    const blockedRedir = await mobileBridge.fetchExternalText({ url: 'https://example.com/hop' });
    expect(blockedRedir.ok).toBe(false);
    expect(blockedRedir.error).toBe('blocked_url');
  });

  it('never falls through to generic login-wall HTML when dedicated Instagram, Telegram, or X tiers fail (including Russian IG login walls)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.44', family: 4 }] as never);

    // cleanInstagramText rejects English & Russian login titles and boilerplate descriptions
    expect(cleanInstagramText('Login • Instagram', 'Create an account or log in to Instagram')).toEqual({
      author: null,
      caption: '',
      cleanTitle: null,
    });
    expect(
      cleanInstagramText('Войдите в Instagram', 'Создайте аккаунт или войдите в Instagram — делитесь моментами')
    ).toEqual({
      author: null,
      caption: '',
      cleanTitle: null,
    });

    // Desktop Instagram: Russian login wall on crawler + login redirect on /embed/captioned/ MUST NOT fall through to Section 6
    const igFetchUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const s = String(u);
      igFetchUrls.push(s);
      if (s.includes('/embed/captioned/')) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://www.instagram.com/accounts/login/?next=/reel/LockedRu1/embed/captioned/' },
        });
      }
      if (s.includes('/accounts/login/')) {
        return new Response('<title>Войдите в Instagram</title><div class="Caption">Fake login</div>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(
        `<html><head>
          <title>Войдите в Instagram</title>
          <meta property="og:description" content="Создайте аккаунт или войдите в Instagram" />
          <meta property="og:image" content="https://static.cdninstagram.com/logo.png" />
        </head><body>Login shell</body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    });
    const igFailed = await unfurlUrl('https://www.instagram.com/reel/LockedRu1/');
    expect(igFailed.title).toBeNull();
    expect(igFailed.bodyMarkdown).toBe('');
    expect(igFailed.ogImageUrl).toBeNull();
    // Only crawler + embed (+ redirect hop) — NEVER a 3rd Section-6 generic fetch of rawUrl
    expect(igFetchUrls.filter((u) => u === 'https://www.instagram.com/reel/LockedRu1/')).toHaveLength(1);

    // Mobile Instagram: Russian login wall + failing embed returns null (never falls through to unfurlMobileGeneric)
    const mobIgCalls: string[] = [];
    const mobIgFail = await unfurlMobileLink('https://www.instagram.com/reel/LockedRu1/', 'ru', async ({ url }) => {
      mobIgCalls.push(url);
      if (url.includes('/embed/captioned/')) {
        return {
          ok: true,
          status: 200,
          finalUrl: 'https://www.instagram.com/accounts/login/',
          contentType: 'text/html',
          body: '<title>Войдите в Instagram</title>',
        };
      }
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        body: '<title>Войти • Instagram</title><meta property="og:description" content="Создайте аккаунт или войдите в Instagram" /><meta property="og:image" content="https://static.cdninstagram.com/logo.png" />',
      };
    });
    expect(mobIgFail).toBeNull();
    expect(mobIgCalls.filter((u) => u === 'https://www.instagram.com/reel/LockedRu1/')).toHaveLength(1);

    // Desktop X status & public Telegram post MUST NOT fall through to Section 6 generic HTML
    const xCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      xCalls.push(String(u));
      if (String(u) === 'https://x.com/someone/status/555555') {
        return new Response('<html><head><title>X login shell</title></head><body>Log in to X</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('', { status: 404 });
    });
    const xFailed = await unfurlUrl('https://x.com/someone/status/555555');
    expect(xFailed.title).toBeNull();
    expect(xCalls).not.toContain('https://x.com/someone/status/555555');

    const tgCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      tgCalls.push(String(u));
      return new Response('<html><head><title>Telegram: View @chan</title></head><body></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const tgFailed = await unfurlUrl('https://t.me/chan/40404');
    expect(tgFailed.title).toBeNull();
    // Tier 3 fetched t.me/chan/40404 once — no extra Section-6 generic fetch
    expect(tgCalls.filter((u) => u === 'https://t.me/chan/40404')).toHaveLength(1);

    const mobTgCalls: string[] = [];
    const mobTgFail = await unfurlMobileLink('https://t.me/chan/40404', 'ru', async ({ url }) => {
      mobTgCalls.push(url);
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        body: '<html><head><title>Telegram: Contact @chan</title></head></html>',
      };
    });
    expect(mobTgFail).toBeNull();
    expect(mobTgCalls.filter((u) => u === 'https://t.me/chan/40404')).toHaveLength(1);
  });

  it('keeps existing link row untouched on failed/disabled reprocessItem, preserves buffer/ghost modes, blocks private Telegram even with unfurl off, and keeps user title in capture()', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '198.18.0.55', family: 4 }] as never);

    // 1. reprocessItem on failing link does NOT call Cloud AI/Vision or mutate existing title/body/orbit
    const cloudSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const visionSpy = vi.fn(async () => ({ base64: 'abc', mimeType: 'image/png' }));
    const env = makePipelineEnv({
      enableUrlUnfurl: true,
      aiProvider: 'google_ai_studio',
      apiKey: 'fake-key',
      fetchFn: cloudSpy as unknown as typeof fetch,
      prepareVisionImage: visionSpy,
    });
    const orbit = env.repo.createOrbit({ name: 'Работа', description: 'Рабочие ссылки' });
    const existing = env.repo.createItem({
      dna: 'link',
      orbit: orbit.id,
      modeCaptured: 'autopilot',
      contentHash: 'hash-keep-untouched-1',
      title: 'Существующий заголовок',
      summary: 'Существующее описание',
      body: 'Существующий текст',
      url: 'https://down.example.com/item',
      domain: 'down.example.com',
      source: 'vault_ui',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    expect(await env.pipeline.reprocessItem(existing.id)).toBeNull();
    const afterFail = env.repo.getItemById(existing.id)!;
    expect(afterFail.title).toBe('Существующий заголовок');
    expect(afterFail.body).toBe('Существующий текст');
    expect(afterFail.orbit).toBe(orbit.id);
    expect(cloudSpy).not.toHaveBeenCalled();
    expect(visionSpy).not.toHaveBeenCalled();

    // 2. reprocessItem respects buffer & ghost capture modes on link refresh
    const bufLink = env.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'buffer',
      aiStatus: 'raw_buffer',
      contentHash: 'hash-reprocess-buffer-1',
      title: 'example.com',
      body: 'https://example.com/buf',
      url: 'https://example.com/buf',
      domain: 'example.com',
      source: 'vault_ui',
    });
    const ghostLink = env.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'ghost',
      aiStatus: 'local',
      contentHash: 'hash-reprocess-ghost-1',
      title: 'example.com',
      body: 'https://example.com/ghost',
      url: 'https://example.com/ghost',
      domain: 'example.com',
      source: 'vault_ui',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      if (String(u) === 'https://example.com/buf') {
        return new Response(
          '<html><head><meta property="og:title" content="Buffer Article" /><meta property="og:description" content="Local buffer preview" /></head><body><p>Local buffer preview body text</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    });
    const bufRefreshed = await env.pipeline.reprocessItem(bufLink.id);
    expect(bufRefreshed?.title).toBe('Buffer Article');
    expect(bufRefreshed?.aiStatus).toBe('raw_buffer');
    expect(bufRefreshed?.orbit).toBe('');
    expect(cloudSpy).not.toHaveBeenCalled();

    await env.pipeline.reprocessItem(ghostLink.id);
    expect(env.repo.getItemById(ghostLink.id)?.title).toBe('example.com');
    expect(cloudSpy).not.toHaveBeenCalled();

    // 3. Private Telegram URL blocked from Cloud AI & ensureLinkVideo even when enableUrlUnfurl === false or alreadyUnfurled === true
    const offEnv = makePipelineEnv({
      enableUrlUnfurl: false,
      aiProvider: 'google_ai_studio',
      apiKey: 'fake-key',
      fetchFn: cloudSpy as unknown as typeof fetch,
    });
    const capturedPriv = await offEnv.pipeline.capture({
      text: 'https://t.me/c/1987654321/77',
      url: 'https://t.me/c/1987654321/77',
      source: 'vault_ui',
    });
    await offEnv.pipeline.waitForIdle();
    expect(capturedPriv.mediaMeta?.linkAccess).toBe('private');
    expect(capturedPriv.mediaMeta?.hasVideo).toBe(false);
    expect(cloudSpy).not.toHaveBeenCalled();

    // Legacy private Telegram row with custom title (alreadyUnfurled === true) and NO pre-saved linkAccess
    const legacyNamedPriv = env.repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      contentHash: 'hash-legacy-priv-named',
      title: 'Важный приватный пост',
      body: 'Личный комментарий к посту из закрытой группы',
      url: 'https://t.me/+UltraPrivateInvite42',
      domain: 't.me',
      platform: 'telegram',
      source: 'vault_ui',
    });
    const vidChecked = await env.pipeline.ensureLinkVideo(legacyNamedPriv.id);
    expect(vidChecked?.mediaMeta?.videoExtractStatus).toBeUndefined();
    const reprPriv = await env.pipeline.reprocessItem(legacyNamedPriv.id);
    expect(reprPriv?.mediaMeta?.linkAccess).toBe('private');
    expect(reprPriv?.mediaMeta?.hasVideo).toBe(false);
    expect(cloudSpy).not.toHaveBeenCalled();

    // 4. capture() preserves user-authored title starting with "Ссылка..." (e.g. "Ссылка для бухгалтерии")
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      if (String(u) === 'https://accounting.example.com/invoice') {
        return new Response(
          '<html><head><meta property="og:title" content="Generic Portal Title" /></head><body><p>Portal</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('', { status: 404 });
    });
    const userTitled = await env.pipeline.capture({
      text: 'Ссылка для бухгалтерии\nhttps://accounting.example.com/invoice',
      url: 'https://accounting.example.com/invoice',
      source: 'vault_ui',
    });
    await env.pipeline.waitForIdle();
    expect(env.repo.getItemById(userTitled.id)?.title).toBe('Ссылка для бухгалтерии');
  });
});
