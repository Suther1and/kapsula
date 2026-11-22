import type { TranslationKey } from '@shared/i18n/types';

export const PRIMARY_NAV_SECTIONS = [
  'flow',
  'notes',
  'media',
  'tasks',
  'calendar',
  'secrets',
] as const;

export type PrimaryNavSection = (typeof PRIMARY_NAV_SECTIONS)[number];

export const SIDEBAR_NAV_ORDER_KEY = 'kapsula.sidebar.primaryNavOrder';

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

function normalizePrimaryNavOrder(order: unknown): PrimaryNavSection[] {
  const allowed = new Set<string>(PRIMARY_NAV_SECTIONS);
  const result: PrimaryNavSection[] = [];
  const seen = new Set<PrimaryNavSection>();
  if (Array.isArray(order)) {
    for (const raw of order) {
      if (typeof raw === 'string' && allowed.has(raw)) {
        const sec = raw as PrimaryNavSection;
        if (!seen.has(sec)) {
          seen.add(sec);
          result.push(sec);
        }
      }
    }
  }
  for (const def of PRIMARY_NAV_SECTIONS) {
    if (!seen.has(def)) {
      seen.add(def);
      result.push(def);
    }
  }
  return result;
}

export function readPrimaryNavOrder(): PrimaryNavSection[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_NAV_ORDER_KEY);
    if (!raw) return [...PRIMARY_NAV_SECTIONS];
    const parsed = JSON.parse(raw);
    return normalizePrimaryNavOrder(parsed);
  } catch {
    return [...PRIMARY_NAV_SECTIONS];
  }
}

export function writePrimaryNavOrder(order: PrimaryNavSection[]): PrimaryNavSection[] {
  const normalized = normalizePrimaryNavOrder(order);
  try {
    localStorage.setItem(SIDEBAR_NAV_ORDER_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SIDEBAR_PREFS_EVENT, { detail: { order: normalized } }));
  }
  return normalized;
}

export function resetPrimaryNavOrder(): PrimaryNavSection[] {
  try {
    localStorage.removeItem(SIDEBAR_NAV_ORDER_KEY);
  } catch {
    // ignore storage errors
  }
  const defaults = [...PRIMARY_NAV_SECTIONS];
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SIDEBAR_PREFS_EVENT, { detail: { order: defaults } }));
  }
  return defaults;
}

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
