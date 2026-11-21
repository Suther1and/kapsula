import type { CaptureMode, ContentDna, OrbitDef } from './types';

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
