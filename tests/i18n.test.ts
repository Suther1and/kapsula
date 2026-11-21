import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { ensureDemoSeeded } from '@main/db/demo-seed';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';
import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  LIGHT_BG_PRESETS,
  getAccentPresets,
  getDarkBgPresets,
  getLightBgPresets,
} from '@shared/color-engine';
import {
  getDefaultStarterTags,
  getDnaMeta,
  getModeMeta,
  getOrganicSectionCatalog,
} from '@shared/constants';
import {
  DEFAULT_LOCALE,
  PLURAL_NOUNS,
  createTranslator,
  detectLocale,
  en,
  formatCurrencyUsd,
  formatRelativeTime,
  formatShortDateTime,
  getDateLocale,
  interpolate,
  normalizeLocale,
  pluralize,
  ru,
  translate,
} from '@shared/i18n';
import { getNoteTemplates, getOnboardingPresets } from '@shared/note-templates';
import { getDefaultTaskBoardColumns, getTaskColumnIcons } from '@shared/task-helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const CYRILLIC_RE = /[а-яА-ЯёЁ]/;
const PLACEHOLDER_RE = /\{\{(\w+)\}\}|\{(\w+)\}/g;

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-i18n-test-'));
  tempDirs.push(dir);
  return dir;
}

function openRepo(dbPath: string): VaultRepository {
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  return repo;
}

function collectFilesRecursive(dir: string, exts: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesRecursive(full, exts));
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out.sort();
}

function extractPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] || match[2];
    if (name) names.add(name);
  }
  return Array.from(names).sort();
}

afterEach(() => {
  delete process.env.KAPSULA_LOCALE;
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore already closed
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Desktop & Shared Bilingual i18n', () => {
  it('maintains 100% RU/EN key parity, non-empty strings, and identical interpolation placeholders', () => {
    const ruKeys = Object.keys(ru).sort();
    const enKeys = Object.keys(en).sort();

    expect(enKeys).toEqual(ruKeys);
    expect(ruKeys.length).toBeGreaterThan(500);

    expect(ru['lang.name.ru']).toBe('Русский');
    expect(en['lang.name.ru']).toBe('Русский');
    expect(ru['lang.name.en']).toBe('English');
    expect(en['lang.name.en']).toBe('English');

    for (const key of ruKeys) {
      const k = key as keyof typeof ru;
      const ruVal = ru[k];
      const enVal = en[k];
      expect(typeof ruVal, `ru["${key}"] must be string`).toBe('string');
      expect(typeof enVal, `en["${key}"] must be string`).toBe('string');
      expect(ruVal.trim().length, `ru["${key}"] must be non-empty`).toBeGreaterThan(0);
      expect(enVal.trim().length, `en["${key}"] must be non-empty`).toBeGreaterThan(0);

      expect(extractPlaceholders(enVal), `placeholder mismatch at "${key}"`).toEqual(
        extractPlaceholders(ruVal)
      );
    }
  });

  it('implements core locale detection, interpolation, plurals, dates, and USD formatting', () => {
    expect(DEFAULT_LOCALE).toBe('ru');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('ru_RU')).toBe('ru');
    expect(normalizeLocale('fr')).toBe('ru');

    expect(detectLocale(undefined, undefined)).toBe('ru');
    expect(detectLocale(undefined, 'en-US')).toBe('en');
    expect(detectLocale(undefined, 'ru-RU')).toBe('ru');
    expect(detectLocale('en', 'ru-RU')).toBe('en');
    expect(detectLocale('ru', 'en-US')).toBe('ru');

    expect(interpolate('Saved {count} items in {name}', { count: 4, name: 'Work' })).toBe(
      'Saved 4 items in Work'
    );
    expect(interpolate('Hello {{user}}, {missing}', { user: 'Alex' })).toBe(
      'Hello Alex, {missing}'
    );

    const itemForms = PLURAL_NOUNS.item;
    expect(pluralize('ru', 1, itemForms)).toBe('запись');
    expect(pluralize('ru', 2, itemForms)).toBe('записи');
    expect(pluralize('ru', 5, itemForms)).toBe('записей');
    expect(pluralize('ru', 11, itemForms)).toBe('записей');
    expect(pluralize('ru', 21, itemForms)).toBe('запись');
    expect(pluralize('ru', 104, itemForms)).toBe('записи');
    expect(pluralize('en', 0, itemForms)).toBe('items');
    expect(pluralize('en', 1, itemForms)).toBe('item');
    expect(pluralize('en', 2, itemForms)).toBe('items');

    const now = Date.UTC(2026, 4, 15, 12, 0, 0);
    expect(formatRelativeTime('en', now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime('ru', now - 10_000, now)).toBe('только что');
    expect(formatRelativeTime('en', now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime('ru', now - 5 * 60_000, now)).toBe('5 мин назад');
    expect(formatRelativeTime('en', now - 24 * 60 * 60_000, now)).toBe('yesterday');
    expect(formatRelativeTime('ru', now - 24 * 60 * 60_000, now)).toBe('вчера');

    expect(formatShortDateTime('en', now).length).toBeGreaterThan(4);
    expect(formatShortDateTime('ru', now).length).toBeGreaterThan(4);

    expect(formatCurrencyUsd('en', 1.25)).toBe('$1.25');
    expect(formatCurrencyUsd('ru', 1.25)).toBe('$1,25');

    const enT = createTranslator('en');
    const ruT = createTranslator('ru');
    expect(enT.dateLocale).toBe('en-US');
    expect(ruT.dateLocale).toBe('ru-RU');
    expect(getDateLocale('en')).toBe('en-US');
    expect(getDateLocale('ru')).toBe('ru-RU');
    expect(enT.pluralNoun(1, 'task')).toBe('task');
    expect(enT.pluralNoun(3, 'task')).toBe('tasks');
    expect(ruT.pluralNoun(3, 'task')).toBe('задачи');
    expect(translate('en', 'nav.vault')).toBe('Vault');
    expect(translate('ru', 'nav.vault')).toBe('Сейф');
  });

  it('localizes shared presets, sections, tasks, starter tags, and templates without breaking defaults', () => {
    expect(getAccentPresets('ru')).toHaveLength(ACCENT_PRESETS.length);
    expect(getAccentPresets('en').some((p) => p.label === 'Terracotta')).toBe(true);
    expect(getDarkBgPresets('en')).toHaveLength(DARK_BG_PRESETS.length);
    expect(getLightBgPresets('en')).toHaveLength(LIGHT_BG_PRESETS.length);

    expect(getModeMeta('en').autopilot.label).toBe('Smart Triage');
    expect(getDnaMeta('en').note.label).toBe('Notes');
    expect(getOrganicSectionCatalog('en').some((s) => s.canonicalName === 'Work')).toBe(true);
    expect(getDefaultStarterTags('en').some((t) => CYRILLIC_RE.test(t))).toBe(false);
    expect(getDefaultTaskBoardColumns('en')[0]?.title).toBe('Inbox');
    expect(getTaskColumnIcons('en').length).toBeGreaterThan(0);

    const enTemplates = getNoteTemplates('en');
    const enOnboarding = getOnboardingPresets('en');
    expect(enTemplates.every((tpl) => !CYRILLIC_RE.test(tpl.label + tpl.body))).toBe(true);
    expect(enOnboarding.welcomeNote.title).toBe('Welcome to Kapsula');
  });

  it('persists locale in VaultRepository, respects bare-Node fallback -> OS -> env -> explicit pref, syncs via workspace_prefs LWW, and seeds EN demo vault', async () => {
    const dir = makeTempDir();
    const repo = openRepo(path.join(dir, 'vault.sqlite'));

    // Bare Node tests fall back to 'ru' when no OS locale or env override exists
    expect(repo.getLocale()).toBe('ru');

    // OS locale applies only when user has not explicitly stored a preference
    repo.setDefaultOsLocale('en-US');
    expect(repo.getLocale()).toBe('en');

    // KAPSULA_LOCALE overrides OS detection when no explicit stored pref exists
    process.env.KAPSULA_LOCALE = 'ru';
    expect(repo.getLocale('en-US')).toBe('ru');

    // Explicit stored locale persists and wins over env/OS
    repo.setLocale('en');
    process.env.KAPSULA_LOCALE = 'ru';
    expect(repo.getLocale('ru-RU')).toBe('en');

    // Included in workspace_prefs sync payload
    const syncPayload = repo.getWorkspacePrefsForSync();
    expect(syncPayload).not.toBeNull();
    expect(syncPayload?.locale).toBe('en');

    // Remote newer workspace_prefs updates local locale via LWW; stale payload is ignored
    const futureTs = Date.now() + 60_000;
    const applied = repo.applySyncedWorkspacePrefs(
      {
        v: 1,
        id: 'default',
        locale: 'ru',
        updatedAt: futureTs,
        deletedAt: null,
        syncVersion: 9,
      },
      'remote-device',
      'local-device'
    );
    expect(applied.applied).toBe(true);
    expect(repo.getLocale('en-US')).toBe('ru');

    const stale = repo.applySyncedWorkspacePrefs(
      {
        v: 1,
        id: 'default',
        locale: 'en',
        updatedAt: futureTs - 120_000,
        deletedAt: null,
        syncVersion: 1,
      },
      'remote-device',
      'local-device'
    );
    expect(stale.applied).toBe(false);
    expect(repo.getLocale()).toBe('ru');

    // Localized English demo seed creates English sections and items
    const enDir = makeTempDir();
    const enRepo = openRepo(path.join(enDir, 'en-vault.sqlite'));
    enRepo.setLocale('en');
    const enCrypto = new VaultCrypto(enDir, null);
    const pipeline = new CapturePipeline({
      repo: enRepo,
      cryptoVault: enCrypto,
      dataDir: enDir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    const seededCount = await ensureDemoSeeded(enRepo, enCrypto, pipeline, true);
    expect(seededCount).toBeGreaterThan(0);
    const orbits = enRepo.listOrbits();
    const seededItems = enRepo.queryItems({ includeSecrets: true, limit: 50 });
    expect(orbits.some((o) => o.name === 'Work')).toBe(true);
    expect(orbits.every((o) => !CYRILLIC_RE.test(o.name))).toBe(true);
    expect(seededItems.some((item) => /Knowledge Base/i.test(item.title))).toBe(true);
    expect(seededItems.every((item) => !CYRILLIC_RE.test(item.title))).toBe(true);
  });

  it('has zero leftover hardcoded Russian UI string literals or static ru-RU tags in src/renderer/**', () => {
    const rendererFiles = collectFilesRecursive(RENDERER_DIR, new Set(['.ts', '.tsx']));
    expect(rendererFiles.length).toBeGreaterThan(40);

    const violations: string[] = [];

    for (const filePath of rendererFiles) {
      const sourceText = fs.readFileSync(filePath, 'utf8');
      const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
      const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node)
        ) {
          const text = node.text;
          if (CYRILLIC_RE.test(text) || /ru-RU/.test(text)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${rel}:${line + 1} -> ${JSON.stringify(text.trim().slice(0, 80))}`);
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(sf);
    }

    expect(violations).toEqual([]);

    const htmlPath = path.join(RENDERER_DIR, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(CYRILLIC_RE.test(html)).toBe(false);
  });
});
