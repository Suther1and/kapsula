import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrbitDef } from '@shared/types';
import {
  DEFAULT_CLOUD_AI_QUOTA_ERROR,
  fetchCloudAiQuota,
  resolveAiRoute,
  type CloudAiProxyConfig,
} from '@main/ai/cloud-proxy';
import {
  askVaultWithAi,
  previewSmartTriageWithAi,
  runAiPipeline,
  synthesizeNotesWithAi,
} from '@main/ai/enricher';
import { transformNoteText } from '@main/ai/text-studio';
import { GoogleCalendarBridge } from '@main/bridges/google-calendar';
import { VaultRepository } from '@main/db/repository';
import { buildDiagnosticsReport, sanitizeDiagnosticText } from '@main/diagnostics';
import { transcribeAudioFile } from '@main/pipeline/audio-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';
import {
  AppUpdaterController,
  SETTINGS_REFRESH_INTERVAL_MS,
  compareSemver,
  isAllowedDownloadUrl,
  isNewerVersion,
  selectReleaseAsset,
  type AutoUpdaterLike,
} from '@main/updater';

const ROOT = path.resolve(import.meta.dirname, '..');
const tempDirs: string[] = [];
const repos: VaultRepository[] = [];

const SAMPLE_ORBITS: OrbitDef[] = [
  {
    id: 'work',
    name: 'Работа',
    description: 'Задачи и проекты',
    icon: 'Briefcase',
    color: '#3B82F6',
    sortOrder: 1,
    isBuiltin: false,
  },
  {
    id: 'personal',
    name: 'Личное',
    description: 'Идеи и планы',
    icon: 'Heart',
    color: '#E86A33',
    sortOrder: 2,
    isBuiltin: false,
  },
];

function createTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-cloud-feat-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  repos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  return { dir, repo, cryptoVault };
}

afterEach(() => {
  while (repos.length > 0) repos.pop()!.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('In-App Cloud Updater (semver, asset matching, Win auto + Mac dmg)', () => {
  it('compares semver strings accurately including v-prefix and pre-releases', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('v1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1', '1.0.1')).toBe(0);
    expect(compareSemver('1.0.1', '1.0.1-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1-beta.2', '1.0.1-beta.1')).toBeGreaterThan(0);
    expect(isNewerVersion('1.0.2', '1.0.1')).toBe(true);
    expect(isNewerVersion('1.0.1', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('invalid-tag', '1.0.1')).toBe(false);
  });

  it('selects matching release assets per OS/arch and rejects untrusted hosts', () => {
    const assets = [
      {
        name: 'Kapsula-1.0.2-windows.exe',
        browser_download_url:
          'https://github.com/Suther1and/kapsula/releases/download/v1.0.2/Kapsula-1.0.2-windows.exe',
      },
      {
        name: 'Kapsula-1.0.2-windows.exe.blockmap',
        browser_download_url:
          'https://github.com/Suther1and/kapsula/releases/download/v1.0.2/Kapsula-1.0.2-windows.exe.blockmap',
      },
      {
        name: 'Kapsula-1.0.2-mac-apple-silicon.dmg',
        browser_download_url:
          'https://github.com/Suther1and/kapsula/releases/download/v1.0.2/Kapsula-1.0.2-mac-apple-silicon.dmg',
      },
      {
        name: 'Kapsula-1.0.2-mac-intel.dmg',
        browser_download_url:
          'https://github.com/Suther1and/kapsula/releases/download/v1.0.2/Kapsula-1.0.2-mac-intel.dmg',
      },
      {
        name: 'Kapsula-1.0.2-evil.dmg',
        browser_download_url: 'https://evil.example.com/Kapsula-1.0.2-mac-apple-silicon.dmg',
      },
    ];

    expect(selectReleaseAsset(assets, 'darwin', 'arm64')?.name).toBe('Kapsula-1.0.2-mac-apple-silicon.dmg');
    expect(selectReleaseAsset(assets, 'darwin', 'x64')?.name).toBe('Kapsula-1.0.2-mac-intel.dmg');
    expect(selectReleaseAsset(assets, 'win32', 'x64')?.name).toBe('Kapsula-1.0.2-windows.exe');
    expect(isAllowedDownloadUrl('https://evil.example.com/Kapsula.exe')).toBe(false);
    expect(
      isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/foo')
    ).toBe(true);
    expect(
      selectReleaseAsset([assets[4]!], 'darwin', 'arm64')
    ).toBeNull();

    // Legacy release names remain supported for backward compatibility
    expect(
      selectReleaseAsset(
        [
          {
            name: 'Kapsula-Setup-1.0.1.exe',
            browser_download_url:
              'https://github.com/Suther1and/kapsula/releases/download/v1.0.1/Kapsula-Setup-1.0.1.exe',
          },
          {
            name: 'Kapsula-1.0.1-arm64.dmg',
            browser_download_url:
              'https://github.com/Suther1and/kapsula/releases/download/v1.0.1/Kapsula-1.0.1-arm64.dmg',
          },
        ],
        'win32',
        'x64'
      )?.name
    ).toBe('Kapsula-Setup-1.0.1.exe');
  });

  it('runs macOS manual-download GitHub release check and opens matching .dmg', async () => {
    const openedUrls: string[] = [];
    let dismissed: string | null = null;
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.2',
          body: 'Новые фичи и фиксы',
          html_url: 'https://github.com/Suther1and/kapsula/releases/tag/v1.0.2',
          assets: [
            {
              name: 'Kapsula-1.0.2-mac-apple-silicon.dmg',
              browser_download_url:
                'https://github.com/Suther1and/kapsula/releases/download/v1.0.2/Kapsula-1.0.2-mac-apple-silicon.dmg',
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    const updater = new AppUpdaterController({
      currentVersion: '1.0.1',
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      disableTimers: true,
      fetchFn: mockFetch,
      openExternal: (url) => {
        openedUrls.push(url);
      },
      getDismissedVersion: () => dismissed,
      setDismissedVersion: (v) => {
        dismissed = v;
      },
    });

    const st = await updater.checkForUpdates({ silent: false });
    expect(st.status).toBe('available');
    expect(st.mode).toBe('manual-download');
    expect(st.latestVersion).toBe('1.0.2');
    expect(st.downloadUrl).toContain('Kapsula-1.0.2-mac-apple-silicon.dmg');

    await updater.downloadUpdate();
    expect(openedUrls[0]).toContain('Kapsula-1.0.2-mac-apple-silicon.dmg');

    updater.dismissUpdate('1.0.2');
    expect(updater.getState().dismissedVersion).toBe('1.0.2');
  });

  it('runs Windows autoUpdater flow and falls back to GitHub API when autoUpdater errors', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const quitAndInstall = vi.fn();

    const fakeAutoUpdater: AutoUpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      on(ev, fn) {
        const list = listeners.get(ev) ?? [];
        list.push(fn);
        listeners.set(ev, list);
      },
      async checkForUpdates() {
        return { updateInfo: { version: '1.0.3', releaseNotes: 'Bug fixes' } };
      },
      async downloadUpdate() {
        for (const fn of listeners.get('download-progress') ?? []) fn({ percent: 62 });
        for (const fn of listeners.get('update-downloaded') ?? []) fn({ version: '1.0.3' });
      },
      quitAndInstall,
    };

    const winUpdater = new AppUpdaterController({
      currentVersion: '1.0.1',
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      disableTimers: true,
      loadAutoUpdater: async () => fakeAutoUpdater,
    });

    const avail = await winUpdater.checkForUpdates({ silent: false });
    expect(avail.status).toBe('available');
    expect(avail.mode).toBe('auto');
    expect(fakeAutoUpdater.autoDownload).toBe(false);
    expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(true);

    const dl = await winUpdater.downloadUpdate();
    expect(dl.status).toBe('downloaded');
    expect(dl.percent).toBe(100);

    const installed = await winUpdater.installUpdate();
    expect(installed.ok).toBe(true);
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);

    // Fallback when latest.yml is missing (autoUpdater throws)
    const fallbackUpdater = new AppUpdaterController({
      currentVersion: '1.0.1',
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      disableTimers: true,
      loadAutoUpdater: async () => ({
        ...fakeAutoUpdater,
        async checkForUpdates() {
          throw new Error('Cannot find latest.yml');
        },
      }),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v1.0.4',
            assets: [
              {
                name: 'Kapsula-1.0.4-windows.exe',
                browser_download_url:
                  'https://github.com/Suther1and/kapsula/releases/download/v1.0.4/Kapsula-1.0.4-windows.exe',
              },
            ],
          }),
          { status: 200 }
        )) as typeof fetch,
    });

    const fb = await fallbackUpdater.checkForUpdates({ silent: false });
    expect(fb.status).toBe('available');
    expect(fb.mode).toBe('manual-download');
    expect(fb.downloadUrl).toContain('Kapsula-1.0.4-windows.exe');
  });

  it('keeps silent startup errors quiet while manual errors show friendly Russian text', async () => {
    const failingFetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;

    const updater = new AppUpdaterController({
      currentVersion: '1.0.1',
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      disableTimers: true,
      fetchFn: failingFetch,
    });

    const silentState = await updater.checkForUpdates({ silent: true });
    expect(silentState.status).toBe('idle');
    expect(silentState.error).toBeNull();

    const manualState = await updater.checkForUpdates({ silent: false });
    expect(manualState.status).toBe('error');
    expect(manualState.error).toContain('Не удалось проверить обновления');
  });

  it('silently refreshes stale update state every 10 minutes on Settings open and right before downloading', async () => {
    expect(SETTINGS_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000);

    let nowMs = 1_000_000;
    let releaseTag = 'v1.0.4';
    let fetchCalls = 0;
    let failNextFetch = false;
    const seenStatuses: string[] = [];
    const openedUrls: string[] = [];

    const updater = new AppUpdaterController({
      currentVersion: '1.0.2',
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      disableTimers: true,
      now: () => nowMs,
      onStateChanged: (st) => {
        seenStatuses.push(st.status);
      },
      openExternal: (url) => {
        openedUrls.push(url);
      },
      fetchFn: (async () => {
        fetchCalls += 1;
        if (failNextFetch) {
          throw new Error('Network unavailable');
        }
        const ver = releaseTag.replace(/^v/, '');
        return new Response(
          JSON.stringify({
            tag_name: releaseTag,
            assets: [
              {
                name: `Kapsula-${ver}-mac-apple-silicon.dmg`,
                browser_download_url: `https://github.com/Suther1and/kapsula/releases/download/${releaseTag}/Kapsula-${ver}-mac-apple-silicon.dmg`,
              },
            ],
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });

    // Initial silent check picks up 1.0.4
    const initial = await updater.checkForUpdates({ silent: true });
    expect(initial.latestVersion).toBe('1.0.4');
    expect(fetchCalls).toBe(1);
    expect(seenStatuses).not.toContain('checking');

    // New release 1.0.5 lands, Settings opens 5 minutes later -> within 10m window, uses cache
    releaseTag = 'v1.0.5';
    nowMs += 5 * 60 * 1000;
    const withinWindow = await updater.refreshIfStale(SETTINGS_REFRESH_INTERVAL_MS);
    expect(fetchCalls).toBe(1);
    expect(withinWindow.latestVersion).toBe('1.0.4');

    // Settings opens 11 minutes after initial check -> silently upgrades cached 1.0.4 -> 1.0.5 without flicker
    nowMs += 6 * 60 * 1000;
    const refreshed = await updater.refreshIfStale(SETTINGS_REFRESH_INTERVAL_MS);
    expect(fetchCalls).toBe(2);
    expect(refreshed.latestVersion).toBe('1.0.5');
    expect(refreshed.downloadUrl).toContain('Kapsula-1.0.5-mac-apple-silicon.dmg');
    expect(seenStatuses).not.toContain('checking');

    // Release 1.0.6 lands; user clicks Download 60s later -> downloadUpdate() refreshes URL first
    releaseTag = 'v1.0.6';
    nowMs += 60 * 1000;
    await updater.downloadUpdate();
    expect(fetchCalls).toBe(3);
    expect(openedUrls[0]).toContain('Kapsula-1.0.6-mac-apple-silicon.dmg');

    // Network fails right before another Download click 60s later -> falls back to cached 1.0.6 cleanly
    failNextFetch = true;
    nowMs += 60 * 1000;
    const afterFailureDl = await updater.downloadUpdate();
    expect(fetchCalls).toBe(4);
    expect(afterFailureDl.status).toBe('available');
    expect(openedUrls[1]).toContain('Kapsula-1.0.6-mac-apple-silicon.dmg');

    // Never clobbers active Windows downloading or downloaded states
    let winChecks = 0;
    let dlProgressCb: ((prog: { percent: number }) => void) | null = null;
    const activeWin = new AppUpdaterController({
      currentVersion: '1.0.2',
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      disableTimers: true,
      now: () => nowMs,
      fetchFn: (async () => {
        throw new Error('unexpected-network-fetch');
      }) as typeof fetch,
      loadAutoUpdater: async () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        on: (ev, cb) => {
          if (ev === 'download-progress') dlProgressCb = cb as (prog: { percent: number }) => void;
        },
        checkForUpdates: async () => {
          winChecks += 1;
          return { updateInfo: { version: '1.0.5' } };
        },
        downloadUpdate: async () => {
          dlProgressCb?.({ percent: 45 });
        },
        quitAndInstall: () => {},
      }),
    });
    await activeWin.checkForUpdates({ silent: false });
    nowMs += 60 * 1000;
    await activeWin.downloadUpdate();
    expect(activeWin.getState().status).toBe('downloading');
    expect(winChecks).toBe(2); // initial check + pre-download refresh (>30s stale)

    nowMs += 20 * 60 * 1000;
    const whileDownloading = await activeWin.refreshIfStale(SETTINGS_REFRESH_INTERVAL_MS);
    expect(whileDownloading.status).toBe('downloading');
    expect(whileDownloading.percent).toBe(45);
    expect(winChecks).toBe(2);
  });
});

describe('Shared Cloud AI Proxy Routing Priority, 429 Quota & Secret Shield', () => {
  const mockProxy: CloudAiProxyConfig = {
    supabaseUrl: 'https://gxkvuwipzbqocbxgyqty.supabase.co',
    supabasePublishableKey: 'sb_publishable_test_key',
    getAccessToken: async () => 'jwt-user-token-123',
  };

  it('gives Priority 1 to personal API key over Cloud Proxy, and Priority 2 to Cloud Proxy when signed in', async () => {
    const p1 = await resolveAiRoute({
      provider: 'google_ai_studio',
      apiKey: 'AIzaPersonalKey1234567890',
      cloudProxy: mockProxy,
    });
    expect(p1.mode).toBe('personal');
    expect(p1.apiKey).toBe('AIzaPersonalKey1234567890');

    // Even if user selected google_ai_studio without a Google key, a saved personal OpenRouter key beats proxy
    const p1Alt = await resolveAiRoute({
      provider: 'google_ai_studio',
      apiKey: null,
      openRouterKey: 'sk-or-v1-personal-key',
      cloudProxy: mockProxy,
    });
    expect(p1Alt.mode).toBe('personal');
    expect(p1Alt.provider).toBe('openrouter');

    // No personal key + signed in -> Cloud Proxy
    const p2 = await resolveAiRoute({
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
    });
    expect(p2.mode).toBe('cloud_proxy');
    expect(p2.accessToken).toBe('jwt-user-token-123');

    // Explicitly local -> never uses Cloud Proxy
    const localOnly = await resolveAiRoute({
      provider: 'local',
      apiKey: null,
      cloudProxy: mockProxy,
    });
    expect(localOnly.mode).toBe('local');
  });

  it('routes runAiPipeline through /functions/v1/ai-proxy with Bearer + apikey headers when signed in without personal key', async () => {
    const { repo } = createTempVault();
    const calls: Array<{ url: string; auth: string | null; apikey: string | null; body: Record<string, unknown> }> = [];

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({
        url: String(url),
        auth: headers.get('Authorization'),
        apikey: headers.get('apikey'),
        body: parsedBody,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        orbit: 'work',
                        dna: 'note',
                        confidence: 0.94,
                        needs_enrichment: false,
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 24 },
          },
          quota: { spentUsd: 0.01, limitUsd: 1, remainingUsd: 0.99 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const out = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
      contentHash: 'hash-proxy-1',
      rawText: 'Подготовить план спринта по проекту',
      domain: null,
      hasImage: false,
      orbits: SAMPLE_ORBITS,
      localBaseline: {
        orbit: '',
        dna: 'note',
        title: 'План спринта',
        summary: '',
        tags: [],
      },
      fetchFn: mockFetch,
    });

    expect(out.usedCloud).toBe(true);
    expect(out.orbit).toBe('work');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gxkvuwipzbqocbxgyqty.supabase.co/functions/v1/ai-proxy');
    expect(calls[0]!.auth).toBe('Bearer jwt-user-token-123');
    expect(calls[0]!.apikey).toBe('sb_publishable_test_key');
    expect(calls[0]!.body.action).toBe('gemini');
    expect(calls[0]!.body.model).toBe('gemini-2.5-flash-lite');
  });

  it('surfaces friendly Russian HTTP 429 quota message without crashing or double-retrying', async () => {
    const { repo } = createTempVault();
    const item = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Идея по рендеру',
      body: 'Нужно улучшить тени в игровом движке',
      summary: 'Тени и освещение',
      tags: ['gamedev'],
      source: 'vault_ui',
      contentHash: 'h-429-1',
      aiStatus: 'local',
    });

    let callCount = 0;
    const quota429Fetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'user_quota_exceeded',
          error: DEFAULT_CLOUD_AI_QUOTA_ERROR,
        }),
        { status: 429 }
      );
    }) as typeof fetch;

    const triage = await previewSmartTriageWithAi({
      repo,
      items: [item],
      orbits: SAMPLE_ORBITS,
      boards: [],
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
      fetchFn: quota429Fetch,
    });
    expect(callCount).toBe(1); // Must NOT retry fallback model on monthly quota exhaustion
    expect(triage.usedCloud).toBe(false);
    expect(triage.message).toBe(DEFAULT_CLOUD_AI_QUOTA_ERROR);

    const askRes = await askVaultWithAi({
      repo,
      question: 'тени в игровом движке',
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
      fetchFn: quota429Fetch,
    });
    expect(askRes.answer).toContain('Месячный лимит общего ИИ ($1,00) исчерпан');

    const audioRes = await transcribeAudioFile({
      buffer: Buffer.from('RIFF....WAVEfmt '),
      mime: 'audio/wav',
      aiProvider: 'google_ai_studio',
      cloudProxy: mockProxy,
      fetchFn: quota429Fetch,
    });
    expect(audioRes.ok).toBe(false);
    expect(audioRes.error).toBe(DEFAULT_CLOUD_AI_QUOTA_ERROR);
  });

  it('NEVER transmits secret items or raw secrets to the Cloud AI Proxy', async () => {
    const { repo } = createTempVault();
    const sentBodies: string[] = [];
    const spyingFetch = (async (_url: string | URL, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ''));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            candidates: [{ content: { parts: [{ text: '{"title":"Ок","formattedText":"Ок"}' }] } }],
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    // 1. Secret VaultItem is strictly excluded from synthesizeNotesWithAi
    const secretItem = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'Сбербанк · •••• 4242',
      body: 'SUPER_SECRET_PASSWORD_999',
      summary: 'Карта',
      tags: ['сейф'],
      source: 'vault_ui',
      contentHash: 'sec-1',
      aiStatus: 'skipped_secret',
    });

    await synthesizeNotesWithAi({
      repo,
      items: [secretItem],
      mode: 'spec',
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
      orbits: SAMPLE_ORBITS,
      fetchFn: spyingFetch,
    });
    expect(sentBodies).toHaveLength(0);

    // 2. Inline API key in transformNoteText is masked BEFORE reaching cloud proxy
    const rawKey = 'sk-or-v1-1234567890abcdef1234567890abcdef';
    const transformed = await transformNoteText({
      text: `Починить интеграцию с ключом ${rawKey} завтра утром`,
      preset: 'polish',
      provider: 'google_ai_studio',
      apiKey: null,
      cloudProxy: mockProxy,
      fetchFn: spyingFetch,
    });
    for (const payload of sentBodies) {
      expect(payload).not.toContain(rawKey);
    }
    expect(transformed.formattedText).toContain(rawKey);
  });

  it('fetches Cloud AI monthly quota status cleanly', async () => {
    const quota = await fetchCloudAiQuota({
      cloudProxy: mockProxy,
      hasGoogleKey: false,
      hasOpenRouterKey: false,
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            spentUsd: 0.04,
            limitUsd: 1.0,
            remainingUsd: 0.96,
            requestCount: 12,
            blocked: false,
            globalExhausted: false,
            providers: { google: true, openrouter: true },
            month: '2026-11',
          }),
          { status: 200 }
        )) as typeof fetch,
    });

    expect(quota.signedIn).toBe(true);
    expect(quota.available).toBe(true);
    expect(quota.spentUsd).toBeCloseTo(0.04);
    expect(quota.remainingUsd).toBeCloseTo(0.96);
    expect(quota.requestCount).toBe(12);

    const signedOut = await fetchCloudAiQuota({
      cloudProxy: { ...mockProxy, getAccessToken: async () => null },
      hasGoogleKey: false,
      hasOpenRouterKey: false,
    });
    expect(signedOut.signedIn).toBe(false);
    expect(signedOut.available).toBe(false);
  });
});

describe('Redacted Diagnostics Report', () => {
  it('redacts all secrets, API keys, JWTs, emails, recovery keys, and OS usernames', () => {
    const leak =
      'Ошибка у alice@example.com в C:\\Users\\alice\\AppData с ключом AIzaSyDTestSecretKey123456789012345678901 и токеном sbp_TestDummyToken1234567890123456789012 и KAPS-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789';
    const clean = sanitizeDiagnosticText(leak);
    expect(clean).not.toContain('alice@example.com');
    expect(clean).not.toContain('\\Users\\alice');
    expect(clean).not.toContain('AIzaSyDTestSecretKey');
    expect(clean).not.toContain('sbp_TestDummyToken1234567890123456789012');
    expect(clean).not.toContain('KAPS-ABCD');

    const report = buildDiagnosticsReport({
      appVersion: '1.0.1',
      platform: 'win32',
      osRelease: '10.0.22631',
      arch: 'x64',
      stats: {
        total: 42,
        inboxCount: 5,
        pinnedCount: 3,
        archivedCount: 2,
        trashedCount: 1,
        byDna: { note: 30, link: 10, secret: 2 },
      },
      orbitsCount: 4,
      boardsCount: 2,
      calendarEventsCount: 7,
      settings: {
        aiProvider: 'google_ai_studio',
        hasGoogleAiKey: false,
        hasOpenRouterKey: false,
        hasMasterPin: true,
        vaultUnlocked: false,
        googleCalendarConnected: true,
      },
      syncStatus: {
        state: 'synced',
        email: 'private-user@secretmail.com',
        userId: '11111111-2222-3333-4444-555555555555',
        deviceId: 'dev-1',
        deviceName: 'MyPrivateLaptop',
        lastSyncAt: Date.UTC(2026, 10, 21, 14, 0, 0),
        pendingCount: 0,
        syncedRecordsCount: 42,
        realtimeConnected: true,
        hasCustomServer: false,
        supabaseUrl: 'https://gxkvuwipzbqocbxgyqty.supabase.co',
        error: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345 failed for private-user@secretmail.com',
        devices: [],
        hasRecoveryKeyBackupHint: true,
        failedDirtyCount: 0,
      },
      cloudQuota: {
        available: true,
        signedIn: true,
        spentUsd: 0.05,
        limitUsd: 1,
        remainingUsd: 0.95,
        requestCount: 14,
        blocked: false,
        globalExhausted: false,
        usingPersonalKey: false,
      },
      updaterState: {
        status: 'up-to-date',
        currentVersion: '1.0.1',
        latestVersion: '1.0.1',
        mode: 'auto',
      },
    });

    expect(report).toContain('Kapsula v1.0.1');
    expect(report).toContain('записей 42');
    expect(report).toContain('разделов 4 · холстов 2 · событий календаря 7');
    expect(report).toContain('потрачено $0.05 из $1.00');
    expect(report).not.toContain('private-user@secretmail.com');
    expect(report).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(report).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(report).not.toContain('MyPrivateLaptop');
  });
});

describe('Google Calendar Server Proxy OAuth Config, Exchange & Refresh', () => {
  it('connects via gcal-oauth proxy when no custom clientId is configured and refreshes tokens via proxy', async () => {
    const { repo, cryptoVault } = createTempVault();
    const proxyRequests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];

    const mockFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/functions/v1/gcal-oauth') && method === 'GET') {
        proxyRequests.push({ method, url });
        return new Response(
          JSON.stringify({ enabled: true, clientId: 'built-in-gcal-client-id.apps.googleusercontent.com' }),
          { status: 200 }
        );
      }
      if (url.endsWith('/functions/v1/gcal-oauth') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        proxyRequests.push({ method, url, body });
        if (body.action === 'exchange') {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: 'gcal-access-1',
              refresh_token: 'gcal-refresh-1',
              expires_in: 1, // expires almost immediately so next sync triggers refresh!
            }),
            { status: 200 }
          );
        }
        if (body.action === 'refresh') {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: 'gcal-access-refreshed',
              expires_in: 3600,
            }),
            { status: 200 }
          );
        }
      }
      if (url.includes('oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ email: 'cal-user@gmail.com' }), { status: 200 });
      }
      if (url.includes('googleapis.com/calendar/v3/calendars/primary/events')) {
        return new Response(JSON.stringify({ items: [], nextSyncToken: 'sync-tok-1' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const bridge = new GoogleCalendarBridge(repo, cryptoVault, {
      getSupabaseConfig: () => ({
        url: 'https://gxkvuwipzbqocbxgyqty.supabase.co',
        key: 'sb_publishable_test_key',
      }),
      fetchFn: mockFetch,
      openExternal: async (authUrl) => {
        const u = new URL(authUrl);
        expect(u.searchParams.get('client_id')).toBe(
          'built-in-gcal-client-id.apps.googleusercontent.com'
        );
        const redirectUri = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        // Simulate browser redirect back to loopback callback
        await fetch(`${redirectUri}?code=test-auth-code-99&state=${encodeURIComponent(state)}`);
      },
      oauthTimeoutMs: 5000,
    });

    const preStatus = await bridge.getStatusWithRemoteCheck(true);
    expect(preStatus.builtInOAuthAvailable).toBe(true);
    expect(preStatus.connected).toBe(false);

    const connectedStatus = await bridge.connectOAuth();
    expect(connectedStatus.connected).toBe(true);
    expect(connectedStatus.email).toBe('cal-user@gmail.com');
    expect(connectedStatus.authMode).toBe('proxy');
    expect(connectedStatus.clientId).toBe(''); // Built-in ID must NOT pollute custom clientId setting

    const exchangeReq = proxyRequests.find((r) => r.body?.action === 'exchange');
    expect(exchangeReq).toBeTruthy();
    expect(exchangeReq?.body?.code).toBe('test-auth-code-99');
    expect(typeof exchangeReq?.body?.codeVerifier).toBe('string');

    // Trigger sync again -> token expired (< 60s buffer), must refresh via proxy
    await bridge.syncNow();
    const refreshReq = proxyRequests.find((r) => r.body?.action === 'refresh');
    expect(refreshReq).toBeTruthy();
    expect(refreshReq?.body?.refreshToken).toBe('gcal-refresh-1');
  });

  it('reports friendly Russian error when built-in OAuth is disabled and no custom clientId is saved', async () => {
    const { repo, cryptoVault } = createTempVault();
    const bridge = new GoogleCalendarBridge(repo, cryptoVault, {
      fetchFn: (async () =>
        new Response(JSON.stringify({ enabled: false, clientId: null }), { status: 200 })) as typeof fetch,
    });

    await expect(bridge.connectOAuth()).rejects.toThrow('Встроенный вход в Google Календарь');
  });
});

describe('Packaging Config & Unified Windows/macOS afterPack Hook', () => {
  it('configures v1.1.0, GitHub Releases publishing, NSIS installer, and safe afterPack hook', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      build: {
        afterPack: string;
        publish: Array<{ provider: string; owner: string; repo: string }>;
        win: { target: string[] };
        nsis: { oneClick: boolean; artifactName: string; shortcutName: string };
      };
    };

    expect(pkg.version).toBe('1.1.0');
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
    expect(pkg.scripts['pack:win:installer']).toContain('electron-builder --win nsis');
    expect(pkg.build.afterPack).toBe('scripts/after-pack-win.cjs');
    expect(pkg.build.publish[0]).toEqual({
      provider: 'github',
      owner: 'Suther1and',
      repo: 'kapsula',
    });
    expect(pkg.build.win.target).toContain('nsis');
    expect(pkg.build.win.target).toContain('dir');
    expect(pkg.build.nsis.oneClick).toBe(false);
    expect(pkg.build.nsis.artifactName).toBe('Kapsula-${version}-windows.${ext}');

    const req = createRequire(import.meta.url);
    const afterPackWin = req(path.join(ROOT, 'scripts', 'after-pack-win.cjs')) as (ctx: {
      electronPlatformName: string;
      appOutDir: string;
    }) => Promise<void>;

    // Safely skips darwin universal temp dirs and non-existent win32 output dirs
    await expect(
      afterPackWin({ electronPlatformName: 'darwin', appOutDir: '/tmp/mac-universal-arm64-temp' })
    ).resolves.toBeUndefined();
    await expect(
      afterPackWin({ electronPlatformName: 'win32', appOutDir: path.join(os.tmpdir(), 'kapsula-nonexistent-dir') })
    ).resolves.toBeUndefined();
  });
});
