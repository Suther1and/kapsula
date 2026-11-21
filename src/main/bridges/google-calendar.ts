import crypto from 'node:crypto';
import http from 'node:http';
import { shell } from 'electron';
import { parseRussianEvent } from '@shared/russian-event-parser';
import {
  DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SYNC_SUPABASE_URL,
} from '@shared/sync-contract';
import type { AppLocale, CalendarEventInput, CalendarSyncStatus } from '@shared/types';
import type { VaultRepository } from '../db/repository';
import type { VaultCrypto } from '../security/vault-crypto';

interface GoogleTokenBundle {
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
  email?: string;
  authMode?: 'proxy' | 'custom';
}

export interface GoogleCalendarBridgeOptions {
  getSupabaseConfig?: () => { url: string; key: string };
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  openExternal?: (url: string) => Promise<void> | void;
  oauthTimeoutMs?: number;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function parseRussianDateExpression(
  rawText: string,
  nowMs = Date.now(),
  locale: AppLocale = 'ru'
): {
  startAt: number;
  endAt: number;
  label: string;
} | null {
  const parsed = parseRussianEvent(rawText, nowMs, undefined, locale);
  if (!parsed) return null;
  return {
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    label: parsed.label,
  };
}

function parseIcalDateValue(raw: string): { ts: number; allDay: boolean } | null {
  const val = raw.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(val);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]) - 1;
    const d = Number(dateOnly[3]);
    return { ts: new Date(y, m, d, 0, 0, 0, 0).getTime(), allDay: true };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(val);
  if (dateTime) {
    const y = Number(dateTime[1]);
    const m = Number(dateTime[2]) - 1;
    const d = Number(dateTime[3]);
    const h = Number(dateTime[4]);
    const min = Number(dateTime[5]);
    const sec = Number(dateTime[6]);
    const ts = dateTime[7]
      ? Date.UTC(y, m, d, h, min, sec)
      : new Date(y, m, d, h, min, sec).getTime();
    return { ts, allDay: false };
  }
  return null;
}

export function parseIcalFeed(
  icsRaw: string,
  locale: AppLocale = 'ru'
): Array<CalendarEventInput & { externalId: string }> {
  // Unfold RFC 5545 folded lines
  const unfolded = (icsRaw || '').replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n');
  const events: Array<CalendarEventInput & { externalId: string }> = [];
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0] ?? '';
    const lines = body.split('\n');
    let uid = '';
    let summary = '';
    let description = '';
    let location = '';
    let startParsed: { ts: number; allDay: boolean } | null = null;
    let endParsed: { ts: number; allDay: boolean } | null = null;

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).split(';')[0]?.toUpperCase() ?? '';
      const val = line.slice(colonIdx + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
      if (key === 'UID') uid = val;
      else if (key === 'SUMMARY') summary = val;
      else if (key === 'DESCRIPTION') description = val;
      else if (key === 'LOCATION') location = val;
      else if (key === 'DTSTART') startParsed = parseIcalDateValue(val);
      else if (key === 'DTEND') endParsed = parseIcalDateValue(val);
    }

    if (!summary && !startParsed) continue;
    const startAt = startParsed?.ts ?? Date.now();
    const endAt = endParsed?.ts
      ? startParsed?.allDay && endParsed.ts > startAt
        ? endParsed.ts - 1000
        : endParsed.ts
      : startAt + (startParsed?.allDay ? 86_400_000 - 1000 : 3_600_000);
    events.push({
      externalId: uid || `ics:${startAt}:${summary.slice(0, 24)}`,
      title: summary || (locale === 'en' ? 'Event' : 'Событие'),
      notes: description,
      location,
      startAt,
      endAt: Math.max(startAt, endAt),
      allDay: Boolean(startParsed?.allDay),
      kind: 'event',
      color: '#3B82F6',
    });
  }
  return events;
}

function formatLocalIsoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function exportEventsToIcal(events: Array<{
  id: string;
  title: string;
  notes: string;
  location?: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
}>): string {
  const fmtUtc = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };
  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  };
  const escapeIcs = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const vevents = events.map((ev) => {
    const startLine = ev.allDay
      ? `DTSTART;VALUE=DATE:${fmtDate(ev.startAt)}`
      : `DTSTART:${fmtUtc(ev.startAt)}`;
    const endLine = ev.allDay
      ? `DTEND;VALUE=DATE:${fmtDate(Math.max(ev.endAt + 1000, ev.startAt + 86_400_000))}`
      : `DTEND:${fmtUtc(ev.endAt)}`;
    return [
      'BEGIN:VEVENT',
      `UID:${ev.id}@kapsula.local`,
      `DTSTAMP:${fmtUtc(Date.now())}`,
      startLine,
      endLine,
      `SUMMARY:${escapeIcs(ev.title)}`,
      ev.location ? `LOCATION:${escapeIcs(ev.location)}` : '',
      ev.notes ? `DESCRIPTION:${escapeIcs(ev.notes)}` : '',
      'END:VEVENT',
    ].filter(Boolean).join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kapsula//Calendar//RU',
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n');
}

export class GoogleCalendarBridge {
  private lastError: string | null = null;
  private authInFlight = false;
  private builtInOAuthCache: { enabled: boolean; clientId: string | null; fetchedAt: number } | null = null;

  constructor(
    private readonly repo: VaultRepository,
    private readonly cryptoVault: VaultCrypto,
    private readonly opts: GoogleCalendarBridgeOptions = {}
  ) {}

  private getFetch(): (input: string | URL, init?: RequestInit) => Promise<Response> {
    return this.opts.fetchFn ?? fetch;
  }

  private getSupabaseConfig(): { url: string; key: string } {
    if (this.opts.getSupabaseConfig) {
      const cfg = this.opts.getSupabaseConfig();
      if (cfg.url && cfg.key) {
        return { url: cfg.url.replace(/\/+$/, ''), key: cfg.key };
      }
    }
    return {
      url: DEFAULT_SYNC_SUPABASE_URL,
      key: DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
    };
  }

  public async fetchBuiltInOAuthConfig(
    forceRefresh = false
  ): Promise<{ enabled: boolean; clientId: string | null }> {
    if (
      !forceRefresh &&
      this.builtInOAuthCache &&
      Date.now() - this.builtInOAuthCache.fetchedAt < 60_000
    ) {
      return {
        enabled: this.builtInOAuthCache.enabled,
        clientId: this.builtInOAuthCache.clientId,
      };
    }

    try {
      const { url, key } = this.getSupabaseConfig();
      const resp = await this.getFetch()(`${url}/functions/v1/gcal-oauth`, {
        method: 'GET',
        headers: {
          apikey: key,
        },
        signal: AbortSignal.timeout(6_000),
      });
      if (!resp.ok) {
        const fallback = { enabled: false, clientId: null };
        this.builtInOAuthCache = { ...fallback, fetchedAt: Date.now() };
        return fallback;
      }
      const json = (await resp.json()) as { enabled?: boolean; clientId?: string | null };
      const clientId =
        typeof json.clientId === 'string' && json.clientId.trim() ? json.clientId.trim() : null;
      const enabled = Boolean(json.enabled && clientId);
      this.builtInOAuthCache = { enabled, clientId, fetchedAt: Date.now() };
      return { enabled, clientId };
    } catch {
      const fallback = { enabled: false, clientId: null };
      this.builtInOAuthCache = { ...fallback, fetchedAt: Date.now() };
      return fallback;
    }
  }

  private loadTokens(): GoogleTokenBundle | null {
    const enc = this.repo.getSetting('gcal_tokens_enc');
    if (!enc) return null;
    try {
      const res = this.cryptoVault.decryptConfigJson<GoogleTokenBundle>(enc);
      if (res.migratedFromVdk && res.value) {
        try {
          this.repo.setSetting('gcal_tokens_enc', this.cryptoVault.encryptConfigJson(res.value));
        } catch {
          // Non-fatal migration re-wrap
        }
      }
      return res.value ?? null;
    } catch {
      return null;
    }
  }

  private saveTokens(bundle: GoogleTokenBundle | null): void {
    if (!bundle) {
      this.repo.setSetting('gcal_tokens_enc', '');
      return;
    }
    this.repo.setSetting('gcal_tokens_enc', this.cryptoVault.encryptConfigJson(bundle));
  }

  public getStatus(): CalendarSyncStatus {
    const tokens = this.loadTokens();
    const clientId = this.repo.getSetting('gcal_client_id') || '';
    const icalUrl = this.repo.getSetting('gcal_ical_url') || '';
    const lastSyncRaw = this.repo.getSetting('gcal_last_sync_at');
    const lastSyncAt = lastSyncRaw ? Number(lastSyncRaw) || null : null;
    const hasRefresh = Boolean(tokens?.refreshToken);
    const authMode: CalendarSyncStatus['authMode'] = hasRefresh
      ? tokens?.authMode ?? (clientId ? 'custom' : 'proxy')
      : icalUrl
        ? 'ical'
        : null;
    return {
      connected: hasRefresh || Boolean(icalUrl),
      email: tokens?.email ?? null,
      clientId,
      icalUrl,
      lastSyncAt,
      error: this.lastError,
      hasCredentials: Boolean(hasRefresh && (authMode === 'proxy' || clientId)),
      builtInOAuthAvailable: Boolean(this.builtInOAuthCache?.enabled),
      authMode,
    };
  }

  public async getStatusWithRemoteCheck(forceRefresh = false): Promise<CalendarSyncStatus> {
    await this.fetchBuiltInOAuthConfig(forceRefresh).catch(() => ({
      enabled: false,
      clientId: null,
    }));
    return this.getStatus();
  }

  public saveConfig(input: { clientId?: string; icalUrl?: string }): CalendarSyncStatus {
    if (input.clientId !== undefined) {
      this.repo.setSetting('gcal_client_id', input.clientId.trim());
    }
    if (input.icalUrl !== undefined) {
      this.repo.setSetting('gcal_ical_url', input.icalUrl.trim());
    }
    this.lastError = null;
    return this.getStatus();
  }

  public disconnect(): CalendarSyncStatus {
    this.saveTokens(null);
    this.repo.setSetting('gcal_sync_token', '');
    this.repo.setSetting('gcal_ical_url', '');
    this.lastError = null;
    return this.getStatus();
  }

  public async connectOAuth(clientIdInput?: string): Promise<CalendarSyncStatus> {
    const isEn = this.repo.getLocale() === 'en';
    if (this.authInFlight) {
      throw new Error(
        isEn
          ? 'Google sign-in is already open in your browser.'
          : 'Авторизация в Google уже открыта в браузере.'
      );
    }

    const customClientId = (clientIdInput ?? this.repo.getSetting('gcal_client_id') ?? '').trim();
    let authMode: 'proxy' | 'custom' = 'custom';
    let effectiveClientId = customClientId;

    if (customClientId) {
      this.repo.setSetting('gcal_client_id', customClientId);
      authMode = 'custom';
    } else {
      const builtIn = await this.fetchBuiltInOAuthConfig(true);
      if (!builtIn.enabled || !builtIn.clientId) {
        throw new Error(
          isEn
            ? 'Built-in Google Calendar OAuth is being configured. Connect using your secret iCal link or enter a custom Client ID.'
            : 'Встроенный вход в Google Календарь пока настраивается. Подключи его по секретной ссылке календаря или укажи свой идентификатор клиента.'
        );
      }
      effectiveClientId = builtIn.clientId;
      authMode = 'proxy';
    }

    this.authInFlight = true;
    this.lastError = null;

    const codeVerifier = base64Url(crypto.randomBytes(48));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(16));
    const openExternalFn = this.opts.openExternal ?? ((url: string) => shell.openExternal(url));
    const fetchImpl = this.getFetch();
    const timeoutMs = this.opts.oauthTimeoutMs ?? 120_000;

    let server: http.Server | null = null;
    try {
      const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
        (resolve, reject) => {
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            fn();
          };

          const timeout = setTimeout(() => {
            finish(() =>
              reject(
                new Error(
                  isEn
                    ? 'Browser sign-in timed out.'
                    : 'Время ожидания входа через браузер истекло.'
                )
              )
            );
          }, timeoutMs);

          let boundRedirectUri = '';

          server = http.createServer((req, res) => {
            const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
            if (reqUrl.pathname === '/favicon.ico') {
              res.writeHead(204);
              res.end();
              return;
            }
            const errParam = reqUrl.searchParams.get('error');
            const returnedState = reqUrl.searchParams.get('state');
            const authCode = reqUrl.searchParams.get('code');

            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              Connection: 'close',
            });
            const htmlTitle = isEn
              ? 'Kapsula connected to Google Calendar'
              : 'Kapsula подключена к Google Календарю';
            const htmlBody = isEn
              ? 'You can close this tab and return to the app.'
              : 'Можешь закрыть эту вкладку и вернуться в приложение.';
            res.end(
              `<!doctype html><html lang="${isEn ? 'en' : 'ru'}"><head><meta charset="utf-8"><title>Kapsula</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#161614;color:#f4f3ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px;border-radius:16px;background:#20201d;border:1px solid rgba(255,255,255,0.08)"><h2 style="margin:0 0 10px">${htmlTitle}</h2><p style="margin:0;color:#b6b4ad">${htmlBody}</p></div></body></html>`
            );

            if (errParam) {
              finish(() =>
                reject(
                  new Error(
                    isEn
                      ? 'Access to Google Calendar was denied.'
                      : 'Доступ к Google Календарю был отклонён.'
                  )
                )
              );
            } else if (returnedState !== state || !authCode) {
              finish(() =>
                reject(
                  new Error(
                    isEn
                      ? 'Could not verify Google sign-in.'
                      : 'Не удалось подтвердить вход Google.'
                  )
                )
              );
            } else {
              finish(() => resolve({ code: authCode, redirectUri: boundRedirectUri }));
            }
          });

          server.listen(0, '127.0.0.1', () => {
            const addr = server?.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            if (!port) {
              finish(() =>
                reject(
                  new Error(
                    isEn
                      ? 'Could not open local port for sign-in.'
                      : 'Не удалось открыть локальный порт для входа.'
                  )
                )
              );
              return;
            }
            boundRedirectUri = `http://127.0.0.1:${port}/`;
            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('client_id', effectiveClientId);
            authUrl.searchParams.set('redirect_uri', boundRedirectUri);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set(
              'scope',
              'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email'
            );
            authUrl.searchParams.set('access_type', 'offline');
            authUrl.searchParams.set('prompt', 'consent');
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');
            authUrl.searchParams.set('state', state);
            void Promise.resolve(openExternalFn(authUrl.toString())).catch(() => {
              finish(() =>
                reject(
                  new Error(
                    isEn
                      ? 'Could not open browser for Google sign-in.'
                      : 'Не удалось открыть браузер для входа в Google.'
                  )
                )
              );
            });
          });
        }
      );

      let tokenResp: Response;
      if (authMode === 'proxy') {
        const { url: supaUrl, key: supaKey } = this.getSupabaseConfig();
        tokenResp = await fetchImpl(`${supaUrl}/functions/v1/gcal-oauth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supaKey,
          },
          body: JSON.stringify({
            action: 'exchange',
            code,
            redirectUri,
            codeVerifier,
          }),
          signal: AbortSignal.timeout(12_000),
        });
      } else {
        tokenResp = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: effectiveClientId,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier,
          }),
          signal: AbortSignal.timeout(12_000),
        });
      }

      if (!tokenResp.ok) {
        throw new Error(isEn ? 'Google rejected authorization code.' : 'Google не принял код авторизации.');
      }

      const rawTokenJson = (await tokenResp.json()) as {
        data?: { access_token?: string; refresh_token?: string; expires_in?: number };
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      const tokenJson = rawTokenJson.data ?? rawTokenJson;
      if (!tokenJson.access_token) {
        throw new Error(isEn ? 'Google did not return an access token.' : 'Google не вернул токен доступа.');
      }

      let email: string | undefined;
      try {
        const meResp = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
          signal: AbortSignal.timeout(6000),
        });
        if (meResp.ok) {
          const me = (await meResp.json()) as { email?: string };
          email = me.email;
        }
      } catch {
        // optional
      }

      const prev = this.loadTokens();
      this.saveTokens({
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token || prev?.refreshToken || '',
        expiresAt: Date.now() + (tokenJson.expires_in ?? 3500) * 1000,
        email: email || prev?.email,
        authMode,
      });

      await this.syncNow();
      return this.getStatus();
    } catch (err) {
      this.lastError =
        err instanceof Error
          ? err.message
          : isEn
            ? 'Google Calendar connection error'
            : 'Ошибка подключения Google Календаря';
      throw err;
    } finally {
      this.authInFlight = false;
      try {
        (server as http.Server | null)?.closeAllConnections?.();
      } catch {
        // ignore
      }
      try {
        (server as http.Server | null)?.close();
      } catch {
        // ignore
      }
    }
  }

  private async ensureValidAccessToken(): Promise<string | null> {
    const bundle = this.loadTokens();
    const clientId = this.repo.getSetting('gcal_client_id') || '';
    if (!bundle?.refreshToken && !bundle?.accessToken) return null;

    if (bundle.accessToken && bundle.expiresAt && bundle.expiresAt > Date.now() + 60_000) {
      return bundle.accessToken;
    }
    if (!bundle.refreshToken) return bundle.accessToken ?? null;

    const fetchImpl = this.getFetch();
    const useProxy = bundle.authMode === 'proxy' || !clientId;
    let resp: Response;

    if (useProxy) {
      const { url: supaUrl, key: supaKey } = this.getSupabaseConfig();
      resp = await fetchImpl(`${supaUrl}/functions/v1/gcal-oauth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supaKey,
        },
        body: JSON.stringify({
          action: 'refresh',
          refreshToken: bundle.refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      resp = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          refresh_token: bundle.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    }

    if (!resp.ok) return null;
    const rawJson = (await resp.json()) as {
      data?: { access_token?: string; expires_in?: number };
      access_token?: string;
      expires_in?: number;
    };
    const json = rawJson.data ?? rawJson;
    if (!json.access_token) return null;
    this.saveTokens({
      ...bundle,
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3500) * 1000,
    });
    return json.access_token;
  }

  public async syncNow(): Promise<{ imported: number; pushed: number; status: CalendarSyncStatus }> {
    let imported = 0;
    let pushed = 0;
    this.lastError = null;
    const fetchImpl = this.getFetch();

    // 1. Optional iCal Feed URL pull (zero OAuth setup!)
    const icalUrl = (this.repo.getSetting('gcal_ical_url') || '').trim();
    if (icalUrl && /^https?:\/\//i.test(icalUrl)) {
      try {
        const resp = await fetchImpl(icalUrl, { signal: AbortSignal.timeout(12_000) });
        if (resp.ok) {
          const text = await resp.text();
          const parsed = parseIcalFeed(text, this.repo.getLocale());
          for (const ev of parsed) {
            this.repo.upsertCalendarEvent({
              ...ev,
              externalSource: 'google_ical',
              externalId: ev.externalId,
            });
            imported++;
          }
        }
      } catch {
        const isEn = this.repo.getLocale() === 'en';
        this.lastError = isEn
          ? 'Could not load events from the iCal URL.'
          : 'Не удалось загрузить события по ссылке iCal.';
      }
    }

    // 2. Two-way Google Calendar API sync (if OAuth connected)
    const accessToken = await this.ensureValidAccessToken().catch(() => null);
    if (accessToken) {
      try {
        let syncToken = this.repo.getSetting('gcal_sync_token') || '';
        const pullAll = async (useSyncToken: string): Promise<void> => {
          let pageToken = '';
          let nextSyncToken = '';
          do {
            const u = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
            u.searchParams.set('singleEvents', 'true');
            if (useSyncToken) {
              u.searchParams.set('syncToken', useSyncToken);
            } else {
              u.searchParams.set('timeMin', new Date(Date.now() - 30 * 86_400_000).toISOString());
              u.searchParams.set('timeMax', new Date(Date.now() + 180 * 86_400_000).toISOString());
            }
            if (pageToken) u.searchParams.set('pageToken', pageToken);

            const r = await fetchImpl(u.toString(), {
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: AbortSignal.timeout(12_000),
            });
            if (r.status === 410 && useSyncToken) {
              this.repo.setSetting('gcal_sync_token', '');
              await pullAll('');
              return;
            }
            if (!r.ok) {
              throw new Error(`Google Calendar HTTP ${r.status}`);
            }
            const data = (await r.json()) as {
              nextPageToken?: string;
              nextSyncToken?: string;
              items?: Array<{
                id?: string;
                status?: string;
                summary?: string;
                description?: string;
                etag?: string;
                start?: { dateTime?: string; date?: string };
                end?: { dateTime?: string; date?: string };
              }>;
            };
            for (const gEv of data.items ?? []) {
              if (!gEv.id) continue;
              if (gEv.status === 'cancelled') {
                const existing = this.repo.findCalendarEventByExternalId('google_api', gEv.id);
                if (existing) this.repo.deleteCalendarEvent(existing.id);
                continue;
              }
              const allDay = Boolean(gEv.start?.date && !gEv.start?.dateTime);
              const startMs = gEv.start?.dateTime
                ? Date.parse(gEv.start.dateTime)
                : gEv.start?.date
                  ? Date.parse(`${gEv.start.date}T00:00:00`)
                  : Date.now();
              const endMs = gEv.end?.dateTime
                ? Date.parse(gEv.end.dateTime)
                : gEv.end?.date
                  ? Date.parse(`${gEv.end.date}T00:00:00`)
                  : startMs + 3_600_000;

              const gcalLocale = this.repo.getLocale();
              this.repo.upsertCalendarEvent({
                title: gEv.summary || (gcalLocale === 'en' ? 'Google Event' : 'Событие Google'),
                notes: gEv.description || '',
                startAt: Number.isFinite(startMs) ? startMs : Date.now(),
                endAt: Number.isFinite(endMs) ? endMs : startMs + 3_600_000,
                allDay,
                color: '#3B82F6',
                kind: 'event',
                externalSource: 'google_api',
                externalId: gEv.id,
                etag: gEv.etag ?? null,
              });
              imported++;
            }
            pageToken = data.nextPageToken ?? '';
            if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
          } while (pageToken);

          if (nextSyncToken) {
            this.repo.setSetting('gcal_sync_token', nextSyncToken);
          }
        };

        await pullAll(syncToken);

        // Push local Kapsula events created without externalId yet
        const localOnly = this.repo
          .listCalendarEvents()
          .filter((ev) => !ev.externalSource && ev.kind !== 'reminder')
          .slice(0, 20);
        for (const ev of localOnly) {
          const startDateStr = formatLocalIsoDate(ev.startAt);
          const minEndMs = new Date(ev.startAt).setHours(0, 0, 0, 0) + 86_400_000;
          const endDateStr = formatLocalIsoDate(Math.max(ev.endAt, minEndMs));
          const body = ev.allDay
            ? {
                summary: ev.title,
                description: ev.notes,
                start: { date: startDateStr },
                end: { date: endDateStr },
              }
            : {
                summary: ev.title,
                description: ev.notes,
                start: { dateTime: new Date(ev.startAt).toISOString() },
                end: { dateTime: new Date(ev.endAt).toISOString() },
              };
          const pushResp = await fetchImpl('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
          });
          if (pushResp.ok) {
            const createdRemote = (await pushResp.json()) as { id?: string; etag?: string };
            if (createdRemote.id) {
              this.repo.upsertCalendarEvent({
                id: ev.id,
                title: ev.title,
                notes: ev.notes,
                startAt: ev.startAt,
                endAt: ev.endAt,
                allDay: ev.allDay,
                color: ev.color,
                kind: ev.kind,
                isDone: ev.isDone,
                linkedItemId: ev.linkedItemId,
                externalSource: 'google_api',
                externalId: createdRemote.id,
                etag: createdRemote.etag ?? null,
              });
              pushed++;
            }
          }
        }
      } catch {
        const isEn = this.repo.getLocale() === 'en';
        this.lastError = isEn
          ? 'Google Calendar sync failed.'
          : 'Ошибка синхронизации с Google Календарём.';
      }
    }

    this.repo.setSetting('gcal_last_sync_at', String(Date.now()));
    return { imported, pushed, status: this.getStatus() };
  }
}
