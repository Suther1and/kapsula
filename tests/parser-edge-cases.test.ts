import { execFileSync } from 'node:child_process';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  PRO_FEATURE_CATALOG,
  PRO_FEATURE_CATALOG_EN,
  canUseFeature,
  getProFeatureCatalog,
  isPaywallEnforced,
  type ProFeatureKey,
} from '@shared/entitlements';
import { decodeHtmlEntities, truncateAtWordBoundary } from '@shared/html-entities';
import { formatRelativeTime } from '@shared/i18n/core';
import { countChecklistStats } from '@shared/item-helpers';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { serializeTelegramEntitiesToMarkdown } from '@shared/telegram-entities';

function runRussianParserInTimezone(
  tz: string,
  text: string,
  refTimestamp: number
): { startAt: number; endAt: number; allDay: boolean } | null {
  const bundled = esbuild.buildSync({
    entryPoints: ['src/shared/russian-event-parser.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
  });
  const code = bundled.outputFiles[0]!.text;
  const script = `
    const mod = { exports: {} };
    const fn = new Function('exports', 'module', ${JSON.stringify(code)});
    fn(mod.exports, mod);
    const res = mod.exports.parseRussianEvent(${JSON.stringify(text)}, ${refTimestamp});
    if (!res) { console.log('null'); }
    else {
      const dStart = new Date(res.startAt);
      const dEnd = new Date(res.endAt);
      console.log(JSON.stringify({
        startAt: res.startAt,
        endAt: res.endAt,
        allDay: res.allDay,
        endYear: dEnd.getFullYear(),
        endMonth: dEnd.getMonth(),
        endDay: dEnd.getDate(),
        endHour: dEnd.getHours(),
        endMinute: dEnd.getMinutes(),
        startDay: dStart.getDate()
      }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();
  return out === 'null' ? null : (JSON.parse(out) as {
    startAt: number;
    endAt: number;
    allDay: boolean;
    endYear: number;
    endMonth: number;
    endDay: number;
    endHour: number;
    endMinute: number;
    startDay: number;
  });
}

describe('Wave 0 Shared Edge Cases: Russian Event Parser, Entitlements & Shared Helpers', () => {
  describe('parseRussianEvent baselines', () => {
    it('parses valid Russian and English natural date expressions accurately', () => {
      const ref = new Date(2026, 4, 10, 9, 0, 0, 0).getTime(); // May 10, 2026 09:00

      const tomorrowRu = parseRussianEvent('завтра в 15:30 созвон с командой', ref);
      expect(tomorrowRu).not.toBeNull();
      expect(tomorrowRu!.isEventIntent).toBe(true);
      const td = new Date(tomorrowRu!.startAt);
      expect(td.getDate()).toBe(11);
      expect(td.getHours()).toBe(15);
      expect(td.getMinutes()).toBe(30);

      const mayRu = parseRussianEvent('15 мая встреча в офисе', ref);
      expect(mayRu).not.toBeNull();
      expect(new Date(mayRu!.startAt).getMonth()).toBe(4);
      expect(new Date(mayRu!.startAt).getDate()).toBe(15);

      const relRu = parseRussianEvent('через 2 часа позвонить врачу', ref);
      expect(relRu).not.toBeNull();
      expect(relRu!.startAt).toBe(ref + 2 * 3_600_000);

      const enEv = parseRussianEvent('tomorrow at 10:00 product demo', ref, undefined, 'en');
      expect(enEv).not.toBeNull();
      expect(enEv!.isEventIntent).toBe(true);
      expect(new Date(enEv!.startAt).getHours()).toBe(10);
    });
  });

  describe('entitlements.ts (Locked Decision #4)', () => {
    it('maintains 100% RU/EN catalog parity and keeps isPaywallEnforced=false during pre-Pro waves', () => {
      const ruKeys = Object.keys(PRO_FEATURE_CATALOG).sort() as ProFeatureKey[];
      const enKeys = Object.keys(PRO_FEATURE_CATALOG_EN).sort() as ProFeatureKey[];
      expect(ruKeys).toEqual(enKeys);
      expect(ruKeys.length).toBeGreaterThanOrEqual(10);

      for (const k of ruKeys) {
        expect(PRO_FEATURE_CATALOG[k].title.trim().length).toBeGreaterThan(0);
        expect(PRO_FEATURE_CATALOG[k].description.trim().length).toBeGreaterThan(0);
        expect(PRO_FEATURE_CATALOG_EN[k].title.trim().length).toBeGreaterThan(0);
        expect(PRO_FEATURE_CATALOG_EN[k].description.trim().length).toBeGreaterThan(0);
        expect(canUseFeature(k, 'free')).toBe(true);
        expect(canUseFeature(k, 'pro')).toBe(true);
      }

      expect(isPaywallEnforced).toBe(false);
      expect(getProFeatureCatalog('ru')).toBe(PRO_FEATURE_CATALOG);
      expect(getProFeatureCatalog('en')).toBe(PRO_FEATURE_CATALOG_EN);
    });
  });

  describe('Shared helpers baselines', () => {
    it('formats past relative times, decodes standard entities, and counts basic checklists', () => {
      const now = 1_700_000_000_000;
      expect(formatRelativeTime('ru', now - 10_000, now)).toBe('только что');
      expect(formatRelativeTime('ru', now - 5 * 60_000, now)).toBe('5 мин назад');
      expect(formatRelativeTime('en', now - 2 * 3_600_000, now)).toBe('2h ago');

      expect(decodeHtmlEntities('We&#x2019;re &laquo;live&raquo;')).toBe('We’re «live»');
      expect(countChecklistStats('- [ ] todo\n- [x] done')).toEqual({ total: 2, done: 1 });
      expect(truncateAtWordBoundary('Короткий заголовок', 50)).toBe('Короткий заголовок');
      expect(
        serializeTelegramEntitiesToMarkdown('Привет мир', [
          { type: 'bold', offset: 0, length: 6 },
        ]).markdown
      ).toBe('**Привет** мир');
    });
  });

  describe('Known Wave 2 audit fixes (shared parsers & formatters)', () => {
    it(
      '[Wave 2: BUG-07] rejects impossible calendar dates like "31 февраля" and "0 марта" instead of rolling over',
      () => {
        const ref = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
        const feb31 = parseRussianEvent('31 февраля встреча', ref);
        const mar0 = parseRussianEvent('0 марта созвон', ref);
        const apr31 = parseRussianEvent('31 апреля дедлайн', ref);

        expect(feb31 === null || feb31.isEventIntent === false).toBe(true);
        expect(mar0 === null || mar0.isEventIntent === false).toBe(true);
        expect(apr31 === null || apr31.isEventIntent === false).toBe(true);
      }
    );

    it(
      '[Wave 2: BUG-07] does not trigger calendar event intent on software versions like "Версия 20.11" or "Chrome 12.10"',
      () => {
        const ref = new Date(2026, 10, 1, 12, 0, 0, 0).getTime();
        const v1 = parseRussianEvent('Версия 20.11 вышла с исправлениями', ref);
        const v2 = parseRussianEvent('Обновление Chrome 12.10', ref);

        expect(v1 === null || v1.isEventIntent === false).toBe(true);
        expect(v2 === null || v2.isEventIntent === false).toBe(true);
      }
    );

    it(
      '[Wave 2: BUG-07] maps "12 ночи" to 00:00 (midnight) rather than 12:00 noon',
      () => {
        const ref = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
        const parsed = parseRussianEvent('завтра в 12 ночи деплой', ref);
        expect(parsed).not.toBeNull();
        expect(new Date(parsed!.startAt).getHours()).toBe(0);
      }
    );

    it(
      '[Wave 2: BUG-07] supports fractional relative offsets like "через 2.5 часа"',
      () => {
        const ref = new Date(2026, 4, 10, 10, 0, 0, 0).getTime();
        const parsed = parseRussianEvent('через 2.5 часа позвонить', ref);
        expect(parsed).not.toBeNull();
        expect(parsed!.startAt).toBe(ref + 150 * 60_000);
      }
    );

    it(
      '[Wave 2: BUG-07] keeps allDay endAt within the same calendar day across DST spring-forward (America/New_York 2026-03-08)',
      () => {
        const ref = Date.parse('2026-03-07T12:00:00-05:00');
        const res = runRussianParserInTimezone('America/New_York', '8 марта весь день конференция', ref) as {
          allDay: boolean;
          startDay: number;
          endDay: number;
          endHour: number;
        } | null;

        expect(res).not.toBeNull();
        expect(res!.allDay).toBe(true);
        expect(res!.startDay).toBe(8);
        expect(res!.endDay).toBe(8);
        expect(res!.endHour).toBe(23);
      }
    );

    it(
      '[Wave 2: BUG-M01] does not format future timestamps (+10m) as "только что"',
      () => {
        const now = 1_700_000_000_000;
        const label = formatRelativeTime('ru', now + 10 * 60_000, now);
        expect(label).not.toBe('только что');
      }
    );

    it(
      '[Wave 2: BUG-M01] countChecklistStats ignores markdown checkboxes inside fenced code blocks',
      () => {
        const md = ['- [ ] Реальная задача', '```md', '- [ ] Пример в коде', '```'].join('\n');
        expect(countChecklistStats(md)).toEqual({ total: 1, done: 0 });
      }
    );

    it(
      '[Wave 2: BUG-M01] truncateAtWordBoundary never splits a UTF-16 emoji surrogate pair in half',
      () => {
        const input = 'АБВГД😀ЕЖЗИЙКЛМНОП';
        // Cut right at index 6 (middle of 😀 surrogate pair at indices 5..6)
        const truncated = truncateAtWordBoundary(input, 6);
        const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          truncated
        );
        expect(hasLoneSurrogate).toBe(false);
      }
    );

    it(
      '[Wave 2: BUG-M01] serializeTelegramEntitiesToMarkdown quotes all lines of multiline blockquotes and escapes ")" in text_link URLs',
      () => {
        const quoteText = 'Первая строка\nВторая строка';
        const qRes = serializeTelegramEntitiesToMarkdown(quoteText, [
          { type: 'blockquote', offset: 0, length: quoteText.length },
        ]);
        expect(qRes.markdown).toContain('> Первая строка\n> Вторая строка');

        const linkText = 'Wiki';
        const linkRes = serializeTelegramEntitiesToMarkdown(linkText, [
          {
            type: 'text_link',
            offset: 0,
            length: linkText.length,
            url: 'https://en.wikipedia.org/wiki/C_(programming_language)',
          },
        ]);
        expect(linkRes.markdown).not.toContain('language))');
        expect(linkRes.markdown).toMatch(/\[Wiki\]\(https:\/\/en\.wikipedia\.org\/wiki\/C_(?:%28|\()programming_language(?:%29|\\\))\)/);
      }
    );
  });
});
