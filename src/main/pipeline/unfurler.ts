import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { cleanInstagramText, decodeHtmlEntities, truncateAtWordBoundary } from '@shared/html-entities';
import {
  isPrivateOrLocalHostname,
  isSafeExternalUrl,
  isSafeResolvedIpForPublicDomain,
} from '@shared/url-safety';
import type { AppLocale, ExtractedAction } from '@shared/types';
import {
  domNodeToMarkdown,
  extractDocumentMeta,
  extractReadablePage,
  normalizeMetaText,
  parseHtmlDocument,
  type DomNodeLike,
} from './html-cleaner';

export { isPrivateOrLocalHostname, isSafeExternalUrl };

export interface UnfurlResult {
  url: string;
  canonicalUrl: string;
  domain: string | null;
  platform: string | null;
  pageKind?: 'platform' | 'article' | 'showcase';
  linkAccess?: 'public' | 'private';
  hasVideo?: boolean;
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

interface ElectronNetLike {
  app?: { isReady?: () => boolean };
  net?: { fetch?: typeof fetch };
}

let cachedElectronModulePromise: Promise<ElectronNetLike | null> | null = null;

async function resolveTransportFetch(explicitFetch?: typeof fetch): Promise<typeof fetch> {
  if (explicitFetch) return explicitFetch;
  if (typeof process !== 'undefined' && process.versions?.electron) {
    if (!cachedElectronModulePromise) {
      cachedElectronModulePromise = import('electron')
        .then((mod) => mod as unknown as ElectronNetLike)
        .catch(() => null);
    }
    const electronMod = await cachedElectronModulePromise;
    if (electronMod?.app?.isReady?.() && typeof electronMod?.net?.fetch === 'function') {
      return electronMod.net.fetch.bind(electronMod.net) as unknown as typeof fetch;
    }
  }
  return globalThis.fetch;
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
  // Literal IP addresses (including RFC 2544 198.18.0.0/15) must never bypass private/reserved checks
  if (net.isIP(cleanHost) !== 0) {
    return !isPrivateOrLocalHostname(cleanHost);
  }
  if (isPrivateOrLocalHostname(cleanHost)) {
    return false;
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
    // Allow RFC 2544 TUN Fake-IP (198.18.0.0/15) strictly for DNS resolution of validated public domains
    return records.every((rec) => isSafeResolvedIpForPublicDomain(rec.address));
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
  if (!isSafeExternalUrl(currentUrl.toString())) return null;
  if (!(await isSafeResolvedHost(currentUrl.hostname))) return null;

  const fetchFn = await resolveTransportFetch(options.fetchImpl);
  const maxHops = options.maxHops ?? 4;
  for (let hop = 0; hop < maxHops; hop++) {
    let resp: Response;
    try {
      resp = await fetchFn(currentUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: options.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 6500),
        redirect: 'manual',
      });
    } catch {
      return null;
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!loc) return null;
      try {
        currentUrl = new URL(loc, currentUrl);
      } catch {
        return null;
      }
      if (!isSafeExternalUrl(currentUrl.toString())) return null;
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
  const hasVideo = Boolean(
    videoUrl ||
      doc.querySelector('.tgme_widget_message_video_player, .tgme_widget_message_video_thumb, .message_video_duration')
  );

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
    linkAccess: 'public',
    hasVideo,
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

/**
 * Classifies private Telegram links (`t.me/c/<chatId>/<msgId>` or `t.me/+...` / `t.me/joinchat/...`)
 * without making useless network calls or emitting raw `t.me` stubs.
 */
export function classifyPrivateTelegramUrl(
  rawUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const hostLower = u.hostname.toLowerCase().replace(/^www\./, '');
  if (hostLower !== 't.me' && hostLower !== 'telegram.me') return null;

  const trimmedPath = u.pathname.replace(/^\/+/, '');
  const isPrivatePost = /^c\/\d+(?:\/\d+)?(?:\/|$)/i.test(trimmedPath);
  const isPrivateInvite = /^(?:\+[a-zA-Z0-9_-]+|joinchat\/[a-zA-Z0-9_-]+)(?:\/|$)/i.test(trimmedPath);
  if (!isPrivatePost && !isPrivateInvite) return null;

  const isEn = locale === 'en';
  const title = isPrivateInvite
    ? isEn
      ? 'Private Telegram invite'
      : 'Закрытое приглашение в Telegram'
    : isEn
      ? 'Private Telegram post'
      : 'Закрытый пост в Telegram';
  const description = isPrivateInvite
    ? isEn
      ? 'Private channel or group invite — open in Telegram to join.'
      : 'Приглашение в закрытый канал или чат — открой ссылку в Telegram.'
    : isEn
      ? 'Only visible to channel or chat members — open the link in Telegram.'
      : 'Доступно только участникам канала или чата — открой ссылку в Telegram.';

  return {
    canonicalUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`,
    domain: 't.me',
    platform: 'telegram',
    pageKind: 'platform',
    linkAccess: 'private',
    hasVideo: false,
    title,
    description,
    bodyMarkdown: [description, rawUrl].join('\n\n'),
    ogImageUrl: null,
    galleryUrls: [],
    videoUrl: null,
    videoDurationSec: null,
  };
}

function parseTelegramPlainOgFallback(
  html: string,
  postUrl: string,
  channel: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const baseUrl = new URL(postUrl);
  const doc = parseHtmlDocument(html);
  const meta = extractDocumentMeta(doc, baseUrl, sanitizeSafeExternalUrl);
  const rawTitle = (meta.title || '').replace(/^Telegram:\s*(?:Contact|View)\s*/i, '').trim();
  const rawDesc = (meta.description || '')
    .replace(/^You can view and join\s+@\S+\s+right away\.?$/i, '')
    .trim();
  const isGenericTitle =
    !rawTitle ||
    /^telegram$/i.test(rawTitle) ||
    rawTitle.toLowerCase() === `@${channel.toLowerCase()}` ||
    /^view\s+@/i.test(rawTitle);

  if (isGenericTitle && !rawDesc && !meta.ogImageUrl) return null;

  const isEn = locale === 'en';
  const title = !isGenericTitle
    ? truncateAtWordBoundary(rawTitle, 120)
    : rawDesc
      ? deriveHeadlineFromText(rawDesc, `@${channel} · ${isEn ? 'post' : 'пост'}`)
      : `@${channel} · ${isEn ? 'post' : 'пост'}`;
  const bodyMarkdown = [rawDesc, postUrl].filter(Boolean).join('\n\n');

  return {
    platform: 'telegram',
    pageKind: 'platform',
    linkAccess: 'public',
    hasVideo: Boolean(meta.ogVideoUrl),
    author: `@${channel}`,
    publishedAt: meta.publishedAt,
    title,
    description: rawDesc ? truncateAtWordBoundary(rawDesc, 220) : null,
    bodyMarkdown,
    ogImageUrl: meta.ogImageUrl,
    galleryUrls: meta.ogImageUrl ? [meta.ogImageUrl] : [],
    videoUrl: meta.ogVideoUrl,
    videoDurationSec: null,
    extractedLinks: [],
  };
}

export function parseFxTwitterResponse(
  json: unknown,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const isEn = locale === 'en';
  if (!json || typeof json !== 'object') return null;
  interface FxTweetLike {
    text?: string;
    created_at?: string;
    author?: { name?: string; screen_name?: string; avatar_url?: string };
    article?: {
      title?: string;
      preview_text?: string;
      cover_media?: { media_info?: { original_img_url?: string } };
      content?: { blocks?: Array<{ text?: string }> };
    };
    quote?: FxTweetLike;
    media?: {
      photos?: Array<{ url?: string }>;
      videos?: Array<{ url?: string; thumbnail_url?: string; duration?: number }>;
      all?: Array<{ type?: string; url?: string; thumbnail_url?: string; duration?: number }>;
    };
  }
  const root = json as {
    code?: number;
    tweet?: FxTweetLike;
  };
  const tweet = root.tweet;
  if (!tweet) return null;

  const authorName = tweet.author?.name?.trim() || '';
  const handle = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '';
  const author = [authorName, handle].filter(Boolean).join(' ') || null;

  const articleTitle = decodeHtmlEntities(tweet.article?.title || '').trim();
  const articleBlocks = (tweet.article?.content?.blocks ?? [])
    .map((b) => decodeHtmlEntities(b.text || '').trim())
    .filter(Boolean);
  const articleBody =
    articleBlocks.length > 0
      ? articleBlocks.join('\n\n').slice(0, 4000)
      : decodeHtmlEntities(tweet.article?.preview_text || '').trim();

  const baseText = decodeHtmlEntities(tweet.text || '').trim();
  const combinedMainText = articleBody
    ? baseText && !articleBody.includes(baseText)
      ? `${baseText}\n\n${articleBody}`
      : articleBody
    : baseText;

  const quoteAuthor = tweet.quote?.author?.screen_name
    ? `@${tweet.quote.author.screen_name}`
    : tweet.quote?.author?.name?.trim() || '';
  const quoteText = decodeHtmlEntities(tweet.quote?.text || '').trim();
  const quoteBlock = quoteText
    ? `> ${quoteAuthor ? `**${quoteAuthor}**: ` : ''}${quoteText.replace(/\r?\n/g, '\n> ')}`
    : '';

  const galleryUrls: string[] = [];
  const pushImg = (raw?: string | null) => {
    const safe = sanitizeSafeExternalUrl(raw);
    if (safe && !galleryUrls.includes(safe)) galleryUrls.push(safe);
  };
  if (tweet.article?.cover_media?.media_info?.original_img_url) {
    pushImg(tweet.article.cover_media.media_info.original_img_url);
  }
  for (const p of tweet.media?.photos ?? []) {
    pushImg(p.url);
  }
  let firstVideo = tweet.media?.videos?.[0];
  if (!firstVideo && Array.isArray(tweet.media?.all)) {
    for (const m of tweet.media.all) {
      if (m.type === 'photo') pushImg(m.url);
      else if ((m.type === 'video' || m.type === 'gif') && !firstVideo) {
        firstVideo = { url: m.url, thumbnail_url: m.thumbnail_url, duration: m.duration };
      }
    }
  }
  if (galleryUrls.length === 0 && tweet.quote) {
    for (const p of tweet.quote.media?.photos ?? []) pushImg(p.url);
    if (!firstVideo && tweet.quote.media?.videos?.[0]) {
      firstVideo = tweet.quote.media.videos[0];
    }
  }
  const videoUrl = sanitizeSafeExternalUrl(firstVideo?.url);
  if (galleryUrls.length === 0 && firstVideo?.thumbnail_url) {
    pushImg(firstVideo.thumbnail_url);
  }

  const hasVideo = Boolean(
    videoUrl ||
      (tweet.media?.videos && tweet.media.videos.length > 0) ||
      (tweet.quote?.media?.videos && tweet.quote.media.videos.length > 0)
  );

  const fallbackTitle = handle
    ? isEn
      ? `Post by ${handle}`
      : `Пост ${handle}`
    : isEn
      ? 'Post on X'
      : 'Пост в X';
  const title = articleTitle
    ? truncateAtWordBoundary(articleTitle, 120)
    : deriveHeadlineFromText(combinedMainText || quoteText, fallbackTitle);

  const summarySource = articleBody || combinedMainText || quoteText;
  const bodyMarkdown = [combinedMainText, quoteBlock, author ? `— *${author}*` : '', postUrl]
    .filter(Boolean)
    .join('\n\n');

  return {
    platform: 'x',
    pageKind: 'platform',
    linkAccess: 'public',
    hasVideo,
    author,
    publishedAt: tweet.created_at ?? null,
    title,
    description: summarySource ? truncateAtWordBoundary(summarySource, 220) : null,
    bodyMarkdown,
    ogImageUrl: galleryUrls[0] ?? null,
    galleryUrls,
    videoUrl,
    videoDurationSec: typeof firstVideo?.duration === 'number' ? firstVideo.duration : null,
  };
}

export function parseTwitterSyndicationResponse(
  json: unknown,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const isEn = locale === 'en';
  if (!json || typeof json !== 'object') return null;
  interface SyndTweet {
    text?: string;
    created_at?: string;
    user?: { name?: string; screen_name?: string };
    photos?: Array<{ url?: string }>;
    mediaDetails?: Array<{
      type?: string;
      media_url_https?: string;
      video_info?: {
        duration_millis?: number;
        variants?: Array<{ content_type?: string; bitrate?: number; url?: string }>;
      };
    }>;
    video?: {
      poster?: string;
      durationMs?: number;
      variants?: Array<{ type?: string; src?: string }>;
    };
    quoted_tweet?: SyndTweet;
    article?: { title?: string; preview_text?: string };
  }
  const t = json as SyndTweet;
  const text = decodeHtmlEntities(t.text || '').trim();
  const articleTitle = decodeHtmlEntities(t.article?.title || '').trim();
  const articlePreview = decodeHtmlEntities(t.article?.preview_text || '').trim();
  if (!text && !articleTitle && !t.mediaDetails?.length && !t.photos?.length && !t.video) return null;

  const authorName = t.user?.name?.trim() || '';
  const handle = t.user?.screen_name ? `@${t.user.screen_name}` : '';
  const author = [authorName, handle].filter(Boolean).join(' ') || null;

  const galleryUrls: string[] = [];
  const pushImg = (raw?: string | null) => {
    const safe = sanitizeSafeExternalUrl(raw);
    if (safe && !galleryUrls.includes(safe)) galleryUrls.push(safe);
  };
  for (const p of t.photos ?? []) pushImg(p.url);

  let videoUrl: string | null = null;
  let videoDurationSec: number | null = null;
  let hasVideo = false;
  for (const m of t.mediaDetails ?? []) {
    if (m.type === 'photo') {
      pushImg(m.media_url_https);
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      hasVideo = true;
      pushImg(m.media_url_https);
      const mp4Variants = (m.video_info?.variants ?? [])
        .filter((v) => (v.content_type || '').includes('mp4') && v.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (!videoUrl && mp4Variants[0]?.url) {
        videoUrl = sanitizeSafeExternalUrl(mp4Variants[0].url);
      }
      if (videoDurationSec === null && typeof m.video_info?.duration_millis === 'number') {
        videoDurationSec = Math.round(m.video_info.duration_millis / 1000);
      }
    }
  }
  if (t.video) {
    hasVideo = true;
    pushImg(t.video.poster);
    if (!videoUrl) {
      const mp4 = (t.video.variants ?? []).find((v) => (v.type || '').includes('mp4') && v.src);
      if (mp4?.src) {
        videoUrl = sanitizeSafeExternalUrl(mp4.src);
      }
    }
    if (videoDurationSec === null && typeof t.video.durationMs === 'number') {
      videoDurationSec = Math.round(t.video.durationMs / 1000);
    }
  }

  const quoteAuthor = t.quoted_tweet?.user?.screen_name
    ? `@${t.quoted_tweet.user.screen_name}`
    : t.quoted_tweet?.user?.name?.trim() || '';
  const quoteText = decodeHtmlEntities(t.quoted_tweet?.text || '').trim();
  const quoteBlock = quoteText
    ? `> ${quoteAuthor ? `**${quoteAuthor}**: ` : ''}${quoteText.replace(/\r?\n/g, '\n> ')}`
    : '';

  const mainText = articlePreview && !text.includes(articlePreview) ? [text, articlePreview].filter(Boolean).join('\n\n') : text;
  const fallbackTitle = handle
    ? isEn
      ? `Post by ${handle}`
      : `Пост ${handle}`
    : isEn
      ? 'Post on X'
      : 'Пост в X';
  const title = articleTitle
    ? truncateAtWordBoundary(articleTitle, 120)
    : deriveHeadlineFromText(mainText || quoteText, fallbackTitle);

  return {
    platform: 'x',
    pageKind: 'platform',
    linkAccess: 'public',
    hasVideo,
    author,
    publishedAt: t.created_at ?? null,
    title,
    description: (mainText || quoteText) ? truncateAtWordBoundary(mainText || quoteText, 220) : null,
    bodyMarkdown: [mainText, quoteBlock, author ? `— *${author}*` : '', postUrl]
      .filter(Boolean)
      .join('\n\n'),
    ogImageUrl: galleryUrls[0] ?? null,
    galleryUrls,
    videoUrl,
    videoDurationSec,
  };
}

export function parseVxTwitterResponse(
  json: unknown,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const isEn = locale === 'en';
  if (!json || typeof json !== 'object') return null;
  interface VxTweet {
    text?: string;
    date?: string;
    user_name?: string;
    user_screen_name?: string;
    mediaURLs?: string[];
    media_extended?: Array<{
      type?: string;
      url?: string;
      thumbnail_url?: string;
      duration_millis?: number;
    }>;
    qrt?: VxTweet;
  }
  const vx = json as VxTweet;
  const text = decodeHtmlEntities(vx.text || '').trim();
  if (!text && !vx.media_extended?.length && !vx.mediaURLs?.length) return null;

  const authorName = vx.user_name?.trim() || '';
  const handle = vx.user_screen_name ? `@${vx.user_screen_name}` : '';
  const author = [authorName, handle].filter(Boolean).join(' ') || null;

  const galleryUrls: string[] = [];
  const pushImg = (raw?: string | null) => {
    const safe = sanitizeSafeExternalUrl(raw);
    if (safe && !galleryUrls.includes(safe)) galleryUrls.push(safe);
  };
  let videoUrl: string | null = null;
  let videoDurationSec: number | null = null;
  let hasVideo = false;
  for (const m of vx.media_extended ?? []) {
    if (m.type === 'image') {
      pushImg(m.url);
    } else if (m.type === 'video' || m.type === 'gif') {
      hasVideo = true;
      if (!videoUrl) videoUrl = sanitizeSafeExternalUrl(m.url);
      pushImg(m.thumbnail_url);
      if (videoDurationSec === null && typeof m.duration_millis === 'number') {
        videoDurationSec = Math.round(m.duration_millis / 1000);
      }
    }
  }
  if (galleryUrls.length === 0) {
    for (const u of vx.mediaURLs ?? []) {
      if (/\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(u)) pushImg(u);
    }
  }

  const qrtAuthor = vx.qrt?.user_screen_name ? `@${vx.qrt.user_screen_name}` : vx.qrt?.user_name?.trim() || '';
  const qrtText = decodeHtmlEntities(vx.qrt?.text || '').trim();
  const quoteBlock = qrtText
    ? `> ${qrtAuthor ? `**${qrtAuthor}**: ` : ''}${qrtText.replace(/\r?\n/g, '\n> ')}`
    : '';

  const fallbackTitle = handle
    ? isEn
      ? `Post by ${handle}`
      : `Пост ${handle}`
    : isEn
      ? 'Post on X'
      : 'Пост в X';

  return {
    platform: 'x',
    pageKind: 'platform',
    linkAccess: 'public',
    hasVideo,
    author,
    publishedAt: vx.date ?? null,
    title: deriveHeadlineFromText(text || qrtText, fallbackTitle),
    description: (text || qrtText) ? truncateAtWordBoundary(text || qrtText, 220) : null,
    bodyMarkdown: [text, quoteBlock, author ? `— *${author}*` : '', postUrl]
      .filter(Boolean)
      .join('\n\n'),
    ogImageUrl: galleryUrls[0] ?? null,
    galleryUrls,
    videoUrl,
    videoDurationSec,
  };
}

export function parseTwitterOembedResponse(
  json: unknown,
  postUrl: string,
  locale: AppLocale = 'ru'
): Partial<UnfurlResult> | null {
  const isEn = locale === 'en';
  if (!json || typeof json !== 'object') return null;
  const oe = json as { author_name?: string; author_url?: string; html?: string };
  if (!oe.html && !oe.author_name) return null;

  let text = '';
  if (oe.html) {
    const doc = parseHtmlDocument(oe.html);
    const pEl = doc.querySelector('blockquote p') ?? doc.querySelector('p');
    text = normalizeMetaText(pEl?.textContent || '');
  }
  const handleMatch = /\/([a-zA-Z0-9_]{1,32})\/?$/.exec(oe.author_url || '');
  const handle = handleMatch?.[1] ? `@${handleMatch[1]}` : '';
  const author = [oe.author_name?.trim() || '', handle].filter(Boolean).join(' ') || null;
  if (!text && !author) return null;

  const fallbackTitle = handle
    ? isEn
      ? `Post by ${handle}`
      : `Пост ${handle}`
    : isEn
      ? 'Post on X'
      : 'Пост в X';

  return {
    platform: 'x',
    pageKind: 'platform',
    linkAccess: 'public',
    hasVideo: false,
    author,
    publishedAt: null,
    title: deriveHeadlineFromText(text, fallbackTitle),
    description: text ? truncateAtWordBoundary(text, 220) : null,
    bodyMarkdown: [text, author ? `— *${author}*` : '', postUrl].filter(Boolean).join('\n\n'),
    ogImageUrl: null,
    galleryUrls: [],
    videoUrl: null,
    videoDurationSec: null,
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

    const hostLower = initial.hostname.toLowerCase().replace(/^www\./, '');

    // 1. Telegram Private (`t.me/c/<chatId>/<msgId>` or invite) & Public 3-tier fallback
    if (hostLower === 't.me' || hostLower === 'telegram.me') {
      const privateTg = classifyPrivateTelegramUrl(rawUrl, locale);
      if (privateTg) {
        return {
          ...fallback,
          ...privateTg,
        };
      }
      const tgMatch = /^(?:s\/)?([a-zA-Z0-9_]{3,})\/(\d+)(?:\/|$)/.exec(
        initial.pathname.replace(/^\/+/, '')
      );
      if (tgMatch && tgMatch[1] !== 'c') {
        const channel = tgMatch[1]!;
        const postId = tgMatch[2]!;
        const canonicalTgUrl = `https://t.me/${channel}/${postId}`;

        // Tier 1: Telegram embed widget
        const embedUrl = `https://t.me/${channel}/${postId}?embed=1&mode=tme`;
        const embedFetch = await safeFetchWithRedirects(embedUrl, { timeoutMs: 7000 });
        if (embedFetch && embedFetch.resp.ok) {
          const html = await readUpToBytes(embedFetch.resp, 260_000);
          const parsed = parseTelegramPostHtml(html, rawUrl, locale);
          if (parsed.bodyMarkdown || parsed.ogImageUrl || parsed.videoUrl) {
            return {
              ...fallback,
              ...parsed,
              canonicalUrl: canonicalTgUrl,
              domain: 't.me',
            };
          }
        }

        // Tier 2: Public channel feed `t.me/s/<channel>/<postId>` via exact `data-post` selector
        const pubFetch = await safeFetchWithRedirects(`https://t.me/s/${channel}/${postId}`, {
          timeoutMs: 7000,
        });
        if (pubFetch && pubFetch.resp.ok) {
          const html = await readUpToBytes(pubFetch.resp, 320_000);
          const feedDoc = parseHtmlDocument(html);
          const expectedDataPost = `${channel}/${postId}`.toLowerCase();
          const postNodes = feedDoc.querySelectorAll('[data-post]');
          let targetOuterHtml: string | null = null;
          for (let i = 0; i < postNodes.length; i++) {
            const el = postNodes[i]!;
            if ((el.getAttribute('data-post') || '').toLowerCase() === expectedDataPost) {
              targetOuterHtml = el.outerHTML || null;
              break;
            }
          }
          if (targetOuterHtml) {
            const parsed = parseTelegramPostHtml(targetOuterHtml, rawUrl, locale);
            if (parsed.bodyMarkdown || parsed.ogImageUrl || parsed.videoUrl) {
              return {
                ...fallback,
                ...parsed,
                canonicalUrl: canonicalTgUrl,
                domain: 't.me',
              };
            }
          }
        }

        // Tier 3: Plain OG page fallback (`https://t.me/<channel>/<postId>`)
        const plainFetch = await safeFetchWithRedirects(canonicalTgUrl, { timeoutMs: 6500 });
        if (plainFetch && plainFetch.resp.ok) {
          const html = await readUpToBytes(plainFetch.resp, 240_000);
          const parsedOg = parseTelegramPlainOgFallback(html, rawUrl, channel, locale);
          if (parsedOg) {
            return {
              ...fallback,
              ...parsedOg,
              canonicalUrl: canonicalTgUrl,
              domain: 't.me',
            };
          }
        }
        return fallback;
      }
    }

    // 2. X / Twitter (`x.com/<user>/status/<id>` or `twitter.com/...`) — 4-tier fallback chain
    const isXHost =
      hostLower === 'x.com' ||
      hostLower === 'twitter.com' ||
      hostLower === 'mobile.x.com' ||
      hostLower === 'mobile.twitter.com' ||
      hostLower === 'fxtwitter.com' ||
      hostLower === 'vxtwitter.com';
    const xMatch = /^([a-zA-Z0-9_]{1,32})\/status\/(\d+)/.exec(initial.pathname.replace(/^\/+/, ''));
    if (isXHost && xMatch) {
      const xUser = xMatch[1]!;
      const xStatusId = xMatch[2]!;
      const canonicalXUrl = `https://x.com/${xUser}/status/${xStatusId}`;

      // Tier 1: FxTwitter JSON API (supports tweets, media, quotes, and X Articles)
      const fx = await safeFetchWithRedirects(
        `https://api.fxtwitter.com/${xUser}/status/${xStatusId}`,
        { accept: 'application/json', timeoutMs: 6500 }
      );
      if (fx && fx.resp.ok) {
        const json = await fx.resp.json().catch(() => null);
        const parsed = parseFxTwitterResponse(json, canonicalXUrl, locale);
        if (parsed) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: canonicalXUrl,
            domain: 'x.com',
          };
        }
      }

      // Tier 2: Twitter Syndication CDN
      const synd = await safeFetchWithRedirects(
        `https://cdn.syndication.twimg.com/tweet-result?id=${xStatusId}&lang=${locale}&token=4a`,
        { accept: 'application/json', timeoutMs: 6500 }
      );
      if (synd && synd.resp.ok) {
        const json = await synd.resp.json().catch(() => null);
        const parsed = parseTwitterSyndicationResponse(json, canonicalXUrl, locale);
        if (parsed) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: canonicalXUrl,
            domain: 'x.com',
          };
        }
      }

      // Tier 3: VxTwitter JSON API
      const vx = await safeFetchWithRedirects(
        `https://api.vxtwitter.com/${xUser}/status/${xStatusId}`,
        { accept: 'application/json', timeoutMs: 6500 }
      );
      if (vx && vx.resp.ok) {
        const json = await vx.resp.json().catch(() => null);
        const parsed = parseVxTwitterResponse(json, canonicalXUrl, locale);
        if (parsed) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: canonicalXUrl,
            domain: 'x.com',
          };
        }
      }

      // Tier 4: Official Twitter oEmbed
      const oe = await safeFetchWithRedirects(
        `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalXUrl)}&omit_script=true`,
        { accept: 'application/json', timeoutMs: 6500 }
      );
      if (oe && oe.resp.ok) {
        const json = await oe.resp.json().catch(() => null);
        const parsed = parseTwitterOembedResponse(json, canonicalXUrl, locale);
        if (parsed) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: canonicalXUrl,
            domain: 'x.com',
          };
        }
      }
      return fallback;
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
            linkAccess: 'public',
            hasVideo: true,
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
                linkAccess: 'public',
                hasVideo: Boolean(redditVideoUrl),
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

    // 5.5. Instagram public Reel / Post (`instagram.com/reel/...`, `/p/...`, `/tv/...`)
    // Instagram serves public OG metadata to crawler UAs while redirecting desktop browser UAs to a login shell.
    if (hostLower === 'instagram.com' || hostLower.endsWith('.instagram.com')) {
      const isIgVideoKind = /^\/(?:reel|reels|tv)\//i.test(initial.pathname);
      const isGenericIgTitle = (t?: string | null) =>
        !t ||
        /^(?:instagram|log\s*in\s*[•·-]\s*instagram|войти\s*[•·-]\s*instagram|войдите\s+в\s+instagram)$/i.test(
          t.trim()
        );
      const isIgLoginPath = (p: string) => /\/accounts\/login|\/login(?:\/|$)/i.test(p);
      const isIgLoginBoilerplate = (d?: string | null) =>
        Boolean(
          d &&
            /create an account or log in to instagram|sign up for instagram|log in to instagram|войдите в instagram|создайте аккаунт или войдите в instagram/i.test(
              d
            )
        );

      const crawlerFetch = await safeFetchWithRedirects(rawUrl, {
        timeoutMs: 7500,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });
      if (crawlerFetch && crawlerFetch.resp.ok && !isIgLoginPath(crawlerFetch.finalUrl.pathname)) {
        const html = await readUpToBytes(crawlerFetch.resp, 320_000);
        const parsed = parseGenericHtmlPage(html, crawlerFetch.finalUrl);
        const hitLoginWall =
          (isGenericIgTitle(parsed.title) && isIgLoginBoilerplate(parsed.description)) ||
          (!parsed.title && !parsed.description && !parsed.author);
        if (!hitLoginWall && (!isGenericIgTitle(parsed.title) || parsed.description || parsed.ogImageUrl)) {
          return {
            ...fallback,
            ...parsed,
            canonicalUrl: parsed.canonicalUrl || crawlerFetch.finalUrl.toString(),
            domain: 'instagram.com',
            platform: 'instagram',
            linkAccess: 'public',
            hasVideo: Boolean(parsed.videoUrl || isIgVideoKind),
          };
        }
      }

      const igPostMatch = /^\/(reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i.exec(initial.pathname);
      if (igPostMatch) {
        const kindNorm = igPostMatch[1]!.toLowerCase() === 'reels' ? 'reel' : igPostMatch[1]!.toLowerCase();
        const embedUrl = `https://www.instagram.com/${kindNorm}/${igPostMatch[2]}/embed/captioned/`;
        const embedFetch = await safeFetchWithRedirects(embedUrl, { timeoutMs: 7500 });
        if (embedFetch && embedFetch.resp.ok && !isIgLoginPath(embedFetch.finalUrl.pathname)) {
          const html = await readUpToBytes(embedFetch.resp, 320_000);
          const doc = parseHtmlDocument(html);
          const meta = extractDocumentMeta(doc, embedFetch.finalUrl, sanitizeSafeExternalUrl);
          const captionText = normalizeMetaText(doc.querySelector('.Caption')?.textContent || '');
          const userText = normalizeMetaText(doc.querySelector('.UsernameText')?.textContent || '').replace(/^@/, '');
          const embedImg = sanitizeSafeExternalUrl(
            doc.querySelector('.EmbeddedMediaImage')?.getAttribute('src') || meta.ogImageUrl,
            embedFetch.finalUrl
          );
          if (captionText || userText || embedImg) {
            const escapedUser = userText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const cleanCap = captionText
              .replace(escapedUser ? new RegExp(`^${escapedUser}\\s+`, 'i') : /^$/, '')
              .replace(/\s*view all \d+ comments.*$/i, '')
              .trim();
            const title = cleanCap
              ? deriveHeadlineFromText(cleanCap, userText ? `@${userText}` : 'Instagram')
              : userText
                ? `@${userText} · Instagram`
                : null;
            return {
              ...fallback,
              canonicalUrl: `https://www.instagram.com/${kindNorm}/${igPostMatch[2]}/`,
              domain: 'instagram.com',
              platform: 'instagram',
              pageKind: 'platform',
              linkAccess: 'public',
              hasVideo: Boolean(meta.ogVideoUrl || isIgVideoKind),
              author: userText ? `@${userText}` : null,
              title,
              description: cleanCap ? truncateAtWordBoundary(cleanCap, 220) : null,
              bodyMarkdown: [cleanCap, userText ? `— *@${userText}*` : '', rawUrl].filter(Boolean).join('\n\n'),
              ogImageUrl: embedImg,
              galleryUrls: embedImg ? [embedImg] : [],
              videoUrl: meta.ogVideoUrl,
            };
          }
        }
      }
      return fallback;
    }

    // 6. Generic HTML (Articles/Docs Mode B, Showcases/Directories/Landings Mode C)
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
