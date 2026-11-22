import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, VaultItem } from '@shared/types';
import type { SyncedCalendarEventPayload, SyncedItemPayload } from '@shared/sync-contract';
import { VaultRepository } from '@main/db/repository';
import {
  extractTasksFromMobileItem,
  resolveMobileAiTarget,
  type MobileAiCloudAuth,
} from '@mobile/lib/mobile-ai';
import { eventOccursOnDay, isMediaItem } from '@mobile/lib/mobile-helpers';
import { isNativeExternalFlowInFlight, mobileBridge } from '@mobile/native/bridge';
import { MobileVaultStore } from '@mobile/storage/mobile-store';

function makeVaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  const now = Date.now();
  return {
    id: 'item-1',
    dna: 'note',
    subKind: null,
    orbit: '',
    modeCaptured: 'autopilot',
    focusBoardId: null,
    title: 'Sample item',
    body: '',
    summary: '',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: null,
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    hasEncryptedPayload: false,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: 'hash-1',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    isDemo: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
    ...overrides,
  };
}

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const now = Date.now();
  return {
    id: 'ev-1',
    title: 'Monthly review',
    notes: '',
    location: '',
    startAt: new Date(2026, 0, 31, 10, 0, 0, 0).getTime(),
    endAt: new Date(2026, 0, 31, 11, 0, 0, 0).getTime(),
    allDay: false,
    hasEndTime: true,
    color: '#4f86f7',
    kind: 'event',
    recurrence: 'monthly',
    isDone: false,
    linkedItemId: null,
    checklist: [],
    attachments: [],
    externalSource: null,
    externalId: null,
    etag: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeSyncedEventPayload(
  overrides: Partial<SyncedCalendarEventPayload> = {}
): SyncedCalendarEventPayload {
  const now = Date.now();
  return {
    v: 1,
    id: 'ev-sync-1',
    title: 'Synced meeting',
    notes: '',
    location: '',
    startAt: now,
    endAt: now + 3_600_000,
    allDay: false,
    hasEndTime: true,
    color: '#4f86f7',
    kind: 'event',
    recurrence: 'none',
    isDone: false,
    linkedItemId: null,
    checklist: [],
    attachments: [],
    externalSource: null,
    externalId: null,
    etag: null,
    createdAt: now - 1000,
    updatedAt: now,
    deletedAt: null,
    syncVersion: 1,
    mediaRefs: [],
    ...overrides,
  };
}

function makeSyncedItemPayload(overrides: Partial<SyncedItemPayload> = {}): SyncedItemPayload {
  const now = Date.now();
  return {
    v: 1,
    id: 'sync-item-1',
    dna: 'note',
    subKind: null,
    orbit: '',
    modeCaptured: 'autopilot',
    focusBoardId: null,
    title: 'Remote note',
    body: 'Remote body',
    summary: '',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: null,
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    secretPayload: null,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: 'hash-remote',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now - 5000,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    purgedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
    syncVersion: 1,
    mediaRefs: [],
    ...overrides,
  };
}

describe('Wave 2 Resilience & Desktop-Mobile Parity', () => {
  const repos: VaultRepository[] = [];

  afterEach(() => {
    while (repos.length > 0) {
      try {
        repos.pop()!.close();
      } catch {
        // ignore close errors
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('CLOUD-M02: excludes built-in cloud proxy AI usage from personal monthly budget cap calculations', () => {
    const repo = new VaultRepository(':memory:');
    repos.push(repo);

    // Log massive built-in cloud proxy usage well above the $5 personal cap
    repo.logAiUsage('google_ai_studio', 'gemini-2.5-flash', 4000, 1200, 12.5, true);
    repo.logAiUsage('google_ai_studio', 'cache_hit', 0, 0, 0, true);

    const afterProxyOnly = repo.getMonthBudgetSummary('google_ai_studio', 5, true);
    expect(afterProxyOnly.spentUsd).toBe(0);
    expect(afterProxyOnly.callsCount).toBe(0);
    expect(afterProxyOnly.cacheHitsCount).toBe(1);
    expect(afterProxyOnly.limitReached).toBe(false);

    // Personal key usage increments personal spend & eventually triggers cap
    repo.logAiUsage('google_ai_studio', 'gemini-2.5-flash', 1000, 500, 1.25, false);
    const afterPersonalPartial = repo.getMonthBudgetSummary('google_ai_studio', 5, true);
    expect(afterPersonalPartial.spentUsd).toBeCloseTo(1.25, 5);
    expect(afterPersonalPartial.callsCount).toBe(1);
    expect(afterPersonalPartial.limitReached).toBe(false);

    repo.logAiUsage('google_ai_studio', 'gemini-2.5-flash', 2000, 900, 3.75, false);
    const afterPersonalCap = repo.getMonthBudgetSummary('google_ai_studio', 5, true);
    expect(afterPersonalCap.spentUsd).toBeCloseTo(5, 5);
    expect(afterPersonalCap.callsCount).toBe(2);
    expect(afterPersonalCap.limitReached).toBe(true);
  });

  it('W2-C: ignores leftover personal AI keys when mobile provider is local (cloud proxy mode)', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    await store.setMobileAiConfig({
      provider: 'local',
      googleKey: 'AIzaSyTestLeftoverPersonalKey00000000000',
    });

    const cloudAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => 'jwt-cloud-token',
      getSupabaseBaseUrl: () => 'https://example.supabase.co',
      getSupabasePublishableKey: async () => 'sb_publishable_demo',
    };

    const targetWithCloud = await resolveMobileAiTarget(store, cloudAuth);
    expect(targetWithCloud?.mode).toBe('cloud_proxy');

    const targetWithoutCloud = await resolveMobileAiTarget(store, null);
    expect(targetWithoutCloud).toBeNull();
  });

  it('W2-C: masks inline secrets outbound and blocks residual unredacted secrets in mobile task extraction', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const cloudAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => 'jwt-cloud-token',
      getSupabaseBaseUrl: () => 'https://example.supabase.co',
      getSupabasePublishableKey: async () => 'sb_publishable_demo',
    };

    const rawGhToken = 'ghp_TestTokenAbCdEfGhIjKlMnOpQrSt123456';
    const noteWithToken = await store.createItem({
      dna: 'note',
      title: 'Production setup',
      body: `Rotate token ${rawGhToken} after deploying the release`,
    });

    const sentBodies: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBodies.push(String(init?.body ?? ''));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tasks: ['Rotate token [REDACTED_SECRET_0] on staging'],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as unknown as Response;
    });

    const okRes = await extractTasksFromMobileItem(store, noteWithToken, cloudAuth);
    expect(okRes.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentBodies[0]).toContain('[REDACTED_SECRET_0]');
    expect(sentBodies[0]).not.toContain(rawGhToken);
    expect(okRes.tasks[0]).toBe(`Rotate token ${rawGhToken} on staging`);

    // 12-word lowercase seed phrase fails residual secret verification -> hard blocked before fetch
    const seedNote = await store.createItem({
      dna: 'note',
      title: 'Wallet backup note',
      body: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
    });
    const blockedRes = await extractTasksFromMobileItem(store, seedNote, cloudAuth);
    expect(blockedRes.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('W2-C: deduplicates colliding (externalSource, externalId) on mobile applySyncedCalendarEvent', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const first = makeSyncedEventPayload({
      id: 'ev-first',
      title: 'Standup A',
      externalSource: 'google',
      externalId: 'gcal-shared-id',
      etag: '"v1"',
    });
    const second = makeSyncedEventPayload({
      id: 'ev-second',
      title: 'Standup B',
      externalSource: 'google',
      externalId: 'gcal-shared-id',
      etag: '"v2"',
    });

    const r1 = await store.applySyncedCalendarEvent(first, 'remote-1', 'local-1');
    const r2 = await store.applySyncedCalendarEvent(second, 'remote-1', 'local-1');
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true);

    const savedFirst = store.getRawCalendarEvent('ev-first')!;
    const savedSecond = store.getRawCalendarEvent('ev-second')!;
    expect(savedFirst.externalSource).toBe('google');
    expect(savedFirst.externalId).toBe('gcal-shared-id');
    expect(savedSecond.externalSource).toBeNull();
    expect(savedSecond.externalId).toBeNull();
  });

  it('W2-C: strips CR/LF in updateVaultTaskText and preserves custom-title/metadata notes on deleteVaultTask', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const quickItem = await store.addQuickTask('Buy coffee');
    const [quickTask] = store.listVaultTasks().filter((t) => t.itemId === quickItem.id);
    const updated = await store.updateVaultTaskText(quickTask!, 'Buy coffee\r\nand oat milk\ntoday');
    expect(updated?.body).toBe('- [ ] Buy coffee and oat milk today');
    expect(updated?.body).not.toMatch(/[\r\n]/);

    // Note with custom title and tag must remain alive after deleting its only markdown checkbox
    const projectNote = await store.createItem({
      dna: 'note',
      title: 'Architecture Decisions',
      body: '- [ ] Confirm DB migration index',
      tags: ['architecture'],
    });
    const [projectTask] = store.listVaultTasks().filter((t) => t.itemId === projectNote.id);
    await store.deleteVaultTask(projectTask!);

    const keptNote = store.getItemById(projectNote.id);
    expect(keptNote).not.toBeNull();
    expect(keptNote?.body).toBe('');
    expect(keptNote?.title).toBe('Architecture Decisions');

    // Bare unnamed single-task capture (title === task text, no custom metadata) soft-deletes cleanly
    const [updatedQuickTask] = store.listVaultTasks().filter((t) => t.itemId === quickItem.id);
    await store.deleteVaultTask(updatedQuickTask!);
    expect(store.getItemById(quickItem.id)).toBeNull();
  });

  it('W2-C: preserves secret conflict copy and deduplicates duplicate revision hashes on applySyncedItem', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    await store.setMasterPin('4729');

    const localSecret = await store.upsertSecret({
      kind: 'password',
      title: 'Prod Admin',
      service: 'admin.example.com',
      login: 'root',
      secretValue: 'LocalSecretValue#1',
    });
    const rawLocalSecret = store.getRawItem(localSecret.id)!;
    const originalCipher = rawLocalSecret.encryptedSecretPayload!;
    const remoteWinsCipher = 'vdk:remote-overwriting-cipher';

    const remoteSecret = makeSyncedItemPayload({
      id: localSecret.id,
      dna: 'secret',
      title: 'Prod Admin Remote',
      body: '',
      secretMeta: { kind: 'password', service: 'admin.example.com', loginHint: 'ro••', fieldsPresent: ['password'] },
      hasEncryptedPayload: true,
      updatedAt: rawLocalSecret.updatedAt + 5000,
      syncVersion: (rawLocalSecret.syncVersion ?? 1) + 1,
    } as Partial<SyncedItemPayload>);

    const secretApply = await store.applySyncedItem(
      remoteSecret,
      remoteWinsCipher,
      'remote-device-B',
      'local-device-A'
    );
    expect(secretApply.applied).toBe(true);
    expect(store.getRawItem(localSecret.id)?.encryptedSecretPayload).toBe(remoteWinsCipher);

    const conflictCopies = store
      .listItems({ includeSecrets: true })
      .filter((i) => i.id !== localSecret.id && String(i.source) === 'sync_conflict');
    expect(conflictCopies).toHaveLength(1);
    expect(store.getRawItem(conflictCopies[0]!.id)?.encryptedSecretPayload).toBe(originalCipher);
    expect(store.listDirtyEntities(50).some((d) => d.entityId === conflictCopies[0]!.id)).toBe(true);

    // Note losing remote revision: repeated apply (e.g. -25 overlap rewind) must not duplicate revision row
    const localNote = await store.createItem({
      dna: 'note',
      title: 'Latest Title',
      body: 'Latest Body',
    });
    const rawLocalNote = store.getRawItem(localNote.id)!;
    const staleRemoteNote = makeSyncedItemPayload({
      id: localNote.id,
      title: 'Previous Title',
      body: 'Previous Body',
      updatedAt: rawLocalNote.updatedAt - 10_000,
      syncVersion: 1,
    });

    await store.applySyncedItem(staleRemoteNote, null, 'remote-device-B', 'local-device-A');
    const revsAfterFirst = store.listItemRevisions(localNote.id).filter((r) => r.source === 'sync_conflict');
    expect(revsAfterFirst).toHaveLength(1);

    await store.applySyncedItem(staleRemoteNote, null, 'remote-device-B', 'local-device-A');
    const revsAfterRewind = store.listItemRevisions(localNote.id).filter((r) => r.source === 'sync_conflict');
    expect(revsAfterRewind).toHaveLength(1);
  });

  it('W2-C: matches mobile eventOccursOnDay (month-end clamping) and isMediaItem rules with shared contract', () => {
    const jan31Anchor = makeCalendarEvent({
      startAt: new Date(2026, 0, 31, 10, 0, 0, 0).getTime(),
      endAt: new Date(2026, 0, 31, 11, 0, 0, 0).getTime(),
      recurrence: 'monthly',
    });

    expect(eventOccursOnDay(jan31Anchor, new Date(2026, 1, 28, 12, 0, 0))).toBe(true);
    expect(eventOccursOnDay(jan31Anchor, new Date(2026, 1, 27, 12, 0, 0))).toBe(false);
    expect(eventOccursOnDay(jan31Anchor, new Date(2028, 1, 29, 12, 0, 0))).toBe(true);
    expect(eventOccursOnDay(jan31Anchor, new Date(2026, 10, 30, 12, 0, 0))).toBe(true);

    expect(isMediaItem(makeVaultItem({ dna: 'shot' }))).toBe(true);
    expect(isMediaItem(makeVaultItem({ dna: 'voice' }))).toBe(true);
    expect(isMediaItem(makeVaultItem({ dna: 'shot', isArchived: true }))).toBe(false);
    expect(isMediaItem(makeVaultItem({ dna: 'secret', imagePath: 'leak.png' }))).toBe(false);
    expect(isMediaItem(makeVaultItem({ dna: 'doc' }))).toBe(false);
  });

  it('MOB-16: tracks active native external UI flows and always resets in-flight state in finally', async () => {
    expect(isNativeExternalFlowInFlight()).toBe(false);

    let observedDuringOpen = false;
    vi.stubGlobal('window', {
      open: vi.fn(() => {
        observedDuringOpen = isNativeExternalFlowInFlight();
        return null;
      }),
    });

    await mobileBridge.openExternalUrl('https://kapsula.app/oauth');
    expect(observedDuringOpen).toBe(true);
    expect(isNativeExternalFlowInFlight()).toBe(false);

    vi.stubGlobal('window', {
      open: vi.fn(() => {
        expect(isNativeExternalFlowInFlight()).toBe(true);
        throw new Error('simulated popup failure');
      }),
    });

    await expect(mobileBridge.openExternalUrl('https://kapsula.app/oauth')).rejects.toThrow(
      'simulated popup failure'
    );
    expect(isNativeExternalFlowInFlight()).toBe(false);
  });
});
