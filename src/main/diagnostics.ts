import os from 'node:os';
import type { SyncStatus } from '@shared/sync-contract';
import type { AppLocale, AppUpdaterState, CloudAiQuotaStatus, SettingsState } from '@shared/types';
import { redactSecrets } from './security/secret-shield';

export interface DiagnosticsInput {
  locale?: AppLocale;
  appVersion: string;
  platform?: NodeJS.Platform;
  osRelease?: string;
  arch?: string;
  electronVersion?: string;
  nodeVersion?: string;
  stats: {
    total: number;
    inboxCount: number;
    pinnedCount: number;
    archivedCount: number;
    trashedCount?: number;
    byDna: Record<string, number>;
  };
  orbitsCount: number;
  boardsCount: number;
  calendarEventsCount: number;
  settings: Pick<
    SettingsState,
    'aiProvider' | 'hasGoogleAiKey' | 'hasOpenRouterKey' | 'hasMasterPin' | 'vaultUnlocked' | 'googleCalendarConnected'
  >;
  syncStatus?: SyncStatus | null;
  cloudQuota?: CloudAiQuotaStatus | null;
  updaterState?: AppUpdaterState | null;
  extraErrors?: Array<string | null | undefined>;
}

/**
 * Strips secrets, API keys, JWTs, emails, recovery keys, and local OS usernames from diagnostic text.
 */
export function sanitizeDiagnosticText(
  raw: string | null | undefined,
  locale: AppLocale = 'ru'
): string {
  if (!raw || !raw.trim()) return '';
  let text = redactSecrets(raw.trim());
  const isEn = locale === 'en';

  // Strip Supabase PATs, publishable keys, bearer tokens, JWTs, long hex/base64 tokens
  text = text.replace(/\bsbp_[A-Za-z0-9_-]{12,}\b/g, isEn ? '[token redacted]' : '[токен скрыт]');
  text = text.replace(
    /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{12,}\b/g,
    isEn ? '[key redacted]' : '[ключ скрыт]'
  );
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
    isEn ? '[token redacted]' : '[токен скрыт]'
  );
  text = text.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
    isEn ? 'Bearer [redacted]' : 'Bearer [скрыто]'
  );
  text = text.replace(
    /\bKAPS(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}\b/gi,
    isEn ? '[recovery key redacted]' : '[ключ восстановления скрыт]'
  );

  // Strip email addresses
  text = text.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    isEn ? '[email redacted]' : '[почта скрыта]'
  );

  // Strip URL query strings & credentials
  text = text.replace(
    /(https?:\/\/)([^\s/:@]+:[^\s/@]+@)/gi,
    isEn ? '$1[redacted]@' : '$1[скрыто]@'
  );
  text = text.replace(
    /(https?:\/\/[^\s?#]+)\?[^\s#]+/gi,
    isEn ? '$1?[params redacted]' : '$1?[параметры скрыты]'
  );

  // Strip local OS usernames in file paths
  text = text.replace(/([A-Za-z]:\\Users\\)([^\\/\s]+)/gi, '$1<user>');
  text = text.replace(/(\/Users\/)([^/\s]+)/g, '$1<user>');
  text = text.replace(/(\/home\/)([^/\s]+)/g, '$1<user>');

  // Strip long opaque hex/random secrets (>= 32 chars)
  text = text.replace(/\b[A-Fa-f0-9]{32,}\b/g, isEn ? '[id redacted]' : '[id скрыт]');

  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const locale: AppLocale = input.locale === 'en' ? 'en' : 'ru';
  const isEn = locale === 'en';
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const osRelease = input.osRelease ?? os.release();
  const electronVer = input.electronVersion ?? process.versions.electron ?? 'n/a';
  const nodeVer = input.nodeVersion ?? process.versions.node ?? 'n/a';

  const dnaSummary = Object.entries(input.stats.byDna || {})
    .filter(([, count]) => count > 0)
    .map(([k, count]) => `${k}:${count}`)
    .join(', ');

  const sync = input.syncStatus;
  const syncLine = sync
    ? isEn
      ? `State: ${sync.state} · account: ${sync.email ? 'connected' : 'not connected'} · realtime: ${sync.realtimeConnected ? 'yes' : 'no'} · queued: ${sync.pendingCount} · failed: ${sync.failedDirtyCount ?? 0} · devices: ${sync.devices?.length ?? 0} · server: ${sync.hasCustomServer ? 'custom' : 'default'}`
      : `Состояние: ${sync.state} · аккаунт: ${sync.email ? 'подключён' : 'не подключён'} · реалтайм: ${sync.realtimeConnected ? 'да' : 'нет'} · в очереди: ${sync.pendingCount} · с ошибкой: ${sync.failedDirtyCount ?? 0} · устройств: ${sync.devices?.length ?? 0} · сервер: ${sync.hasCustomServer ? 'свой' : 'стандартный'}`
    : isEn
      ? 'Not initialized'
      : 'Модуль не инициализирован';
  const lastSyncIso = sync?.lastSyncAt
    ? new Date(sync.lastSyncAt).toISOString()
    : isEn
      ? 'never'
      : 'не выполнялась';

  const aiMode =
    input.settings.hasGoogleAiKey || input.settings.hasOpenRouterKey
      ? isEn
        ? `personal key (${input.settings.aiProvider})`
        : `личный ключ (${input.settings.aiProvider})`
      : input.cloudQuota?.signedIn
        ? isEn
          ? `built-in AI (${input.settings.aiProvider})`
          : `встроенный ИИ (${input.settings.aiProvider})`
        : input.settings.aiProvider;

  const quotaLine = input.cloudQuota
    ? input.cloudQuota.usingPersonalKey
      ? isEn
        ? 'using personal key (no Kapsula limit)'
        : 'используется личный ключ (без лимита Kapsula)'
      : input.cloudQuota.signedIn
        ? isEn
          ? `spent $${input.cloudQuota.spentUsd.toFixed(2)} of $${input.cloudQuota.limitUsd.toFixed(2)} · requests: ${input.cloudQuota.requestCount} · available: ${input.cloudQuota.available ? 'yes' : 'no'}${input.cloudQuota.blocked ? ' · blocked' : ''}${input.cloudQuota.globalExhausted ? ' · global limit reached' : ''}`
          : `потрачено $${input.cloudQuota.spentUsd.toFixed(2)} из $${input.cloudQuota.limitUsd.toFixed(2)} · запросов: ${input.cloudQuota.requestCount} · доступен: ${input.cloudQuota.available ? 'да' : 'нет'}${input.cloudQuota.blocked ? ' · заблокирован' : ''}${input.cloudQuota.globalExhausted ? ' · общий лимит исчерпан' : ''}`
        : isEn
          ? 'not signed in'
          : 'не подключён (нужен вход в аккаунт)'
    : isEn
      ? 'no data'
      : 'нет данных';

  const updater = input.updaterState;
  const updaterLine = updater
    ? isEn
      ? `${updater.status} (mode: ${updater.mode}, latest: ${updater.latestVersion ?? '—'})`
      : `${updater.status} (режим: ${updater.mode}, последняя: ${updater.latestVersion ?? '—'})`
    : isEn
      ? 'no data'
      : 'нет данных';

  const errors: string[] = [];
  for (const rawErr of [sync?.error, updater?.error, input.cloudQuota?.error, ...(input.extraErrors ?? [])]) {
    const clean = sanitizeDiagnosticText(rawErr, locale);
    if (clean && !errors.includes(clean)) {
      errors.push(clean);
    }
  }

  const lines = isEn
    ? [
        '=== Kapsula Diagnostics ===',
        `Time (UTC): ${new Date().toISOString()}`,
        `Version: Kapsula v${input.appVersion}`,
        `System: ${platform} ${osRelease} (${arch}) · Electron ${electronVer} · Node ${nodeVer}`,
        `Database: ${input.stats.total} items (inbox: ${input.stats.inboxCount}, pinned: ${input.stats.pinnedCount}, archive: ${input.stats.archivedCount}, trash: ${input.stats.trashedCount ?? 0})`,
        `Item types: ${dnaSummary || 'empty'}`,
        `Structure: ${input.orbitsCount} sections · ${input.boardsCount} boards · ${input.calendarEventsCount} calendar events`,
        `Vault: master PIN ${input.settings.hasMasterPin ? 'enabled' : 'disabled'} · status ${input.settings.vaultUnlocked ? 'unlocked' : 'locked'}`,
        `Sync: ${syncLine}`,
        `Last sync: ${lastSyncIso}`,
        `Google Calendar: ${input.settings.googleCalendarConnected ? 'connected' : 'not connected'}`,
        `AI: ${aiMode} · Gemini key: ${input.settings.hasGoogleAiKey ? 'yes' : 'no'} · OpenRouter key: ${input.settings.hasOpenRouterKey ? 'yes' : 'no'}`,
        `Built-in AI quota: ${quotaLine}`,
        `Updates: ${updaterLine}`,
        `Last error: ${errors.length > 0 ? errors.join(' | ') : 'none'}`,
        'Notes, Vault secrets, emails, and API keys are strictly excluded from this report.',
      ]
    : [
        '=== Диагностика Kapsula ===',
        `Время (UTC): ${new Date().toISOString()}`,
        `Версия: Kapsula v${input.appVersion}`,
        `Система: ${platform} ${osRelease} (${arch}) · Electron ${electronVer} · Node ${nodeVer}`,
        `База: записей ${input.stats.total} (входящие: ${input.stats.inboxCount}, закреплено: ${input.stats.pinnedCount}, архив: ${input.stats.archivedCount}, корзина: ${input.stats.trashedCount ?? 0})`,
        `Типы записей: ${dnaSummary || 'пусто'}`,
        `Структура: разделов ${input.orbitsCount} · холстов ${input.boardsCount} · событий календаря ${input.calendarEventsCount}`,
        `Сейф: мастер-код ${input.settings.hasMasterPin ? 'включён' : 'выключен'} · статус ${input.settings.vaultUnlocked ? 'открыт' : 'заблокирован'}`,
        `Синхронизация: ${syncLine}`,
        `Последняя синхронизация: ${lastSyncIso}`,
        `Google Календарь: ${input.settings.googleCalendarConnected ? 'подключён' : 'не подключён'}`,
        `ИИ: ${aiMode} · Gemini ключ: ${input.settings.hasGoogleAiKey ? 'да' : 'нет'} · OpenRouter ключ: ${input.settings.hasOpenRouterKey ? 'да' : 'нет'}`,
        `Квота встроенного ИИ: ${quotaLine}`,
        `Обновления: ${updaterLine}`,
        `Последняя ошибка: ${errors.length > 0 ? errors.join(' | ') : 'нет'}`,
        'Заметки, секреты, почта и API-ключи полностью исключены из отчёта.',
      ];

  return lines.join('\n');
}
