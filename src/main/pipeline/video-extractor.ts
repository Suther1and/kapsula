import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isPrivateOrLocalHostname } from '@shared/url-safety';
import { parseHtmlDocument } from './html-cleaner';
import { isSafeResolvedHost, readUpToBytes, safeFetchWithRedirects } from './unfurler';
import {
  MAX_VIDEO_FILE_BYTES,
  MIN_VIDEO_FILE_BYTES,
  type VideoCacheManager,
} from './video-cache';

export type SocialVideoPlatform =
  | 'youtube'
  | 'telegram'
  | 'instagram'
  | 'tiktok'
  | 'reddit'
  | 'x'
  | 'other';

export interface SocialVideoResolution {
  status: 'ready' | 'login_required' | 'unavailable';
  cachedVideoFile?: string;
  youtubeVideoId?: string;
  videoUrl?: string;
  durationSec?: number;
}

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoId(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').replace(/^m\./i, '').toLowerCase();
  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = u.pathname.replace(/^\/+/, '').split('/')[0] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') {
      candidate = u.searchParams.get('v');
    } else {
      const m = /^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
      candidate = m?.[1] ?? null;
    }
  }
  return candidate && YOUTUBE_ID_RE.test(candidate) ? candidate : null;
}

export function detectSocialVideoPlatform(rawUrl?: string | null): SocialVideoPlatform {
  if (!rawUrl) return 'other';
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./i, '').replace(/^m\./i, '').toLowerCase();
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') return 'youtube';
    if (host === 't.me' || host === 'telegram.me') return 'telegram';
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'v.redd.it') return 'reddit';
    if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
  } catch {
    // ignore
  }
  return 'other';
}

function sanitizeSafeVideoHttpsUrl(raw?: string | null, baseUrl?: URL): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const unescaped = raw
    .trim()
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  if (!unescaped) return null;
  try {
    const u = baseUrl ? new URL(unescaped, baseUrl) : new URL(unescaped);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (isPrivateOrLocalHostname(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function parseRedditVideoFromJson(jsonPayload: unknown): {
  videoUrl: string | null;
  durationSec: number | null;
  posterUrl: string | null;
} {
  try {
    const listings = Array.isArray(jsonPayload) ? jsonPayload : [jsonPayload];
    const post = (listings[0] as { data?: { children?: Array<{ data?: Record<string, unknown> }> } })
      ?.data?.children?.[0]?.data;
    if (!post) return { videoUrl: null, durationSec: null, posterUrl: null };

    const checkMediaObj = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return null;
      const rv = (obj as Record<string, unknown>).reddit_video as
        | { fallback_url?: string; duration?: number }
        | undefined;
      if (rv?.fallback_url) {
        return {
          url: sanitizeSafeVideoHttpsUrl(rv.fallback_url),
          duration: typeof rv.duration === 'number' ? Math.round(rv.duration) : null,
        };
      }
      return null;
    };

    const crosspost = Array.isArray(post.crosspost_parent_list)
      ? (post.crosspost_parent_list[0] as Record<string, unknown> | undefined)
      : undefined;

    const match =
      checkMediaObj(post.secure_media) ??
      checkMediaObj(post.media) ??
      checkMediaObj(post.preview ? { reddit_video: (post.preview as Record<string, unknown>).reddit_video_preview } : null) ??
      (crosspost ? checkMediaObj(crosspost.secure_media) ?? checkMediaObj(crosspost.media) : null);

    const previewImg = sanitizeSafeVideoHttpsUrl(
      ((post.preview as { images?: Array<{ source?: { url?: string } }> } | undefined)?.images?.[0]
        ?.source?.url ?? null) as string | null
    );

    return {
      videoUrl: match?.url ?? null,
      durationSec: match?.duration ?? null,
      posterUrl: previewImg,
    };
  } catch {
    return { videoUrl: null, durationSec: null, posterUrl: null };
  }
}

export function extractVideoUrlFromHtml(
  html: string,
  baseUrl: URL
): { videoUrl: string | null; isLoginWall: boolean } {
  const lower = (html || '').toLowerCase();
  const isLoginWall =
    lower.includes('accounts/login') ||
    lower.includes('/login/?next=') ||
    lower.includes('log in to instagram') ||
    lower.includes('войдите в instagram');

  const doc = parseHtmlDocument(html);
  const metaSelectors = [
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
    'meta[name="twitter:player:stream"]',
  ];
  for (const sel of metaSelectors) {
    const content = doc.querySelector(sel)?.getAttribute('content');
    const safe = sanitizeSafeVideoHttpsUrl(content, baseUrl);
    if (safe && (/\.(?:mp4|webm|m4v)(?:[?#]|$)/i.test(safe) || safe.includes('cdninstagram') || safe.includes('fbcdn') || safe.includes('twimg'))) {
      return { videoUrl: safe, isLoginWall: false };
    }
  }

  const videoSrc =
    doc.querySelector('video source[src]')?.getAttribute('src') ??
    doc.querySelector('video[src]')?.getAttribute('src');
  const safeDomVideo = sanitizeSafeVideoHttpsUrl(videoSrc, baseUrl);
  if (safeDomVideo) {
    return { videoUrl: safeDomVideo, isLoginWall: false };
  }

  // Instagram /embed/captioned/ often embeds `"video_url":"https:\/\/...mp4..."` inside inline script JSON
  const igVideoMatch = /"video_url"\s*:\s*"((?:https?:\\?\/\\?\/)[^"]+\.mp4[^"]*)"/i.exec(html);
  if (igVideoMatch?.[1]) {
    const safeIg = sanitizeSafeVideoHttpsUrl(igVideoMatch[1], baseUrl);
    if (safeIg) return { videoUrl: safeIg, isLoginWall: false };
  }

  const mp4Match = /(https?:\\?\/\\?\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?)/i.exec(html);
  if (mp4Match?.[1]) {
    const safeMp4 = sanitizeSafeVideoHttpsUrl(mp4Match[1], baseUrl);
    if (safeMp4 && !safeMp4.includes('.m3u8')) {
      return { videoUrl: safeMp4, isLoginWall: false };
    }
  }

  return { videoUrl: null, isLoginWall };
}

export async function streamResponseToTempFile(
  resp: Response,
  tmpPath: string,
  maxBytes: number
): Promise<{ byteLength: number; sha256Hex: string } | null> {
  if (!resp.body) {
    try {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength < MIN_VIDEO_FILE_BYTES || ab.byteLength > maxBytes) {
        return null;
      }
      const buf = Buffer.from(ab);
      await fs.promises.writeFile(tmpPath, buf, { mode: 0o600 });
      const sha256Hex = crypto.createHash('sha256').update(buf).digest('hex');
      return { byteLength: buf.byteLength, sha256Hex };
    } catch {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return null;
    }
  }

  const reader = resp.body.getReader();
  const hash = crypto.createHash('sha256');
  let fh: fs.promises.FileHandle | null = null;
  let total = 0;
  let committed = false;

  try {
    fh = await fs.promises.open(tmpPath, 'w', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) {
          throw new Error('Short write while streaming video');
        }
        offset += bytesWritten;
      }
    }
    if (total < MIN_VIDEO_FILE_BYTES) {
      return null;
    }
    committed = true;
    return {
      byteLength: total,
      sha256Hex: hash.digest('hex'),
    };
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    if (fh) {
      await fh.close().catch(() => {});
    }
    if (!committed) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

export async function downloadStreamIntoCache(
  videoUrl: string,
  stem: string,
  videoCache: VideoCacheManager
): Promise<{ filename: string; mime: string; byteLength: number } | null> {
  if (!videoUrl) return null;
  try {
    const u = new URL(videoUrl);
    if (isPrivateOrLocalHostname(u.hostname)) return null;
    if (!(await isSafeResolvedHost(u.hostname))) return null;

    const fetched = await safeFetchWithRedirects(videoUrl, {
      accept: 'video/mp4,video/webm,video/*;q=0.8',
      timeoutMs: 22_000,
      maxHops: 4,
    });
    if (!fetched || !fetched.resp.ok) {
      await fetched?.resp.body?.cancel().catch(() => {});
      return null;
    }
    const ct = (fetched.resp.headers.get('content-type') || '').toLowerCase();
    if (
      ct &&
      !ct.includes('video/') &&
      !ct.includes('application/octet-stream') &&
      !ct.includes('binary/octet-stream')
    ) {
      await fetched.resp.body?.cancel().catch(() => {});
      return null;
    }
    const clHeader = Number(fetched.resp.headers.get('content-length') || 0);
    if (clHeader > MAX_VIDEO_FILE_BYTES) {
      await fetched.resp.body?.cancel().catch(() => {});
      return null;
    }

    const ext: '.mp4' | '.webm' =
      ct.includes('webm') || /\.webm(?:[?#]|$)/i.test(videoUrl) ? '.webm' : '.mp4';
    await videoCache.ensureDirAsync();
    const tmpPath = videoCache.createTempFilePath(ext);
    const streamed = await streamResponseToTempFile(fetched.resp, tmpPath, MAX_VIDEO_FILE_BYTES);
    if (!streamed) return null;
    return await videoCache.putFileFromTemp(
      tmpPath,
      streamed.sha256Hex,
      streamed.byteLength,
      stem,
      ext
    );
  } catch {
    return null;
  }
}

function tryResolveViaYtDlp(pageUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'yt-dlp',
        ['-g', '--no-playlist', '--no-warnings', '-f', 'b[ext=mp4][filesize<60M]/b[ext=mp4]/b', pageUrl],
        { timeout: 6500, maxBuffer: 256 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          const lines = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^https?:\/\//i.test(l));
          const safe = sanitizeSafeVideoHttpsUrl(lines[0] ?? null);
          resolve(safe);
        }
      );
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function tryResolveViaEphemeralBrowserWindow(pageUrl: string): Promise<{
  videoUrl: string | null;
  loginRequired: boolean;
}> {
  // Dynamically require electron so Node unit tests outside Electron runtime never fail
  let BrowserWindowCtor: typeof import('electron').BrowserWindow | undefined;
  let electronSession: typeof import('electron').session | undefined;
  try {
    const mod = await import('electron');
    BrowserWindowCtor = mod.BrowserWindow;
    electronSession = mod.session;
  } catch {
    return { videoUrl: null, loginRequired: false };
  }
  if (!BrowserWindowCtor || !electronSession) {
    return { videoUrl: null, loginRequired: false };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pageUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return { videoUrl: null, loginRequired: false };
    }
    if (isPrivateOrLocalHostname(parsedUrl.hostname)) {
      return { videoUrl: null, loginRequired: false };
    }
  } catch {
    return { videoUrl: null, loginRequired: false };
  }

  const partitionName = `kapsula-vid-${crypto.randomUUID()}`;
  const partSession = electronSession.fromPartition(partitionName, { cache: false });
  let win: import('electron').BrowserWindow | null = null;
  let foundVideoUrl: string | null = null;
  let loginWall = false;

  try {
    partSession.webRequest.onHeadersReceived((details, callback) => {
      if (!foundVideoUrl && details.url.startsWith('https://')) {
        const ctHeader = Object.entries(details.responseHeaders ?? {}).find(
          ([k]) => k.toLowerCase() === 'content-type'
        )?.[1]?.[0];
        const isMp4Resp =
          (ctHeader && ctHeader.toLowerCase().includes('video/mp4')) ||
          /\.mp4(?:\?|$)/i.test(details.url);
        if (isMp4Resp && !details.url.includes('blob:')) {
          const safe = sanitizeSafeVideoHttpsUrl(details.url);
          if (safe) foundVideoUrl = safe;
        }
      }
      callback({ responseHeaders: details.responseHeaders });
    });

    win = new BrowserWindowCtor({
      show: false,
      width: 430,
      height: 760,
      webPreferences: {
        partition: partitionName,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.webContents.setAudioMuted(true);

    await win.loadURL(pageUrl).catch(() => {});
    const deadline = Date.now() + 7000;
    while (!foundVideoUrl && Date.now() < deadline && !win.isDestroyed()) {
      const currentUrl = win.webContents.getURL();
      if (/\/accounts\/login|\/login\//i.test(currentUrl)) {
        loginWall = true;
        break;
      }
      const domResult = await win.webContents
        .executeJavaScript(
          `(() => {
            const v = document.querySelector('video');
            const src = v ? (v.currentSrc || v.getAttribute('src') || v.querySelector('source')?.getAttribute('src') || '') : '';
            const txt = (document.body?.innerText || '').slice(0, 600).toLowerCase();
            return { src, login: txt.includes('accounts/login') || txt.includes('log in to instagram') };
          })()`,
          true
        )
        .catch(() => null);
      if (domResult?.src && typeof domResult.src === 'string' && domResult.src.startsWith('https://')) {
        const safe = sanitizeSafeVideoHttpsUrl(domResult.src);
        if (safe) {
          foundVideoUrl = safe;
          break;
        }
      }
      if (domResult?.login) {
        loginWall = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch {
    // ignore window errors gracefully
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      // ignore
    }
    try {
      await partSession.clearStorageData();
    } catch {
      // ignore
    }
  }

  return { videoUrl: foundVideoUrl, loginRequired: loginWall };
}

export async function resolveAndCacheSocialVideo(params: {
  url: string;
  stem: string;
  knownVideoUrl?: string | null;
  videoCache: VideoCacheManager;
  enableBrowserFallback?: boolean;
}): Promise<SocialVideoResolution> {
  const { url, stem, knownVideoUrl, videoCache, enableBrowserFallback = true } = params;
  const ytId = extractYouTubeVideoId(url);
  if (ytId) {
    return { status: 'ready', youtubeVideoId: ytId };
  }

  let candidateUrl = sanitizeSafeVideoHttpsUrl(knownVideoUrl ?? null);
  let durationSec: number | undefined;
  let loginRequired = false;

  // 1. Try direct known video URL first
  if (candidateUrl) {
    const cached = await downloadStreamIntoCache(candidateUrl, stem, videoCache);
    if (cached) {
      return { status: 'ready', cachedVideoFile: cached.filename, videoUrl: candidateUrl };
    }
  }

  const platform = detectSocialVideoPlatform(url);
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { status: 'unavailable' };
  }
  if (isPrivateOrLocalHostname(parsedUrl.hostname) || !(await isSafeResolvedHost(parsedUrl.hostname))) {
    return { status: 'unavailable' };
  }

  // 2. Platform-specific lightweight HTML / JSON extractors
  if (platform === 'reddit') {
    const cleanPath = parsedUrl.pathname.replace(/\/+$/, '');
    const rdRes = await safeFetchWithRedirects(`https://www.reddit.com${cleanPath}.json?raw_json=1`, {
      accept: 'application/json',
      timeoutMs: 7000,
    });
    if (rdRes?.resp.ok) {
      const json = await rdRes.resp.json().catch(() => null);
      const parsed = parseRedditVideoFromJson(json);
      if (parsed.videoUrl) candidateUrl = parsed.videoUrl;
      if (parsed.durationSec) durationSec = parsed.durationSec;
    }
  } else if (platform === 'instagram') {
    const igMatch = /^\/(reel|p|tv)\/([a-zA-Z0-9_-]+)/i.exec(parsedUrl.pathname);
    if (igMatch) {
      const embedUrl = `https://www.instagram.com/${igMatch[1]}/${igMatch[2]}/embed/captioned/`;
      const igRes = await safeFetchWithRedirects(embedUrl, { timeoutMs: 7500 });
      if (igRes?.resp.ok) {
        const html = await readUpToBytes(igRes.resp, 320_000);
        const extracted = extractVideoUrlFromHtml(html, new URL(embedUrl));
        if (extracted.videoUrl) candidateUrl = extracted.videoUrl;
        if (extracted.isLoginWall) loginRequired = true;
      }
    }
  } else if (platform === 'telegram') {
    const tgMatch = /^\/(?:s\/)?([a-zA-Z0-9_]{3,})\/(\d+)/i.exec(parsedUrl.pathname);
    if (tgMatch && tgMatch[1] !== 'c') {
      const embedUrl = `https://t.me/${tgMatch[1]}/${tgMatch[2]}?embed=1&mode=tme`;
      const tgRes = await safeFetchWithRedirects(embedUrl, { timeoutMs: 7500 });
      if (tgRes?.resp.ok) {
        const html = await readUpToBytes(tgRes.resp, 260_000);
        const extracted = extractVideoUrlFromHtml(html, new URL(embedUrl));
        if (extracted.videoUrl) candidateUrl = extracted.videoUrl;
      }
    }
  } else {
    const pageRes = await safeFetchWithRedirects(url, { timeoutMs: 7500 });
    if (pageRes?.resp.ok && (pageRes.resp.headers.get('content-type') || '').includes('text/html')) {
      const html = await readUpToBytes(pageRes.resp, 300_000);
      const extracted = extractVideoUrlFromHtml(html, pageRes.finalUrl);
      if (extracted.videoUrl) candidateUrl = extracted.videoUrl;
      if (extracted.isLoginWall) loginRequired = true;
    }
  }

  if (candidateUrl) {
    const cached = await downloadStreamIntoCache(candidateUrl, stem, videoCache);
    if (cached) {
      return {
        status: 'ready',
        cachedVideoFile: cached.filename,
        videoUrl: candidateUrl,
        durationSec,
      };
    }
  }

  // 3. Optional local yt-dlp if present on user PATH (never bundled or forced)
  if (!candidateUrl && (platform === 'instagram' || platform === 'tiktok' || platform === 'x')) {
    const ytDlpUrl = await tryResolveViaYtDlp(url);
    if (ytDlpUrl) {
      const cached = await downloadStreamIntoCache(ytDlpUrl, stem, videoCache);
      if (cached) {
        return { status: 'ready', cachedVideoFile: cached.filename, videoUrl: ytDlpUrl, durationSec };
      }
    }
  }

  // 4. Sandboxed ephemeral BrowserWindow fallback (respects login walls — zero bypass)
  if (
    enableBrowserFallback &&
    (platform === 'instagram' || platform === 'tiktok' || platform === 'x')
  ) {
    const bw = await tryResolveViaEphemeralBrowserWindow(url);
    if (bw.loginRequired) {
      return { status: 'login_required' };
    }
    if (bw.videoUrl) {
      const cached = await downloadStreamIntoCache(bw.videoUrl, stem, videoCache);
      if (cached) {
        return {
          status: 'ready',
          cachedVideoFile: cached.filename,
          videoUrl: bw.videoUrl,
          durationSec,
        };
      }
    }
  }

  return { status: loginRequired ? 'login_required' : 'unavailable' };
}
