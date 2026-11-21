import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom/worker';
import { decodeHtmlEntities, truncateAtWordBoundary } from '@shared/html-entities';
import type { ExtractedAction } from '@shared/types';

export type UrlSanitizer = (raw: string | null | undefined, base?: URL) => string | null;

// Structural DOM node shape compatible with linkedom & standard DOM without cross-realm instanceof pitfalls.
export interface DomNodeLike {
  nodeType: number;
  nodeName?: string;
  tagName?: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNodeLike>;
  parentNode?: DomNodeLike | null;
  remove?: () => void;
  getAttribute?: (name: string) => string | null;
  querySelector?: (sel: string) => DomNodeLike | null;
  querySelectorAll?: (sel: string) => ArrayLike<DomNodeLike>;
  closest?: (sel: string) => DomNodeLike | null;
  cloneNode?: (deep?: boolean) => DomNodeLike;
}

export interface DocumentMeta {
  title: string | null;
  ogTitle: string | null;
  titleTag: string | null;
  description: string | null;
  ogImageUrl: string | null;
  fallbackCoverUrl: string | null;
  galleryUrls: string[];
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
  canonicalUrl: string | null;
  ogType: string | null;
  jsonLdArticleBody: string | null;
}

export interface DomMarkdownResult {
  markdown: string;
  firstBoldTitle: string | null;
  links: ExtractedAction[];
  hasCodeBlocks: boolean;
}

export interface ReadablePageResult {
  pageKind: 'article' | 'showcase';
  title: string | null;
  description: string | null;
  bodyMarkdown: string;
  ogImageUrl: string | null;
  galleryUrls: string[];
  author: string | null;
  publishedAt: string | null;
  canonicalUrl: string | null;
  extractedLinks: ExtractedAction[];
}

const DEFAULT_URL_SANITIZER: UrlSanitizer = (raw, base) => {
  if (!raw) return null;
  let candidate = raw.trim();
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  try {
    const u = base ? new URL(candidate, base) : new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
};

function cleanInlineWhitespace(input: string): string {
  return input
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMetaText(input: string | null | undefined): string {
  if (!input) return '';
  return cleanInlineWhitespace(decodeHtmlEntities(input));
}

/**
 * Safely parses full HTML documents OR partial fragments with `linkedom`,
 * guaranteeing `document.documentElement`, `document.head`, and `document.body` never throw.
 */
export function parseHtmlDocument(rawHtml: string): Document {
  const input = (rawHtml || '').trim();
  if (!input) {
    return parseHTML('<!doctype html><html><head></head><body></body></html>').document as unknown as Document;
  }
  let normalized = input;
  if (!/<html\b/i.test(input)) {
    if (/<(?:head|body)\b/i.test(input)) {
      normalized = `<!doctype html><html>${input}</html>`;
    } else {
      normalized = `<!doctype html><html><head></head><body>${input}</body></html>`;
    }
  }
  const { document } = parseHTML(normalized);
  return document as unknown as Document;
}

export function parseHtmlFragment(fragmentHtml: string): { document: Document; body: DomNodeLike } {
  const wrapped = `<!doctype html><html><head></head><body>${fragmentHtml || ''}</body></html>`;
  const { document } = parseHTML(wrapped);
  const body = (document.body ?? document.documentElement) as unknown as DomNodeLike;
  return { document: document as unknown as Document, body };
}

function getTagName(node: DomNodeLike): string {
  return (node.tagName || node.nodeName || '').toLowerCase();
}

function getAttr(node: DomNodeLike, name: string): string {
  return node.getAttribute?.(name) ?? '';
}

function isHiddenStyle(style: string): boolean {
  if (!style) return false;
  const s = style.toLowerCase();
  return (
    /display\s*:\s*none\b/.test(s) ||
    /visibility\s*:\s*hidden\b/.test(s) ||
    /opacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*$)/.test(s) ||
    /max-height\s*:\s*0(?:px)?(?:\s*;|\s*$)/.test(s) ||
    /font-size\s*:\s*0(?:px)?(?:\s*;|\s*$)/.test(s) ||
    /mso-hide\s*:\s*all\b/.test(s)
  );
}

/**
 * Picks the highest-resolution non-SVG/non-data URL from an HTML `srcset` / `data-srcset` attribute.
 */
export function pickBestSrcsetUrl(
  rawSrcset: string | null | undefined,
  baseUrl?: URL,
  sanitizeUrl: UrlSanitizer = DEFAULT_URL_SANITIZER
): string | null {
  if (!rawSrcset || !rawSrcset.trim()) return null;
  const candidates: Array<{ url: string; score: number }> = [];
  // Split entries on commas followed by whitespace and a URL-like token (safe against commas inside CDN resize paths)
  const parts = rawSrcset.split(/,\s+(?=(?:https?:|\/\/|\/|[^,\s]+\.(?:png|jpe?g|webp|avif|gif)))/i);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const rawUrl = tokens[0] || '';
    if (!rawUrl || rawUrl.startsWith('data:')) continue;
    const safe = sanitizeUrl(rawUrl, baseUrl);
    if (!safe) continue;
    if (/\.(?:svg|ico)(?:\?|$)/i.test(safe)) continue;
    const desc = tokens[1] || '';
    let score = 1;
    const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(desc);
    const wMatch = /^(\d+)w$/i.exec(desc);
    if (xMatch) {
      score = Number(xMatch[1]) * 1000;
    } else if (wMatch) {
      const w = Number(wMatch[1]);
      // Prefer crisp medium-high previews (~800–1600px) without chasing massive 4K originals
      score = w <= 1600 ? w : 1600 - Math.min(400, (w - 1600) / 10);
    }
    candidates.push({ url: safe, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url ?? null;
}

const SKIP_IMAGE_HINT_RE =
  /(?:avatar|thumb_user|user[_-]?pic|profile[_-]?img|favicon|logo|icon|badge|emoji|spinner|loader|spacer|pixel|beacon|tracking|1x1|blank\.gif|placeholder)/i;

function isLikelyAvatarOrIconImg(img: DomNodeLike, resolvedUrl: string): boolean {
  const wAttr = Number(getAttr(img, 'width') || 0);
  const hAttr = Number(getAttr(img, 'height') || 0);
  if ((wAttr > 0 && wAttr <= 120) || (hAttr > 0 && hAttr <= 120)) return true;
  if (/\.(?:svg|ico)(?:\?|$)/i.test(resolvedUrl)) return true;
  const cls = getAttr(img, 'class');
  const alt = getAttr(img, 'alt');
  const id = getAttr(img, 'id');
  const combined = `${resolvedUrl} ${cls} ${id}`;
  if (SKIP_IMAGE_HINT_RE.test(combined)) return true;
  if (/\b(?:logo|icon|avatar)\b/i.test(alt) && wAttr <= 200) return true;
  return false;
}

function extractBestImgUrl(
  img: DomNodeLike,
  baseUrl?: URL,
  sanitizeUrl: UrlSanitizer = DEFAULT_URL_SANITIZER
): string | null {
  const fromDataSrcset = pickBestSrcsetUrl(getAttr(img, 'data-srcset'), baseUrl, sanitizeUrl);
  if (fromDataSrcset) return fromDataSrcset;
  const fromSrcset = pickBestSrcsetUrl(getAttr(img, 'srcset'), baseUrl, sanitizeUrl);
  if (fromSrcset) return fromSrcset;

  for (const attrName of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const raw = getAttr(img, attrName).trim();
    if (!raw || raw.startsWith('data:')) continue;
    const safe = sanitizeUrl(raw, baseUrl);
    if (safe && !/\.(?:svg|ico)(?:\?|$)/i.test(safe)) return safe;
  }
  return null;
}

function extractJsonLdSignals(
  doc: Document,
  baseUrl?: URL,
  sanitizeUrl: UrlSanitizer = DEFAULT_URL_SANITIZER
): {
  articleBody: string | null;
  imageUrl: string | null;
  author: string | null;
  publishedAt: string | null;
} {
  let articleBody: string | null = null;
  let imageUrl: string | null = null;
  let author: string | null = null;
  let publishedAt: string | null = null;

  const editorialTypes = new Set([
    'article',
    'newsarticle',
    'blogposting',
    'techarticle',
    'report',
    'scholarlyarticle',
  ]);

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) {
      visit(obj['@graph']);
    }
    const rawType = obj['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.toLowerCase());
    const isEditorial = types.some((t) => editorialTypes.has(t));

    if (isEditorial && !articleBody && typeof obj.articleBody === 'string') {
      const cleaned = decodeHtmlEntities(obj.articleBody).replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned.length >= 260) {
        articleBody = cleaned.slice(0, 8000);
      }
    }

    if (!imageUrl && obj.image) {
      const imgField = obj.image;
      let candidate: string | null = null;
      if (typeof imgField === 'string') candidate = imgField;
      else if (Array.isArray(imgField) && typeof imgField[0] === 'string') candidate = imgField[0];
      else if (imgField && typeof imgField === 'object') {
        const imgObj = imgField as Record<string, unknown>;
        if (typeof imgObj.url === 'string') candidate = imgObj.url;
      }
      const safe = sanitizeUrl(candidate, baseUrl);
      if (safe && !/\.(?:svg|ico)(?:\?|$)/i.test(safe)) {
        imageUrl = safe;
      }
    }

    if (!author && obj.author) {
      const a = obj.author;
      if (typeof a === 'string' && a.trim()) {
        author = normalizeMetaText(a);
      } else if (Array.isArray(a) && a[0] && typeof a[0] === 'object') {
        const name = (a[0] as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) author = normalizeMetaText(name);
      } else if (a && typeof a === 'object') {
        const name = (a as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) author = normalizeMetaText(name);
      }
    }

    if (!publishedAt && typeof obj.datePublished === 'string' && obj.datePublished.trim()) {
      publishedAt = obj.datePublished.trim();
    }
  };

  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = scripts[i]?.textContent?.trim();
    if (!raw) continue;
    try {
      visit(JSON.parse(raw));
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }

  return { articleBody, imageUrl, author, publishedAt };
}

/**
 * Extracts all OpenGraph / Twitter / standard HTML metadata and fallback hero cover images via real DOM.
 */
export function extractDocumentMeta(
  doc: Document,
  baseUrl?: URL,
  sanitizeUrl: UrlSanitizer = DEFAULT_URL_SANITIZER
): DocumentMeta {
  const metaMap = new Map<string, string>();
  const metas = doc.querySelectorAll('meta');
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i]!;
    const key = (m.getAttribute('property') || m.getAttribute('name') || '').trim().toLowerCase();
    const content = m.getAttribute('content');
    if (key && content && content.trim() && !metaMap.has(key)) {
      metaMap.set(key, normalizeMetaText(content));
    }
  }

  const getMeta = (...keys: string[]): string | null => {
    for (const k of keys) {
      const val = metaMap.get(k.toLowerCase());
      if (val) return val;
    }
    return null;
  };

  const ogTitle = getMeta('og:title', 'twitter:title');
  const titleTagRaw = doc.querySelector('title')?.textContent;
  const titleTag = titleTagRaw ? normalizeMetaText(titleTagRaw) : null;
  const title = ogTitle || titleTag || null;

  const description = getMeta('og:description', 'twitter:description', 'description');
  const siteName = getMeta('og:site_name', 'application-name');
  const ogType = getMeta('og:type')?.toLowerCase() ?? null;
  const metaAuthor = getMeta('author', 'article:author', 'twitter:creator');
  const metaPublishedAt = getMeta('article:published_time', 'og:published_time', 'publish-date', 'date');

  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const canonicalUrl = sanitizeUrl(canonicalHref, baseUrl);

  const jsonLd = extractJsonLdSignals(doc, baseUrl, sanitizeUrl);

  const rawOgImg = getMeta('og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src');
  let ogImageUrl = sanitizeUrl(rawOgImg, baseUrl);
  if (ogImageUrl && /\.(?:svg|ico)(?:\?|$)/i.test(ogImageUrl)) {
    ogImageUrl = null;
  }

  if (!ogImageUrl) {
    const linkImgHref = doc.querySelector('link[rel="image_src"]')?.getAttribute('href');
    const safeLinkImg = sanitizeUrl(linkImgHref, baseUrl);
    if (safeLinkImg && !/\.(?:svg|ico)(?:\?|$)/i.test(safeLinkImg)) {
      ogImageUrl = safeLinkImg;
    }
  }
  if (!ogImageUrl && jsonLd.imageUrl) {
    ogImageUrl = jsonLd.imageUrl;
  }

  // Fallback hero/showcase cover extraction from main content images (supports lazy data-srcset / srcset / data-src)
  const galleryUrls: string[] = [];
  if (ogImageUrl) galleryUrls.push(ogImageUrl);

  let fallbackCoverUrl: string | null = null;
  const imgScope =
    doc.querySelector('main, [role="main"], article') ??
    doc.body ??
    doc.documentElement;
  if (imgScope) {
    const imgs = imgScope.querySelectorAll('figure img, img');
    for (let i = 0; i < imgs.length && galleryUrls.length < 4; i++) {
      const img = imgs[i] as unknown as DomNodeLike;
      // Skip images inside header/nav/footer/aside
      if (img.closest?.('nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) {
        continue;
      }
      const candidate = extractBestImgUrl(img, baseUrl, sanitizeUrl);
      if (!candidate) continue;
      if (isLikelyAvatarOrIconImg(img, candidate)) continue;
      if (!fallbackCoverUrl) fallbackCoverUrl = candidate;
      if (!galleryUrls.includes(candidate)) {
        galleryUrls.push(candidate);
      }
    }
  }

  return {
    title,
    ogTitle,
    titleTag,
    description,
    ogImageUrl: ogImageUrl || fallbackCoverUrl,
    fallbackCoverUrl,
    galleryUrls,
    siteName,
    author: metaAuthor || jsonLd.author,
    publishedAt: metaPublishedAt || jsonLd.publishedAt,
    canonicalUrl,
    ogType,
    jsonLdArticleBody: jsonLd.articleBody,
  };
}

const BOILERPLATE_ATTR_RE =
  /(?:^|[\s_-])(?:cookie|cookies|consent|gdpr|onetrust|cmp|promo|promotion|alert-bar|announcement|banner-promo|top-bar|topbar|site-header|site-footer|navbar|nav-bar|nav-menu|mega-menu|megamenu|dropdown-menu|mobile-menu|breadcrumb|breadcrumbs|pagination|pager|sidebar|side-bar|filter-bar|filter-drawer|filters|searchable-filter|search-box|search-bar|search-modal|search-dropdown|newsletter|subscribe-box|social-links|share-buttons|share-bar|related-posts|recommended-posts|comment-form|comments-section|skip-link|sr-only|visually-hidden|example-header|copy-code|preheader)(?:$|[\s_-])/i;

const SOCIAL_HOST_RE =
  /(?:^|\.)(?:facebook\.com|fb\.com|tiktok\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|pinterest\.com|discord\.gg|discord\.com)$/i;

const ALWAYS_REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'template',
  'iframe',
  'object',
  'embed',
  'nav',
  'footer',
  'aside',
  'menu',
  'menuitem',
  'form',
  'dialog',
  'button',
  'input',
  'select',
  'textarea',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="complementary"]',
  '[role="menubar"]',
  '[role="menu"]',
  '[aria-hidden="true"]',
  '[hidden]',
].join(', ');

function measureLinkDensity(el: DomNodeLike): {
  totalChars: number;
  linkChars: number;
  linkCount: number;
  avgLinkLen: number;
  socialLinkCount: number;
  hasPromoUtm: boolean;
  hasLongProseParagraph: boolean;
} {
  const totalText = cleanInlineWhitespace(el.textContent || '');
  const totalChars = totalText.length;
  const anchors = el.querySelectorAll ? Array.from(el.querySelectorAll('a')) : [];
  let linkChars = 0;
  let socialLinkCount = 0;
  let hasPromoUtm = false;

  for (const a of anchors) {
    const t = cleanInlineWhitespace(a.textContent || '');
    linkChars += t.length;
    const href = getAttr(a, 'href').trim();
    if (/utm_source=alert|utm_campaign=promo|\/academy-plan\b/i.test(href)) {
      hasPromoUtm = true;
    }
    if (/^https?:\/\//i.test(href)) {
      try {
        const host = new URL(href).hostname.replace(/^www\./i, '').toLowerCase();
        if (SOCIAL_HOST_RE.test(host)) socialLinkCount++;
      } catch {
        // ignore invalid href
      }
    }
  }

  let hasLongProseParagraph = false;
  const paragraphs = el.querySelectorAll ? Array.from(el.querySelectorAll('p')) : [];
  for (const p of paragraphs) {
    const pt = cleanInlineWhitespace(p.textContent || '');
    if (pt.length >= 100) {
      const pAnchors = p.querySelectorAll ? Array.from(p.querySelectorAll('a')) : [];
      const pLinkChars = pAnchors.reduce((acc, a) => acc + cleanInlineWhitespace(a.textContent || '').length, 0);
      if (pLinkChars / Math.max(1, pt.length) < 0.5) {
        hasLongProseParagraph = true;
        break;
      }
    }
  }

  return {
    totalChars,
    linkChars,
    linkCount: anchors.length,
    avgLinkLen: anchors.length > 0 ? linkChars / anchors.length : 0,
    socialLinkCount,
    hasPromoUtm,
    hasLongProseParagraph,
  };
}

/**
 * Strips navigation, headers, footers, forms, popups, cookie/promo banners,
 * hidden elements, tracking pixels, and link-dense category/filter drawers from a DOM tree.
 */
export function stripBoilerplateFromDom(
  root: DomNodeLike,
  options: { preserveEmailLayout?: boolean } = {}
): void {
  const safeQueryAll = (sel: string): DomNodeLike[] => {
    try {
      return root.querySelectorAll ? Array.from(root.querySelectorAll(sel)) : [];
    } catch {
      return [];
    }
  };

  // 1. Remove unambiguous structural noise elements
  for (const el of safeQueryAll(ALWAYS_REMOVE_SELECTORS)) {
    el.remove?.();
  }

  // 2. Remove site-level <header> (keeping editorial <article><header> with <h1> unless link-heavy nav)
  for (const hdr of safeQueryAll('header')) {
    const insideArticle = Boolean(hdr.closest?.('article'));
    if (!insideArticle) {
      hdr.remove?.();
      continue;
    }
    const stats = measureLinkDensity(hdr);
    if (stats.linkCount >= 5 && stats.linkChars / Math.max(1, stats.totalChars) > 0.55) {
      hdr.remove?.();
    }
  }

  // 3. Remove hidden inline-style elements & tracking pixels
  for (const el of safeQueryAll('[style]')) {
    const tag = getTagName(el);
    if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article') continue;
    if (isHiddenStyle(getAttr(el, 'style'))) {
      el.remove?.();
    }
  }

  for (const img of safeQueryAll('img')) {
    const w = Number(getAttr(img, 'width') || -1);
    const h = Number(getAttr(img, 'height') || -1);
    const src = getAttr(img, 'src').toLowerCase();
    if (
      (w >= 0 && w <= 2) ||
      (h >= 0 && h <= 2) ||
      /(?:pixel|beacon|open\.track|mailtrack|\/track\/|spacer\.gif)/i.test(src)
    ) {
      img.remove?.();
    }
  }

  // 4. Remove cookie, consent, promo, filter, search, and sidebar containers by attributes
  const allEls = safeQueryAll('*');
  for (let i = allEls.length - 1; i >= 0; i--) {
    const el = allEls[i]!;
    const tag = getTagName(el);
    if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article' || tag === 'head') {
      continue;
    }
    const cls = getAttr(el, 'class');
    const id = getAttr(el, 'id');
    const ctrl = getAttr(el, 'data-controller');
    const testId = getAttr(el, 'data-testid');
    const ariaLabel = getAttr(el, 'aria-label');
    const attrSignal = `${cls} ${id} ${ctrl} ${testId} ${ariaLabel}`;

    if (attrSignal.trim() && BOILERPLATE_ATTR_RE.test(attrSignal)) {
      const stats = measureLinkDensity(el);
      // Guard: never remove a broad page container that wraps substantial editorial prose
      if (stats.totalChars > 1400 && stats.hasLongProseParagraph && stats.linkChars / stats.totalChars < 0.3) {
        continue;
      }
      el.remove?.();
    }
  }

  // 5. Remove link-dense nav/category/filter lists & promo/social clusters (bottom-up)
  if (!options.preserveEmailLayout) {
    const containers = safeQueryAll('ul, ol, div, section');
    for (let i = containers.length - 1; i >= 0; i--) {
      const el = containers[i]!;
      const tag = getTagName(el);
      if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article') continue;
      if (!el.parentNode) continue;

      const stats = measureLinkDensity(el);
      if (stats.totalChars === 0) continue;
      if (stats.hasLongProseParagraph) continue;

      const linkRatio = stats.linkChars / Math.max(1, stats.totalChars);
      const isLinkDenseNavList =
        stats.linkCount >= 4 && linkRatio > 0.65 && stats.avgLinkLen < 45;
      const isSocialCluster =
        stats.socialLinkCount >= 3 && stats.totalChars - stats.linkChars < 80;
      const isPromoAlert =
        stats.hasPromoUtm && stats.totalChars < 280;

      if (isLinkDenseNavList || isSocialCluster || isPromoAlert) {
        el.remove?.();
      }
    }
  }
}

const GENERIC_ANCHOR_RE =
  /^(?:this|here|link|click|more|source|post|read more|learn more|view|тут|здесь|ссылка|источник|подробнее|пост|сюда)$/i;

const PROMO_HREF_RE = /(?:utm_source=alert|utm_campaign=promo|\/academy-plan\b)/i;

function extractCodeLanguage(preEl: DomNodeLike, codeEl: DomNodeLike | null): string {
  const cls = `${getAttr(preEl, 'class')} ${codeEl ? getAttr(codeEl, 'class') : ''}`;
  const m =
    /(?:language|lang)-([a-z0-9_+#.-]+)/i.exec(cls) ||
    /\bbrush:\s*([a-z0-9_+#.-]+)/i.exec(cls);
  if (!m?.[1]) return '';
  const lang = m[1].toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
  if (lang === 'plain' || lang === 'text' || lang === 'none' || lang === 'notranslate') return '';
  return lang;
}

function collectPreformattedText(node: DomNodeLike): string {
  if (node.nodeType === 3) {
    return node.textContent || '';
  }
  if (node.nodeType !== 1) return '';
  const tag = getTagName(node);
  if (tag === 'br') return '\n';
  if (tag === 'button' || tag === 'script' || tag === 'style') return '';
  const cls = getAttr(node, 'class');
  if (/\b(?:example-header|copy-code|hljs-ln-numbers)\b/i.test(cls)) return '';

  let out = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    out += collectPreformattedText(node.childNodes[i]!);
  }
  return out;
}

function isLayoutEmailTable(tableEl: DomNodeLike): boolean {
  const thCount = tableEl.querySelectorAll ? tableEl.querySelectorAll('th').length : 0;
  if (thCount > 0) return false;
  const nestedTables = tableEl.querySelectorAll ? tableEl.querySelectorAll('table').length : 0;
  if (nestedTables > 0) return true;
  const role = getAttr(tableEl, 'role').toLowerCase();
  if (role === 'presentation' || role === 'none') return true;
  const rows = tableEl.querySelectorAll ? Array.from(tableEl.querySelectorAll('tr')) : [];
  if (rows.length === 0) return true;
  // Single-column email wrapper tables or tables with multi-block cells are layout wrappers
  let maxCellsInRow = 0;
  for (const row of rows) {
    const cells = row.querySelectorAll ? row.querySelectorAll('td, th').length : 0;
    if (cells > maxCellsInRow) maxCellsInRow = cells;
  }
  if (maxCellsInRow <= 1) return true;
  const hasBlockInsideCell = Boolean(tableEl.querySelector?.('td p, td h1, td h2, td h3, td ul, td ol, td blockquote'));
  return hasBlockInsideCell;
}

/**
 * Pure DOM-tree-to-Markdown serializer. Zero regex HTML stripping — immune to `>` inside attributes.
 */
export function domNodeToMarkdown(
  root: DomNodeLike,
  options: {
    baseUrl?: URL;
    sanitizeUrl?: UrlSanitizer;
    mode?: 'web' | 'telegram' | 'email' | 'archive';
  } = {}
): DomMarkdownResult {
  const mode = options.mode ?? 'web';
  const sanitizeUrl = options.sanitizeUrl ?? DEFAULT_URL_SANITIZER;
  const links: ExtractedAction[] = [];
  const seenUrls = new Set<string>();
  let firstBoldTitle: string | null = null;
  let hasCodeBlocks = false;

  const recordLink = (href: string, label: string) => {
    if (!/^https?:\/\//i.test(href) || seenUrls.has(href)) return;
    if (mode === 'web') {
      if (PROMO_HREF_RE.test(href)) return;
      try {
        const host = new URL(href).hostname.replace(/^www\./i, '').toLowerCase();
        if (SOCIAL_HOST_RE.test(host) && label.length < 28) return;
      } catch {
        return;
      }
    }
    seenUrls.add(href);
    const cleanLabel = cleanInlineWhitespace(label);
    const isGeneric = cleanLabel.length < 3 || GENERIC_ANCHOR_RE.test(cleanLabel);
    const readableUrl = href.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
    links.push({
      type: 'url',
      label: (isGeneric ? readableUrl : cleanLabel).slice(0, 32),
      value: href,
    });
  };

  const renderChildren = (node: DomNodeLike, inInline = false): string => {
    let out = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      out += walk(node.childNodes[i]!, inInline);
    }
    return out;
  };

  const walk = (node: DomNodeLike, inInline = false): string => {
    if (node.nodeType === 3) {
      const raw = node.textContent || '';
      if (!raw) return '';
      // Strip invisible soft-hyphen / zero-width / preheader filler chars; collapse HTML source newlines
      const cleaned = raw
        .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t\r\n]+/g, ' ');
      return cleaned;
    }

    if (node.nodeType !== 1) return '';
    const tag = getTagName(node);

    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'noscript' ||
      tag === 'svg' ||
      tag === 'canvas' ||
      tag === 'template' ||
      tag === 'iframe' ||
      tag === 'button' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'head' ||
      tag === 'meta' ||
      tag === 'link' ||
      tag === 'title'
    ) {
      return '';
    }

    if (isHiddenStyle(getAttr(node, 'style')) || getAttr(node, 'aria-hidden') === 'true') {
      return '';
    }

    // Telegram decorative emoji tags keep inner <b> fallback emoji cleanly
    if (tag === 'tg-emoji' || (tag === 'i' && /\bemoji\b/i.test(getAttr(node, 'class')))) {
      const innerB = node.querySelector?.('b');
      const fallbackEmoji = cleanInlineWhitespace(innerB?.textContent || node.textContent || '');
      return fallbackEmoji ? `${fallbackEmoji} ` : '';
    }

    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';

    if (tag === 'pre') {
      hasCodeBlocks = true;
      const codeEl = node.querySelector?.('code') ?? null;
      const lang = extractCodeLanguage(node, codeEl);
      const rawCode = collectPreformattedText(codeEl ?? node).replace(/^\n+|\n+$/g, '');
      if (!rawCode.trim()) return '';
      return `\n\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n\n`;
    }

    if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      // Do NOT run decodeHtmlEntities again: linkedom already decoded HTML entities once!
      const rawCode = (node.textContent || '')
        .replace(/[\u00AD\u200B\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawCode) return '';
      const escaped = rawCode.replace(/`/g, "'");
      return `\`${escaped}\``;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = cleanInlineWhitespace(renderChildren(node, true))
        .replace(/^#+\s*/, '')
        .trim();
      if (!text) return '';
      const mdLevel = mode === 'email' ? level : Math.min(4, Math.max(2, level));
      return `\n\n${'#'.repeat(mdLevel)} ${text}\n\n`;
    }

    if (tag === 'blockquote') {
      const inner = renderChildren(node, false)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((line) => `> ${line.trim()}`)
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }

    if (tag === 'a') {
      const rawHref = getAttr(node, 'href').trim();
      const innerText = renderChildren(node, true);
      const label = cleanInlineWhitespace(innerText);

      if (!rawHref || rawHref.startsWith('#') || /^javascript:/i.test(rawHref)) {
        return label;
      }

      let resolvedHref: string | null = null;
      if (/^mailto:/i.test(rawHref)) {
        resolvedHref = rawHref;
      } else {
        resolvedHref = sanitizeUrl(rawHref, options.baseUrl);
      }

      if (!resolvedHref) {
        return label;
      }

      if (mode === 'web' && PROMO_HREF_RE.test(resolvedHref)) {
        return '';
      }

      recordLink(resolvedHref, label);
      if (!label) {
        // Skip empty icon/image-only anchor tags in web/email mode so raw tracker URLs don't clutter notes
        return mode === 'telegram' || mode === 'archive' ? resolvedHref : '';
      }
      if (label === resolvedHref) return resolvedHref;
      // Avoid nested `[text](url)` inside `[label](href)`
      if (/^\[[^\]]+\]\([^)]+\)$/.test(label)) return label;
      return `[${label}](${resolvedHref})`;
    }

    if (tag === 'strong' || tag === 'b') {
      const inner = renderChildren(node, true).trim();
      if (!inner) return '';
      if (!firstBoldTitle) {
        const plain = cleanInlineWhitespace(node.textContent || '');
        if (plain.length >= 4) {
          firstBoldTitle = truncateAtWordBoundary(plain, 120);
        }
      }
      if (inner.startsWith('**') && inner.endsWith('**')) return inner;
      return `**${inner}**`;
    }

    if (tag === 'em' || tag === 'i') {
      const inner = renderChildren(node, true).trim();
      if (!inner) return '';
      if (inner.startsWith('*') && inner.endsWith('*')) return inner;
      return `*${inner}*`;
    }

    if (tag === 'del' || tag === 's' || tag === 'strike') {
      const inner = renderChildren(node, true).trim();
      return inner ? `~~${inner}~~` : '';
    }

    if (tag === 'ul' || tag === 'ol') {
      const isOrdered = tag === 'ol';
      let idx = 0;
      const items: string[] = [];
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i]!;
        if (child.nodeType !== 1 || getTagName(child) !== 'li') continue;
        const itemText = renderChildren(child, false)
          .replace(/\r?\n+/g, ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        if (!itemText) continue;
        idx += 1;
        items.push(isOrdered ? `${idx}. ${itemText}` : `- ${itemText}`);
      }
      if (items.length === 0) return '';
      return `\n\n${items.join('\n')}\n\n`;
    }

    if (tag === 'li') {
      const itemText = renderChildren(node, false)
        .replace(/\r?\n+/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return itemText ? `\n- ${itemText}` : '';
    }

    if (tag === 'table') {
      if (mode === 'email' && isLayoutEmailTable(node)) {
        return `\n\n${renderChildren(node, false)}\n\n`;
      }
      const rows = node.querySelectorAll ? Array.from(node.querySelectorAll('tr')) : [];
      const rowLines: string[] = [];
      for (const row of rows) {
        // Skip rows belonging to nested tables (handled by their own table walk)
        if (row.closest?.('table') !== node) continue;
        const cells: string[] = [];
        for (let i = 0; i < row.childNodes.length; i++) {
          const cell = row.childNodes[i]!;
          if (cell.nodeType !== 1) continue;
          const ct = getTagName(cell);
          if (ct !== 'td' && ct !== 'th') continue;
          const cellText = cleanInlineWhitespace(renderChildren(cell, true));
          if (cellText) cells.push(cellText);
        }
        if (cells.length > 0) {
          rowLines.push(cells.join(' · '));
        }
      }
      return rowLines.length > 0 ? `\n\n${rowLines.join('\n')}\n\n` : '';
    }

    if (tag === 'tr') {
      return `\n${renderChildren(node, false)}\n`;
    }

    if (tag === 'td' || tag === 'th') {
      return `${renderChildren(node, false)}\n`;
    }

    if (tag === 'summary') {
      const t = cleanInlineWhitespace(renderChildren(node, true));
      return t ? `\n\n**${t}**\n\n` : '';
    }

    if (
      tag === 'p' ||
      tag === 'div' ||
      tag === 'section' ||
      tag === 'article' ||
      tag === 'main' ||
      tag === 'header' ||
      tag === 'figure' ||
      tag === 'figcaption' ||
      tag === 'details' ||
      tag === 'dl' ||
      tag === 'dt' ||
      tag === 'dd'
    ) {
      const inner = renderChildren(node, false);
      if (!inner.trim()) return '';
      if (inInline) return inner;
      if (tag === 'div' && (mode === 'telegram' || mode === 'archive')) {
        return `\n${inner.trim()}\n`;
      }
      return `\n\n${inner.trim()}\n\n`;
    }

    return renderChildren(node, inInline);
  };

  const rawMd = walk(root, false);

  // Normalize whitespace outside fenced code blocks so code indentation is preserved verbatim
  const segments = rawMd.split(/(```[\s\S]*?```)/g);
  const normalized = segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg;
      return seg
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ · \n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (/```[\s\S]+?```/.test(normalized)) hasCodeBlocks = true;

  return {
    markdown: normalized,
    firstBoldTitle,
    links,
    hasCodeBlocks,
  };
}

/**
 * Converts an HTML fragment cleanly to Markdown via real DOM parsing (zero regex tag stripping).
 */
export function htmlFragmentToCleanMarkdown(
  fragmentHtml: string,
  options: {
    baseUrl?: URL;
    sanitizeUrl?: UrlSanitizer;
    mode?: 'web' | 'telegram' | 'email' | 'archive';
    stripBoilerplate?: boolean;
  } = {}
): DomMarkdownResult {
  const { body } = parseHtmlFragment(fragmentHtml);
  if (options.stripBoilerplate) {
    stripBoilerplateFromDom(body, { preserveEmailLayout: options.mode === 'email' });
  }
  return domNodeToMarkdown(body, options);
}

// ==================== Page-Type Classification (Mode B vs Mode C) ====================

const SHOWCASE_OR_TOOL_DOMAINS = new Set([
  'awwwards.com',
  'dribbble.com',
  'behance.net',
  'producthunt.com',
  'pinterest.com',
  'mobbin.com',
  'godly.website',
  'siteinspire.com',
  'land-book.com',
  'lapa.ninja',
  'saaslandingpage.com',
  'layers.to',
  'cosmos.so',
  'savee.it',
  'are.na',
  'codepen.io',
  'figma.com',
  'linear.app',
  'vercel.com',
  'stripe.com',
  'notion.so',
  'notion.site',
  'framer.com',
  'webflow.com',
  'raycast.com',
  'arc.net',
  'superhuman.com',
  'awwwards.net',
]);

const EDITORIAL_PATH_RE =
  /\/(?:blog|articles?|posts?|news|docs|documentation|guide|guides|tutorials?|handbook|changelog|engineering|stories|essay|essays|wiki|learn|reference|manual|research|papers?)(?:\/|$)/i;

const DIRECTORY_PATH_RE =
  /\/(?:websites?|sites_of_the_month|sites-of-the-month|sites_of_the_day|nominees|winners|directory|gallery|showcase|explore|discover|categories|category|templates|inspiration|collections|search|tags?|topics?|trending|featured|browse)(?:\/|$)/i;

const BOILERPLATE_LINE_RE =
  /^(?:we use cookies|this (?:site|website) uses cookies|accept (?:all )?cookies|reject (?:all )?cookies|manage (?:cookie )?preferences|cookie (?:policy|settings|notice)|privacy policy|terms of (?:service|use)|skip to (?:main )?content|all rights reserved|sign in|log in|sign up|create (?:an )?account|subscribe to our newsletter|watch all courses for just|the creative pass|follow us on|share this (?:post|article)|©\s*\d{4})/i;

function stripBoilerplateLines(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    if (block.startsWith('```')) {
      kept.push(block);
      continue;
    }
    const cleanLines = block
      .split('\n')
      .filter((line) => {
        const plain = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`>#-]/g, '').trim();
        if (!plain) return false;
        if (BOILERPLATE_LINE_RE.test(plain)) return false;
        return true;
      });
    if (cleanLines.length > 0) {
      kept.push(cleanLines.join('\n'));
    }
  }
  return kept.join('\n\n').trim();
}

function stripDuplicateLeadingHeading(markdown: string, title: string | null): string {
  if (!title) return markdown;
  const norm = (s: string) =>
    s
      .replace(/^#+\s*/, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const titleNorm = norm(title);
  if (!titleNorm) return markdown;
  const blocks = markdown.split(/\n{2,}/);
  if (blocks.length > 1 && /^#{1,4}\s+/.test(blocks[0]!)) {
    const firstNorm = norm(blocks[0]!);
    if (
      firstNorm === titleNorm ||
      titleNorm.startsWith(`${firstNorm} `) ||
      titleNorm.startsWith(`${firstNorm} -`) ||
      titleNorm.startsWith(`${firstNorm} —`) ||
      titleNorm.startsWith(`${firstNorm} |`)
    ) {
      blocks.shift();
      return blocks.join('\n\n').trim();
    }
  }
  return markdown;
}

function measureMarkdownProseQuality(markdown: string): {
  genuineProseParagraphs: number;
  totalProseChars: number;
  overallLinkDensity: number;
  shortFragmentRatio: number;
  hasCodeBlocks: boolean;
} {
  const hasCodeBlocks = /```[\s\S]+?```/.test(markdown);
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  const paragraphs = withoutCode.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  let genuineProseParagraphs = 0;
  let totalProseChars = 0;
  let totalVisibleChars = 0;
  let totalLinkLabelChars = 0;
  let totalLines = 0;
  let shortLines = 0;

  for (const para of paragraphs) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      totalLines++;
      const plainLine = l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[#>*\-\d.\s]+/, '').trim();
      if (plainLine.length < 45) shortLines++;
    }

    const linkLabels = [...para.matchAll(/\[([^\]]+)\]\([^)]+\)/g)].map((m) => m[1] || '');
    const paraLinkChars = linkLabels.reduce((acc, s) => acc + s.length, 0);
    const paraPlain = para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`>#]/g, '').trim();
    totalVisibleChars += paraPlain.length;
    totalLinkLabelChars += paraLinkChars;

    if (/^#{1,6}\s/.test(para)) continue;
    if (/^(?:[-*•]\s|\d+\.\s)/.test(para)) continue;
    if (BOILERPLATE_LINE_RE.test(paraPlain)) continue;

    const words = paraPlain.split(/\s+/).filter(Boolean);
    const paraLinkRatio = paraLinkChars / Math.max(1, paraPlain.length);
    if (paraPlain.length >= 60 && words.length >= 8 && paraLinkRatio < 0.52) {
      genuineProseParagraphs++;
      totalProseChars += paraPlain.length;
    }
  }

  return {
    genuineProseParagraphs,
    totalProseChars,
    overallLinkDensity: totalLinkLabelChars / Math.max(1, totalVisibleChars),
    shortFragmentRatio: totalLines > 0 ? shortLines / totalLines : 1,
    hasCodeBlocks,
  };
}

function isShowcaseOrDirectoryUrl(url: URL): { isRoot: boolean; isDirectoryPath: boolean; isShowcaseDomain: boolean; isEditorialPath: boolean } {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const pathname = url.pathname || '/';
  const isRoot = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(pathname);
  const isEditorialPath = EDITORIAL_PATH_RE.test(pathname);
  const isDirectoryPath = !isEditorialPath && DIRECTORY_PATH_RE.test(pathname);
  const isShowcaseDomain = SHOWCASE_OR_TOOL_DOMAINS.has(host);
  return { isRoot, isDirectoryPath, isShowcaseDomain, isEditorialPath };
}

function extractCleanShowcaseHighlights(doc: Document): string[] {
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  if (!main) return [];

  const highlights: string[] = [];
  const seen = new Set<string>();

  const pushHighlight = (raw: string | null | undefined) => {
    const clean = cleanInlineWhitespace(raw || '');
    if (!clean || clean.length < 3 || clean.length > 72) return;
    if (BOILERPLATE_LINE_RE.test(clean)) return;
    if (/^(?:https?:|\/|#|utm_|menu|search|filter|sort|all|awards|nominees|free fonts|by category)/i.test(clean)) {
      return;
    }
    if (/[<>]|data-[a-z]+-|->/.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    highlights.push(clean);
  };

  // Extract genuine showcase items from <figure> cards with high-res content images (never tiny avatars!)
  const figures = main.querySelectorAll('figure');
  for (let i = 0; i < figures.length && highlights.length < 5; i++) {
    const fig = figures[i] as unknown as DomNodeLike;
    if (fig.closest?.('nav, header, footer, aside')) continue;
    const img = fig.querySelector?.('img');
    if (!img) continue;
    const resolved = extractBestImgUrl(img);
    if (!resolved || isLikelyAvatarOrIconImg(img, resolved)) continue;
    const alt = getAttr(img, 'alt').trim();
    if (alt && alt.length >= 3 && !/^(?:image|photo|thumbnail|screenshot|preview)$/i.test(alt)) {
      pushHighlight(alt);
    }
  }

  return highlights;
}

function buildShowcaseBookmarkBody(
  description: string | null,
  highlights: string[],
  finalUrl: URL
): string {
  const parts: string[] = [];
  if (description) {
    parts.push(description);
  }
  if (highlights.length >= 2) {
    const descLow = (description || '').toLowerCase();
    const fresh = highlights.filter((h) => !descLow.includes(h.toLowerCase())).slice(0, 5);
    if (fresh.length >= 2) {
      parts.push(fresh.map((h) => `- ${h}`).join('\n'));
    }
  }
  if (parts.length === 0) {
    parts.push(finalUrl.toString());
  }
  return parts.join('\n\n').trim();
}

function truncateMarkdownCleanly(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let cut = trimmed.slice(0, maxChars);
  // Prefer breaking at the last paragraph boundary if reasonably close
  const lastPara = cut.lastIndexOf('\n\n');
  if (lastPara >= Math.floor(maxChars * 0.72)) {
    cut = cut.slice(0, lastPara).trimEnd();
  } else {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= Math.floor(maxChars * 0.85)) {
      cut = cut.slice(0, lastSpace).trimEnd();
    }
  }
  // Never leave an unclosed fenced code block dangling at the end
  const fenceCount = (cut.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    const lastFenceIdx = cut.lastIndexOf('```');
    if (lastFenceIdx > 0) {
      cut = cut.slice(0, lastFenceIdx).trimEnd();
    }
  }
  return cut;
}

/**
 * Full DOM + Mozilla Readability page extractor & Mode B (Article) vs Mode C (Showcase/Directory) classifier.
 */
export function extractReadablePage(
  html: string,
  finalUrl: URL,
  sanitizeUrl: UrlSanitizer = DEFAULT_URL_SANITIZER
): ReadablePageResult {
  // Pass 1: Extract complete metadata & cover images from intact DOM before stripping
  const metaDoc = parseHtmlDocument(html);
  const meta = extractDocumentMeta(metaDoc, finalUrl, sanitizeUrl);
  const urlSignals = isShowcaseOrDirectoryUrl(finalUrl);

  // Extract optional showcase highlights BEFORE Readability mutates DOM (only used on directory/showcase pages)
  const showcaseHighlights =
    urlSignals.isDirectoryPath || (urlSignals.isShowcaseDomain && !urlSignals.isEditorialPath)
      ? extractCleanShowcaseHighlights(metaDoc)
      : [];

  // Pass 2: Build clean DOM copy, strip all nav/header/footer/promo/filter boilerplate, run Readability
  const workDoc = parseHtmlDocument(html);
  stripBoilerplateFromDom(workDoc as unknown as DomNodeLike);

  let readableArticle: ReturnType<Readability<string>['parse']> = null;
  try {
    const reader = new Readability(workDoc, { charThreshold: 180, keepClasses: true });
    readableArticle = reader.parse();
  } catch {
    readableArticle = null;
  }

  const rawTitle =
    meta.ogTitle ||
    (readableArticle?.title ? normalizeMetaText(readableArticle.title) : null) ||
    meta.titleTag ||
    null;
  const cleanTitle = rawTitle ? truncateAtWordBoundary(rawTitle, 120) : null;

  let cleanDescription = meta.description
    ? truncateAtWordBoundary(meta.description, 260)
    : null;
  if (!cleanDescription && readableArticle?.excerpt) {
    const ex = normalizeMetaText(readableArticle.excerpt);
    if (ex && !BOILERPLATE_LINE_RE.test(ex)) {
      cleanDescription = truncateAtWordBoundary(ex, 260);
    }
  }

  // Prefer JSON-LD editorial articleBody when explicitly marked as an editorial article
  if (meta.jsonLdArticleBody && !urlSignals.isDirectoryPath && !urlSignals.isRoot) {
    const cleanedJsonBody = stripBoilerplateLines(meta.jsonLdArticleBody);
    const q = measureMarkdownProseQuality(cleanedJsonBody);
    if (q.genuineProseParagraphs >= 2 || q.totalProseChars >= 320) {
      return {
        pageKind: 'article',
        title: cleanTitle,
        description: cleanDescription,
        bodyMarkdown: truncateMarkdownCleanly(cleanedJsonBody, 8000),
        ogImageUrl: meta.ogImageUrl,
        galleryUrls: meta.galleryUrls,
        author: meta.author || (readableArticle?.byline ? normalizeMetaText(readableArticle.byline) : null),
        publishedAt: meta.publishedAt || readableArticle?.publishedTime || null,
        canonicalUrl: meta.canonicalUrl,
        extractedLinks: [],
      };
    }
  }

  // Serialize Readability HTML via real DOM walker (ZERO regex HTML stripping!)
  let articleMd = '';
  let extractedLinks: ExtractedAction[] = [];
  if (readableArticle?.content) {
    const parsedContent = htmlFragmentToCleanMarkdown(readableArticle.content, {
      baseUrl: finalUrl,
      sanitizeUrl,
      mode: 'web',
      stripBoilerplate: true,
    });
    articleMd = stripDuplicateLeadingHeading(stripBoilerplateLines(parsedContent.markdown), cleanTitle);
    extractedLinks = parsedContent.links;
  }

  const quality = measureMarkdownProseQuality(articleMd);

  const isExplicitShowcaseOrDirectory =
    urlSignals.isDirectoryPath ||
    (urlSignals.isShowcaseDomain && !urlSignals.isEditorialPath && meta.ogType !== 'article');

  const isLandingHomepage =
    urlSignals.isRoot &&
    meta.ogType !== 'article' &&
    !(quality.genuineProseParagraphs >= 4 && quality.totalProseChars >= 750 && quality.shortFragmentRatio < 0.4);

  const qualifiesAsArticle =
    !isExplicitShowcaseOrDirectory &&
    !isLandingHomepage &&
    articleMd.length >= 200 &&
    quality.overallLinkDensity < 0.42 &&
    ((quality.genuineProseParagraphs >= 2 && quality.totalProseChars >= 320) ||
      (quality.hasCodeBlocks && quality.totalProseChars >= 180) ||
      (quality.genuineProseParagraphs >= 1 &&
        quality.totalProseChars >= 450 &&
        quality.shortFragmentRatio < 0.45));

  if (qualifiesAsArticle) {
    return {
      pageKind: 'article',
      title: cleanTitle,
      description: cleanDescription,
      bodyMarkdown: truncateMarkdownCleanly(articleMd, 8000),
      ogImageUrl: meta.ogImageUrl,
      galleryUrls: meta.galleryUrls,
      author: meta.author || (readableArticle?.byline ? normalizeMetaText(readableArticle.byline) : null),
      publishedAt: meta.publishedAt || readableArticle?.publishedTime || null,
      canonicalUrl: meta.canonicalUrl,
      extractedLinks: extractedLinks.slice(0, 8),
    };
  }

  // Mode C — Directory / Showcase / Gallery / Homepage / Tool / SaaS Landing
  // Never dump navigation menus, filter drawers, category trees, or promo banners!
  if (!cleanDescription && articleMd) {
    // Fallback description from first genuine clean prose paragraph if meta description was missing
    const firstCleanPara = articleMd
      .split(/\n{2,}/)
      .map((p) => p.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#+\s*/, '').trim())
      .find((p) => p.length >= 36 && !BOILERPLATE_LINE_RE.test(p) && !/^[-*•]\s/.test(p));
    if (firstCleanPara) {
      cleanDescription = truncateAtWordBoundary(firstCleanPara, 260);
    }
  }

  const bookmarkBody = buildShowcaseBookmarkBody(cleanDescription, showcaseHighlights, finalUrl);

  return {
    pageKind: 'showcase',
    title: cleanTitle,
    description: cleanDescription,
    bodyMarkdown: bookmarkBody,
    ogImageUrl: meta.ogImageUrl,
    galleryUrls: meta.galleryUrls,
    author: meta.author,
    publishedAt: meta.publishedAt,
    canonicalUrl: meta.canonicalUrl,
    extractedLinks: [],
  };
}

// ==================== Pasted / Clipped Text & HTML Sanitizer ====================

const CODE_HINT_RE =
  /(?:```|(?:^|\n)\s*(?:import\s+[\w{*\s,]+\s+from\s+|export\s+(?:default\s+)?(?:function|const|class|type|interface)|const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+\s*\(|class\s+\w+\s*[{<]|def\s+\w+\s*\(|<\?php))/m;

const RAW_HTML_SIGNAL_RE =
  /(?:<!DOCTYPE\s+html\b|<html\b|<body\b|<head\b|<div\s+(?:class|id|style|data-|role)=|<table\b[^>]*>[\s\S]*?<tr\b|<p\b[^>]*>[\s\S]*?<\/p>|<a\s+[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>|<ul\b[^>]*>[\s\S]*?<li\b|<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>)/i;

const LEAKED_ATTR_FRAGMENT_RE =
  /(?:^|\s)(?:[a-z0-9_-]+#[a-z0-9_-]+["']?\s*>|[a-z0-9_-]+->[a-z0-9_-]+#[a-z0-9_-]+["']?(?:\s+data-[a-z0-9-]+="[^"]*")*\s*>|data-[a-z0-9-]+="[^"]*"\s*>)/gim;

export function looksLikeRawHtmlContent(input: string): boolean {
  const trimmed = (input || '').trim();
  if (!trimmed || trimmed.length < 12) return false;
  if (!trimmed.includes('<') || !trimmed.includes('>')) return false;
  if (CODE_HINT_RE.test(trimmed)) return false;
  if (RAW_HTML_SIGNAL_RE.test(trimmed)) return true;

  // Multiple paired HTML tags indicate copied HTML markup rather than prose using `<` / `>`
  const paired = trimmed.match(/<\/(?:div|p|span|ul|ol|li|section|article|header|footer|nav|table|tr|td|th|h[1-6]|blockquote|strong|em|a)>/gi);
  return Boolean(paired && paired.length >= 2);
}

/**
 * Cleans user-pasted or browser-clipped web text/HTML:
 * - Converts copied HTML markup via real DOM (stripping nav/cookie/script/attribute noise)
 * - Leaves intentional code snippets and clean Markdown untouched
 * - Strips stray leaked HTML attribute fragments (`search#doToogleTab">`, `data-*-target="..."`)
 * - Decodes stray HTML entities outside fenced/inline code blocks
 * - Removes isolated cookie/consent/skip-nav boilerplate lines when clipping pages
 */
export function sanitizeIngestedText(
  rawText: string,
  options: { baseUrl?: URL; sanitizeUrl?: UrlSanitizer; stripCookieNoise?: boolean } = {}
): string {
  if (!rawText) return '';
  const trimmed = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!trimmed) return '';

  // 1. If pasted/clipped payload is raw HTML (not code!), convert cleanly through linkedom
  if (looksLikeRawHtmlContent(trimmed)) {
    const parsed = htmlFragmentToCleanMarkdown(trimmed, {
      baseUrl: options.baseUrl,
      sanitizeUrl: options.sanitizeUrl,
      mode: 'web',
      stripBoilerplate: true,
    });
    const cleaned = options.stripCookieNoise
      ? stripBoilerplateLines(parsed.markdown)
      : parsed.markdown;
    if (cleaned) return cleaned;
  }

  // 2. Preserve code snippets untouched except newline normalization
  if (CODE_HINT_RE.test(trimmed)) {
    return trimmed;
  }

  // 3. Clean entities & leaked HTML attribute artifacts outside inline code
  let out = trimmed
    .replace(/[\u00AD\u200B\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ');

  if (out.includes('&')) {
    const parts = out.split(/(`[^`\n]+`)/g);
    out = parts.map((seg, i) => (i % 2 === 1 ? seg : decodeHtmlEntities(seg))).join('');
  }

  if (LEAKED_ATTR_FRAGMENT_RE.test(out)) {
    out = out.replace(LEAKED_ATTR_FRAGMENT_RE, ' ');
  }

  if (options.stripCookieNoise) {
    out = stripBoilerplateLines(out);
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
