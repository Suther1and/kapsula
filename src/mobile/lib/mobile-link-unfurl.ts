import type { AppLocale } from '@shared/i18n/core';
import {
  cleanBrokenTextArtifacts,
  cleanInstagramText,
  decodeHtmlEntities,
  truncateAtWordBoundary,
} from '@shared/html-entities';
import type { MediaMeta } from '@shared/types';
import { isSafeExternalUrl } from '@shared/url-safety';
import { tm } from './mobile-i18n';
import { mobileBridge, type ExternalTextFetchResult } from '../native/bridge';

export type MobileFetchTextFn = (options: {
  url: string;
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
}) => Promise<ExternalTextFetchResult>;

export interface MobileUnfurlResult {
  title: string;
  description: string;
  summary: string;
  body: string;
  ogImageUrl: string | null;
  domain: string;
  platform: string | null;
  canonicalUrl: string;
  linkAccess?: 'public' | 'private';
  hasVideo?: boolean;
  mediaMetaPatch?: Partial<MediaMeta>;
}

const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMetaContent(html: string, attrName: 'property' | 'name', attrVal: string): string | null {
  const escaped = escapeRegExp(attrVal);
  const re1 = new RegExp(
    `<meta[^>]*${attrName}\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    'i'
  );
  const m1 = re1.exec(html);
  if (m1?.[1]) return decodeHtmlEntities(m1[1]).trim() || null;

  const re2 = new RegExp(
    `<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*${attrName}\\s*=\\s*["']${escaped}["'][^>]*>`,
    'i'
  );
  const m2 = re2.exec(html);
  if (m2?.[1]) return decodeHtmlEntities(m2[1]).trim() || null;
  return null;
}

function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m?.[1]) return null;
  return decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim() || null;
}

function resolveSafeImageUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const resolved = new URL(raw.trim(), baseUrl).toString();
    return isSafeExternalUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function isMobileLinkStubTitle(
  title: string | null | undefined,
  url: string | null | undefined
): boolean {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) return true;
  if (!url) return false;
  if (cleanTitle === url.trim()) return true;
  if (/^https?:\/\//i.test(cleanTitle)) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    const norm = cleanTitle.replace(/^www\./i, '').toLowerCase();
    if (norm === host) return true;
    const stubTitles = new Set([
      tm('store.linkTitle', undefined, 'ru').toLowerCase(),
      tm('store.linkTitle', undefined, 'en').toLowerCase(),
      tm('store.newItemTitle', undefined, 'ru').toLowerCase(),
      tm('store.newItemTitle', undefined, 'en').toLowerCase(),
      tm('share.linkFallbackTitle', undefined, 'ru').toLowerCase(),
      tm('share.linkFallbackTitle', undefined, 'en').toLowerCase(),
    ]);
    if (stubTitles.has(norm)) {
      return true;
    }
    if (norm === 'x' || norm === 'twitter' || norm === 'telegram' || norm === 'instagram') {
      return true;
    }
    if (norm.startsWith(`${host}/`)) return true;
  } catch {
    // ignore
  }
  return false;
}

export function isMobileLinkStubBody(
  body: string | null | undefined,
  url: string | null | undefined
): boolean {
  const cleanBody = (body || '').trim();
  if (!cleanBody) return true;
  if (!url) return false;
  const normalize = (s: string) => s.trim().replace(/\/+$/, '').toLowerCase();
  return normalize(cleanBody) === normalize(url);
}

export function classifyMobilePrivateTelegramUrl(
  rawUrl: string,
  locale: AppLocale = 'ru'
): MobileUnfurlResult | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 't.me' && host !== 'telegram.me' && host !== 'telegram.dog') {
    return null;
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const isPrivatePost = /^\/c\/\d+(?:\/\d+)?(?:\/\d+)?$/i.test(cleanPath);
  const isInvite = /^\/\+[A-Za-z0-9_-]+$/i.test(cleanPath) || /^\/joinchat\/[A-Za-z0-9_-]+$/i.test(cleanPath);
  if (!isPrivatePost && !isInvite) return null;

  const title = isInvite
    ? tm('link.privateTelegramInviteTitle', undefined, locale)
    : tm('link.privateTelegramTitle', undefined, locale);
  const description = isInvite
    ? tm('link.privateTelegramInviteDesc', undefined, locale)
    : tm('link.privateTelegramDesc', undefined, locale);

  return {
    title,
    description,
    summary: description,
    body: description,
    ogImageUrl: null,
    domain: 't.me',
    platform: 'telegram',
    canonicalUrl: parsed.toString(),
    linkAccess: 'private',
    hasVideo: false,
    mediaMetaPatch: {
      linkAccess: 'private',
      hasVideo: false,
    },
  };
}

function parseTwitterStatusUrl(rawUrl: string): { user: string; id: string } | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^(?:www\.|mobile\.)/i, '').toLowerCase();
    if (
      host !== 'x.com' &&
      host !== 'twitter.com' &&
      host !== 'fxtwitter.com' &&
      host !== 'vxtwitter.com' &&
      host !== 'fixupx.com' &&
      host !== 'fixvx.com'
    ) {
      return null;
    }
    const m = /^\/([^/]+)\/status(?:es)?\/(\d+)/i.exec(u.pathname);
    if (!m?.[1] || !m[2]) return null;
    return { user: m[1], id: m[2] };
  } catch {
    return null;
  }
}

async function unfurlMobileX(
  rawUrl: string,
  user: string,
  id: string,
  locale: AppLocale,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const canonicalUrl = `https://x.com/${user}/status/${id}`;

  // Tier 1: FxTwitter JSON API (supports X Articles, quoted tweets, media.all)
  const fx = await fetchText({
    url: `https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${id}`,
    accept: 'application/json',
    timeoutMs: 4500,
  });
  if (fx.ok && fx.body.trim().startsWith('{')) {
    try {
      const data = JSON.parse(fx.body) as {
        tweet?: {
          text?: string;
          author?: { name?: string; screen_name?: string };
          article?: {
            title?: string;
            preview_text?: string;
            cover_media?: { media_info?: { original_img_url?: string } };
          };
          quote?: { text?: string; author?: { name?: string; screen_name?: string } };
          media?: {
            photos?: Array<{ url?: string }>;
            videos?: Array<{ url?: string; thumbnail_url?: string }>;
            all?: Array<{ type?: string; url?: string; thumbnail_url?: string }>;
          };
        };
      };
      const tw = data.tweet;
      if (tw) {
        const handle = tw.author?.screen_name || user;
        const authorName = tw.author?.name || `@${handle}`;
        const articleTitle = tw.article?.title?.trim() || '';
        const articleText = tw.article?.preview_text?.trim() || '';
        const tweetText = decodeHtmlEntities(tw.text || '').trim();
        const quoteText = tw.quote?.text
          ? `\n\n> @${tw.quote.author?.screen_name || ''}: ${decodeHtmlEntities(tw.quote.text).trim()}`
          : '';
        const fullBody = [articleText || tweetText, quoteText].filter(Boolean).join('').trim();

        const photos = (tw.media?.photos || [])
          .map((p) => p.url)
          .filter((u): u is string => Boolean(u && isSafeExternalUrl(u)));
        const videos = tw.media?.videos || [];
        const allMedia = tw.media?.all || [];
        const hasVideo =
          videos.length > 0 || allMedia.some((m) => m.type === 'video' || m.type === 'gif');
        const videoThumb = videos[0]?.thumbnail_url || allMedia.find((m) => m.thumbnail_url)?.thumbnail_url || null;
        const coverImg = tw.article?.cover_media?.media_info?.original_img_url || null;
        const ogImageUrl = resolveSafeImageUrl(photos[0] || coverImg || videoThumb, canonicalUrl);
        const videoUrl =
          videos[0]?.url && isSafeExternalUrl(videos[0].url) ? videos[0].url : undefined;

        const baseTitle = articleTitle
          ? `${authorName}: ${articleTitle}`
          : fullBody
            ? `${authorName} (@${handle}): ${truncateAtWordBoundary(fullBody.split('\n')[0] || fullBody, 72)}`
            : tm('link.xPostFallback', { author: `@${handle}` }, locale);

        return {
          title: cleanBrokenTextArtifacts(baseTitle, true),
          description: truncateAtWordBoundary(fullBody || baseTitle, 220),
          summary: truncateAtWordBoundary(fullBody || baseTitle, 220),
          body: fullBody || canonicalUrl,
          ogImageUrl,
          domain: 'x.com',
          platform: 'x',
          canonicalUrl,
          linkAccess: 'public',
          hasVideo,
          mediaMetaPatch: {
            forwardAuthor: `@${handle}`,
            linkAccess: 'public',
            hasVideo,
            ...(videoUrl ? { videoUrl } : {}),
          },
        };
      }
    } catch {
      // fall through
    }
  }

  // Tier 2: Twitter Syndication API
  const syn = await fetchText({
    url: `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&lang=en&token=1`,
    accept: 'application/json',
    timeoutMs: 4200,
  });
  if (syn.ok && syn.body.trim().startsWith('{')) {
    try {
      const data = JSON.parse(syn.body) as {
        text?: string;
        user?: { name?: string; screen_name?: string };
        photos?: Array<{ url?: string }>;
        mediaDetails?: Array<{ type?: string; media_url_https?: string }>;
        video?: { poster?: string; variants?: Array<{ src?: string; type?: string }> };
      };
      if (data.text || data.user) {
        const handle = data.user?.screen_name || user;
        const authorName = data.user?.name || `@${handle}`;
        const text = decodeHtmlEntities(data.text || '').trim();
        const photoUrl =
          data.photos?.[0]?.url ||
          data.mediaDetails?.find((m) => m.media_url_https)?.media_url_https ||
          data.video?.poster ||
          null;
        const hasVideo =
          Boolean(data.video) ||
          Boolean(data.mediaDetails?.some((m) => m.type === 'video' || m.type === 'animated_gif'));
        const mp4 = data.video?.variants?.find((v) => v.type?.includes('mp4') && v.src)?.src;
        const title = text
          ? `${authorName} (@${handle}): ${truncateAtWordBoundary(text.split('\n')[0] || text, 72)}`
          : tm('link.xPostFallback', { author: `@${handle}` }, locale);

        return {
          title: cleanBrokenTextArtifacts(title, true),
          description: truncateAtWordBoundary(text || title, 220),
          summary: truncateAtWordBoundary(text || title, 220),
          body: text || canonicalUrl,
          ogImageUrl: resolveSafeImageUrl(photoUrl, canonicalUrl),
          domain: 'x.com',
          platform: 'x',
          canonicalUrl,
          linkAccess: 'public',
          hasVideo,
          mediaMetaPatch: {
            forwardAuthor: `@${handle}`,
            linkAccess: 'public',
            hasVideo,
            ...(mp4 && isSafeExternalUrl(mp4) ? { videoUrl: mp4 } : {}),
          },
        };
      }
    } catch {
      // fall through
    }
  }

  // Tier 3: VxTwitter JSON API
  const vx = await fetchText({
    url: `https://api.vxtwitter.com/${encodeURIComponent(user)}/status/${id}`,
    accept: 'application/json',
    timeoutMs: 4200,
  });
  if (vx.ok && vx.body.trim().startsWith('{')) {
    try {
      const data = JSON.parse(vx.body) as {
        text?: string;
        user_name?: string;
        user_screen_name?: string;
        media_extended?: Array<{ type?: string; url?: string; thumbnail_url?: string }>;
      };
      if (data.text || data.user_screen_name) {
        const handle = data.user_screen_name || user;
        const authorName = data.user_name || `@${handle}`;
        const text = decodeHtmlEntities(data.text || '').trim();
        const media = data.media_extended || [];
        const hasVideo = media.some((m) => m.type === 'video' || m.type === 'gif');
        const thumb = media.find((m) => m.type === 'image')?.url || media[0]?.thumbnail_url || null;
        const title = text
          ? `${authorName} (@${handle}): ${truncateAtWordBoundary(text.split('\n')[0] || text, 72)}`
          : tm('link.xPostFallback', { author: `@${handle}` }, locale);

        return {
          title: cleanBrokenTextArtifacts(title, true),
          description: truncateAtWordBoundary(text || title, 220),
          summary: truncateAtWordBoundary(text || title, 220),
          body: text || canonicalUrl,
          ogImageUrl: resolveSafeImageUrl(thumb, canonicalUrl),
          domain: 'x.com',
          platform: 'x',
          canonicalUrl,
          linkAccess: 'public',
          hasVideo,
          mediaMetaPatch: {
            forwardAuthor: `@${handle}`,
            linkAccess: 'public',
            hasVideo,
          },
        };
      }
    } catch {
      // fall through
    }
  }

  // Tier 4: Official Twitter oEmbed
  const oe = await fetchText({
    url: `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=true`,
    accept: 'application/json',
    timeoutMs: 4000,
  });
  if (oe.ok && oe.body.trim().startsWith('{')) {
    try {
      const data = JSON.parse(oe.body) as { author_name?: string; html?: string };
      const text = data.html ? stripTags(data.html) : '';
      if (text || data.author_name) {
        const authorName = data.author_name || `@${user}`;
        const title = text
          ? `${authorName}: ${truncateAtWordBoundary(text.split('\n')[0] || text, 72)}`
          : tm('link.xPostFallback', { author: authorName }, locale);
        return {
          title: cleanBrokenTextArtifacts(title, true),
          description: truncateAtWordBoundary(text || title, 220),
          summary: truncateAtWordBoundary(text || title, 220),
          body: text || canonicalUrl,
          ogImageUrl: null,
          domain: 'x.com',
          platform: 'x',
          canonicalUrl,
          linkAccess: 'public',
          hasVideo: false,
          mediaMetaPatch: {
            forwardAuthor: `@${user}`,
            linkAccess: 'public',
            hasVideo: false,
          },
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function parseTelegramHtmlSimple(
  html: string,
  channel: string,
  canonicalUrl: string
): MobileUnfurlResult | null {
  const authorMatch =
    /class="tgme_widget_message_author_name"[^>]*>([\s\S]*?)<\/(?:a|span)>/i.exec(html) ||
    /class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const channelTitle = authorMatch?.[1] ? stripTags(authorMatch[1]) : `@${channel}`;

  const msgMatch = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const postText = msgMatch?.[1] ? stripTags(msgMatch[1]) : '';

  const bgImgMatch =
    /tgme_widget_message_(?:photo_wrap|video_thumb)[^>]*style="[^"]*background-image:url\(['"]?([^'")]+)['"]?\)/i.exec(
      html
    );
  const ogImg = bgImgMatch?.[1] || extractMetaContent(html, 'property', 'og:image');
  const ogTitle = extractMetaContent(html, 'property', 'og:title');
  const ogDesc = extractMetaContent(html, 'property', 'og:description');

  const bodyText = postText || ogDesc || '';
  if (!bodyText && (!ogTitle || /^telegram/i.test(ogTitle))) {
    return null;
  }

  const hasVideo =
    /tgme_widget_message_video_player|tgme_widget_message_roundvideo|video_play_btn|<video\b/i.test(
      html
    );

  const firstLine = bodyText.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const title = firstLine
    ? `${channelTitle}: ${truncateAtWordBoundary(firstLine, 70)}`
    : ogTitle && !/^telegram/i.test(ogTitle)
      ? ogTitle
      : channelTitle;

  return {
    title: cleanBrokenTextArtifacts(title, true),
    description: truncateAtWordBoundary(bodyText || title, 220),
    summary: truncateAtWordBoundary(bodyText || title, 220),
    body: bodyText || canonicalUrl,
    ogImageUrl: resolveSafeImageUrl(ogImg, canonicalUrl),
    domain: 't.me',
    platform: 'telegram',
    canonicalUrl,
    linkAccess: 'public',
    hasVideo,
    mediaMetaPatch: {
      forwardAuthor: channelTitle,
      linkAccess: 'public',
      hasVideo,
    },
  };
}

function extractTelegramFeedPostSlice(html: string, channel: string, msgId: string): string | null {
  const postAttrRe = new RegExp(`data-post\\s*=\\s*["']${escapeRegExp(channel)}\\/${escapeRegExp(msgId)}["']`, 'i');
  const match = postAttrRe.exec(html);
  if (!match) return null;
  const tagStart = html.lastIndexOf('<div', match.index);
  const startIdx = tagStart >= 0 ? tagStart : match.index;
  const nextWrap = html.indexOf('tgme_widget_message_wrap', match.index + match[0].length);
  const nextDataPost = html.slice(match.index + match[0].length).search(/data-post\s*=\s*["']/i);
  let endIdx = html.length;
  if (nextWrap !== -1) endIdx = Math.min(endIdx, nextWrap);
  if (nextDataPost !== -1) endIdx = Math.min(endIdx, match.index + match[0].length + nextDataPost);
  return html.slice(startIdx, endIdx);
}

async function unfurlMobileTelegramPublic(
  rawUrl: string,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const u = new URL(rawUrl);
  const match = /^\/(?:s\/)?([A-Za-z0-9_]{3,})\/(\d+)/.exec(u.pathname);
  if (!match?.[1] || !match[2]) return null;
  const channel = match[1];
  const msgId = match[2];
  const canonicalUrl = `https://t.me/${channel}/${msgId}`;

  // Tier 1: Telegram embed widget
  const embedRes = await fetchText({
    url: `https://t.me/${channel}/${msgId}?embed=1&mode=tme`,
    accept: 'text/html',
    timeoutMs: 4200,
  });
  if (embedRes.ok && embedRes.body) {
    const parsed = parseTelegramHtmlSimple(embedRes.body, channel, canonicalUrl);
    if (parsed) return parsed;
  }

  // Tier 2: Public channel feed (requires exact data-post="<channel>/<msgId>" match)
  const feedRes = await fetchText({
    url: `https://t.me/s/${channel}/${msgId}`,
    accept: 'text/html',
    timeoutMs: 4200,
  });
  if (feedRes.ok && feedRes.body) {
    const postSlice = extractTelegramFeedPostSlice(feedRes.body, channel, msgId);
    if (postSlice) {
      const parsed = parseTelegramHtmlSimple(postSlice, channel, canonicalUrl);
      if (parsed) return parsed;
    }
  }

  // Tier 3: Plain OG page fallback
  const plainRes = await fetchText({
    url: canonicalUrl,
    accept: 'text/html',
    timeoutMs: 4200,
  });
  if (plainRes.ok && plainRes.body) {
    const parsed = parseTelegramHtmlSimple(plainRes.body, channel, canonicalUrl);
    if (parsed) return parsed;
  }

  return null;
}

async function unfurlMobileYouTube(
  rawUrl: string,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^(?:www\.|m\.)/i, '').toLowerCase();
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = u.pathname.replace(/^\/+/, '').split('/')[0] || null;
  } else if (host === 'youtube.com') {
    videoId = u.searchParams.get('v');
    if (!videoId) {
      const m = /^\/(?:shorts|embed|live)\/([^/?]+)/i.exec(u.pathname);
      if (m?.[1]) videoId = m[1];
    }
  }
  if (!videoId) return null;
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const res = await fetchText({
    url: `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
    accept: 'application/json',
    timeoutMs: 4000,
  });
  if (res.ok && res.body.trim().startsWith('{')) {
    try {
      const data = JSON.parse(res.body) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      const title = cleanBrokenTextArtifacts(data.title || '', true);
      if (title) {
        const desc = data.author_name ? `${data.author_name} · YouTube` : 'YouTube';
        return {
          title,
          description: desc,
          summary: desc,
          body: data.author_name ? `${title}\n${data.author_name}` : title,
          ogImageUrl: resolveSafeImageUrl(data.thumbnail_url || thumbUrl, canonicalUrl),
          domain: 'youtube.com',
          platform: 'youtube',
          canonicalUrl,
          linkAccess: 'public',
          hasVideo: true,
          mediaMetaPatch: {
            forwardAuthor: data.author_name,
            linkAccess: 'public',
            hasVideo: true,
          },
        };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

async function unfurlMobileGitHub(
  rawUrl: string,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const u = new URL(rawUrl);
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  // Only use GitHub repo REST API for repo-root URLs (`github.com/owner/repo`);
  // deeper paths (`/issues/123`, `/pull/45`, `/blob/...`) fall through to generic OG.
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;

  const res = await fetchText({
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    accept: 'application/vnd.github+json',
    timeoutMs: 4000,
  });
  if (!res.ok || !res.body.trim().startsWith('{')) return null;
  try {
    const data = JSON.parse(res.body) as {
      full_name?: string;
      description?: string;
      stargazers_count?: number;
      language?: string;
    };
    const title = data.full_name || `${owner}/${repo}`;
    const desc = (data.description || '').trim();
    const meta = [data.language, data.stargazers_count ? `★ ${data.stargazers_count}` : null]
      .filter(Boolean)
      .join(' · ');
    const summary = [desc, meta].filter(Boolean).join(' — ') || title;
    return {
      title,
      description: summary,
      summary: truncateAtWordBoundary(summary, 220),
      body: summary,
      ogImageUrl: `https://opengraph.githubassets.com/1/${owner}/${repo}`,
      domain: 'github.com',
      platform: 'github',
      canonicalUrl: u.toString(),
      linkAccess: 'public',
      hasVideo: false,
      mediaMetaPatch: {
        forwardAuthor: owner,
        linkAccess: 'public',
        hasVideo: false,
      },
    };
  } catch {
    return null;
  }
}

async function unfurlMobileInstagram(
  rawUrl: string,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const u = new URL(rawUrl);
  const isReelOrTv = /\/(?:reel|reels|tv)\//i.test(u.pathname);
  const isLoginPath = (targetUrl?: string | null) => {
    if (!targetUrl) return false;
    try {
      return /\/accounts\/login|\/login(?:\/|$)/i.test(new URL(targetUrl).pathname);
    } catch {
      return false;
    }
  };
  const isGenericIgTitle = (t?: string | null) =>
    !t ||
    /^(?:instagram|log\s*in\s*[•·-]\s*instagram|войти\s*[•·-]\s*instagram|войдите\s+в\s+instagram)$/i.test(
      t.trim()
    );
  const isExplicitIgLoginTitle = (t?: string | null) =>
    Boolean(
      t &&
        /^(?:log\s*in\s*[•·-]\s*instagram|войти\s*[•·-]\s*instagram|войдите\s+в\s+instagram)$/i.test(
          t.trim()
        )
    );
  const isIgLoginDesc = (d?: string | null) =>
    Boolean(
      d &&
        /create an account or log in to instagram|sign up for instagram|log in to instagram|войдите в instagram|войти\s*[•·-]\s*instagram|создайте аккаунт или войдите в instagram/i.test(
          d
        )
    );

  const res = await fetchText({
    url: rawUrl,
    accept: 'text/html,application/xhtml+xml',
    userAgent: CRAWLER_UA,
    timeoutMs: 4500,
  });
  if (res.ok && res.body && !isLoginPath(res.finalUrl)) {
    const ogTitle =
      extractMetaContent(res.body, 'property', 'og:title') ||
      extractHtmlTitle(res.body) ||
      '';
    const ogDesc =
      extractMetaContent(res.body, 'property', 'og:description') ||
      extractMetaContent(res.body, 'name', 'description') ||
      '';
    const ogImg = extractMetaContent(res.body, 'property', 'og:image');
    const hitLoginWall =
      isExplicitIgLoginTitle(ogTitle) || (isGenericIgTitle(ogTitle) && isIgLoginDesc(ogDesc));
    if (!hitLoginWall) {
      const cleaned = cleanInstagramText(ogTitle, ogDesc);
      if (cleaned.cleanTitle || cleaned.caption || (cleaned.author && ogImg)) {
        const title = cleanBrokenTextArtifacts(cleaned.cleanTitle || 'Instagram', true);
        const body = cleaned.caption || title;
        return {
          title,
          description: truncateAtWordBoundary(body, 220),
          summary: truncateAtWordBoundary(body, 220),
          body,
          ogImageUrl: resolveSafeImageUrl(ogImg, rawUrl),
          domain: 'instagram.com',
          platform: 'instagram',
          canonicalUrl: u.toString(),
          linkAccess: 'public',
          hasVideo: isReelOrTv,
          mediaMetaPatch: {
            ...(cleaned.author ? { forwardAuthor: `@${cleaned.author}` } : {}),
            linkAccess: 'public',
            hasVideo: isReelOrTv,
          },
        };
      }
    }
  }

  // Fallback to Instagram captioned embed when crawler OG hits login redirect/wall
  const igPostMatch = /^\/(reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i.exec(u.pathname);
  if (igPostMatch) {
    const kindNorm =
      igPostMatch[1]!.toLowerCase() === 'reels' ? 'reel' : igPostMatch[1]!.toLowerCase();
    const embedUrl = `https://www.instagram.com/${kindNorm}/${igPostMatch[2]}/embed/captioned/`;
    const embedRes = await fetchText({ url: embedUrl, accept: 'text/html', timeoutMs: 4500 });
    if (embedRes.ok && embedRes.body && !isLoginPath(embedRes.finalUrl)) {
      const capMatch = /class="[^"]*Caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(embedRes.body);
      const userMatch = /class="[^"]*UsernameText[^"]*"[^>]*>([\s\S]*?)<\/(?:span|a)>/i.exec(embedRes.body);
      const imgMatch =
        /class="[^"]*EmbeddedMediaImage[^"]*"[^>]*src=["']([^"']+)["']/i.exec(embedRes.body) ||
        /src=["']([^"']+)["'][^>]*class="[^"]*EmbeddedMediaImage[^"]*"/i.exec(embedRes.body);
      const userText = userMatch?.[1] ? stripTags(userMatch[1]).replace(/^@/, '') : '';
      const rawCap = capMatch?.[1] ? stripTags(capMatch[1]) : '';
      const cleanCap = rawCap
        .replace(userText ? new RegExp(`^${escapeRegExp(userText)}\\s+`, 'i') : /^$/, '')
        .replace(/\s*view all \d+ comments.*$/i, '')
        .trim();
      const embedImg = resolveSafeImageUrl(
        imgMatch?.[1] || extractMetaContent(embedRes.body, 'property', 'og:image'),
        embedUrl
      );
      if (cleanCap || userText || embedImg) {
        const title = cleanCap
          ? cleanBrokenTextArtifacts(truncateAtWordBoundary(cleanCap, 80), true)
          : userText
            ? `@${userText} · Instagram`
            : 'Instagram';
        return {
          title,
          description: truncateAtWordBoundary(cleanCap || title, 220),
          summary: truncateAtWordBoundary(cleanCap || title, 220),
          body: cleanCap || title,
          ogImageUrl: embedImg,
          domain: 'instagram.com',
          platform: 'instagram',
          canonicalUrl: `https://www.instagram.com/${kindNorm}/${igPostMatch[2]}/`,
          linkAccess: 'public',
          hasVideo: isReelOrTv,
          mediaMetaPatch: {
            ...(userText ? { forwardAuthor: `@${userText}` } : {}),
            linkAccess: 'public',
            hasVideo: isReelOrTv,
          },
        };
      }
    }
  }

  return null;
}

async function unfurlMobileGeneric(
  rawUrl: string,
  fetchText: MobileFetchTextFn
): Promise<MobileUnfurlResult | null> {
  const res = await fetchText({ url: rawUrl, accept: 'text/html', timeoutMs: 4200 });
  if (!res.ok || !res.body) return null;

  const u = new URL(res.finalUrl || rawUrl);
  const domain = u.hostname.replace(/^www\./i, '');
  const rawTitle =
    extractMetaContent(res.body, 'property', 'og:title') ||
    extractMetaContent(res.body, 'name', 'twitter:title') ||
    extractHtmlTitle(res.body) ||
    '';
  const rawDesc =
    extractMetaContent(res.body, 'property', 'og:description') ||
    extractMetaContent(res.body, 'name', 'twitter:description') ||
    extractMetaContent(res.body, 'name', 'description') ||
    '';
  const rawImg =
    extractMetaContent(res.body, 'property', 'og:image') ||
    extractMetaContent(res.body, 'name', 'twitter:image');

  const title = cleanBrokenTextArtifacts(rawTitle, true);
  const desc = cleanBrokenTextArtifacts(rawDesc, true);
  if (!title && !desc && !rawImg) return null;

  return {
    title: title || domain,
    description: truncateAtWordBoundary(desc || title || domain, 220),
    summary: truncateAtWordBoundary(desc || title || domain, 220),
    body: desc || title || rawUrl,
    ogImageUrl: resolveSafeImageUrl(rawImg, res.finalUrl || rawUrl),
    domain,
    platform: null,
    canonicalUrl: res.finalUrl || rawUrl,
    linkAccess: 'public',
    hasVideo: false,
    mediaMetaPatch: {
      linkAccess: 'public',
      hasVideo: false,
    },
  };
}

export async function unfurlMobileLink(
  rawUrl: string,
  locale: AppLocale = 'ru',
  fetchText: MobileFetchTextFn = (opts) => mobileBridge.fetchExternalText(opts)
): Promise<MobileUnfurlResult | null> {
  const cleanUrl = (rawUrl || '').trim();
  if (!isSafeExternalUrl(cleanUrl)) return null;

  const privateTg = classifyMobilePrivateTelegramUrl(cleanUrl, locale);
  if (privateTg) return privateTg;

  const tw = parseTwitterStatusUrl(cleanUrl);
  if (tw) {
    return unfurlMobileX(cleanUrl, tw.user, tw.id, locale, fetchText);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cleanUrl);
  } catch {
    return null;
  }
  const host = parsedUrl.hostname.replace(/^(?:www\.|m\.)/i, '').toLowerCase();

  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
    if (/^\/(?:s\/)?([A-Za-z0-9_]{3,})\/(\d+)(?:\/|$)/.test(parsedUrl.pathname)) {
      return unfurlMobileTelegramPublic(cleanUrl, fetchText);
    }
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    const yt = await unfurlMobileYouTube(cleanUrl, fetchText);
    if (yt) return yt;
  }
  if (host === 'github.com') {
    const gh = await unfurlMobileGitHub(cleanUrl, fetchText);
    if (gh) return gh;
  }
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    return unfurlMobileInstagram(cleanUrl, fetchText);
  }

  return unfurlMobileGeneric(cleanUrl, fetchText);
}
