import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleCalendarBridge } from '@main/bridges/google-calendar';
import { VaultRepository } from '@main/db/repository';
import { VaultCrypto } from '@main/security/vault-crypto';
import {
  fromGoogleRecurrenceRrule,
  layoutOverlappingEvents,
  partitionAllDayEntries,
  toGoogleRecurrenceRrule,
} from '@shared/calendar-layout';

const tempDirs: string[] = [];
const repos: VaultRepository[] = [];

function createTempBridgeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-cal-sync-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  repos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  repo.setSetting(
    'gcal_tokens_enc',
    cryptoVault.encryptConfigJson({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      email: 'cal-user@kapsula.test',
      authMode: 'custom',
    })
  );
  return { repo, cryptoVault };
}

function dayAt(hour: number, minute = 0): number {
  return new Date(2026, 10, 24, hour, minute, 0, 0).getTime();
}

afterEach(() => {
  while (repos.length > 0) {
    try {
      repos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('Wave 6: Calendar Overlap Layout, RRULE Conversion & Two-Way Google Sync', () => {
  it('partitions all-day and timed entries while preserving input order', () => {
    const entries = [
      { id: 'a', allDay: true },
      { id: 'b', allDay: false },
      { id: 'c', allDay: true },
      { id: 'd' },
    ];
    const { allDay, timed } = partitionAllDayEntries(entries);
    expect(allDay.map((x) => x.id)).toEqual(['a', 'c']);
    expect(timed.map((x) => x.id)).toEqual(['b', 'd']);
  });

  it('lays out adjacent back-to-back events at full width and splits overlapping clusters cleanly', () => {
    const dayStartMs = new Date(2026, 10, 24, 0, 0, 0, 0).getTime();

    // Adjacent 09:00-10:00 and 10:00-11:00 -> each full width (totalColumns === 1)
    const adjacent = layoutOverlappingEvents(
      [
        { id: 'ev-1', startAt: dayAt(9, 0), endAt: dayAt(10, 0) },
        { id: 'ev-2', startAt: dayAt(10, 0), endAt: dayAt(11, 0) },
      ],
      { dayStartMs }
    );
    expect(adjacent).toHaveLength(2);
    expect(adjacent[0]!.totalColumns).toBe(1);
    expect(adjacent[1]!.totalColumns).toBe(1);

    // Cluster 1: 3-way overlap (A: 09:00-11:00, B: 09:30-10:30, C: 10:00-12:00) + isolated D: 14:00-15:00
    const complex = layoutOverlappingEvents(
      [
        { id: 'A', startAt: dayAt(9, 0), endAt: dayAt(11, 0) },
        { id: 'B', startAt: dayAt(9, 30), endAt: dayAt(10, 30) },
        { id: 'C', startAt: dayAt(10, 0), endAt: dayAt(12, 0) },
        { id: 'D', startAt: dayAt(14, 0), endAt: dayAt(15, 0) },
      ],
      { dayStartMs }
    );

    const slotById = new Map(complex.map((s) => [s.id, s]));
    expect(slotById.get('A')!.totalColumns).toBe(3);
    expect(slotById.get('B')!.totalColumns).toBe(3);
    expect(slotById.get('C')!.totalColumns).toBe(3);
    const cols = new Set([
      slotById.get('A')!.columnIndex,
      slotById.get('B')!.columnIndex,
      slotById.get('C')!.columnIndex,
    ]);
    expect(cols.size).toBe(3);

    expect(slotById.get('D')!.totalColumns).toBe(1);
    expect(slotById.get('D')!.columnIndex).toBe(0);
  });

  it('converts Kapsula recurrence enums <-> RFC 5545 Google RRULE strings cleanly', () => {
    expect(toGoogleRecurrenceRrule('daily')).toEqual(['RRULE:FREQ=DAILY']);
    expect(toGoogleRecurrenceRrule('weekdays')).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
    expect(toGoogleRecurrenceRrule('weekly')).toEqual(['RRULE:FREQ=WEEKLY']);
    expect(toGoogleRecurrenceRrule('monthly')).toEqual(['RRULE:FREQ=MONTHLY']);
    expect(toGoogleRecurrenceRrule('none')).toBeUndefined();

    expect(fromGoogleRecurrenceRrule(['RRULE:FREQ=DAILY'])).toBe('daily');
    expect(fromGoogleRecurrenceRrule(['RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TU,WE,TH'])).toBe('weekdays');
    expect(fromGoogleRecurrenceRrule(['RRULE:FREQ=WEEKLY'])).toBe('weekly');
    expect(fromGoogleRecurrenceRrule(['RRULE:FREQ=MONTHLY'])).toBe('monthly');
    expect(fromGoogleRecurrenceRrule(['RRULE:FREQ=WEEKLY;INTERVAL=2'])).toBe('none');
    expect(fromGoogleRecurrenceRrule(undefined)).toBe('none');
  });

  it('performs two-way Google Calendar sync: pull location/RRULE, POST create preserving fields, PATCH local edit, and DELETE local soft-delete', async () => {
    const { repo, cryptoVault } = createTempBridgeEnv();
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    let pullPhase: 'initial' | 'after' = 'initial';

    const mockFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();
      const parsedBody =
        typeof init?.body === 'string' && init.body.startsWith('{')
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({ method, url, body: parsedBody });

      if (method === 'GET' && url.includes('/calendars/primary/events')) {
        if (pullPhase === 'initial') {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'g-remote-1',
                  etag: '"etag-1"',
                  summary: 'Еженедельный созвон',
                  description: 'Повестка в описании',
                  location: 'Zoom Room 7',
                  recurrence: ['RRULE:FREQ=WEEKLY'],
                  start: { dateTime: '2026-11-24T10:00:00.000Z' },
                  end: { dateTime: '2026-11-24T11:00:00.000Z' },
                },
              ],
              nextSyncToken: 'sync-1',
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: 'sync-2' }), { status: 200 });
      }

      if (method === 'POST' && url.endsWith('/calendars/primary/events')) {
        return new Response(
          JSON.stringify({ id: 'g-created-2', etag: '"etag-created-2"' }),
          { status: 200 }
        );
      }

      if (method === 'PATCH' && url.includes('/events/g-remote-1')) {
        return new Response(JSON.stringify({ etag: '"etag-1b"' }), { status: 200 });
      }

      if (method === 'DELETE' && url.includes('/events/g-created-2')) {
        return new Response(null, { status: 204 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const bridge = new GoogleCalendarBridge(repo, cryptoVault, { fetchFn: mockFetch });

    // Local Kapsula event created before first sync
    const localEv = repo.upsertCalendarEvent({
      title: 'Утренний стендап',
      notes: 'Короткий синк',
      location: 'Переговорная B',
      startAt: dayAt(9, 0),
      endAt: dayAt(9, 30),
      hasEndTime: true,
      recurrence: 'weekdays',
      checklist: [{ id: 'c1', text: 'Открыть доску', done: false }],
    });

    // 1. Initial sync: pulls g-remote-1 (with location & recurrence) + POSTs localEv
    const sync1 = await bridge.syncNow();
    expect(sync1.imported).toBe(1);
    expect(sync1.pushed).toBe(1);

    const pulledRemote = repo.findCalendarEventByExternalId('google_api', 'g-remote-1');
    expect(pulledRemote).toBeTruthy();
    expect(pulledRemote!.location).toBe('Zoom Room 7');
    expect(pulledRemote!.recurrence).toBe('weekly');

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.body?.location).toBe('Переговорная B');
    expect(postCall?.body?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);

    // Fields on localEv must remain intact after acquiring Google externalId
    const pushedLocal = repo.getCalendarEventById(localEv.id)!;
    expect(pushedLocal.externalId).toBe('g-created-2');
    expect(pushedLocal.location).toBe('Переговорная B');
    expect(pushedLocal.recurrence).toBe('weekdays');
    expect(pushedLocal.hasEndTime).toBe(true);
    expect(pushedLocal.checklist).toHaveLength(1);

    // 2. Modify pulledRemote locally & soft-delete pushedLocal -> sync2 sends PATCH + DELETE
    await new Promise((r) => setTimeout(r, 10));
    pullPhase = 'after';
    repo.upsertCalendarEvent({
      id: pulledRemote!.id,
      title: 'Еженедельный созвон (обновлён)',
      location: 'Google Meet',
      startAt: pulledRemote!.startAt,
      endAt: pulledRemote!.endAt,
      recurrence: 'daily',
      externalSource: pulledRemote!.externalSource,
      externalId: pulledRemote!.externalId,
    });
    repo.deleteCalendarEvent(pushedLocal.id);

    const sync2 = await bridge.syncNow();
    expect(sync2.pushed).toBe(2);

    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.body?.summary).toBe('Еженедельный созвон (обновлён)');
    expect(patchCall?.body?.location).toBe('Google Meet');
    expect(patchCall?.body?.recurrence).toEqual(['RRULE:FREQ=DAILY']);

    const delCall = calls.find((c) => c.method === 'DELETE');
    expect(delCall?.url).toContain('g-created-2');
  });
});
