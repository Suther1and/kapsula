import type { SyncStatus } from '@shared/sync-contract';
import { redactSecrets } from '../../main/security/secret-shield';
import type { MobileAiConfig } from '../storage/mobile-store';

export interface MobileDiagnosticsInput {
  appVersionName: string;
  appVersionCode: number;
  platform: 'android' | 'web';
  viewportWidth: number;
  viewportHeight: number;
  foldMode: 'compact' | 'expanded';
  foldPosture: 'flat' | 'half-opened';
  itemCounts: {
    activeTotal: number;
    notes: number;
    secrets: number;
    tasksTotal: number;
    eventsTotal: number;
    orbits: number;
    boards: number;
    trashed: number;
    archived: number;
  };
  syncStatus: SyncStatus;
  aiConfig: MobileAiConfig;
  nowMs?: number;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_CRED_OR_QUERY_RE = /https?:\/\/[^\s"'<>]+/gi;
const LONG_TOKEN_RE = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{28,}\b/g;

export function sanitizeDiagnosticsError(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return 'none';
  let text = redactSecrets(raw.trim());
  text = text.replace(EMAIL_RE, '[redacted-email]');
  text = text.replace(UUID_RE, '[redacted-id]');
  text = text.replace(URL_CRED_OR_QUERY_RE, '[redacted-url]');
  text = text.replace(LONG_TOKEN_RE, '[redacted-token]');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

export function resolveDiagnosticsAiMode(
  aiConfig: MobileAiConfig,
  syncState: SyncStatus['state']
): 'personal_gemini' | 'personal_openrouter' | 'cloud_proxy' | 'off' {
  if (aiConfig.provider === 'google_ai_studio' && aiConfig.hasGoogleKey) {
    return 'personal_gemini';
  }
  if (aiConfig.provider === 'openrouter' && aiConfig.hasOpenRouterKey) {
    return 'personal_openrouter';
  }
  if (aiConfig.hasGoogleKey) return 'personal_gemini';
  if (aiConfig.hasOpenRouterKey) return 'personal_openrouter';
  if (syncState !== 'signed_out' && syncState !== 'awaiting_email_confirm') {
    return 'cloud_proxy';
  }
  return 'off';
}

export function buildMobileDiagnosticsReport(input: MobileDiagnosticsInput): string {
  const generatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const lastSyncIso = input.syncStatus.lastSyncAt
    ? new Date(input.syncStatus.lastSyncAt).toISOString()
    : 'none';
  const lastReconcileIso = input.syncStatus.lastReconcileAt
    ? new Date(input.syncStatus.lastReconcileAt).toISOString()
    : 'none';
  const aiMode = resolveDiagnosticsAiMode(input.aiConfig, input.syncStatus.state);
  const lastError = sanitizeDiagnosticsError(input.syncStatus.error);

  const lines = [
    'Kapsula Mobile Diagnostics (Redacted)',
    `generatedAt: ${generatedAt}`,
    `appVersion: ${input.appVersionName} (${input.appVersionCode})`,
    `platform: ${input.platform}`,
    `viewport: ${Math.round(input.viewportWidth)}x${Math.round(input.viewportHeight)}`,
    `fold: mode=${input.foldMode}, posture=${input.foldPosture}`,
    `counts: items=${input.itemCounts.activeTotal}, notes=${input.itemCounts.notes}, secrets=${input.itemCounts.secrets}, tasks=${input.itemCounts.tasksTotal}, events=${input.itemCounts.eventsTotal}, orbits=${input.itemCounts.orbits}, boards=${input.itemCounts.boards}, trash=${input.itemCounts.trashed}, archive=${input.itemCounts.archived}`,
    `sync: state=${input.syncStatus.state}, realtime=${input.syncStatus.realtimeConnected ? 'on' : 'off'}, pending=${input.syncStatus.pendingCount}, failed=${input.syncStatus.failedDirtyCount ?? 0}, syncedRecords=${input.syncStatus.syncedRecordsCount}, devices=${input.syncStatus.devices.length}, customServer=${input.syncStatus.hasCustomServer ? 'yes' : 'no'}`,
    `syncTimestamps: lastSync=${lastSyncIso}, lastReconcile=${lastReconcileIso}`,
    `aiMode: ${aiMode}`,
    `lastError: ${lastError}`,
  ];

  return lines.join('\n');
}
