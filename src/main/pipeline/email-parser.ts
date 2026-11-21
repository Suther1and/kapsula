import { decodeHtmlEntities } from '@shared/html-entities';
import type { ParsedEmailAttachment, ParsedEmailSummary } from '@shared/types';
import {
  domNodeToMarkdown,
  parseHtmlDocument,
  stripBoilerplateFromDom,
  type DomNodeLike,
} from './html-cleaner';

function normalizeCharsetLabel(charset: string | undefined | null): string {
  const raw = (charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!raw || raw === 'utf8' || raw === 'utf-8' || raw === 'us-ascii' || raw === 'ascii') {
    return 'utf-8';
  }
  if (raw === 'cp1251' || raw === 'win1251' || raw === 'windows1251' || raw === 'windows-1251') {
    return 'windows-1251';
  }
  if (raw === 'cp1252' || raw === 'win1252' || raw === 'windows-1252') {
    return 'windows-1252';
  }
  if (raw === 'koi8r' || raw === 'koi8-r') return 'koi8-r';
  if (raw === 'koi8u' || raw === 'koi8-u') return 'koi8-u';
  if (raw === 'latin1' || raw === 'iso8859-1' || raw === 'iso-8859-1') return 'iso-8859-1';
  if (raw === 'iso8859-5' || raw === 'iso-8859-5') return 'iso-8859-5';
  return raw;
}

export function decodeBytesWithCharset(bytes: Uint8Array, charset?: string | null): string {
  const label = normalizeCharsetLabel(charset);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Decodes Quoted-Printable bytes cleanly (preserving multi-byte UTF-8 / windows-1251 sequences
 * even when split across soft `=\r\n` line breaks).
 */
export function decodeQuotedPrintableToBytes(raw: string, isHeaderQ = false): Uint8Array {
  // Remove soft line breaks (`=\r\n` or `=\n`)
  const unfolded = isHeaderQ ? raw : raw.replace(/=(?:\r\n|\n|\r)/g, '');
  const out: number[] = [];

  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]!;
    if (isHeaderQ && ch === '_') {
      out.push(0x20);
      continue;
    }
    if (ch === '=' && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = unfolded.charCodeAt(i);
    if (code <= 0xff) {
      out.push(code);
    } else {
      const utf8 = Buffer.from(ch, 'utf8');
      for (const b of utf8) out.push(b);
    }
  }

  return new Uint8Array(out);
}

/**
 * Decodes RFC 2047 encoded-words (`=?charset?B?...?=` and `=?charset?Q?...?=`)
 * including consecutive encoded words separated only by linear whitespace.
 */
export function decodeRfc2047Header(raw: string): string {
  if (!raw) return '';
  // Unfold RFC 5322 folded header lines
  let value = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
  // RFC 2047 §6.2: linear whitespace between adjacent encoded-words must be ignored
  value = value.replace(/(\?=)[ \t]+(=\?)/g, '$1$2');

  const encodedWordRe = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;
  return value.replace(encodedWordRe, (_full, charset: string, encoding: string, payload: string) => {
    try {
      const enc = encoding.toUpperCase();
      if (enc === 'B') {
        const cleaned = payload.replace(/\s+/g, '');
        const buf = Buffer.from(cleaned, 'base64');
        return decodeBytesWithCharset(buf, charset);
      }
      if (enc === 'Q') {
        const bytes = decodeQuotedPrintableToBytes(payload, true);
        return decodeBytesWithCharset(bytes, charset);
      }
    } catch {
      // Keep original on malformed token
    }
    return _full;
  });
}

function decodeRfc2231Param(raw: string): string {
  // Format: charset'lang'percent-encoded-value (e.g. UTF-8''%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82.png)
  const m = /^([^']*)'[^']*'(.*)$/.exec(raw.trim());
  if (!m) return decodeRfc2047Header(raw);
  const charset = m[1] || 'utf-8';
  const encoded = m[2] || '';
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && i + 2 < encoded.length && /^[0-9a-fA-F]{2}$/.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
  }
  return decodeBytesWithCharset(new Uint8Array(bytes), charset);
}

interface ParsedHeaderValue {
  main: string;
  params: Record<string, string>;
}

function parseParameterizedHeader(rawHeader: string | undefined): ParsedHeaderValue {
  if (!rawHeader) return { main: '', params: {} };
  const unfolded = rawHeader.replace(/\r?\n[ \t]+/g, ' ').trim();
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  let escape = false;

  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]!;
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuotes) {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());

  const main = (segments[0] || '').toLowerCase().trim();
  const params: Record<string, string> = {};
  const continuations = new Map<string, Array<{ idx: number; val: string; extended: boolean }>>();

  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    const contMatch = /^([^*]+)\*(\d+)(\*)?$/.exec(rawKey);
    if (contMatch) {
      const baseKey = contMatch[1]!;
      const idx = Number(contMatch[2]);
      const extended = Boolean(contMatch[3]);
      const list = continuations.get(baseKey) ?? [];
      list.push({ idx, val, extended });
      continuations.set(baseKey, list);
    } else if (rawKey.endsWith('*')) {
      const baseKey = rawKey.slice(0, -1);
      params[baseKey] = decodeRfc2231Param(val);
    } else {
      params[rawKey] = decodeRfc2047Header(val);
    }
  }

  for (const [baseKey, parts] of continuations.entries()) {
    parts.sort((a, b) => a.idx - b.idx);
    const joined = parts.map((p) => p.val).join('');
    params[baseKey] = parts.some((p) => p.extended)
      ? decodeRfc2231Param(joined)
      : decodeRfc2047Header(joined);
  }

  return { main, params };
}

function splitHeadersAndBody(raw: string): { headers: Map<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const headerBlock = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : '';

  const headers = new Map<string, string>();
  const lines = headerBlock.split(/\r?\n/);
  let currentKey = '';
  let currentVal = '';

  const flush = () => {
    if (!currentKey) return;
    const lower = currentKey.toLowerCase();
    if (!headers.has(lower)) {
      headers.set(lower, currentVal.trim());
    }
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      currentVal += `\n${line}`;
    } else {
      flush();
      const colon = line.indexOf(':');
      if (colon > 0) {
        currentKey = line.slice(0, colon).trim();
        currentVal = line.slice(colon + 1).trim();
      } else {
        currentKey = '';
        currentVal = '';
      }
    }
  }
  flush();

  return { headers, body };
}

function parseFromField(rawFrom: string): {
  from: string;
  fromName?: string;
  fromAddress?: string;
} {
  const decoded = decodeRfc2047Header(rawFrom).trim();
  if (!decoded) return { from: '' };

  const angleMatch = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(decoded);
  if (angleMatch) {
    const rawName = angleMatch[1]!.trim().replace(/^["']|["']$/g, '').trim();
    const addr = angleMatch[2]!.trim();
    return {
      from: rawName ? `${rawName} <${addr}>` : addr,
      fromName: rawName || undefined,
      fromAddress: addr,
    };
  }

  const emailOnly = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(decoded);
  if (emailOnly?.[1]) {
    const addr = emailOnly[1];
    const remainder = decoded.replace(addr, '').replace(/[()<>"]/g, '').trim();
    return {
      from: decoded,
      fromName: remainder || undefined,
      fromAddress: addr,
    };
  }

  return { from: decoded, fromName: decoded };
}

function decodePartBodyToBytes(bodyRaw: string, transferEncoding: string): Uint8Array {
  const enc = (transferEncoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const cleaned = bodyRaw.replace(/\s+/g, '');
    return new Uint8Array(Buffer.from(cleaned, 'base64'));
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintableToBytes(bodyRaw, false);
  }
  // 7bit / 8bit / binary: preserve raw single-byte values from latin1 string view
  return new Uint8Array(Buffer.from(bodyRaw, 'latin1'));
}

function splitMultipartParts(bodyRaw: string, boundary: string): string[] {
  const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiterRe = new RegExp(`(?:^|\\r?\\n)--${escapedBoundary}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const markers: Array<{ start: number; end: number; isClosing: boolean }> = [];

  for (const m of bodyRaw.matchAll(delimiterRe)) {
    markers.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      isClosing: Boolean(m[1]),
    });
  }

  if (markers.length === 0) return [];

  const parts: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i]!;
    if (cur.isClosing) break;
    const next = markers[i + 1];
    const partEnd = next ? next.start : bodyRaw.length;
    let slice = bodyRaw.slice(cur.end, partEnd);
    slice = slice.replace(/^\r?\n/, '');
    if (slice.length > 0) {
      parts.push(slice);
    }
  }
  return parts;
}

/**
 * Converts HTML email body into clean, readable Markdown via real DOM parsing (`linkedom`),
 * eliminating broken regex HTML attribute leakage (`->`, `data-*`, CSS, tracking pixels, preheaders)
 * while preserving headings, links, bold/italic, lists, blockquotes, code blocks, and paragraphs.
 */
export function emailHtmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';

  // Remove Outlook/MSO conditional blocks before DOM parsing
  const cleanedRaw = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '');
  const doc = parseHtmlDocument(cleanedRaw);
  const body = (doc.body ?? doc.documentElement) as unknown as DomNodeLike | null;
  if (!body) return '';

  stripBoilerplateFromDom(body, { preserveEmailLayout: true });

  const { markdown } = domNodeToMarkdown(body, { mode: 'email' });
  return markdown
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ · \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface MimeWalkAccumulator {
  plainParts: string[];
  htmlParts: string[];
  attachments: ParsedEmailAttachment[];
}

function walkMimeEntity(rawEntity: string, acc: MimeWalkAccumulator, depth = 0): void {
  if (depth > 12) return;
  const { headers, body } = splitHeadersAndBody(rawEntity);

  const ct = parseParameterizedHeader(headers.get('content-type') || 'text/plain; charset=utf-8');
  const cd = parseParameterizedHeader(headers.get('content-disposition'));
  const cte = headers.get('content-transfer-encoding') || '7bit';
  const contentType = ct.main || 'text/plain';

  if (contentType.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    const subParts = splitMultipartParts(body, boundary);
    for (const part of subParts) {
      walkMimeEntity(part, acc, depth + 1);
    }
    return;
  }

  const filename = (cd.params.filename || ct.params.name || '').trim();
  const isExplicitAttachment = cd.main === 'attachment';
  const isInlineWithFile =
    cd.main === 'inline' && (Boolean(filename) || !contentType.startsWith('text/'));
  const isNonTextBinary = !contentType.startsWith('text/') && contentType !== '';

  const decodedBytes = decodePartBodyToBytes(body, cte);

  if (isExplicitAttachment || isInlineWithFile || isNonTextBinary) {
    const extGuess =
      contentType.includes('png')
        ? 'png'
        : contentType.includes('jpeg') || contentType.includes('jpg')
          ? 'jpg'
          : contentType.includes('webp')
            ? 'webp'
            : contentType.includes('gif')
              ? 'gif'
              : contentType.includes('pdf')
                ? 'pdf'
                : 'bin';
    const safeName = (filename || `attachment-${acc.attachments.length + 1}.${extGuess}`)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim();
    acc.attachments.push({
      filename: safeName,
      contentType,
      size: decodedBytes.byteLength,
      data: decodedBytes,
    });
    return;
  }

  const text = decodeBytesWithCharset(decodedBytes, ct.params.charset);
  if (contentType === 'text/html') {
    if (text.trim()) acc.htmlParts.push(text.trim());
  } else if (text.trim()) {
    acc.plainParts.push(text.trim());
  }
}

/**
 * Pure-Node RFC 5322 / MIME `.eml` parser (zero external dependencies).
 * Supports RFC 2047 headers (UTF-8 B/Q, windows-1251, KOI8-R), recursive multipart/*,
 * base64 & quoted-printable decoding, HTML -> Markdown conversion, and attachments.
 */
export function parseEmlBuffer(buffer: Buffer): ParsedEmailSummary {
  // Decode raw RFC 5322 envelope using latin1 to preserve exact byte values for 8-bit/windows-1251 bodies
  const raw = buffer.toString('latin1');
  const { headers } = splitHeadersAndBody(raw);

  const subject = decodeRfc2047Header(headers.get('subject') || '').trim() || 'Письмо без темы';
  const fromInfo = parseFromField(headers.get('from') || '');
  const to = decodeRfc2047Header(headers.get('to') || '').trim() || undefined;
  const rawDate = (headers.get('date') || '').trim();
  let date: number | null = null;
  if (rawDate) {
    const parsedTs = Date.parse(rawDate);
    if (Number.isFinite(parsedTs)) {
      date = parsedTs;
    }
  }
  const rawMessageId = (headers.get('message-id') || '').trim();
  const messageId = rawMessageId ? rawMessageId.replace(/^<|>$/g, '').trim() : null;

  const acc: MimeWalkAccumulator = {
    plainParts: [],
    htmlParts: [],
    attachments: [],
  };
  walkMimeEntity(raw, acc, 0);

  const plainJoined = acc.plainParts.join('\n\n').replace(/\r\n/g, '\n').trim();
  const htmlMarkdown = acc.htmlParts.map(emailHtmlToMarkdown).filter(Boolean).join('\n\n').trim();

  // Prefer HTML->Markdown when HTML exists and plain text is empty or lacks structure/links that HTML provides
  let bodyMarkdown = plainJoined;
  if (htmlMarkdown) {
    const plainHasLinks = /https?:\/\//i.test(plainJoined);
    const htmlHasLinksOrHeadings = /\[[^\]]+\]\(https?:\/\/|^#{1,6}\s/m.test(htmlMarkdown);
    if (!plainJoined || (htmlHasLinksOrHeadings && !plainHasLinks)) {
      bodyMarkdown = htmlMarkdown;
    }
  }

  const bodyText =
    plainJoined ||
    htmlMarkdown
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/[#*_`>]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  return {
    subject,
    from: fromInfo.from,
    fromName: fromInfo.fromName,
    fromAddress: fromInfo.fromAddress,
    to,
    date,
    messageId,
    bodyText,
    bodyMarkdown: bodyMarkdown || bodyText,
    attachments: acc.attachments,
  };
}

/**
 * Formats a parsed email into a crisp Markdown note with sender/date header,
 * clean body, embedded image attachments, and attachment list.
 */
export function formatEmailAsNoteMarkdown(
  parsed: ParsedEmailSummary,
  savedImages: Array<{ filename: string; mediaUrl: string }> = []
): string {
  const metaLines: string[] = [];
  if (parsed.from) metaLines.push(`**От:** ${parsed.from}`);
  if (parsed.to) metaLines.push(`**Кому:** ${parsed.to}`);
  if (parsed.date) {
    const formattedDate = new Date(parsed.date).toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    metaLines.push(`**Дата:** ${formattedDate}`);
  }

  const sections: string[] = [];
  if (metaLines.length > 0) {
    sections.push(metaLines.join('  \n'));
  }

  if (parsed.bodyMarkdown.trim()) {
    sections.push(parsed.bodyMarkdown.trim());
  }

  if (savedImages.length > 0) {
    const imgMarkdown = savedImages
      .map((img) => `![${img.filename}](${img.mediaUrl})`)
      .join('\n\n');
    sections.push(`## Вложения\n\n${imgMarkdown}`);
  }

  const nonImageAttachments = parsed.attachments.filter(
    (att) => !att.contentType.toLowerCase().startsWith('image/')
  );
  if (nonImageAttachments.length > 0) {
    const fileList = nonImageAttachments
      .map((att) => {
        const kb = Math.max(1, Math.round(att.size / 1024));
        return `- ${att.filename} (${kb} КБ)`;
      })
      .join('\n');
    sections.push(
      savedImages.length > 0 ? fileList : `## Файлы во вложении\n\n${fileList}`
    );
  }

  return sections.join('\n\n').trim();
}
