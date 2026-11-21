import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanBrokenTextArtifacts,
  cleanInstagramText,
  decodeHtmlEntities,
  truncateAtWordBoundary,
} from '@shared/html-entities';
import { DEFAULT_HUD_SHORTCUT } from '@shared/shortcuts';
import {
  detectPlatformIntent,
  expandBilingualQuery,
  matchesBilingualHaystack,
} from '@shared/bilingual-search';
import {
  exportEventsToIcal,
  parseIcalFeed,
  parseRussianDateExpression,
} from '@main/bridges/google-calendar';
import { VaultRepository } from '@main/db/repository';
import { callFlashLiteJson, previewSmartTriageWithAi } from '@main/ai/enricher';
import { classifyLocally } from '@main/ai/local-heuristic';
import { parseFxTwitterResponse, parseTelegramPostHtml } from '@main/pipeline/unfurler';
import { analyzeForSecret } from '@main/security/secret-shield';
import { VaultCrypto } from '@main/security/vault-crypto';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import {
  formatCardExpiryDraft,
  normalizeCardExpiry,
  parseRussianEvent,
  recoverBankCardExpiry,
} from '@shared/russian-event-parser';
import {
  countChecklistStats,
  getMediaCategory,
  isAnyTextNote,
  isDedicatedNote,
  isMediaItem,
} from '@shared/item-helpers';
import { stripLeadingTitle, stripMarkdownPreview, getDnaHumanLabel } from '../src/renderer/lib/format';

const repos: VaultRepository[] = [];
const tempDirs: string[] = [];

function createRepo(): VaultRepository {
  const repo = new VaultRepository(':memory:');
  repos.push(repo);
  return repo;
}

afterEach(() => {
  while (repos.length > 0) repos.pop()!.close();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula v6 Intelligence, Parsers & Calendar', () => {
  it('decodes HTML entities and strips Instagram engagement boilerplate', () => {
    expect(
      decodeHtmlEntities('Don&#039;t miss &quot;Design &amp; Motion&quot; &#x2014; v6!')
    ).toBe('Don\'t miss "Design & Motion" — v6!');

    const cleaned = cleanInstagramText(
      '12.4K likes, 84 comments - studio.ref on May 1, 2026: "Shaders &amp; UI breakdown"',
      '9,120 likes, 31 comments - studio.ref on May 1, 2026: "Shaders &amp; UI breakdown for indie game devs"'
    );
    expect(cleaned.cleanTitle ?? '').not.toMatch(/likes.*comments/i);
    expect(cleaned.cleanTitle ?? cleaned.caption).toContain('Shaders & UI');
    expect(cleaned.caption).toContain('Shaders & UI breakdown for indie game devs');
  });

  it('extracts full body, links, author and images from Telegram embed/web post HTML', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta property="og:title" content="Дизайн-капсула" />
          <meta property="og:image" content="https://cdn.telegram.org/file/cover.jpg" />
        </head>
        <body>
          <div class="tgme_widget_message">
            <div class="tgme_widget_message_author"><span dir="auto">Артем · Шейдеры</span></div>
            <div class="tgme_widget_message_text js-message_text">
              Отличная подборка референсов по стилизованной воде для Unity:<br/>
              1. <a href="https://example.com/water-guide">Гайд по каустикам</a><br/>
              2. Поддержка &laquo;мягкой&raquo; глубины буфера.
            </div>
            <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.telegram.org/file/shot1.jpg')"></a>
            <time datetime="2026-11-10T14:20:00+00:00"></time>
          </div>
        </body>
      </html>
    `;

    const parsed = parseTelegramPostHtml(html, 'https://t.me/shader_lab/412');
    expect(parsed.bodyMarkdown).toContain('стилизованной воде для Unity');
    expect(parsed.bodyMarkdown).toContain('«мягкой» глубины буфера');
    expect(parsed.bodyMarkdown).toContain('https://example.com/water-guide');
    expect(parsed.author).toContain('Артем');
    expect(parsed.ogImageUrl).toBe('https://cdn.telegram.org/file/shot1.jpg');
    expect(parsed.title).toBeTruthy();
    expect(parsed.title).not.toBe('Дизайн-капсула');
  });

  it('parses X/Twitter posts via fxtwitter payload', () => {
    const out = parseFxTwitterResponse(
      {
        tweet: {
          text: 'Procedural foliage wind shader breakdown for stylized RPGs https://t.co/xyz',
          created_at: '2026-11-10T10:00:00Z',
          author: { name: 'Shader Craft', screen_name: 'shadercraft' },
          media: {
            photos: [{ url: 'https://pbs.twimg.com/media/foliage.jpg' }],
          },
        },
      },
      'https://x.com/shadercraft/status/123456'
    );
    expect(out).not.toBeNull();
    expect(out?.author).toContain('Shader Craft');
    expect(out?.bodyMarkdown).toContain('Procedural foliage wind shader breakdown');
    expect(out?.ogImageUrl).toBe('https://pbs.twimg.com/media/foliage.jpg');
  });

  it('performs bilingual RU<->EN and wrong-keyboard-layout search in memory & SQLite repository', () => {
    const groups = expandBilingualQuery('инстаграм');
    expect(groups.flatMap((g) => g.variants)).toContain('instagram');

    expect(matchesBilingualHaystack('instagram post reels', 'инстаграм')).toBe(true);
    expect(matchesBilingualHaystack('instagram post reels', 'bycnfuhfv')).toBe(true);

    const repo = createRepo();
    const ig = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Instagram Shader Reference',
      url: 'https://www.instagram.com/p/C9abc123/',
      domain: 'instagram.com',
      tags: ['instagram'],
      source: 'vault_ui',
      contentHash: 'ig-bi-1',
    });

    expect(repo.queryItems({ search: 'инстаграм' }).map((i) => i.id)).toContain(ig.id);
    expect(repo.queryItems({ search: 'bycnfuhfv' }).map((i) => i.id)).toContain(ig.id);
  });

  it('parses Russian natural date phrases and round-trips iCalendar (.ics) events', () => {
    const baseMs = new Date(2026, 10, 16, 10, 0, 0).getTime(); // 16 Nov 2026 10:00
    const tomorrow = parseRussianDateExpression('созвон завтра в 15:30 по новому релизу', baseMs);
    expect(tomorrow).not.toBeNull();
    const d = new Date(tomorrow!.startAt);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);

    const ics = exportEventsToIcal([
      {
        id: 'ev-1',
        title: 'Синк по Kapsula',
        notes: 'Проверка релиза',
        startAt: new Date(2026, 10, 17, 15, 30, 0).getTime(),
        endAt: new Date(2026, 10, 17, 16, 30, 0).getTime(),
        allDay: false,
      },
    ]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('Синк по Kapsula');

    const imported = parseIcalFeed(ics);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.title).toBe('Синк по Kapsula');
    expect(imported[0]?.allDay).toBe(false);
  });

  it('does NOT misclassify casual promo codes as secrets while still catching real API keys', () => {
    const promo = analyzeForSecret('Промокод на доставку: SALE2026 действует до пятницы');
    expect(promo.isSecret).toBe(false);

    const apiKey = analyzeForSecret('OpenRouter ключ: sk-or-v1-abcdefghijklmnopqrstuvwxyz123456');
    expect(apiKey.isSecret).toBe(true);
    expect(apiKey.meta?.kind).toBe('api_key');
  });

  it('strips inline markdown checklists and leading titles across emoji variation selectors', () => {
    const cleanedMd = stripMarkdownPreview('Нужно добавить каустики. - [ ] Настроить карту нормалей');
    expect(cleanedMd).toBe('Нужно добавить каустики. Настроить карту нормалей');

    const stripped = stripLeadingTitle(
      '❤\uFE0F Thanks everyone for your support and love! Last month I got interviewed by police',
      '❤ Thanks everyone for your support and love!',
    );
    expect(stripped).toBe('Last month I got interviewed by police');
  });

  it('does not trigger false design/document tags on substrings like require, built, or факт', () => {
    const falseUi = classifyLocally({
      title: 'News post update',
      text: 'This build would require several changes and was built around a quiet fact. Интересный факт и реакция.',
    });
    expect(falseUi.tags).not.toContain('дизайн');
    expect(falseUi.tags).not.toContain('документы');

    const realUi = classifyLocally({
      text: 'Палитра цветов, макет и UI с UX компонентами',
    });
    expect(realUi.tags).toContain('дизайн');
  });

  it('preserves HTML entities inside Telegram <pre><code> blocks without double decoding', () => {
    const sampleHtml = `
      <div class="tgme_widget_message_text">Пример кода <pre><code>&amp;lt;div&amp;gt;hello&amp;lt;/div&amp;gt;</code></pre> и текст &amp;mdash; готово</div>
    `;
    const parsed = parseTelegramPostHtml(sampleHtml, 'https://t.me/test/1');
    expect(parsed.bodyMarkdown).toContain('&lt;div&gt;hello&lt;/div&gt;');
  });

  it('excludes all-day events ending exactly at day start from spilling into the next calendar day', () => {
    const repo = createRepo();
    const day1Start = new Date(2026, 10, 16, 0, 0, 0, 0).getTime();
    const day2Start = day1Start + 86_400_000;
    const day3Start = day2Start + 86_400_000;

    repo.upsertCalendarEvent({
      title: 'Однодневное событие',
      startAt: day1Start,
      endAt: day2Start,
      allDay: true,
    });

    expect(repo.listCalendarEvents({ startAt: day1Start, endAt: day2Start })).toHaveLength(1);
    expect(repo.listCalendarEvents({ startAt: day2Start, endAt: day3Start })).toHaveLength(0);
  });

  it('returns distinct Russian labels for all 5 SecretKind variants', () => {
    const base = { dna: 'secret' } as Parameters<typeof getDnaHumanLabel>[0];
    const meta = (kind: NonNullable<typeof base.secretMeta>['kind']) => ({
      kind,
      service: 'test',
      loginHint: '',
    });
    expect(getDnaHumanLabel({ ...base, secretMeta: meta('bank_card') })).toBe('Банковская карта');
    expect(getDnaHumanLabel({ ...base, secretMeta: meta('password') })).toBe('Логин и пароль');
    expect(getDnaHumanLabel({ ...base, secretMeta: meta('api_key') })).toBe('Ключ доступа');
    expect(getDnaHumanLabel({ ...base, secretMeta: meta('seed') })).toBe('Фраза восстановления');
    expect(getDnaHumanLabel({ ...base, secretMeta: meta('note') })).toBe('Секретная заметка');
  });

  it('defaults HUD global shortcut to Alt+Space and cleans split/markdown artifacts', () => {
    expect(DEFAULT_HUD_SHORTCUT).toBe('Alt+Space');
    expect(cleanBrokenTextArtifacts('клиент с н — евероятной скоростью', true)).toBe(
      'клиент с невероятной скоростью'
    );
    expect(cleanBrokenTextArtifacts('рекомендует устан — овить скилл', true)).toBe(
      'рекомендует установить скилл'
    );
    expect(cleanBrokenTextArtifacts('зелёной, крас — кой, синей', true)).toBe(
      'зелёной, краской, синей'
    );
    expect(cleanBrokenTextArtifacts('**База ресурсов для дизайнеров**', true)).toBe(
      'База ресурсов для дизайнеров'
    );
  });

  it('strips Telegram channel subscribe promo links and duplicate leading headline', () => {
    const html = `
      <div class="tgme_widget_message">
        <div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name">Топор Live</a></div>
        <div class="tgme_widget_message_text">
          <b>⚡ США разрабатывают новую ядерную авиабомбу B94, — TWZ.</b><br><br>
          В бюджетных документах США впервые за десятилетия появилось обозначение новой бомбы.<br><br>
          👉 <a href="https://t.me/toporlive">Топор Live. Подписаться</a><br>
          <a href="https://twz.com/news-b94">Источник TWZ</a>
        </div>
      </div>
    `;
    const parsed = parseTelegramPostHtml(html, 'https://t.me/toporlive/207549');
    expect(parsed.title).toContain('США разрабатывают новую ядерную авиабомбу B94');
    expect(parsed.bodyMarkdown).toContain('В бюджетных документах США');
    expect(parsed.bodyMarkdown).not.toContain('Подписаться');
    expect(parsed.bodyMarkdown).not.toMatch(/США разрабатывают новую ядерную авиабомбу B94/);
    expect(parsed.extractedLinks?.some((l) => l.value === 'https://twz.com/news-b94')).toBe(true);
    expect(parsed.extractedLinks?.some((l) => l.value === 'https://t.me/toporlive')).toBe(false);
  });

  it('keeps social/news feed links out of Документы even if body mentions документах', () => {
    const out = classifyLocally({
      url: 'https://t.me/toporlive/207549',
      title: 'США разрабатывают новую ядерную авиабомбу B94',
      text: 'В бюджетных документах США впервые появилось обозначение бомбы.',
    });
    expect(out.dna).toBe('link');
    expect(out.orbit).not.toBe('docs');
    expect(out.tags).not.toContain('документы');
  });

  it('scopes Assistant search strictly to requested platform on Instagram/Telegram queries', () => {
    expect(detectPlatformIntent('какие у меня есть сохраненки из инстаграма?')?.platform).toBe('instagram');

    const repo = createRepo();
    repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Discord клиент с невероятной скоростью',
      body: 'Вышел суперлёгкий клиент LarperCord',
      url: 'https://t.me/devnews/12',
      domain: 't.me',
      platform: 'telegram',
      source: 'vault_ui',
      contentHash: 'h-tg-1',
    });
    repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'UI референсы анимаций карточек',
      body: 'Разбор микровзаимодействий',
      url: 'https://www.instagram.com/p/demoCard/',
      domain: 'instagram.com',
      platform: 'instagram',
      source: 'vault_ui',
      contentHash: 'h-ig-1',
    });

    const found = repo.searchNonSecretForAsk('какие у меня есть сохраненки из инстаграма?', 12);
    expect(found).toHaveLength(1);
    expect(found[0]?.platform).toBe('instagram');
  });

  it('never slices Russian titles mid-word, avoids Финансы false positive on game cards, and eliminates 1-letter stubs', () => {
    const noteText = 'из интерфейса выбора карты селать просмотр всех текущих карт и колоды';
    expect(truncateAtWordBoundary('пример очень длинного текста про механику колоды', 30)).toBe(
      'пример очень длинного текста…'
    );

    const out = classifyLocally({
      text: noteText,
      orbits: [
        { id: 'fin', name: 'Финансы', description: 'Банки', icon: 'Receipt', color: '#2EA06B', sortOrder: 0, isBuiltin: false },
        { id: 'game', name: 'The Game', description: 'Игра', icon: 'GameController', color: '#8B5CF6', sortOrder: 1, isBuiltin: false },
      ],
    });
    expect(out.title).toBe(noteText);
    expect(out.title).not.toMatch(/колод$/);
    expect(out.tags).not.toContain('финансы');
    expect(out.orbit).not.toBe('fin');

    // Even if a legacy item had a mid-word chopped 68-char title, stripLeadingTitle swallows remainder word instead of showing "ы"
    const choppedLegacy = 'из интерфейса выбора карты селать просмотр всех текущих карт и колод';
    expect(stripLeadingTitle(noteText, choppedLegacy)).toBe('');
    expect(stripLeadingTitle(noteText, out.title)).toBe('');
  });

  it('heals mid-word titles, misrouted Финансы/Документы notes and Telegram promo footers on DB startup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v62-heal-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'vault.sqlite');
    const seedRepo = new VaultRepository(dbPath);
    const fin = seedRepo.createOrbit({ name: 'Финансы', description: '', color: '#2EA06B', icon: 'Receipt' });
    const docs = seedRepo.createOrbit({ name: 'Документы', description: '', color: '#94A3B8', icon: 'BookOpen' });
    const read = seedRepo.createOrbit({ name: 'Чтение', description: '', color: '#EAB308', icon: 'BookmarkSimple' });
    const game = seedRepo.createOrbit({ name: 'The Game', description: '', color: '#8B5CF6', icon: 'GameController' });

    const gameItem = seedRepo.createItem({
      dna: 'note',
      orbit: fin.id,
      modeCaptured: 'autopilot',
      title: 'из интерфейса выбора карты селать просмотр всех текущих карт и колод',
      body: 'из интерфейса выбора карты селать просмотр всех текущих карт и колоды',
      tags: ['финансы', 'telegram'],
      source: 'vault_ui',
      contentHash: 'heal-game-1',
      aiStatus: 'local',
    });

    const tgItem = seedRepo.createItem({
      dna: 'link',
      orbit: docs.id,
      modeCaptured: 'autopilot',
      title: 'Новая бомба B94',
      body: 'Подробный разбор.\n\n👉 Топор Live. Подписаться',
      url: 'https://t.me/toporlive/207549',
      domain: 't.me',
      platform: 'telegram',
      tags: ['telegram', 'документы'],
      extractedActions: [
        { type: 'url', value: 'https://t.me/toporlive', label: 'Топор Live. Подписаться' },
        { type: 'url', value: 'https://twz.com/b94', label: 'Источник' },
      ],
      source: 'vault_ui',
      contentHash: 'heal-tg-1',
      aiStatus: 'local',
    });
    seedRepo.close();

    // Re-run migration by clearing v6_2_deep_vault_heal markers in SQLite
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare("DELETE FROM settings WHERE key LIKE 'v6_2_deep_vault_heal%'").run();
    rawDb.close();

    const healedRepo = new VaultRepository(dbPath);
    repos.push(healedRepo);

    const healedGame = healedRepo.getItemById(gameItem.id);
    expect(healedGame?.title).toBe('из интерфейса выбора карты селать просмотр всех текущих карт и колоды');
    expect(healedGame?.orbit).toBe(game.id);
    expect(healedGame?.tags).not.toContain('финансы');

    const healedTg = healedRepo.getItemById(tgItem.id);
    expect(healedTg?.orbit).toBe(read.id);
    expect(healedTg?.tags).not.toContain('документы');
    expect(healedTg?.body).toBe('Подробный разбор.');
    expect(healedTg?.extractedActions.map((a) => a.value)).toEqual(['https://twz.com/b94']);
  });

  it('handles Gemini 2.5 thinking blocks, retries truncated JSON on fallback Flash, and triages misrouted local items', async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const mockThoughtFetch: typeof fetch = async (_url, init) => {
      if (init?.body) seenBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Internal chain of thought...' },
                  { text: '{"ok":true,"note":"clean"}' },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const thoughtRes = await callFlashLiteJson({
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetchFn: mockThoughtFetch,
    });
    expect(thoughtRes.parsed).toEqual({ ok: true, note: 'clean' });
    expect((seenBodies[0]?.generationConfig as Record<string, unknown>)?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });

    // Primary returns truncated JSON on HTTP 200 -> automatically retries on gemini-2.5-flash
    const urlsCalled: string[] = [];
    const mockRetryFetch: typeof fetch = async (url) => {
      const sUrl = String(url);
      urlsCalled.push(sUrl);
      if (urlsCalled.length === 1) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"truncated": ' }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"recovered":true}' }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const retryRes = await callFlashLiteJson({
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetchFn: mockRetryFetch,
    });
    expect(urlsCalled).toHaveLength(2);
    expect(urlsCalled[1]).toContain('gemini-2.5-flash:generateContent');
    expect(retryRes.parsed).toEqual({ recovered: true });

    // Triage across local misclassified game items -> suggests re-routing to game orbit + board + mergeGroups
    const repo = createRepo();
    const fin = repo.createOrbit({ name: 'Финансы', description: 'Банки', color: '#2EA06B', icon: 'Receipt' });
    const game = repo.createOrbit({ name: 'The Game', description: 'Игра', color: '#8B5CF6', icon: 'GameController' });
    const gameBoard = repo.createFocusBoard('The game', '#8B5CF6', 'GameController');

    const m1 = repo.createItem({
      dna: 'note',
      orbit: fin.id,
      modeCaptured: 'autopilot',
      title: 'Просмотр всех текущих карт и колоды',
      body: 'Из интерфейса выбора карты сделать просмотр колоды',
      source: 'vault_ui',
      contentHash: 'tr-1',
      aiStatus: 'local',
    });
    const m2 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Три ступени графики 100, 85, 75',
      body: 'Три ступени графики и эффектов без HDR',
      source: 'vault_ui',
      contentHash: 'tr-2',
      aiStatus: 'local',
    });

    const triageRes = await previewSmartTriageWithAi({
      repo,
      items: [m1, m2],
      orbits: [fin, game],
      boards: [gameBoard],
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestions: [
                          {
                            itemId: m1.id,
                            targetOrbit: game.id,
                            targetBoardId: gameBoard.id,
                            suggestedTags: ['игра', 'колода'],
                            archive: false,
                            reason: 'Механика карточной игры',
                            confidence: 0.94,
                          },
                          {
                            itemId: m2.id,
                            targetOrbit: game.id,
                            targetBoardId: gameBoard.id,
                            suggestedTags: ['графика'],
                            archive: false,
                            reason: 'Настройки рендера игры',
                            confidence: 0.91,
                          },
                        ],
                        newOrbits: [],
                        mergeGroups: [
                          {
                            title: 'Идеи по игре',
                            itemIds: [m1.id, m2.id],
                            reason: 'Короткие заметки про игру',
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    expect(triageRes.configured).toBe(true);
    expect(triageRes.usedCloud).toBe(true);
    expect(triageRes.suggestions).toHaveLength(2);
    expect(triageRes.suggestions[0]?.targetOrbit).toBe(game.id);
    expect(triageRes.suggestions[0]?.targetBoardId).toBe(gameBoard.id);
    expect(triageRes.mergeGroups).toHaveLength(1);
  });

  it('prevents false Финансы matches on conversational/UI phrases and heals markdown-prefixed titles + FTS summary', () => {
    const finOrbits = [
      { id: 'fin', name: 'Финансы', description: '', icon: 'Receipt', color: '#2EA06B', sortOrder: 0, isBuiltin: false },
      { id: 'work', name: 'Работа', description: '', icon: 'Briefcase', color: '#3B82F6', sortOrder: 1, isBuiltin: false },
    ];
    for (const sample of [
      'перевод текста на английский',
      'на счёт завтрашней встречи нужно уточнить время',
      'сделать чек-бокс в форме настроек',
    ]) {
      const classified = classifyLocally({ text: sample, orbits: finOrbits });
      expect(classified.orbit, `Should not classify "${sample}" into Финансы`).not.toBe('fin');
      expect(classified.tags).not.toContain('финансы');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v62-heal-v2-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'vault.sqlite');
    const seed = new VaultRepository(dbPath);
    const fin = seed.createOrbit({ name: 'Финансы', description: '', color: '#2EA06B', icon: 'Receipt' });
    const myGames = seed.createOrbit({ name: 'Мои игры', description: '', color: '#8B5CF6', icon: 'GameController' });
    const mdChopped = seed.createItem({
      dna: 'note',
      orbit: fin.id,
      modeCaptured: 'autopilot',
      title: 'из интерфейса выбора карты селать просмотр всех текущих карт и колод',
      summary: 'из интерфейса выбора карты селать просмотр всех текущих карт и колод',
      body: '- [ ] из интерфейса выбора карты селать просмотр всех текущих карт и колоды',
      tags: ['финансы'],
      source: 'vault_ui',
      contentHash: 'md-chop-1',
      aiStatus: 'local',
    });
    seed.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("DELETE FROM settings WHERE key LIKE 'v6_2_deep_vault_heal%'").run();
    raw.close();

    const healed = new VaultRepository(dbPath);
    repos.push(healed);

    const row = healed.getItemById(mdChopped.id);
    expect(row?.title).toBe('из интерфейса выбора карты селать просмотр всех текущих карт и колоды');
    expect(row?.summary).toBe('');
    expect(row?.orbit).toBe(myGames.id);
    expect(row?.tags).not.toContain('финансы');
  });

  it('normalizes, auto-formats and recovers bank card expiry including Belarusian banks', () => {
    expect(normalizeCardExpiry('09/29')).toBe('09/29');
    expect(normalizeCardExpiry('9.2029')).toBe('09/29');
    expect(normalizeCardExpiry('0929')).toBe('09/29');
    expect(formatCardExpiryDraft('0929')).toBe('09/29');
    expect(formatCardExpiryDraft('929')).toBe('09/29');
    expect(recoverBankCardExpiry('', 'Статус Банк действительна до 09/29')).toBe('09/29');

    const detected = analyzeForSecret('Статус Банк (Беларусь)\n4111 1111 1119 9215\n09/29\nCVV 412');
    expect(detected.isSecret).toBe(true);
    expect(detected.meta?.kind).toBe('bank_card');
    expect(detected.meta?.last4).toBe('9215');
    expect(detected.meta?.expiry).toBe('09/29');
    expect(detected.meta?.hasCvv).toBe(true);
  });

  it('parses Russian natural events cleanly and auto-syncs CapturePipeline notes to Calendar', async () => {
    const refNow = new Date(2026, 10, 17, 10, 0, 0, 0).getTime(); // Tue 2026-11-17

    const bareWeekday = parseRussianEvent('Пятница 15:00 созвон по проекту', refNow);
    expect(bareWeekday?.isEventIntent).toBe(true);
    expect(bareWeekday?.hasEndTime).toBe(false);
    expect(new Date(bareWeekday!.startAt).getDay()).toBe(5);
    expect(new Date(bareWeekday!.startAt).getHours()).toBe(15);

    const dentist = parseRussianEvent('21.11 в 17:15 Чистка зубов на Ленина 14', refNow);
    expect(dentist?.isEventIntent).toBe(true);
    expect(dentist?.hasEndTime).toBe(false);
    expect(dentist?.title).toContain('Чистка зубов');
    expect(dentist?.location).toContain('Ленина 14');

    const ranged = parseRussianEvent('Завтра в 11:00 стендап в Zoom на 45 м', refNow);
    expect(ranged?.isEventIntent).toBe(true);
    expect(ranged?.hasEndTime).toBe(true);
    expect(Math.round((ranged!.endAt - ranged!.startAt) / 60_000)).toBe(45);
    expect(ranged?.title).not.toMatch(/\b45\s*м\b/);

    const clinic = parseRussianEvent('Приём клиника Медси завтра в 15:00', refNow);
    expect(clinic?.isEventIntent).toBe(true);
    expect(clinic?.location).toContain('Медси');
    expect(new Date(clinic!.startAt).getHours()).toBe(15);

    const fbDay = new Date(2026, 10, 25, 0, 0, 0, 0).getTime();
    const withFallback = parseRussianEvent('Созвон в 15:00', refNow, fbDay);
    expect(withFallback?.isEventIntent).toBe(true);
    expect(new Date(withFallback!.startAt).getDate()).toBe(25);
    expect(new Date(withFallback!.startAt).getHours()).toBe(15);

    const febShortYear = parseRussianEvent('05.02.26 Встреча в 14:00', refNow);
    expect(febShortYear?.isEventIntent).toBe(true);
    expect(new Date(febShortYear!.startAt).getFullYear()).toBe(2026);
    expect(new Date(febShortYear!.startAt).getMonth()).toBe(1);
    expect(new Date(febShortYear!.startAt).getDate()).toBe(5);

    const twoClicks = parseRussianEvent('Сделать экспорт в 2 клика завтра', refNow);
    expect(twoClicks?.isEventIntent).toBe(true);
    expect(twoClicks?.allDay).toBe(true);
    expect(twoClicks?.title).toContain('2 клика');

    const icsParsed = parseIcalFeed(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:allday-1\nDTSTART;VALUE=DATE:20261119\nSUMMARY:Выставка\nEND:VEVENT\nEND:VCALENDAR'
    );
    expect(icsParsed).toHaveLength(1);
    expect(icsParsed[0]!.endAt).toBeLessThan(icsParsed[0]!.startAt + 86_400_000);

    const newsText = parseRussianEvent('16 ноября вышла новая версия движка без подробностей', refNow);
    expect(newsText?.isEventIntent ?? false).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v63-pipe-'));
    tempDirs.push(dir);
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    repos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    let calNotified = 0;
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 3,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
      onCalendarChanged: () => {
        calNotified++;
      },
    });

    const item = await pipeline.capture({
      text: '21.11 в 17:15 Чистка зубов на Ленина 14',
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();

    const events = repo.listCalendarEvents();
    const linked = events.find((ev) => ev.linkedItemId === item.id);
    expect(linked).toBeDefined();
    expect(linked?.externalSource).toBe('vault_auto');
    expect(linked?.hasEndTime).toBe(false);
    expect(linked?.title).toContain('Чистка зубов');
    expect(linked?.location).toContain('Ленина 14');
    expect(calNotified).toBeGreaterThanOrEqual(1);
  });

  it('distinguishes dedicated Notes Studio documents from short Telegram chatter and classifies Media categories cleanly', () => {
    const baseItem = {
      id: 'x',
      dna: 'note' as const,
      subKind: null,
      orbit: '',
      modeCaptured: 'autopilot' as const,
      focusBoardId: null,
      title: 'Test',
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
      source: 'vault_ui' as const,
      externalId: null,
      contentHash: 'h',
      aiStatus: 'local' as const,
      aiConfidence: null,
      isPinned: false,
      isArchived: false,
      isDemo: false,
      remindAt: null,
      remindedAt: null,
      createdAt: 1,
      updatedAt: 1,
      contentUpdatedAt: 1,
      deletedAt: null,
      canvasX: null,
      canvasY: null,
      canvasW: null,
      canvasH: null,
      canvasFrame: null,
      annotations: [],
      linksOut: [],
    };

    // Authored note in Kapsula always belongs in Заметки
    expect(isDedicatedNote({ ...baseItem, source: 'vault_ui', body: 'Короткая мысль' })).toBe(true);

    // Short 1-line Telegram Saved Message stays in Все записи, not polluting Мои заметки
    const shortTg = {
      ...baseItem,
      source: 'telegram_saved' as const,
      title: '3 ступени графики 100%, 85, 75',
      body: '3 ступени графики 100%, 85, 75',
    };
    expect(isDedicatedNote(shortTg)).toBe(false);
    expect(isAnyTextNote(shortTg)).toBe(true);

    // Structured or long Telegram note DOES qualify for Заметки
    const structuredTg = {
      ...baseItem,
      source: 'telegram_saved' as const,
      body: '## План релиза\n\n- [ ] Сделать билд\n- [x] Проверить меню',
    };
    expect(isDedicatedNote(structuredTg)).toBe(true);
    expect(countChecklistStats(structuredTg.body)).toEqual({ total: 2, done: 1 });

    // Media categorization across photo, video, audio, link_visual, and non-media
    expect(getMediaCategory({ ...baseItem, dna: 'shot', imagePath: 'a.png' })).toBe('photo');
    expect(getMediaCategory({ ...baseItem, dna: 'shot', subKind: 'video_ref', mediaPath: 'clip.mp4' })).toBe('video');
    expect(getMediaCategory({ ...baseItem, dna: 'voice', mediaPath: 'memo.wav' })).toBe('audio');
    expect(getMediaCategory({ ...baseItem, dna: 'link', ogImageUrl: 'https://img/1.jpg' })).toBe('link_visual');
    expect(isMediaItem({ ...baseItem, dna: 'note' })).toBe(false);
    expect(isMediaItem({ ...baseItem, dna: 'secret', imagePath: 'secret.png' })).toBe(false);
  });
});
