import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCENT_PRESETS, DARK_BG_PRESETS, LIGHT_BG_PRESETS } from '@shared/color-engine';
import { NOTE_TEMPLATES, ONBOARDING_PRESETS } from '@shared/note-templates';
import type { SyncKeyEnvelopeRow, SyncRecordRow, SyncedWorkspacePrefsPayload } from '@shared/sync-contract';
import {
  MOBILE_ACCENT_LABELS,
  MOBILE_DARK_BG_LABELS,
  MOBILE_DEFAULT_COLUMN_LABELS,
  MOBILE_DICT,
  MOBILE_DICT_EN,
  MOBILE_DICT_RU,
  MOBILE_DNA_LABELS,
  MOBILE_LIGHT_BG_LABELS,
  MOBILE_LOCALE_OPTIONS,
  MOBILE_NOTE_TEMPLATES,
  MOBILE_ONBOARDING_PRESETS,
  MOBILE_PLURALS,
  MOBILE_WEEKDAYS,
} from '@shared/i18n/mobile-dict';
import {
  MOBILE_LOCALE_STORAGE_KEY,
  formatMobileFileSize,
  formatMobileReminderStamp,
  formatMobileUsd,
  getMobileColumnTitle,
  getMobileDnaLabel,
  getUrlLocaleOverride,
  resolveMobileLocale,
  setRuntimeMobileLocale,
  tm,
  tmPlural,
  tmPluralWord,
} from '@mobile/lib/mobile-i18n';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';

const CYRILLIC_RE = /[а-яА-ЯёЁ]/;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function extractPlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m[1]) names.add(m[1]);
  }
  return Array.from(names).sort();
}

function collectFilesRecursive(dir: string, exts: Set<string>, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, exts, out);
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
  return out;
}

interface MockCloudState {
  envelopes: Map<string, SyncKeyEnvelopeRow>;
  records: Map<string, SyncRecordRow>;
  blobsMeta: Map<string, { user_id: string; blob_id: string; byte_size: number; ext: string }>;
  storage: Map<string, Uint8Array>;
  devices: Map<string, Record<string, unknown>>;
  seq: number;
}

function createMockCloud(): MockCloudState {
  return {
    envelopes: new Map(),
    records: new Map(),
    blobsMeta: new Map(),
    storage: new Map(),
    devices: new Map(),
    seq: 0,
  };
}

function createMockSupabaseClient(
  cloud: MockCloudState,
  userId: string,
  email: string
): SupabaseClient {
  let signedIn = false;

  const makeQuery = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let maxRows = 1000;

    const getRows = (): Array<Record<string, unknown>> => {
      if (table === 'sync_key_envelopes') {
        return Array.from(cloud.envelopes.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_records') {
        return Array.from(cloud.records.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_blobs') {
        return Array.from(cloud.blobsMeta.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_devices') {
        return Array.from(cloud.devices.values());
      }
      return [];
    };

    const runSelect = () => {
      let rows = getRows().filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (typeof av === 'number' && typeof bv === 'number') {
            return orderAsc ? av - bv : bv - av;
          }
          return orderAsc
            ? String(av ?? '').localeCompare(String(bv ?? ''))
            : String(bv ?? '').localeCompare(String(av ?? ''));
        });
      }
      return rows.slice(0, maxRows);
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      gt: (col: string, val: number) => {
        filters.push((r) => Number(r[col] ?? 0) > val);
        return chain;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return chain;
      },
      limit: (n: number) => {
        maxRows = n;
        return Promise.resolve({ data: runSelect(), error: null });
      },
      maybeSingle: () => {
        const rows = runSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      insert: (payload: Record<string, unknown>) => {
        if (table === 'sync_key_envelopes') {
          const row = payload as unknown as SyncKeyEnvelopeRow;
          if (cloud.envelopes.has(row.user_id)) {
            return Promise.resolve({ error: { message: 'duplicate key 23505' } });
          }
          cloud.envelopes.set(row.user_id, row);
        }
        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => {
          if (table === 'sync_key_envelopes' && col === 'user_id') {
            const prev = cloud.envelopes.get(String(val));
            if (prev) {
              cloud.envelopes.set(String(val), { ...prev, ...patch } as SyncKeyEnvelopeRow);
            }
          }
          return Promise.resolve({ error: null });
        },
      }),
      upsert: (payload: Record<string, unknown>) => {
        if (table === 'sync_records') {
          const row = payload as unknown as SyncRecordRow;
          const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
          const prev = cloud.records.get(key);
          let winning: SyncRecordRow;
          if (
            prev &&
            (row.updated_at < prev.updated_at ||
              (row.updated_at === prev.updated_at && row.sync_version < prev.sync_version))
          ) {
            winning = prev;
          } else {
            cloud.seq += 1;
            winning = { ...row, server_seq: cloud.seq };
            cloud.records.set(key, winning);
          }
          const okResult = { data: [winning], error: null };
          return {
            select: () => Promise.resolve(okResult),
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
        }
        if (table === 'sync_blobs') {
          const b = payload as { user_id: string; blob_id: string; byte_size: number; ext: string };
          cloud.blobsMeta.set(`${b.user_id}:${b.blob_id}`, b);
        } else if (table === 'sync_devices') {
          const key = `${String(payload.user_id)}:${String(payload.device_id)}`;
          cloud.devices.set(key, payload);
        }
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  };

  return {
    auth: {
      getSession: async () => ({
        data: { session: signedIn ? { user: { id: userId, email } } : null },
        error: null,
      }),
      signUp: async () => {
        signedIn = true;
        return {
          data: { session: { user: { id: userId, email } }, user: { id: userId, email } },
          error: null,
        };
      },
      signInWithPassword: async () => {
        signedIn = true;
        return { data: { session: { user: { id: userId, email } } }, error: null };
      },
      signOut: async () => {
        signedIn = false;
        return { error: null };
      },
    },
    from: (table: string) => makeQuery(table),
    storage: {
      from: () => ({
        upload: async (pathKey: string, bytes: Uint8Array) => {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          cloud.storage.set(pathKey, copy);
          return { error: null };
        },
        download: async (pathKey: string) => {
          const bytes = cloud.storage.get(pathKey);
          if (!bytes) return { data: null, error: { message: 'Object not found (404)' } };
          return {
            data: {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

describe('Mobile bilingual RU/EN i18n', () => {
  afterEach(() => {
    setRuntimeMobileLocale(null);
    vi.unstubAllGlobals();
  });

  it('has 100% RU/EN key parity, non-empty values, and matching interpolation parameters', () => {
    const ruKeys = Object.keys(MOBILE_DICT_RU).sort();
    const enKeys = Object.keys(MOBILE_DICT_EN).sort();

    expect(enKeys).toEqual(ruKeys);
    expect(ruKeys.length).toBeGreaterThan(500);

    for (const key of ruKeys) {
      const ruVal = MOBILE_DICT_RU[key as keyof typeof MOBILE_DICT_RU];
      const enVal = MOBILE_DICT_EN[key as keyof typeof MOBILE_DICT_EN];
      expect(ruVal.trim().length, `RU value empty for ${key}`).toBeGreaterThan(0);
      expect(enVal.trim().length, `EN value empty for ${key}`).toBeGreaterThan(0);
      expect(CYRILLIC_RE.test(enVal), `EN key ${key} contains Cyrillic: ${enVal}`).toBe(false);

      const ruParams = extractPlaceholders(ruVal);
      const enParams = extractPlaceholders(enVal);
      expect(enParams, `Placeholder mismatch for ${key}`).toEqual(ruParams);
    }

    expect(MOBILE_DICT.ru).toBe(MOBILE_DICT_RU);
    expect(MOBILE_DICT.en).toBe(MOBILE_DICT_EN);
    expect(MOBILE_LOCALE_OPTIONS.map((o) => o.id)).toEqual(['ru', 'en']);
    expect(MOBILE_LOCALE_OPTIONS.map((o) => o.label)).toEqual(['Русский', 'English']);
  });

  it('covers all structured metadata tables cleanly in both RU and EN', () => {
    expect(Object.keys(MOBILE_PLURALS)).toEqual(['item', 'event', 'task', 'secretEntry']);
    for (const pluralKey of Object.keys(MOBILE_PLURALS) as Array<keyof typeof MOBILE_PLURALS>) {
      expect(MOBILE_PLURALS[pluralKey].ru).toHaveLength(3);
      expect(MOBILE_PLURALS[pluralKey].en).toHaveLength(2);
      expect(CYRILLIC_RE.test(MOBILE_PLURALS[pluralKey].en.join(' '))).toBe(false);
    }

    expect(MOBILE_WEEKDAYS.ru).toHaveLength(7);
    expect(MOBILE_WEEKDAYS.en).toHaveLength(7);
    expect(MOBILE_WEEKDAYS.en.join(' ')).not.toMatch(CYRILLIC_RE);

    expect(Object.keys(MOBILE_DNA_LABELS.en).sort()).toEqual(
      Object.keys(MOBILE_DNA_LABELS.ru).sort()
    );
    expect(Object.keys(MOBILE_DEFAULT_COLUMN_LABELS.en).sort()).toEqual(
      Object.keys(MOBILE_DEFAULT_COLUMN_LABELS.ru).sort()
    );

    for (const accent of ACCENT_PRESETS) {
      expect(MOBILE_ACCENT_LABELS.ru[accent.id]?.trim().length).toBeGreaterThan(0);
      expect(MOBILE_ACCENT_LABELS.en[accent.id]?.trim().length).toBeGreaterThan(0);
      expect(CYRILLIC_RE.test(MOBILE_ACCENT_LABELS.en[accent.id]!)).toBe(false);
    }
    for (const bg of DARK_BG_PRESETS) {
      expect(MOBILE_DARK_BG_LABELS.ru[bg.id]?.trim().length).toBeGreaterThan(0);
      expect(MOBILE_DARK_BG_LABELS.en[bg.id]?.trim().length).toBeGreaterThan(0);
      expect(CYRILLIC_RE.test(MOBILE_DARK_BG_LABELS.en[bg.id]!)).toBe(false);
    }
    for (const bg of LIGHT_BG_PRESETS) {
      expect(MOBILE_LIGHT_BG_LABELS.ru[bg.id]?.trim().length).toBeGreaterThan(0);
      expect(MOBILE_LIGHT_BG_LABELS.en[bg.id]?.trim().length).toBeGreaterThan(0);
      expect(CYRILLIC_RE.test(MOBILE_LIGHT_BG_LABELS.en[bg.id]!)).toBe(false);
    }

    expect(MOBILE_NOTE_TEMPLATES.en.map((t) => t.id)).toEqual(NOTE_TEMPLATES.map((t) => t.id));
    expect(MOBILE_ONBOARDING_PRESETS.en.orbits.map((o) => o.id)).toEqual(
      ONBOARDING_PRESETS.orbits.map((o) => o.id)
    );
    expect(CYRILLIC_RE.test(MOBILE_ONBOARDING_PRESETS.en.welcomeNote.title)).toBe(false);
    expect(CYRILLIC_RE.test(MOBILE_ONBOARDING_PRESETS.en.welcomeNote.body)).toBe(false);
  });

  it('interpolates strings, formats plurals, currency, file sizes, DNA, columns & timestamps in RU and EN', () => {
    expect(tm('settings.orbitsHeading', { count: 4 }, 'ru')).toBe('Разделы (4)');
    expect(tm('settings.orbitsHeading', { count: 4 }, 'en')).toBe('Sections (4)');

    expect(tmPlural('item', 1, 'ru')).toBe('1 запись');
    expect(tmPlural('item', 2, 'ru')).toBe('2 записи');
    expect(tmPlural('item', 5, 'ru')).toBe('5 записей');
    expect(tmPlural('item', 21, 'ru')).toBe('21 запись');
    expect(tmPlural('item', 0, 'en')).toBe('0 items');
    expect(tmPlural('item', 1, 'en')).toBe('1 item');
    expect(tmPlural('item', 5, 'en')).toBe('5 items');
    expect(tmPluralWord('secretEntry', 2, 'en')).toBe('protected entries');

    expect(formatMobileUsd(0.37, 'ru')).toBe('$0,37');
    expect(formatMobileUsd(0.37, 'en')).toBe('$0.37');
    expect(formatMobileFileSize(1536, 'ru')).toBe('1,5 КБ');
    expect(formatMobileFileSize(1536, 'en')).toBe('1.5 KB');

    expect(getMobileDnaLabel('doc', null, 'ru')).toBe('Файл');
    expect(getMobileDnaLabel('doc', null, 'en')).toBe('File');
    expect(getMobileDnaLabel('snippet', null, 'en')).toBe('Code');

    // Default Russian board columns translate automatically to English and keep custom titles intact
    expect(getMobileColumnTitle({ id: 'inbox', title: 'Входящие' }, 'en')).toBe('Inbox');
    expect(getMobileColumnTitle({ id: 'in_progress', title: 'В работе' }, 'en')).toBe(
      'In Progress'
    );
    expect(getMobileColumnTitle({ id: 'inbox', title: 'Inbox' }, 'ru')).toBe('Входящие');
    expect(getMobileColumnTitle({ id: 'col_custom', title: 'Code Review' }, 'ru')).toBe(
      'Code Review'
    );

    const sampleTs = new Date(2026, 4, 15, 14, 30, 0, 0).getTime();
    expect(CYRILLIC_RE.test(formatMobileReminderStamp(sampleTs, 'en'))).toBe(false);
    expect(formatMobileReminderStamp(sampleTs, 'ru')).toMatch(/\d{2}:\d{2}/);
  });

  it('enforces locale resolution order: ?lang= override -> persisted mobile_locale -> navigator.language -> Node fallback', () => {
    expect(getUrlLocaleOverride('?foo=1&lang=en')).toBe('en');
    expect(getUrlLocaleOverride('?lang=RU')).toBe('ru');
    expect(getUrlLocaleOverride('?lang=fr')).toBeNull();

    // 1. URL override always wins
    expect(
      resolveMobileLocale({
        urlSearch: '?lang=en',
        persistedLocale: 'ru',
        navigatorLanguage: 'ru-RU',
      })
    ).toBe('en');
    expect(
      resolveMobileLocale({
        urlSearch: '?lang=ru',
        persistedLocale: 'en',
        navigatorLanguage: 'en-US',
      })
    ).toBe('ru');

    // 2. Persisted locale beats navigator.language
    expect(
      resolveMobileLocale({
        urlSearch: '',
        persistedLocale: 'en',
        navigatorLanguage: 'ru-RU',
      })
    ).toBe('en');
    expect(
      resolveMobileLocale({
        urlSearch: '',
        persistedLocale: 'ru',
        navigatorLanguage: 'en-US',
      })
    ).toBe('ru');

    // 3. Browser navigator.language fallback when explicit
    expect(
      resolveMobileLocale({
        urlSearch: '',
        persistedLocale: null,
        navigatorLanguage: 'ru-UA',
      })
    ).toBe('ru');
    expect(
      resolveMobileLocale({
        urlSearch: '',
        persistedLocale: null,
        navigatorLanguage: 'en-US',
      })
    ).toBe('en');
    expect(
      resolveMobileLocale({
        urlSearch: '',
        persistedLocale: null,
        navigatorLanguage: 'de-DE',
      })
    ).toBe('en');

    // 4. Headless Node default (no window/document) always defaults to 'ru' even if global navigator is non-Russian
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(resolveMobileLocale()).toBe('ru');

    // 5. With DOM window + localStorage available, reads MOBILE_LOCALE_STORAGE_KEY & navigator.language
    const memStorage = new Map<string, string>();
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('document', {});
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memStorage.get(k) ?? null,
      setItem: (k: string, v: string) => memStorage.set(k, v),
      removeItem: (k: string) => memStorage.delete(k),
    });

    expect(resolveMobileLocale()).toBe('en'); // navigator.language = 'en-US'

    memStorage.set(MOBILE_LOCALE_STORAGE_KEY, 'ru');
    expect(resolveMobileLocale()).toBe('ru'); // localStorage overrides navigator

    vi.stubGlobal('window', { location: { search: '?lang=en' } });
    expect(resolveMobileLocale()).toBe('en'); // ?lang= overrides localStorage
  });

  it('persists and syncs workspace_prefs.locale via MobileVaultStore and MobileSyncEngine E2EE', async () => {
    const cloud = createMockCloud();
    const userId = 'u-i18n-sync';
    const email = 'i18n@kapsula.app';

    const storeA = new MobileVaultStore({ memoryOnly: true });
    expect(storeA.getLocale()).toBe('ru');

    await storeA.setLocale('en');
    expect(storeA.getLocale()).toBe('en');
    const prefsA = storeA.getWorkspacePrefsForSync();
    expect(prefsA.locale).toBe('en');

    const engineA = new MobileSyncEngine({
      store: storeA,
      deviceName: 'Fold A',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineA.init();
    await engineA.signUp(email, 'pw-sync-123');
    await engineA.setupPassphrase('StrongSyncPass!2026');
    const pushRes = await engineA.syncNow();
    expect(pushRes.ok).toBe(true);

    // Device B joins and unlocks with same passphrase -> receives workspace_prefs.locale = 'en'
    const storeB = new MobileVaultStore({ memoryOnly: true });
    const engineB = new MobileSyncEngine({
      store: storeB,
      deviceName: 'Phone B',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineB.init();
    await engineB.signIn(email, 'pw-sync-123');
    const unlockB = await engineB.unlockWithPassphrase('StrongSyncPass!2026');
    expect(unlockB.ok).toBe(true);
    const pullRes = await engineB.syncNow();
    expect(pullRes.ok).toBe(true);
    expect(storeB.getLocale()).toBe('en');

    // Direct applyRemoteWorkspacePrefs LWW check: older remote payload is ignored, newer wins
    const newerPrefs: SyncedWorkspacePrefsPayload = {
      ...storeB.getWorkspacePrefsForSync(),
      locale: 'ru',
      updatedAt: storeB.getWorkspacePrefsForSync().updatedAt + 5000,
      syncVersion: storeB.getWorkspacePrefsForSync().syncVersion + 1,
    };
    const appliedNew = await storeB.applyRemoteWorkspacePrefs(newerPrefs, 'desktop-device');
    expect(appliedNew.applied).toBe(true);
    expect(storeB.getLocale()).toBe('ru');

    const stalePrefs: SyncedWorkspacePrefsPayload = {
      ...newerPrefs,
      locale: 'en',
      updatedAt: newerPrefs.updatedAt - 10_000,
      syncVersion: newerPrefs.syncVersion - 1,
    };
    const rejectedStale = await storeB.applyRemoteWorkspacePrefs(stalePrefs, 'stale-device');
    expect(rejectedStale.applied).toBe(false);
    expect(rejectedStale.localStrictlyNewer).toBe(true);
    expect(storeB.getLocale()).toBe('ru');

    engineA.dispose();
    engineB.dispose();
  });

  it('AST & regex scan: zero leftover hardcoded Russian UI strings in src/mobile/** and required selectors wired', () => {
    const rootDir = path.resolve(process.cwd(), 'src', 'mobile');
    const tsFiles = collectFilesRecursive(rootDir, new Set(['.ts', '.tsx']));
    expect(tsFiles.length).toBeGreaterThanOrEqual(25);

    const violations: string[] = [];

    for (const filePath of tsFiles) {
      const sourceText = fs.readFileSync(filePath, 'utf8');
      const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
      const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (CYRILLIC_RE.test(node.text) && node.text !== 'Русский') {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${line + 1} -> ${JSON.stringify(node.text)}`);
          }
        } else if (
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (CYRILLIC_RE.test(node.text)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${line + 1} -> ${JSON.stringify(node.text)}`);
          }
        } else if (ts.isJsxText(node)) {
          if (CYRILLIC_RE.test(node.text) && node.text.trim() !== 'Русский') {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${line + 1} -> JSX ${JSON.stringify(node.text.trim())}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    const htmlPath = path.join(rootDir, 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    if (CYRILLIC_RE.test(htmlContent)) {
      violations.push('src/mobile/index.html contains Cyrillic');
    }

    expect(violations).toEqual([]);

    // Ensure both Settings & Welcome sheets wire language selectors and App wraps MobileI18nProvider
    const settingsSrc = fs.readFileSync(
      path.join(rootDir, 'components', 'SettingsCloudSheet.tsx'),
      'utf8'
    );
    const welcomeSrc = fs.readFileSync(
      path.join(rootDir, 'components', 'MobileWelcomeSheet.tsx'),
      'utf8'
    );
    const appSrc = fs.readFileSync(path.join(rootDir, 'App.tsx'), 'utf8');
    expect(settingsSrc).toContain('settings-language-selector');
    expect(settingsSrc).toContain('settings-lang-${opt.id}');
    expect(settingsSrc).toContain('setLocale(opt.id)');
    expect(welcomeSrc).toContain('welcome-language-selector');
    expect(welcomeSrc).toContain('welcome-lang-${opt.id}');
    expect(welcomeSrc).toContain('setLocale(opt.id)');
    expect(appSrc).toContain('MobileI18nProvider');
  });
});
