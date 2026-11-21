import type { AppLocale } from './types';

export interface NoteTemplate {
  id: 'meeting' | 'idea' | 'project' | 'day';
  label: string;
  shortLabel: string;
  description: string;
  icon: string;
  title: string;
  body: string;
  tags: string[];
}

export interface OnboardingOrbitPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface OnboardingWelcomeNote {
  title: string;
  summary: string;
  body: string;
  tags: string[];
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'meeting',
    label: 'Встреча',
    shortLabel: 'Встреча',
    description: 'Повестка, участники, главные тезисы и договорённости',
    icon: 'UsersThree',
    title: 'Итоги встречи',
    body: [
      '## Контекст',
      '- **Дата:** ',
      '- **Участники:** ',
      '',
      '## Что обсудили',
      '- Главная тема и ключевые аргументы',
      '',
      '## Договорённости и следующие шаги',
      '- [ ] Зафиксировать ключевое решение и отправить участникам',
      '- [ ] Назначить дату следующей проверки',
    ].join('\n'),
    tags: ['встреча'],
  },
  {
    id: 'idea',
    label: 'Идея',
    shortLabel: 'Идея',
    description: 'Суть мысли, зачем она нужна и первые шаги для проверки',
    icon: 'Lightbulb',
    title: 'Новая идея',
    body: [
      '## Суть в одной фразе',
      '',
      '## Зачем это нужно',
      '- Какую задачу решает или что заметно упростит',
      '',
      '## Первые шаги',
      '- [ ] Проверить гипотезу на простом примере',
      '- [ ] Собрать 2–3 референса или заметки по теме',
      '',
      '## Материалы и ссылки',
      '',
    ].join('\n'),
    tags: ['идея'],
  },
  {
    id: 'project',
    label: 'Проект',
    shortLabel: 'Проект',
    description: 'Цель, этапы, ближайшие задачи и ключевые материалы',
    icon: 'RocketLaunch',
    title: 'План проекта',
    body: [
      '## Цель',
      '',
      '## Этапы',
      '1. Подготовка и сбор вводных',
      '2. Основная работа',
      '3. Проверка и запуск',
      '',
      '## Ближайшие задачи',
      '- [ ] Определить первый измеримый результат',
      '- [ ] Разбить работу на шаги с понятными сроками',
      '',
      '## Ссылки и заметки',
      '',
    ].join('\n'),
    tags: ['проект'],
  },
  {
    id: 'day',
    label: 'План дня',
    shortLabel: 'План дня',
    description: 'Три главных приоритета, встречи и короткий итог дня',
    icon: 'SunHorizon',
    title: 'План на день',
    body: [
      '## Главные 3 дела',
      '- [ ] Самая важная задача дня',
      '- [ ] Вторая ключевая задача',
      '- [ ] Третий приоритет',
      '',
      '## Встречи и звонки',
      '',
      '## Мелкие дела',
      '- [ ] Разобрать входящие сообщения и мелочи',
      '',
      '## Итоги вечера',
      '- Что получилось лучше всего: ',
    ].join('\n'),
    tags: ['план'],
  },
];

export const ONBOARDING_PRESETS: {
  orbits: OnboardingOrbitPreset[];
  welcomeNote: OnboardingWelcomeNote;
} = {
  orbits: [
    {
      id: 'work',
      name: 'Работа',
      description: 'Задачи, проекты, встречи, заметки и рабочие материалы.',
      icon: 'Briefcase',
      color: '#3B82F6',
    },
    {
      id: 'personal',
      name: 'Личное',
      description: 'Повседневные заметки, покупки, планы и важные мелочи.',
      icon: 'Heart',
      color: '#EC4899',
    },
    {
      id: 'study',
      name: 'Учёба',
      description: 'Конспекты, книги, статьи, курсы и полезные разборы.',
      icon: 'BookOpen',
      color: '#8B5CF6',
    },
    {
      id: 'finance',
      name: 'Финансы',
      description: 'Чеки, счета, бюджет, подписки и важные платежи.',
      icon: 'Receipt',
      color: '#2EA06B',
    },
    {
      id: 'ideas',
      name: 'Идеи',
      description: 'Вдохновение, черновики, ссылки и мысли на будущее.',
      icon: 'Lightbulb',
      color: '#F5A524',
    },
  ],
  welcomeNote: {
    title: 'Добро пожаловать в Капсулу',
    summary: 'Короткий чек-лист, чтобы быстро освоиться и настроить пространство под себя',
    body: [
      'Капсула держит под рукой всё важное — заметки, фото, ссылки, задачи, календарь и защищённый Сейф.',
      '',
      '## С чего удобно начать',
      '- [ ] Создай первую заметку или вставь картинку прямо в текст из буфера обмена',
      '- [ ] Открой быструю панель для мгновенного поиска и заметок (сочетание клавиш можно изменить в Настройках)',
      '- [ ] Переключи вкладку «Задачи» в режим «Доска», чтобы раскладывать дела по колонкам',
      '- [ ] Загляни в «Сейф» — туда можно сохранить пароли, карты и одноразовые коды 2FA',
      '- [ ] Настрой внешний вид и облачную синхронизацию между компьютером и телефоном в Настройках',
    ].join('\n'),
    tags: ['старт'],
  },
};

export const NOTE_TEMPLATES_EN: NoteTemplate[] = [
  {
    id: 'meeting',
    label: 'Meeting',
    shortLabel: 'Meeting',
    description: 'Agenda, attendees, key points, and next steps',
    icon: 'UsersThree',
    title: 'Meeting Notes',
    body: [
      '## Context',
      '- **Date:** ',
      '- **Attendees:** ',
      '',
      '## Discussion',
      '- Main topic and key points',
      '',
      '## Decisions & Next Steps',
      '- [ ] Capture the key decision and share with attendees',
      '- [ ] Schedule follow-up check-in',
    ].join('\n'),
    tags: ['meeting'],
  },
  {
    id: 'idea',
    label: 'Idea',
    shortLabel: 'Idea',
    description: 'Core concept, why it matters, and first steps to test',
    icon: 'Lightbulb',
    title: 'New Idea',
    body: [
      '## One-Liner',
      '',
      '## Why It Matters',
      '- What problem it solves or noticeably simplifies',
      '',
      '## First Steps',
      '- [ ] Test the hypothesis with a quick prototype',
      '- [ ] Gather 2–3 references or related notes',
      '',
      '## Links & Materials',
      '',
    ].join('\n'),
    tags: ['idea'],
  },
  {
    id: 'project',
    label: 'Project',
    shortLabel: 'Project',
    description: 'Goal, milestones, next tasks, and key links',
    icon: 'RocketLaunch',
    title: 'Project Plan',
    body: [
      '## Goal',
      '',
      '## Milestones',
      '1. Prep & context gathering',
      '2. Core execution',
      '3. Review & launch',
      '',
      '## Next Tasks',
      '- [ ] Define the first measurable outcome',
      '- [ ] Break work into scoped tasks with dates',
      '',
      '## Links & Notes',
      '',
    ].join('\n'),
    tags: ['project'],
  },
  {
    id: 'day',
    label: 'Daily Plan',
    shortLabel: 'Daily Plan',
    description: 'Top three priorities, meetings, and end-of-day wrap-up',
    icon: 'SunHorizon',
    title: 'Daily Plan',
    body: [
      '## Top 3 Priorities',
      '- [ ] Most important task today',
      '- [ ] Second key task',
      '- [ ] Third priority',
      '',
      '## Meetings & Calls',
      '',
      '## Quick Tasks',
      '- [ ] Clear inbox and small follow-ups',
      '',
      '## Evening Wrap-Up',
      '- What went best today: ',
    ].join('\n'),
    tags: ['plan'],
  },
];

export const ONBOARDING_PRESETS_EN: {
  orbits: OnboardingOrbitPreset[];
  welcomeNote: OnboardingWelcomeNote;
} = {
  orbits: [
    {
      id: 'work',
      name: 'Work',
      description: 'Tasks, projects, meetings, notes, and work materials.',
      icon: 'Briefcase',
      color: '#3B82F6',
    },
    {
      id: 'personal',
      name: 'Personal',
      description: 'Everyday notes, shopping, plans, and important details.',
      icon: 'Heart',
      color: '#EC4899',
    },
    {
      id: 'study',
      name: 'Study',
      description: 'Notes, books, articles, courses, and deep dives.',
      icon: 'BookOpen',
      color: '#8B5CF6',
    },
    {
      id: 'finance',
      name: 'Finance',
      description: 'Receipts, bills, budgets, subscriptions, and payments.',
      icon: 'Receipt',
      color: '#2EA06B',
    },
    {
      id: 'ideas',
      name: 'Ideas',
      description: 'Inspiration, drafts, links, and thoughts for later.',
      icon: 'Lightbulb',
      color: '#F5A524',
    },
  ],
  welcomeNote: {
    title: 'Welcome to Kapsula',
    summary: 'A quick checklist to settle in and tailor your workspace',
    body: [
      'Kapsula keeps everything important close at hand — notes, images, links, tasks, calendar, and an encrypted Vault.',
      '',
      '## Good places to start',
      '- [ ] Create your first note or paste an image straight from the clipboard',
      '- [ ] Open Quick Launch for instant search and capture (you can change the shortcut in Settings)',
      '- [ ] Switch Tasks to Board view to organize items across custom columns',
      '- [ ] Explore the Vault — store passwords, bank cards, and 2FA codes safely',
      '- [ ] Customize appearance and set up encrypted Cloud Sync in Settings',
    ].join('\n'),
    tags: ['start'],
  },
};

export function getNoteTemplates(locale: AppLocale = 'ru'): NoteTemplate[] {
  return locale === 'en' ? NOTE_TEMPLATES_EN : NOTE_TEMPLATES;
}

export function getOnboardingPresets(locale: AppLocale = 'ru'): typeof ONBOARDING_PRESETS {
  return locale === 'en' ? ONBOARDING_PRESETS_EN : ONBOARDING_PRESETS;
}
