export type PlanTier = 'free' | 'pro';

export type ProFeatureKey =
  | 'cloud_sync'
  | 'version_history'
  | 'ai_suite'
  | 'kanban_board'
  | 'reference_board'
  | 'integrations'
  | 'vault_totp'
  | 'vault_security_audit'
  | 'custom_theme_sliders'
  | 'email_forwarding';

export interface ProFeatureMeta {
  key: ProFeatureKey;
  title: string;
  description: string;
  minTier: PlanTier;
}

export const PRO_FEATURE_CATALOG: Record<ProFeatureKey, ProFeatureMeta> = {
  cloud_sync: {
    key: 'cloud_sync',
    title: 'Облачная синхронизация',
    description: 'Мгновенная зашифрованная синхронизация заметок, фото, календаря и Сейфа между всеми устройствами.',
    minTier: 'pro',
  },
  version_history: {
    key: 'version_history',
    title: 'История версий заметок',
    description: 'Автоматические снимки изменений с просмотром отличий и восстановлением любой прошлой версии.',
    minTier: 'pro',
  },
  ai_suite: {
    key: 'ai_suite',
    title: 'Умный помощник и расшифровка',
    description: 'Расшифровка голосовых, оформление заметок, выделение задач, умный разбор и поиск по смыслу.',
    minTier: 'pro',
  },
  kanban_board: {
    key: 'kanban_board',
    title: 'Канбан-доска задач',
    description: 'Гибкие колонки, приоритеты, сроки и перетаскивание задач прямо из заметок и голоса.',
    minTier: 'pro',
  },
  reference_board: {
    key: 'reference_board',
    title: 'Визуальная доска референсов',
    description: 'Свободный холст для раскладки картинок, заметок, ссылок и пометок по проектам.',
    minTier: 'pro',
  },
  integrations: {
    key: 'integrations',
    title: 'Интеграции и импорт',
    description: 'Двусторонняя синхронизация с Google Календарём, расширение для браузера и импорт архивов.',
    minTier: 'pro',
  },
  vault_totp: {
    key: 'vault_totp',
    title: 'Коды 2FA в Сейфе',
    description: 'Генерация одноразовых кодов подтверждения прямо рядом с паролями и копирование в один клик.',
    minTier: 'pro',
  },
  vault_security_audit: {
    key: 'vault_security_audit',
    title: 'Расширенная защита Сейфа',
    description: 'Автоблокировка по таймеру, защита экрана от записи, биометрия и защита истории буфера обмена.',
    minTier: 'pro',
  },
  custom_theme_sliders: {
    key: 'custom_theme_sliders',
    title: 'Тонкая настройка палитры',
    description: 'Свой цвет акцента и фона с автоматическим контролем читаемости текста.',
    minTier: 'pro',
  },
  email_forwarding: {
    key: 'email_forwarding',
    title: 'Пересылка писем в Капсулу',
    description: 'Личный адрес для сохранения писем и вложений, а также импорт писем в один клик.',
    minTier: 'pro',
  },
};

/**
 * Global paywall switch. Kept `false` while all Pro capabilities are open;
 * flipping this single flag enables tier enforcement without touching UI callers.
 */
export const isPaywallEnforced = false;

export function canUseFeature(_feature: ProFeatureKey, _tier?: PlanTier): boolean {
  if (!isPaywallEnforced) return true;
  return _tier === 'pro';
}
