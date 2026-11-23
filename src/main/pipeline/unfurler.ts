import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { cleanInstagramText, decodeHtmlEntities, truncateAtWordBoundary } from '@shared/html-entities';
import { isPrivateOrLocalHostname } from '@shared/url-safety';
import type { AppLocale, ExtractedAction } from '@shared/types';
import {
  domNodeToMarkdown,
  extractDocumentMeta,
  extractReadablePage,
  normalizeMetaText,
  parseHtmlDocument,
  type DomNodeLike,
} from './html-cleaner';

export { isPrivateOrLocalHostname };

export interface UnfurlResult {
  url: string;
  canonicalUrl: string;
  domain: string | null;
  platform: string | null;
  pageKind?: 'platform' | 'article' | 'showcase';
  author: string | null;
  publishedAt: string | null;
  title: string | null;
  description: string | null;
  bodyMarkdown: string;
  ogImageUrl: string | null;
  galleryUrls: string[];
  videoUrl: string | null;
  videoDurationSec: number | null;
  extractedLinks: ExtractedAction[];
}

function emptyUnfurl(rawUrl: string): UnfurlResult {
  let domain: string | null = null;
  try {
    domain = new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    domain = null;
  }
  return {
    url: rawUrl,
    canonicalUrl: rawUrl,
    domain,
    platform: null,
    author: null,
    publishedAt: null,
    title: null,
    description: null,
    bodyMarkdown: '',
    ogImageUrl: null,
    galleryUrls: [],
    videoUrl: null,
    videoDurationSec: null,
    extractedLinks: [],
  };
}

export async function isSafeResolvedHost(hostname: string): Promise<boolean> {
  const cleanHost = (hostname.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? '').trim();
  if (!cleanHost) return false;
  if (net.isIP(cleanHost) !== 0) {
    return !isPrivateOrLocalHostname(cleanHost);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const lookupPromise = dns.promises
      .lookup(cleanHost, { all: true, verbatim: true })
      .catch(() => null);
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 1500);
      timer.unref?.();
    });
    const records = await Promise.race([lookupPromise, timeoutPromise]);
    if (!records || records.length === 0) return false;
    return records.every((rec) => !isPrivateOrLocalHostname(rec.address));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function safeFetchWithRedirects(
  rawUrl: string,
  options: {
    accept?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxHops?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<{ resp: Response; finalUrl: URL } | null> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') return null;
  if (isPrivateOrLocalHostname(currentUrl.hostname)) return null;
  if (!(await isSafeResolvedHost(currentUrl.hostname))) return null;

  const fetchFn = options.fetchImpl ?? fetch;
  const maxHops = options.maxHops ?? 4;
  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetchFn(currentUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Kapsula/6.0',
        Accept: options.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 6500),
      redirect: 'manual',
    });

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!loc) return null;
      currentUrl = new URL(loc, currentUrl);
      if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') return null;
      if (isPrivateOrLocalHostname(currentUrl.hostname)) return null;
      if (!(await isSafeResolvedHost(currentUrl.hostname))) return null;
      continue;
    }
    return { resp, finalUrl: currentUrl };
  }
  return null;
}

export async function readUpToBytes(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) {
    return (await resp.text()).slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remain = maxBytes - total;
      const slice = value.byteLength > remain ? value.subarray(0, remain) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (value.byteLength >= remain) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // partial read
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBinaryUpToBytes(resp: Response, maxBytes: number): Promise<Buffer | null> {
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

export function sanitizeSafeExternalUrl(raw: string | null | undefined, base?: URL): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  }
  try {
    const u = base ? new URL(candidate, base) : new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateOrLocalHostname(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function parseDurationToSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parts = raw.trim().split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

function deriveHeadlineFromText(text: string, fallback: string): string {
  const cleanLines = text
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*|^>\s*|[*_`]/g, '').trim())
    .filter((l) => l.length >= 4 && !/^https?:\/\//i.test(l));
  const first = cleanLines[0];
  if (!first) return fallback;
  return truncateAtWordBoundary(first, 120);
}

function isTelegramPromoLink(label: string, href: string, postChannel: string | null): boolean {
  const cleanLabel = label.toLowerCase();
  if (/подписаться|subscribe|прислать\s+новост|наш\s+резерв|наш\s+канал|бот\s+обратн|реклам/i.test(cleanLabel)) {
    return true;
  }
  if (/^https?:\/\/(?:t\.me|telegram\.me)\/\+/i.test(href)) {
    return true;
  }
  if (postChannel) {
    const m = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})(?:\/(\d+))?(?:\?.*)?$/i.exec(href.trim());
    if (m && m[1]?.toLowerCase() === postChannel && !m[2]) {
      return true;
    }
  }
  return false;
}

function normalizeForTitleMatch(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Pure DOM-based parser for Telegram embed (`?embed=1&mode=tme`) or `t.me/s/` public channel post HTML.
 * Extracts post title, full body markdown, embedded links, author, timestamp, photos, and MP4 video stream.
 */
export function parseTelegramPostHtml(
  html: string,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> {
  const baseUrl = new URL(postUrl);
  const doc = parseHtmlDocument(html);

  const ownerEl =
    doc.querySelector('.tgme_widget_message_owner_name') ??
    doc.querySelector('.tgme_widget_message_author');
  const author = ownerEl?.textContent ? normalizeMetaText(ownerEl.textContent) : null;

  const timeEl = doc.querySelector('time[datetime]');
  const publishedAt = timeEl?.getAttribute('datetime')?.trim() || null;

  const textEl = doc.querySelector('.tgme_widget_message_text') as unknown as DomNodeLike | null;
  const parsedText = textEl
    ? domNodeToMarkdown(textEl, {
        baseUrl,
        sanitizeUrl: sanitizeSafeExternalUrl,
        mode: 'telegram',
      })
    : { markdown: '', firstBoldTitle: null, links: [], hasCodeBlocks: false };

  const galleryUrls: string[] = [];
  const pushImg = (raw: string | null | undefined) => {
    const safe = sanitizeSafeExternalUrl(raw, baseUrl);
    if (safe && !galleryUrls.includes(safe)) galleryUrls.push(safe);
  };

  const mediaThumbs = doc.querySelectorAll('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_thumb');
  for (let i = 0; i < mediaThumbs.length; i++) {
    const style = mediaThumbs[i]?.getAttribute('style') || '';
    const bgMatch = /background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style);
    if (bgMatch?.[1]) pushImg(bgMatch[1]);
  }

  if (galleryUrls.length === 0) {
    const meta = extractDocumentMeta(doc, baseUrl, sanitizeSafeExternalUrl);
    if (meta.ogImageUrl) pushImg(meta.ogImageUrl);
  }

  const videoEl = doc.querySelector('video[src]');
  const videoUrl = sanitizeSafeExternalUrl(videoEl?.getAttribute('src'), baseUrl);
  const durEl = doc.querySelector('.message_video_duration');
  const videoDurationSec = parseDurationToSeconds(durEl?.textContent);

  const postChannelMatch = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})/i.exec(baseUrl.href);
  const postChannel = postChannelMatch?.[1]?.toLowerCase() ?? null;

  const filteredLinks = parsedText.links.filter(
    (l) => !isTelegramPromoLink(l.label, l.value, postChannel)
  );

  // Strip channel self-promo lines (`👉 Топор Live. Подписаться`, invite links, self-channel roots)
  const rawParagraphs = parsedText.markdown
    .split(/\n{2,}/)
    .map((p) => {
      const keptLines = p
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          const mdLinkMatches = [...trimmed.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi)];
          if (
            mdLinkMatches.length > 0 &&
            mdLinkMatches.every((m) => isTelegramPromoLink(m[1] ?? '', m[2] ?? '', postChannel)) &&
            trimmed.replace(/\[[^\]]+\]\([^)]+\)/g, '').replace(/[👉❗⚡🔥📢💬—–\s.]/g, '').length === 0
          ) {
            return false;
          }
          if (/^(?:👉|📢|🔥)?\s*(?:[^.\n]{1,50}\.\s*)?подписаться(?=$|[^\p{L}])/iu.test(trimmed)) {
            return false;
          }
          return true;
        });
      return keptLines.join('\n').trim();
    })
    .filter(Boolean);

  const isEn = locale === 'en';
  const title =
    parsedText.firstBoldTitle ||
    (rawParagraphs.length > 0
      ? deriveHeadlineFromText(rawParagraphs.join('\n\n'), author || (isEn ? 'Telegram post' : 'Пост в Telegram'))
      : null) ||
    (author ? `${author} · ${isEn ? 'post' : 'пост'}` : null);

  // Strip duplicate standalone bold headline paragraph while keeping unbolded lead-in prose intact
  const normTitle = parsedText.firstBoldTitle ? normalizeForTitleMatch(parsedText.firstBoldTitle) : '';
  if (normTitle && rawParagraphs.length > 1) {
    const firstParaNorm = normalizeForTitleMatch(rawParagraphs[0]!);
    if (firstParaNorm === normTitle || firstParaNorm.replace(/…$/, '') === normTitle.replace(/…$/, '')) {
      rawParagraphs.shift();
    }
  }

  const bodyMarkdown = rawParagraphs.join('\n\n');

  const plainSummary = truncateAtWordBoundary(
    bodyMarkdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    220
  );

  return {
    platform: 'telegram',
    pageKind: 'platform',
    author,
    publishedAt,
    title: title ? truncateAtWordBoundary(title, 120) : null,
    description: plainSummary || null,
    bodyMarkdown,
    ogImageUrl: galleryUrls[0] ?? null,
    galleryUrls,
    videoUrl,
    videoDurationSec,
    extractedLinks: filteredLinks,
  };
}

export function parseFxTwitterResponse(
  json: unknown,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const isEn = locale === 'en';
  if (!json || typeof json !== 'object') return null;
  const root = json as {
    code?: number;
    tweet?: {
      text?: string;
      created_at?: string;
      author?: { name?: string; screen_name?: string; avatar_url?: string };
      media?: {
        photos?: Array<{ url?: string }>;
        videos?: Array<{ url?: string; thumbnail_url?: string; duration?: number }>;
      };
    };
  };
  const tweet = root.tweet;
  if (!tweet) return null;

  const authorName = tweet.author?.name?.trim() || '';
  const handle = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '';
  const author = [authorName, handle].filter(Boolean).join(' ') || null;
  const text = decodeHtmlEntities(tweet.text || '').trim();
  const galleryUrls: string[] = [];
  for (const p of tweet.media?.photos ?? []) {
    const safe = sanitizeSafeExternalUrl(p.url);
    if (safe) galleryUrls.push(safe);
  }
  const firstVideo = tweet.media?.videos?.[0];
  const videoUrl = sanitizeSafeExternalUrl(firstVideo?.url);
  if (galleryUrls.length === 0 && firstVideo?.thumbnail_url) {
    const safeThumb = sanitizeSafeExternalUrl(firstVideo.thumbnail_url);
    if (safeThumb) galleryUrls.push(safeThumb);
  }

  const title = deriveHeadlineFromText(
    text,
    handle ? (isEn ? `Post by ${handle}` : `Пост ${handle}`) : isEn ? 'Post on X' : 'Пост в X'
  );
  const bodyMarkdown = [text, author ? `— *${author}*` : '', postUrl].filter(Boolean).join('\n\n');

  return {
    platform: 'x',
    pageKind: 'platform',
    author,
    publishedAt: tweet.created_at ?? null,
    title,
    description: text ? truncateAtWordBoundary(text, 220) : null,
    bodyMarkdown,
    ogImageUrl: galleryUrls[0] ?? null,
    galleryUrls,
    videoUrl,
    videoDurationSec: typeof firstVideo?.duration === 'number' ? firstVideo.duration : null,
  };
}

/**
 * Pure parser for generic web HTML (used by unfurlUrl and directly testable without network).
 */
export function parseGenericHtmlPage(html: string, finalUrl: URL): Partial<UnfurlResult> {
  const finalHost = finalUrl.hostname.replace(/^www\./i, '').toLowerCase();

  // Instagram posts: extract clean OG metadata via DOM and strip engagement boilerplate
  if (finalHost === 'instagram.com' || finalHost.endsWith('.instagram.com')) {
    const doc = parseHtmlDocument(html);
    const meta = extractDocumentMeta(doc, finalUrl, sanitizeSafeExternalUrl);
    const ig = cleanInstagramText(meta.title || '', meta.description || '');
    const bodyParts = [
      ig.caption,
      ig.author ? `— *@${ig.author}*` : '',
      finalUrl.toString(),
    ].filter(Boolean);
    return {
      canonicalUrl: meta.canonicalUrl || finalUrl.toString(),
      domain: 'instagram.com',
      platform: 'instagram',
      pageKind: 'platform',
      author: ig.author ? `@${ig.author}` : null,
      publishedAt: meta.publishedAt,
      title: ig.cleanTitle ? truncateAtWordBoundary(ig.cleanTitle, 120) : null,
      description: ig.caption ? truncateAtWordBoundary(ig.caption, 220) : null,
      bodyMarkdown: bodyParts.join('\n\n'),
      ogImageUrl: meta.ogImageUrl,
      galleryUrls: meta.galleryUrls,
      videoUrl: meta.ogVideoUrl,
    };
  }

  // GitHub HTML fallback (when GitHub API is rate-limited or non-repo URL): extract clean meta + README only
  if (finalHost === 'github.com') {
    const doc = parseHtmlDocument(html);
    const meta = extractDocumentMeta(doc, finalUrl, sanitizeSafeExternalUrl);
    const cleanTitle = meta.title
      ? truncateAtWordBoundary(meta.title.replace(/^GitHub\s*-\s*/i, ''), 120)
      : null;
    const cleanDesc = meta.description
      ? truncateAtWordBoundary(
          meta.description.replace(/\s*Contribute to [^\s]+ development by creating an account on GitHub\.?$/i, '').trim(),
          240
        )
      : null;
    const readmeEl = doc.querySelector('article.markdown-body') as unknown as DomNodeLike | null;
    let bodyMarkdown = [cleanDesc || '', finalUrl.toString()].filter(Boolean).join('\n\n');
    let extractedLinks: ExtractedAction[] = [];
    if (readmeEl) {
      const parsedReadme = domNodeToMarkdown(readmeEl, {
        baseUrl: finalUrl,
        sanitizeUrl: sanitizeSafeExternalUrl,
        mode: 'web',
      });
      if (parsedReadme.markdown.length >= 80) {
        bodyMarkdown = [cleanDesc || '', parsedReadme.markdown.slice(0, 4000)]
          .filter(Boolean)
          .join('\n\n');
        extractedLinks = parsedReadme.links.slice(0, 6);
      }
    }
    return {
      canonicalUrl: meta.canonicalUrl || finalUrl.toString(),
      domain: 'github.com',
      platform: 'github',
      pageKind: 'platform',
      author: meta.author,
      publishedAt: meta.publishedAt,
      title: cleanTitle,
      description: cleanDesc,
      bodyMarkdown,
      ogImageUrl: meta.ogImageUrl,
      galleryUrls: meta.galleryUrls,
      extractedLinks,
    };
  }

  // Mode B (Article / Docs / Blog) vs Mode C (Directory / Showcase / Homepage / Tool)
  const extracted = extractReadablePage(html, finalUrl, sanitizeSafeExternalUrl);
  return {
    canonicalUrl: extracted.canonicalUrl || finalUrl.toString(),
    domain: finalHost,
    pageKind: extracted.pageKind,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
    title: extracted.title,
    description: extracted.description,
    bodyMarkdown: extracted.bodyMarkdown,
    ogImageUrl: extracted.ogImageUrl,
    galleryUrls: extracted.galleryUrls,
    extractedLinks: extracted.extractedLinks,
  };
}

export async function unfurlUrl(rawUrl: string, locale: AppLocale = 'ru'): Promise<UnfurlResult> {
  const isEn = locale === 'en';
  const fallback = emptyUnfurl(rawUrl);
  try {
    const initial = new URL(rawUrl);
    if (initial.protocol !== 'http:' && initial.protocol !== 'https:') return fallback;
    if (isPrivateOrLocalHostname(initial.hostname)) return fallback;
    if (!(await isSafeResolvedHost(initial.hostname))) return fallback;

    const hostLower = initial.hostname.toLowerCase().replace(/^www\./, '');

    // 1. Telegram Public Post (`t.me/<channel>/<postId>` or `t.me/s/<channel>/<postId>`)
    const tgMatch = /^(?:s\/)?([a-zA-Z0-9_]{3,})\/(\d+)(?:\/|$)/.exec(
      initial.pathname.replace(/^\/+/, '')
    );
    if ((hostLower === 't.me' || hostLower === 'telegram.me') && tgMatch && tgMatch[1] !== 'c') {
      const channel = tgMatch[1]!;
      const postId = tgMatch[2]!;
      const embedUrl = `https://t.me/${channel}/${postId}?embed=1&mode=tme`;
      const embedFetch = await safeFetchWithRedirects(embedUrl, { timeoutMs: 7000 });
      if (embedFetch && embedFetch.resp.ok) {
        const html = await readUpToBytes(embedFetch.resp, 260_000);
        const parsed = parseTelegramPostHtml(html, rawUrl, locale);
        if (parsed.bodyMarkdown || parsed.ogImageUrl || parsed.videoUrl) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: `https://t.me/${channel}/${postId}`,
            domain: 't.me',
          };
        }
      }
      // Secondary fallback: public channel feed `t.me/s/<channel>/<postId>` via DOM selector
      const pubFetch = await safeFetchWithRedirects(`https://t.me/s/${channel}/${postId}`, { timeoutMs: 7000 });
      if (pubFetch && pubFetch.resp.ok) {
        const html = await readUpToBytes(pubFetch.resp, 320_000);
        const feedDoc = parseHtmlDocument(html);
        const expectedDataPost = `${channel}/${postId}`.toLowerCase();
        const postNodes = feedDoc.querySelectorAll('[data-post]');
        let targetOuterHtml = html;
        for (let i = 0; i < postNodes.length; i++) {
          const el = postNodes[i]!;
          if ((el.getAttribute('data-post') || '').toLowerCase() === expectedDataPost) {
            targetOuterHtml = el.outerHTML || html;
            break;
          }
        }
        const parsed = parseTelegramPostHtml(targetOuterHtml, rawUrl, locale);
        if (parsed.bodyMarkdown || parsed.ogImageUrl || parsed.videoUrl) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: `https://t.me/${channel}/${postId}`,
            domain: 't.me',
          };
        }
      }
    }

    // 2. X / Twitter (`x.com/<user>/status/<id>` or `twitter.com/...`)
    const xMatch = /^([a-zA-Z0-9_]{1,32})\/status\/(\d+)/.exec(initial.pathname.replace(/^\/+/, ''));
    if ((hostLower === 'x.com' || hostLower === 'twitter.com') && xMatch) {
      const apiUrl = `https://api.fxtwitter.com/${xMatch[1]}/status/${xMatch[2]}`;
      const fx = await safeFetchWithRedirects(apiUrl, { accept: 'application/json', timeoutMs: 6500 });
      if (fx && fx.resp.ok) {
        const json = await fx.resp.json().catch(() => null);
        const parsed = parseFxTwitterResponse(json, rawUrl, locale);
        if (parsed) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: rawUrl,
            domain: hostLower,
          };
        }
      }
    }

    // 3. YouTube (`youtube.com/watch`, `youtu.be/<id>`, `/shorts/<id>`)
    const isYt = hostLower === 'youtube.com' || hostLower === 'm.youtube.com' || hostLower === 'youtu.be';
    if (isYt) {
      let videoId: string | null = null;
      if (hostLower === 'youtu.be') {
        videoId = initial.pathname.replace(/^\/+/, '').split('/')[0] || null;
      } else {
        videoId =
          initial.searchParams.get('v') ||
          initial.pathname.match(/\/(?:shorts|embed)\/([a-zA-Z0-9_-]{6,})/)?.[1] ||
          null;
      }
      const oembedRes = await safeFetchWithRedirects(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`,
        { accept: 'application/json', timeoutMs: 6000 }
      );
      if (oembedRes && oembedRes.resp.ok) {
        const oe = (await oembedRes.resp.json().catch(() => null)) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        } | null;
        if (oe?.title) {
          const thumb =
            (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null) ||
            sanitizeSafeExternalUrl(oe.thumbnail_url);
          const bodyParts = [
            oe.author_name ? `${isEn ? 'Channel' : 'Канал'}: **${oe.author_name}**` : '',
            rawUrl,
          ].filter(Boolean);
          return {
            ...fallback,
            platform: 'youtube',
            pageKind: 'platform',
            domain: 'youtube.com',
            author: oe.author_name ?? null,
            title: truncateAtWordBoundary(decodeHtmlEntities(oe.title), 120),
            description: oe.author_name
              ? isEn
                ? `Video by ${oe.author_name}`
                : `Видео канала ${oe.author_name}`
              : null,
            bodyMarkdown: bodyParts.join('\n\n'),
            ogImageUrl: thumb,
            galleryUrls: thumb ? [thumb] : [],
          };
        }
      }
    }

    // 4. GitHub Repository (`github.com/<owner>/<repo>`) & Issues / PRs
    const trimmedPath = initial.pathname.replace(/^\/+/, '');
    const ghIssueMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/(issues|pull)\/(\d+)(?:\/|$)/.exec(trimmedPath);
    if (hostLower === 'github.com' && ghIssueMatch) {
      const owner = ghIssueMatch[1]!;
      const repoName = ghIssueMatch[2]!;
      const num = ghIssueMatch[4]!;
      const issueFetch = await safeFetchWithRedirects(
        `https://api.github.com/repos/${owner}/${repoName}/issues/${num}`,
        { accept: 'application/vnd.github+json', timeoutMs: 6500 }
      );
      if (issueFetch && issueFetch.resp.ok) {
        const issue = (await issueFetch.resp.json().catch(() => null)) as {
          title?: string;
          body?: string;
          state?: string;
          user?: { login?: string };
          created_at?: string;
        } | null;
        if (issue?.title) {
          const cleanTitle = decodeHtmlEntities(issue.title).trim();
          const cleanBody = decodeHtmlEntities(issue.body || '').trim().slice(0, 4500);
          const metaLine = [
            `${owner}/${repoName} #${num}`,
            issue.state ? `${isEn ? 'Status' : 'Статус'}: \`${issue.state}\`` : '',
            issue.user?.login ? `${isEn ? 'Author' : 'Автор'}: @${issue.user.login}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const ogImg = `https://opengraph.githubassets.com/1/${owner}/${repoName}`;
          return {
            ...fallback,
            platform: 'github',
            pageKind: 'platform',
            domain: 'github.com',
            author: issue.user?.login ? `@${issue.user.login}` : owner,
            publishedAt: issue.created_at ?? null,
            title: truncateAtWordBoundary(`${cleanTitle} · ${owner}/${repoName}`, 120),
            description: truncateAtWordBoundary(cleanBody || metaLine, 220),
            bodyMarkdown: [metaLine, cleanBody, rawUrl].filter(Boolean).join('\n\n'),
            ogImageUrl: ogImg,
            galleryUrls: [ogImg],
          };
        }
      }
    }

    const ghRepoMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/.exec(trimmedPath);
    if (
      hostLower === 'github.com' &&
      ghRepoMatch &&
      !['topics', 'explore', 'settings', 'orgs', 'features', 'marketplace', 'sponsors', 'pricing', 'about'].includes(
        ghRepoMatch[1]!.toLowerCase()
      )
    ) {
      const owner = ghRepoMatch[1]!;
      const repoName = ghRepoMatch[2]!;
      const ghFetch = await safeFetchWithRedirects(`https://api.github.com/repos/${owner}/${repoName}`, {
        accept: 'application/vnd.github+json',
        timeoutMs: 6500,
      });
      if (ghFetch && ghFetch.resp.ok) {
        const gh = (await ghFetch.resp.json().catch(() => null)) as {
          full_name?: string;
          description?: string;
          language?: string;
          stargazers_count?: number;
          topics?: string[];
          homepage?: string;
        } | null;
        if (gh?.full_name) {
          const safeHomepage = sanitizeSafeExternalUrl(gh.homepage);
          const metaLine = [
            gh.language ? `${isEn ? 'Language' : 'Язык'}: \`${gh.language}\`` : '',
            typeof gh.stargazers_count === 'number' ? `★ ${gh.stargazers_count.toLocaleString('en-US')}` : '',
            safeHomepage ? `[${isEn ? 'Website' : 'Сайт'}](${safeHomepage})` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const topicsLine =
            Array.isArray(gh.topics) && gh.topics.length > 0
              ? gh.topics
                  .slice(0, 6)
                  .map((t) => `#${t}`)
                  .join(' ')
              : '';
          const cleanDesc = decodeHtmlEntities(gh.description || '').trim();
          const bodyMarkdown = [cleanDesc, metaLine, topicsLine, rawUrl].filter(Boolean).join('\n\n');
          const ogImg = `https://opengraph.githubassets.com/1/${gh.full_name}`;
          return {
            ...fallback,
            platform: 'github',
            pageKind: 'platform',
            domain: 'github.com',
            author: owner,
            title: truncateAtWordBoundary(
              `${gh.full_name}${cleanDesc ? ` — ${truncateAtWordBoundary(cleanDesc, 56)}` : ''}`,
              110
            ),
            description: cleanDesc ? truncateAtWordBoundary(cleanDesc, 220) : null,
            bodyMarkdown,
            ogImageUrl: ogImg,
            galleryUrls: [ogImg],
          };
        }
      }
    }

    // 5. Reddit public thread (`reddit.com/r/<sub>/comments/<id>/...`)
    if (
      (hostLower === 'reddit.com' || hostLower.endsWith('.reddit.com')) &&
      /^r\/[^/]+\/comments\/[a-z0-9]+/i.test(trimmedPath)
    ) {
      const jsonUrl = `https://www.reddit.com/${trimmedPath.replace(/\/+$/, '')}.json?raw_json=1`;
      const rdFetch = await safeFetchWithRedirects(jsonUrl, {
        accept: 'application/json',
        timeoutMs: 6500,
      });
      if (rdFetch && rdFetch.resp.ok) {
            const rdJson = (await rdFetch.resp.json().catch(() => null)) as Array<{
              data?: {
                children?: Array<{
                  data?: {
                    title?: string;
                    selftext?: string;
                    subreddit_name_prefixed?: string;
                    author?: string;
                    url_overridden_by_dest?: string;
                    preview?: {
                      images?: Array<{ source?: { url?: string } }>;
                      reddit_video_preview?: { fallback_url?: string; duration?: number };
                    };
                    secure_media?: { reddit_video?: { fallback_url?: string; duration?: number } };
                    media?: { reddit_video?: { fallback_url?: string; duration?: number } };
                  };
                }>;
              };
            }> | null;
            const post = rdJson?.[0]?.data?.children?.[0]?.data;
            if (post?.title) {
              const cleanTitle = decodeHtmlEntities(post.title).trim();
              const selfText = decodeHtmlEntities(post.selftext || '').trim().slice(0, 4000);
              const author = [post.subreddit_name_prefixed, post.author ? `u/${post.author}` : '']
                .filter(Boolean)
                .join(' · ') || null;
              const img = sanitizeSafeExternalUrl(post.preview?.images?.[0]?.source?.url);
              const rv =
                post.secure_media?.reddit_video ??
                post.media?.reddit_video ??
                post.preview?.reddit_video_preview;
              const redditVideoUrl = sanitizeSafeExternalUrl(rv?.fallback_url);
              const extDest =
                post.url_overridden_by_dest && post.url_overridden_by_dest !== rawUrl
                  ? sanitizeSafeExternalUrl(post.url_overridden_by_dest)
                  : null;
              return {
                ...fallback,
                platform: 'reddit',
                pageKind: 'platform',
                domain: 'reddit.com',
                author,
                title: truncateAtWordBoundary(cleanTitle, 120),
                description: truncateAtWordBoundary(selfText || author || cleanTitle, 220),
                bodyMarkdown: [selfText, extDest && !selfText.includes(extDest) ? extDest : '', rawUrl]
                  .filter(Boolean)
                  .join('\n\n'),
                ogImageUrl: img,
                galleryUrls: img ? [img] : [],
                videoUrl: redditVideoUrl,
                videoDurationSec: typeof rv?.duration === 'number' ? Math.round(rv.duration) : null,
              };
            }
      }
    }

    // 6. Generic HTML (Instagram, Articles/Docs Mode B, Showcases/Directories/Landings Mode C)
    const fetched = await safeFetchWithRedirects(rawUrl, { timeoutMs: 7500 });
    if (!fetched) return fallback;

    const { resp, finalUrl } = fetched;
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok || !contentType.includes('text/html')) {
      return fallback;
    }

    const html = await readUpToBytes(resp, 320_000);
    const parsed = parseGenericHtmlPage(html, finalUrl);

    return {
      ...fallback,
      ...parsed,
      canonicalUrl: parsed.canonicalUrl || finalUrl.toString(),
      domain: parsed.domain || finalUrl.hostname.replace(/^www\./i, '').toLowerCase(),
    };
  } catch {
    return fallback;
  }
}

export async function downloadOgImage(
  ogImageUrl: string,
  mediaDir: string,
  fileStem: string
): Promise<{ filename: string; buffer: Buffer } | null> {
  if (!ogImageUrl) return null;
  try {
    const fetched = await safeFetchWithRedirects(ogImageUrl, {
      accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
      timeoutMs: 6500,
      maxHops: 3,
    });
    if (!fetched || !fetched.resp.ok) return null;

    const ct = (fetched.resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return null;

    const clHeader = Number(fetched.resp.headers.get('content-length') || 0);
    if (clHeader > 6 * 1024 * 1024) return null;

    const buf = await readBinaryUpToBytes(fetched.resp, 6 * 1024 * 1024);
    if (!buf) return null;

    let ext = '.jpg';
    if (ct.includes('png')) ext = '.png';
    else if (ct.includes('webp')) ext = '.webp';
    else if (ct.includes('gif')) ext = '.gif';

    const filename = `og_${fileStem}${ext}`;
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mediaDir, filename), buf, { mode: 0o600 });
    return { filename, buffer: buf };
  } catch {
    return null;
  }
}

export async function downloadVideoAsset(
  videoUrl: string,
  mediaDir: string,
  fileStem: string
): Promise<{ filename: string; mime: string; byteLength: number } | null> {
  if (!videoUrl) return null;
  try {
    const fetched = await safeFetchWithRedirects(videoUrl, {
      accept: 'video/mp4,video/webm,video/*;q=0.8',
      timeoutMs: 18_000,
      maxHops: 3,
    });
    if (!fetched || !fetched.resp.ok) return null;

    const ct = (fetched.resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('video/') && !ct.includes('application/octet-stream')) return null;

    const maxBytes = 35 * 1024 * 1024;
    const clHeader = Number(fetched.resp.headers.get('content-length') || 0);
    if (clHeader > maxBytes) return null;

    const buf = await readBinaryUpToBytes(fetched.resp, maxBytes);
    if (!buf || buf.length < 1024) return null;

    const ext = ct.includes('webm') ? '.webm' : '.mp4';
    const mime = ct.includes('webm') ? 'video/webm' : 'video/mp4';
    const hashShort = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const filename = `vid_${fileStem.slice(0, 12)}_${hashShort}${ext}`;
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mediaDir, filename), buf, { mode: 0o600 });
    return { filename, mime, byteLength: buf.length };
  } catch {
    return null;
  }
}
