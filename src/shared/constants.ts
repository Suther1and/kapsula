import type { AppLocale, CaptureMode, ContentDna, OrbitDef } from './types';

export const MAX_TAGS_PER_ITEM = 6;
export const DEFAULT_MONTHLY_CAP_USD = 1.5;
export const SECRET_CLIPBOARD_WIPE_MS = 30_000;
export const CLIPPER_PORT_BASE = 47831;
export const CLIPPER_PORT_RANGE = 5;

export const SECTION_COLOR_PALETTE = [
  '#E86A33', // Kapsula Terracotta
  '#F5A524', // Warm Amber
  '#EAB308', // Honey Gold
  '#84CC16', // Lime Moss
  '#2EA06B', // Vault Emerald
  '#14B8A6', // Deep Teal
  '#06B6D4', // Cyan
  '#0EA5E9', // Sky Azure
  '#3B82F6', // Cobalt Blue
  '#6366F1', // Indigo
  '#8B5CF6', // Violet
  '#A855F7', // Purple
  '#D946EF', // Magenta
  '#EC4899', // Rose Pink
  '#F43F5E', // Crimson
  '#EF4444', // Coral Red
  '#F97316', // Tangelo
  '#FB7185', // Flamingo
  '#22C55E', // Mint Leaf
  '#38BDF8', // Glacier
  '#818CF8', // Periwinkle
  '#C084FC', // Lavender
  '#FBBF24', // Saffron
  '#A3E635', // Chartreuse
  '#2DD4BF', // Aqua
  '#D97706', // Ochre
  '#94A3B8', // Cool Slate
  '#A8A29E', // Warm Stone
];

export const SECTION_ICON_CHOICES = [
  'Dot',
  'Folder',
  'GameController',
  'Code',
  'Sparkle',
  'Palette',
  'BookmarkSimple',
  'FilmStrip',
  'Lightbulb',
  'ShieldCheck',
  'Receipt',
  'TerminalWindow',
  'Globe',
  'MusicNotes',
  'Camera',
  'Cpu',
  'RocketLaunch',
  'Sword',
  'Cube',
  'Compass',
  'BookOpen',
  'ChatCircleText',
  'Briefcase',
  'Heart',
  'Lightning',
] as const;

export type SectionIconKey = (typeof SECTION_ICON_CHOICES)[number];

export interface OrganicSectionTemplate {
  canonicalName: string;
  aliases: string[];
  description: string;
  icon: string;
  color: string;
}

export const ORGANIC_SECTION_CATALOG: OrganicSectionTemplate[] = [
  {
    canonicalName: 'Финансы',
    aliases: ['финанс', 'карт', 'банк', 'деньг', 'чек', 'оплат', 'бюджет', 'налог'],
    description: 'Банковские карты, чеки, счета, переводы и промокоды.',
    icon: 'Receipt',
    color: '#2EA06B',
  },
  {
    canonicalName: 'Контакты',
    aliases: ['контакт', 'телефон', 'люди', 'номер', 'мастер', 'связ'],
    description: 'Номера телефонов, ники, почты и нужные специалисты.',
    icon: 'ChatCircleText',
    color: '#06B6D4',
  },
  {
    canonicalName: 'Доступы',
    aliases: ['доступ', 'парол', 'сейф', 'ключ', 'токен', 'логин', 'аккаунт'],
    description: 'Пароли, ключи сервисов и конфиденциальные заметки.',
    icon: 'ShieldCheck',
    color: '#2EA06B',
  },
  {
    canonicalName: 'Код',
    aliases: ['код', 'разработ', 'програм', 'скрипт', 'терминал', 'dev', 'github', 'работа'],
    description: 'Сниппеты кода, команды терминала, репозитории и документация.',
    icon: 'Code',
    color: '#3B82F6',
  },
  {
    canonicalName: 'Дизайн',
    aliases: ['дизайн', 'референс', 'палитр', 'интерфейс', 'макет', 'шрифт', 'ui', 'ux'],
    description: 'Референсы интерфейсов, цветовые палитры, шрифты и вдохновение.',
    icon: 'Palette',
    color: '#EC4899',
  },
  {
    canonicalName: 'Встречи',
    aliases: ['встреч', 'звон', 'созвон', 'голос', 'аудио', 'митинг'],
    description: 'Голосовые заметки, записи звонков, итоги и договорённости.',
    icon: 'MusicNotes',
    color: '#F5A524',
  },
  {
    canonicalName: 'Документы',
    aliases: ['документ', 'доки', 'pdf', 'договор', 'паспорт', 'инструкц', 'файл'],
    description: 'PDF-файлы, договоры, билеты и важные документы.',
    icon: 'BookOpen',
    color: '#94A3B8',
  },
  {
    canonicalName: 'Покупки',
    aliases: ['покуп', 'заказ', 'товар', 'магазин', 'маркет', 'подар', 'wishlist'],
    description: 'Товары, заказы с маркетплейсов, цены и списки желаний.',
    icon: 'Briefcase',
    color: '#F97316',
  },
  {
    canonicalName: 'Поездки',
    aliases: ['поезд', 'путешеств', 'билет', 'отел', 'маршрут', 'перелёт', 'перелет'],
    description: 'Билеты, брони отелей, места и маршруты поездок.',
    icon: 'Compass',
    color: '#0EA5E9',
  },
  {
    canonicalName: 'Чтение',
    aliases: ['чтен', 'стат', 'книг', 'гайд', 'лекц', 'исслед'],
    description: 'Статьи, книги, конспекты и длинные разборы.',
    icon: 'BookmarkSimple',
    color: '#EAB308',
  },
  {
    canonicalName: 'Работа',
    aliases: ['работ', 'проект', 'клиент', 'офис', 'бизнес', 'карьер', 'work'],
    description: 'Рабочие задачи, проекты, планы, отчёты и важные договорённости.',
    icon: 'Briefcase',
    color: '#3B82F6',
  },
  {
    canonicalName: 'Учёба',
    aliases: ['учеб', 'учёб', 'курс', 'конспект', 'универ', 'экзамен', 'обучен', 'study'],
    description: 'Учебные конспекты, курсы, лекции, шпаргалки и экзамены.',
    icon: 'BookOpen',
    color: '#8B5CF6',
  },
  {
    canonicalName: 'Идеи',
    aliases: ['иде', 'мысл', 'черновик', 'вдохновен', 'творчеств', 'ideas'],
    description: 'Заметки на будущее, творческие идеи, черновики и вдохновение.',
    icon: 'Lightbulb',
    color: '#F5A524',
  },
  {
    canonicalName: 'Здоровье',
    aliases: ['здоров', 'спорт', 'врач', 'трениров', 'рецепт', 'питани', 'health'],
    description: 'Записи к врачам, тренировки, анализы, рецепты и привычки.',
    icon: 'Heart',
    color: '#EF4444',
  },
  {
    canonicalName: 'Игры',
    aliases: ['игр', 'game', 'хобби', 'досуг'],
    description: 'Игры, хобби, настолки, референсы и любимые увлечения.',
    icon: 'GameController',
    color: '#8B5CF6',
  },
];

// Legacy lookup only — NOT auto-seeded on empty vaults
export const DEFAULT_ORBITS: OrbitDef[] = [];

export const MODE_META: Record<
  CaptureMode,
  { id: CaptureMode; label: string; shortLabel: string; hint: string; color: string }
> = {
  autopilot: {
    id: 'autopilot',
    label: 'Умный разбор',
    shortLabel: 'Авто',
    hint: 'Сам наводит порядок и подбирает разделы для понятных записей',
    color: '#E86A33',
  },
  buffer: {
    id: 'buffer',
    label: 'Без сортировки',
    shortLabel: 'Черновик',
    hint: 'Сохраняет мгновенно во «Все записи» — разберёшь позже по желанию',
    color: '#94A3B8',
  },
  ghost: {
    id: 'ghost',
    label: 'Режим Сейфа',
    shortLabel: 'Сейф',
    hint: 'Сразу шифрует на диске и очищает буфер обмена через 30 секунд',
    color: '#2EA06B',
  },
  focus: {
    id: 'focus',
    label: 'Проект',
    shortLabel: 'Проект',
    hint: 'Привязывает все новые сохранения к выбранному проекту',
    color: '#3B82F6',
  },
};

export const DNA_META: Record<ContentDna, { id: ContentDna; label: string; accent: string }> = {
  note: { id: 'note', label: 'Заметки', accent: '#94A3B8' },
  shot: { id: 'shot', label: 'Картинки', accent: '#E4E4E7' },
  link: { id: 'link', label: 'Ссылки', accent: '#60A5FA' },
  secret: { id: 'secret', label: 'Сейф', accent: '#2EA06B' },
  snippet: { id: 'snippet', label: 'Код', accent: '#E86A33' },
  voice: { id: 'voice', label: 'Голос', accent: '#F43F5E' },
  doc: { id: 'doc', label: 'Файлы', accent: '#CBD5E1' },
};

const ORGANIC_SECTION_EN_BY_RU: Record<
  string,
  { canonicalName: string; description: string; extraAliases?: string[] }
> = {
  'Финансы': {
    canonicalName: 'Finance',
    description: 'Bank cards, receipts, invoices, transfers, and promo codes.',
    extraAliases: ['finance', 'bank', 'card', 'receipt', 'budget', 'tax'],
  },
  'Контакты': {
    canonicalName: 'Contacts',
    description: 'Phone numbers, handles, emails, and key specialists.',
    extraAliases: ['contact', 'phone', 'people', 'email'],
  },
  'Доступы': {
    canonicalName: 'Credentials',
    description: 'Passwords, service keys, and confidential notes.',
    extraAliases: ['credential', 'password', 'secret', 'vault', 'token', 'login'],
  },
  'Код': {
    canonicalName: 'Code',
    description: 'Code snippets, terminal commands, repositories, and docs.',
    extraAliases: ['code', 'dev', 'script', 'terminal', 'snippet'],
  },
  'Дизайн': {
    canonicalName: 'Design',
    description: 'UI references, color palettes, typography, and inspiration.',
    extraAliases: ['design', 'reference', 'palette', 'typography', 'mockup'],
  },
  'Встречи': {
    canonicalName: 'Meetings',
    description: 'Voice memos, call recordings, summaries, and action items.',
    extraAliases: ['meeting', 'call', 'voice', 'audio', 'sync'],
  },
  'Документы': {
    canonicalName: 'Documents',
    description: 'PDFs, contracts, tickets, and important paperwork.',
    extraAliases: ['document', 'docs', 'contract', 'passport', 'manual', 'file'],
  },
  'Покупки': {
    canonicalName: 'Shopping',
    description: 'Items, orders, prices, and wishlists.',
    extraAliases: ['shopping', 'shop', 'order', 'store', 'gift'],
  },
  'Поездки': {
    canonicalName: 'Travel',
    description: 'Tickets, hotel bookings, places, and itineraries.',
    extraAliases: ['travel', 'trip', 'ticket', 'hotel', 'flight', 'route'],
  },
  'Чтение': {
    canonicalName: 'Reading',
    description: 'Articles, books, study notes, and deep dives.',
    extraAliases: ['reading', 'article', 'book', 'guide', 'research'],
  },
  'Работа': {
    canonicalName: 'Work',
    description: 'Tasks, projects, plans, reports, and agreements.',
    extraAliases: ['work', 'project', 'client', 'office', 'business', 'career'],
  },
  'Учёба': {
    canonicalName: 'Study',
    description: 'Lecture notes, courses, cheat sheets, and exam prep.',
    extraAliases: ['study', 'course', 'lecture', 'exam', 'learning'],
  },
  'Идеи': {
    canonicalName: 'Ideas',
    description: 'Future notes, creative ideas, drafts, and inspiration.',
    extraAliases: ['idea', 'ideas', 'thought', 'draft', 'inspiration'],
  },
  'Здоровье': {
    canonicalName: 'Health',
    description: 'Doctor appointments, workouts, lab results, and recipes.',
    extraAliases: ['health', 'fitness', 'doctor', 'workout', 'recipe'],
  },
  'Игры': {
    canonicalName: 'Games',
    description: 'Games, hobbies, tabletop references, and inspirations.',
    extraAliases: ['game', 'games', 'hobby', 'gaming'],
  },
};

export function getOrganicSectionCatalog(locale: AppLocale = 'ru'): OrganicSectionTemplate[] {
  if (locale !== 'en') return ORGANIC_SECTION_CATALOG;
  return ORGANIC_SECTION_CATALOG.map((entry) => {
    const en = ORGANIC_SECTION_EN_BY_RU[entry.canonicalName];
    return en
      ? {
          ...entry,
          canonicalName: en.canonicalName,
          description: en.description,
          aliases: Array.from(
            new Set([
              ...entry.aliases,
              entry.canonicalName.toLowerCase(),
              ...(en.extraAliases ?? []),
            ])
          ),
        }
      : entry;
  });
}

export const MODE_META_EN: Record<
  CaptureMode,
  { id: CaptureMode; label: string; shortLabel: string; hint: string; color: string }
> = {
  autopilot: {
    id: 'autopilot',
    label: 'Smart Triage',
    shortLabel: 'Auto',
    hint: 'Automatically organizes clear entries into matching sections',
    color: '#E86A33',
  },
  buffer: {
    id: 'buffer',
    label: 'Quick Capture',
    shortLabel: 'Draft',
    hint: 'Saves straight to All Items so you can sort later if needed',
    color: '#94A3B8',
  },
  ghost: {
    id: 'ghost',
    label: 'Vault Mode',
    shortLabel: 'Vault',
    hint: 'Encrypts immediately on disk and clears the clipboard after 30 seconds',
    color: '#2EA06B',
  },
  focus: {
    id: 'focus',
    label: 'Project',
    shortLabel: 'Project',
    hint: 'Routes all new captures directly into the selected project',
    color: '#3B82F6',
  },
};

export function getModeMeta(locale: AppLocale = 'ru'): typeof MODE_META {
  return locale === 'en' ? MODE_META_EN : MODE_META;
}

export const DNA_META_EN: Record<ContentDna, { id: ContentDna; label: string; accent: string }> = {
  note: { id: 'note', label: 'Notes', accent: '#94A3B8' },
  shot: { id: 'shot', label: 'Images', accent: '#E4E4E7' },
  link: { id: 'link', label: 'Links', accent: '#60A5FA' },
  secret: { id: 'secret', label: 'Vault', accent: '#2EA06B' },
  snippet: { id: 'snippet', label: 'Code', accent: '#E86A33' },
  voice: { id: 'voice', label: 'Voice', accent: '#F43F5E' },
  doc: { id: 'doc', label: 'Files', accent: '#CBD5E1' },
};

export function getDnaMeta(locale: AppLocale = 'ru'): typeof DNA_META {
  return locale === 'en' ? DNA_META_EN : DNA_META;
}

const DEFAULT_STARTER_TAGS_RU = [
  'идея',
  'важно',
  'работа',
  'личное',
  'проект',
  'задача',
  'референс',
  'почитать',
] as const;

const DEFAULT_STARTER_TAGS_EN = [
  'idea',
  'important',
  'work',
  'personal',
  'project',
  'task',
  'reference',
  'to-read',
] as const;

export function getDefaultStarterTags(locale: AppLocale = 'ru'): readonly string[] {
  return locale === 'en' ? DEFAULT_STARTER_TAGS_EN : DEFAULT_STARTER_TAGS_RU;
}
