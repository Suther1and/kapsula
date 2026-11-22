import type { VaultItem } from './types';

export interface ContactActionsInfo {
  email: string | null;
  phone: string | null;
  telegram: string | null;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const TG_LINK_RE = /(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,})/i;
const TG_HANDLE_RE = /(?:^|[\s(,;:])@([a-z0-9_]{4,})\b/i;
const PHONE_RE = /(?:\+?\d[\d\s()-]{6,}\d)/;

export function extractContactActions(item: VaultItem): ContactActionsInfo {
  const haystack = `${item.title || ''}\n${item.body || ''}`;

  const rawEmail = item.mediaMeta?.contactEmail?.trim() || EMAIL_RE.exec(haystack)?.[0] || null;
  const email = rawEmail ? rawEmail.toLowerCase() : null;

  const rawPhone = item.mediaMeta?.contactPhone?.trim() || PHONE_RE.exec(haystack)?.[0]?.trim() || null;
  const phone = rawPhone && rawPhone.replace(/\D/g, '').length >= 7 ? rawPhone : null;

  let telegram: string | null = item.mediaMeta?.contactHandle?.trim() || null;
  if (!telegram) {
    // Strip known email addresses so `@domain` inside email never mimics a Telegram handle
    const withoutEmails = haystack.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');
    const linkMatch = TG_LINK_RE.exec(withoutEmails);
    if (linkMatch?.[1]) {
      telegram = `@${linkMatch[1]}`;
    } else {
      const handleMatch = TG_HANDLE_RE.exec(withoutEmails);
      if (handleMatch?.[1]) {
        telegram = `@${handleMatch[1]}`;
      }
    }
  } else if (!telegram.startsWith('@')) {
    telegram = `@${telegram.replace(/^https?:\/\/t\.me\//i, '').replace(/^@+/, '')}`;
  }

  return { email, phone, telegram };
}

export function filterDistinctKeyPoints(
  points: string[] | undefined | null,
  title?: string | null,
  summary?: string | null
): string[] {
  if (!Array.isArray(points) || points.length === 0) return [];
  const norm = (s: string | null | undefined) =>
    (s || '')
      .toLowerCase()
      .replace(/[«»"'`.,!?;:()—-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normTitle = norm(title);
  const normSummary = norm(summary);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of points) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = norm(trimmed);
    if (!key) continue;
    if (normTitle && (normTitle === key || normTitle.includes(key) || key.includes(normTitle))) {
      continue;
    }
    if (normSummary && (normSummary === key || normSummary.includes(key) || key.includes(normSummary))) {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export type MediaCategory = 'photo' | 'video' | 'audio' | 'link_visual';

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|mkv)$/i;
const AUDIO_EXT_RE = /\.(?:wav|ogg|oga|mp3|m4a|flac|aac)$/i;
/**
 * Determines whether an item belongs in the curated `Заметки` studio by default.
 * Only notes/snippets explicitly created in Notes Hub or added via `mediaMeta.inNotesHub === true`
 * appear here; quick captures stay in `Все записи` (and remain visible under `Все тексты`).
 */
export function isDedicatedNote(item: VaultItem): boolean {
  if (item.isArchived) return false;
  if (item.dna !== 'note' && item.dna !== 'snippet') return false;
  return item.mediaMeta?.inNotesHub === true;
}

/**
 * All non-archived textual records (including short Telegram thoughts & docs) for
 * the `Все тексты` toggle inside the 2-pane Notes Studio.
 */
export function isAnyTextNote(item: VaultItem): boolean {
  if (item.isArchived) return false;
  return item.dna === 'note' || item.dna === 'snippet' || item.dna === 'doc';
}

export function getMediaCategory(item: VaultItem): MediaCategory | null {
  if (item.isArchived || item.dna === 'secret') return null;

  const mediaPath = item.mediaPath || '';
  const isVideo =
    item.subKind === 'video_ref' ||
    (Boolean(mediaPath) && VIDEO_EXT_RE.test(mediaPath)) ||
    Boolean(item.mediaType && item.mediaType.startsWith('video/'));
  if (isVideo) return 'video';

  const isAudio =
    item.dna === 'voice' ||
    (Boolean(mediaPath) && AUDIO_EXT_RE.test(mediaPath)) ||
    Boolean(item.mediaType && item.mediaType.startsWith('audio/'));
  if (isAudio) return 'audio';

  if (item.dna === 'shot' || Boolean(item.imagePath)) {
    return 'photo';
  }

  if (item.dna === 'link' && Boolean(item.ogImageUrl)) {
    return 'link_visual';
  }

  return null;
}

export function isMediaItem(item: VaultItem): boolean {
  return getMediaCategory(item) !== null;
}

export function countChecklistStats(body: string | null | undefined): {
  total: number;
  done: number;
} {
  if (!body) return { total: 0, done: 0 };
  const matches = body.match(/^[-*]\s+\[([ xX])\]/gm);
  if (!matches || matches.length === 0) return { total: 0, done: 0 };
  let done = 0;
  for (const m of matches) {
    if (/\[[xX]\]/.test(m)) done += 1;
  }
  return { total: matches.length, done };
}

export function isUntitledPlaceholderTitle(title: string | null | undefined): boolean {
  const norm = (title || '').trim().toLowerCase();
  return !norm || norm === 'новая заметка' || norm === 'new note' || norm === 'без названия' || norm === 'untitled';
}

export function isGenericDraftTitle(val: string | null | undefined): boolean {
  const norm = (val || '').trim().toLowerCase();
  return (
    !norm ||
    norm === 'заметка' ||
    norm === 'note' ||
    norm === 'новая заметка' ||
    norm === 'new note' ||
    norm === 'быстрая заметка' ||
    norm === 'quick note' ||
    norm === 'без названия' ||
    norm === 'untitled' ||
    norm.startsWith('голосовая заметка') ||
    norm.startsWith('voice memo') ||
    norm.startsWith('аудиозапись') ||
    norm.startsWith('audio recording')
  );
}

export function getRedundantCardTags(): readonly string[] {
  return ['favorite', 'favorites', 'pin', 'избранное'];
}
