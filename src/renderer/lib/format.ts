import type { AppLocale, TranscribeItemResult, VaultItem } from '@shared/types';
import { decodeHtmlEntities } from '@shared/html-entities';
import { getDateLocale, translate } from '@shared/i18n';
import { decodeBlobToMono16kWav } from './audioWav';

function resolveActiveLocale(locale?: AppLocale): AppLocale {
  if (locale === 'en' || locale === 'ru') return locale;
  if (typeof document !== 'undefined' && document.documentElement?.lang === 'en') {
    return 'en';
  }
  return 'ru';
}

export function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let form = many;
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) form = one;
    else if (mod10 >= 2 && mod10 <= 4) form = few;
  }
  return `${count} ${form}`;
}

export function formatRelativeDate(timestampMs: number, locale?: AppLocale): string {
  const activeLoc = resolveActiveLocale(locale);
  const dateLoc = getDateLocale(activeLoc);
  const diffSec = Math.round((Date.now() - timestampMs) / 1000);
  if (diffSec < 45) return translate(activeLoc, 'date.justNow');
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return translate(activeLoc, 'date.minutesAgo', { count: diffMin });
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) {
    const d = new Date(timestampMs);
    const now = new Date();
    const timeStr = d.toLocaleTimeString(dateLoc, { hour: '2-digit', minute: '2-digit' });
    if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth()) {
      return translate(activeLoc, 'date.todayAt', { time: timeStr });
    }
    return translate(activeLoc, 'date.yesterdayAt', { time: timeStr });
  }
  const date = new Date(timestampMs);
  return date.toLocaleDateString(dateLoc, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function formatReminderStamp(timestampMs: number, locale?: AppLocale): string {
  const d = new Date(timestampMs);
  return d.toLocaleString(getDateLocale(resolveActiveLocale(locale)), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateCompact(timestampMs: number, locale?: AppLocale): string {
  const dateLoc = getDateLocale(resolveActiveLocale(locale));
  const d = new Date(timestampMs);
  const now = new Date();
  if (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  ) {
    return d.toLocaleTimeString(dateLoc, { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(dateLoc, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(dateLoc, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatDurationMmSs(seconds?: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatFileSize(bytes?: number | null, locale?: AppLocale): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  const activeLoc = resolveActiveLocale(locale);
  if (bytes < 1024) return translate(activeLoc, 'common.bytes', { count: bytes });
  if (bytes < 1024 * 1024) return translate(activeLoc, 'common.kilobytes', { count: Math.round(bytes / 1024) });
  return translate(activeLoc, 'common.megabytes', { count: (bytes / (1024 * 1024)).toFixed(1) });
}

export function formatCardPanGroups(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

export function getMediaUrl(filename?: string | null): string | null {
  if (!filename) return null;
  return `kapsula-media://local/${encodeURIComponent(filename)}`;
}

export function getCachedVideoUrl(filename?: string | null): string | null {
  if (!filename) return null;
  return `kapsula-media://cache/${encodeURIComponent(filename)}`;
}

export function extractFirstCodeBlock(body: string): { lang: string; code: string } | null {
  const m = /```([a-z0-9_-]*)\n([\s\S]*?)```/i.exec(body || '');
  if (!m) return null;
  return {
    lang: (m[1] || 'code').toLowerCase(),
    code: (m[2] || '').trim(),
  };
}

export function getDnaHumanLabel(item: VaultItem, locale?: AppLocale): string {
  const activeLoc = resolveActiveLocale(locale);
  if (item.dna === 'secret') {
    if (item.secretMeta?.kind === 'bank_card') return translate(activeLoc, 'dna.bankCard');
    if (item.secretMeta?.kind === 'password') return translate(activeLoc, 'dna.password');
    if (item.secretMeta?.kind === 'api_key') return translate(activeLoc, 'dna.apiKey');
    if (item.secretMeta?.kind === 'seed') return translate(activeLoc, 'dna.seed');
    if (item.secretMeta?.kind === 'note') return translate(activeLoc, 'dna.secretNote');
    return translate(activeLoc, 'dna.vault');
  }
  switch (item.dna) {
    case 'note':
      return translate(activeLoc, 'dna.note');
    case 'shot':
      return translate(activeLoc, 'dna.shot');
    case 'link':
      return translate(activeLoc, 'dna.link');
    case 'voice':
      return translate(activeLoc, 'dna.voice');
    case 'snippet':
      return translate(activeLoc, 'dna.snippet');
    case 'doc':
      return translate(activeLoc, 'dna.doc');
    default:
      return translate(activeLoc, 'dna.item');
  }
}

export function stripMarkdownPreview(raw: string): string {
  const cleaned = decodeHtmlEntities(raw || '')
    .replace(/```[\s\S]*?```/g, '')
    // Strip inline Markdown images ![alt](url "title") before link unwrapping
    .replace(/!\[[^\]]*\]\((?:<[^>]+>|[^()\s]+(?:\([^)]*\))*)(?:\s+"[^"]*")?\)/g, '')
    // Strip any bare local media protocol references
    .replace(/kapsula-media:\/\/local\/[^\s)"'<>`?#]+/gi, '')
    // Unwrap Markdown links [label](url) -> label
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^()\s]+(?:\([^)]*\))*)(?:\s+"[^"]*")?\)/g, '$1')
    // Unwrap Wiki-links [[Target|Alias]] -> Alias and [[Title]] -> Title
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(
      /^\s*#{1,6}\s*(?:Задачи|Следующие шаги|Ключевые тезисы|Дела|Tasks|Next steps|Key points|Action items)\s*$/gim,
      ''
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(?:^|\n)\s*---+\s*(?:\n|$)/g, '\n')
    // Strip rich inline formatting tags (color, size, highlight, underline) to clean preview text
    .replace(/<\/?(?:span|mark|u)(?:\s+[^>]*)?>/gi, '')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/\\([[\]*_`])/g, '$1')
    .replace(/[*_`~]/g, '');

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/(?:^|\s)[-*•]?\s*\\?\[[ xX]\\?\]\s+/g, ' ')
        .replace(/^\s*[-*>•]\s+/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);

  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
    } else if (/[.!?:;…·—]$/.test(out)) {
      out += ` ${line}`;
    } else {
      out += ` · ${line}`;
    }
  }
  return out.trim();
}

export function stripLeadingTitle(preview: string, title?: string | null): string {
  const cleanPreview = decodeHtmlEntities(preview || '').trim();
  const rawTitle = decodeHtmlEntities(title || '')
    .replace(/(?:…|\.\.\.)\s*$/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  if (!cleanPreview || !rawTitle || rawTitle.length < 4) return cleanPreview;

  const isIgnorable = (ch: string) => /[\uFE0E\uFE0F\u200D*_`~]/.test(ch);
  const isSpace = (ch: string) => /\s/.test(ch);

  let pi = 0;
  let ti = 0;
  while (ti < rawTitle.length && pi < cleanPreview.length) {
    const tc = rawTitle[ti]!;
    if (isIgnorable(tc)) {
      ti++;
      continue;
    }
    const pc = cleanPreview[pi]!;
    if (isIgnorable(pc)) {
      pi++;
      continue;
    }
    if (isSpace(tc) && isSpace(pc)) {
      while (ti < rawTitle.length && isSpace(rawTitle[ti]!)) ti++;
      while (pi < cleanPreview.length && isSpace(cleanPreview[pi]!)) pi++;
      continue;
    }
    if (tc.toLowerCase() === pc.toLowerCase()) {
      ti++;
      pi++;
    } else {
      break;
    }
  }
  while (ti < rawTitle.length && (isIgnorable(rawTitle[ti]!) || isSpace(rawTitle[ti]!))) {
    ti++;
  }
  if (ti === rawTitle.length) {
    // Advance past the remainder of any mid-word sliced title so 1-2 letter tails ("ы") are never orphaned
    if (
      pi < cleanPreview.length &&
      /[\p{L}\d]/u.test(cleanPreview[pi]!) &&
      /[\p{L}\d]/u.test(rawTitle[rawTitle.length - 1] || '')
    ) {
      while (pi < cleanPreview.length && /[\p{L}\d]/u.test(cleanPreview[pi]!)) {
        pi++;
      }
    }
    const remainder = cleanPreview
      .slice(pi)
      .replace(/^[\s.,:;!?\-—–·•|/]+/, '')
      .trim();
    if (remainder.length < 8 || !/[\p{L}\d]{3,}/u.test(remainder)) {
      return '';
    }
    return remainder;
  }
  return cleanPreview;
}

export function friendlyErrorMessage(err: unknown, fallback?: string, locale?: AppLocale): string {
  const activeLocale = resolveActiveLocale(locale);
  const resolvedFallback = fallback ?? translate(activeLocale, 'error.generic');
  if (!(err instanceof Error)) return resolvedFallback;
  const cleaned = err.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  if (!cleaned) return resolvedFallback;
  // Pass through natural localized messages; mask raw low-level stack/technical jargon
  if (/SQLITE|ECONN|ENOTFOUND|TypeError|SyntaxError|ReferenceError|RangeError|at\s+\S+\s+\(/i.test(cleaned)) {
    return resolvedFallback;
  }
  return cleaned;
}

const WAV_FALLBACK_ERROR_RE = /wav|ffmpeg|webm|m4a|ogg|format|формат|конверт|декод|transcode/i;

export async function transcribeItemWithWavFallback(
  item: Pick<VaultItem, 'id' | 'mediaPath' | 'mediaDurationSec'>,
  opts?: { extractTasks?: boolean }
): Promise<TranscribeItemResult> {
  const first = await window.kapsula.transcribeItem({
    itemId: item.id,
    extractTasks: opts?.extractTasks,
  });

  if (first.ok || !item.mediaPath) return first;

  const needsWavRetry =
    WAV_FALLBACK_ERROR_RE.test(first.error || '') ||
    /\.(?:webm|ogg|oga|m4a|opus)$/i.test(item.mediaPath);
  if (!needsWavRetry) return first;

  try {
    const mediaUrl = getMediaUrl(item.mediaPath);
    if (!mediaUrl) return first;
    const response = await fetch(mediaUrl);
    if (!response.ok) return first;
    const blob = await response.blob();
    const wav = await decodeBlobToMono16kWav(blob, item.mediaDurationSec || 1);
    if (!wav.wavBase64) return first;
    return await window.kapsula.transcribeItem({
      itemId: item.id,
      wavBase64Fallback: wav.wavBase64,
      extractTasks: opts?.extractTasks,
    });
  } catch {
    return first;
  }
}
