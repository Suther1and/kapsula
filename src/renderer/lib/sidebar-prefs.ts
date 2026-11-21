import type { TranslationKey } from '@shared/i18n/types';

export const HIDEABLE_NAV_SECTIONS = [
  'notes',
  'media',
  'tasks',
  'calendar',
  'secrets',
  'boards',
] as const;

export type HideableNavSection = (typeof HIDEABLE_NAV_SECTIONS)[number];

export const HIDEABLE_SECTION_LABEL_KEYS: Record<HideableNavSection, TranslationKey> = {
  notes: 'nav.notes',
  media: 'nav.media',
  tasks: 'nav.tasks',
  calendar: 'nav.calendar',
  secrets: 'nav.vault',
  boards: 'nav.boards',
};

export const SIDEBAR_HIDDEN_SECTIONS_KEY = 'kapsula.sidebar.hiddenNavSections';
export const SIDEBAR_PREFS_EVENT = 'kapsula:sidebar-prefs-changed';

export function readHiddenNavSections(): HideableNavSection[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_HIDDEN_SECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(HIDEABLE_NAV_SECTIONS);
    return parsed.filter((id): id is HideableNavSection => typeof id === 'string' && allowed.has(id));
  } catch {
    return [];
  }
}

export function writeHiddenNavSections(sections: HideableNavSection[]): HideableNavSection[] {
  const allowed = new Set<string>(HIDEABLE_NAV_SECTIONS);
  const normalized = Array.from(
    new Set(sections.filter((id): id is HideableNavSection => allowed.has(id)))
  );
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_SECTIONS_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SIDEBAR_PREFS_EVENT, { detail: normalized }));
  }
  return normalized;
}
