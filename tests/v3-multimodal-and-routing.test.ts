import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeTelegramEntitiesToMarkdown } from '@shared/telegram-entities';
import type { VaultItem } from '@shared/types';
import { askVaultWithAi } from '@main/ai/enricher';
import { answerVaultLocally, pickCleanScreenshotTitle } from '@main/ai/local-heuristic';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { ReminderScheduler } from '@main/pipeline/reminder-scheduler';
import { VaultCrypto } from '@main/security/vault-crypto';
import { extractContactActions, filterDistinctKeyPoints } from '@shared/item-helpers';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function createTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v3-test-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'vault.sqlite');
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  const pipeline = new CapturePipeline({
    repo,
    cryptoVault,
    dataDir: dir,
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
  return { dir, dbPath, repo, cryptoVault, pipeline };
}

/** Builds a minimal valid Stored `.docx` ZIP archive containing `word/document.xml`. */
function makeMinimalDocxBuffer(textContent: string): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${textContent}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const fileNameBuf = Buffer.from('word/document.xml', 'utf8');
  const uncompressed = Buffer.from(xml, 'utf8');
  const compressed = deflateRawSync(uncompressed);

  // Compute minimal ZIP with single Deflate entry
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of uncompressed) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(8, 8); // Deflate
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(uncompressed.length, 22);
  lfh.writeUInt16LE(fileNameBuf.length, 26);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(uncompressed.length, 24);
  cdh.writeUInt16LE(fileNameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);

  const cdOffset = lfh.length + fileNameBuf.length + compressed.length;
  const cdSize = cdh.length + fileNameBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, fileNameBuf, compressed, cdh, fileNameBuf, eocd]);
}

afterEach(() => {
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula v3: Organic Routing, Scratch Safety, Multimodal, Reminders & Inventory Chat', () => {
  it('keeps fleeting scratch noise unfoldered and avoids false secret classification', async () => {
    const { pipeline, repo } = createTestEnv();

    for (const phrase of ['Привет', '123123', 'фывфыв', 'тест']) {
      const item = await pipeline.capture({ text: phrase, source: 'vault_ui' });
      expect(item.dna).toBe('note');
      expect(item.orbit).toBe('');
      expect(item.hasEncryptedPayload).toBe(false);
    }

    expect(repo.listOrbits()).toHaveLength(0);
  });

  it('routes contacts into Контакты while keeping bank cards and API keys cleanly inside Сейф without clutter orbits', async () => {
    const { pipeline, repo } = createTestEnv();

    const contact = await pipeline.capture({
      text: 'Алексей Орлов (дизайнер)\nТел: +7 (999) 451-22-10\nTelegram: @alex_orlov_ux',
      source: 'vault_ui',
    });
    expect(contact.dna).toBe('note');
    expect(contact.subKind).toBe('contact');

    const card = await pipeline.capture({
      text: 'МИР Т-Банк 2200 7007 1234 5676 08/28 CVV 412',
      source: 'vault_ui',
    });
    expect(card.dna).toBe('secret');
    expect(card.orbit).toBe('');
    expect(card.secretMeta?.kind).toBe('bank_card');

    const apiKey = await pipeline.capture({
      text: 'OpenRouter API key: sk-or-v1-test9876543210abcdef123456',
      source: 'vault_ui',
    });
    expect(apiKey.dna).toBe('secret');
    expect(apiKey.orbit).toBe('');

    const orbitNames = new Set(repo.listOrbits().map((o) => o.name));
    expect(orbitNames.has('Контакты')).toBe(true);
    expect(orbitNames.has('Финансы')).toBe(false);
    expect(orbitNames.has('Доступы')).toBe(false);
  });

  it('migrates legacy v2 SQLite tables cleanly without losing existing data or orbits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-mig-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'legacy.sqlite');

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE orbits (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL, is_builtin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE focus_boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE items (
        id TEXT PRIMARY KEY, dna TEXT NOT NULL, orbit TEXT NOT NULL DEFAULT '', mode_captured TEXT NOT NULL, focus_board_id TEXT,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', url TEXT, domain TEXT, platform TEXT,
        image_path TEXT, og_image_url TEXT, ocr_text TEXT NOT NULL DEFAULT '',
        extracted_actions_json TEXT NOT NULL DEFAULT '[]', color_palette_json TEXT NOT NULL DEFAULT '[]',
        encrypted_payload TEXT, secret_meta_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual', external_id TEXT, content_hash TEXT NOT NULL,
        ai_status TEXT NOT NULL DEFAULT 'local', ai_confidence REAL,
        is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE ai_cache (content_hash TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE ai_usage_log (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO orbits (id, name, description, icon, color, sort_order, is_builtin) VALUES ('work', 'Работа', 'Старый раздел', 'Briefcase', '#6366F1', 0, 1);
      INSERT INTO items (id, dna, orbit, mode_captured, title, body, content_hash, source, created_at, updated_at) VALUES ('old-1', 'note', 'work', 'autopilot', 'Старая запись', 'Важные данные v2', 'oldhash1', 'vault_ui', 1700000000000, 1700000000000);
      CREATE VIRTUAL TABLE items_fts USING fts5(item_id UNINDEXED, title, body, ocr_text, tags);
      CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts (item_id, title, body, ocr_text, tags) VALUES (new.id, new.title, new.body, new.ocr_text, new.tags_json);
      END;
    `);
    legacyDb.close();

    const upgradedRepo = new VaultRepository(dbPath);
    openRepos.push(upgradedRepo);

    expect(upgradedRepo.listOrbits().some((o) => o.id === 'work' && o.name === 'Работа')).toBe(true);
    const oldItem = upgradedRepo.getItemById('old-1');
    expect(oldItem?.title).toBe('Старая запись');
    expect(oldItem?.subKind).toBeNull();
    expect(oldItem?.thumbPath).toBeNull();
    expect(oldItem?.remindAt).toBeNull();

    // FTS backfilled legacy item cleanly and removed stale v2 triggers
    const foundViaFts = upgradedRepo.queryItems({ search: 'Важные данные v2' });
    expect(foundViaFts.some((i) => i.id === 'old-1')).toBe(true);
    expect(() =>
      upgradedRepo.createItem({
        dna: 'note',
        orbit: 'work',
        modeCaptured: 'autopilot',
        title: 'После миграции',
        body: 'Новая запись',
        tags: [],
        source: 'vault_ui',
        contentHash: 'post-mig-1',
      })
    ).not.toThrow();
  });

  it('serializes Telegram UTF-16 entities (with emojis and multiple code blocks) cleanly', () => {
    const rawText = '🚀 Полезные команды:\n\nnpm run build\n\nИ ещё одна:\ngit status -sb';
    const cmd1Offset = rawText.indexOf('npm run build');
    const cmd2Offset = rawText.indexOf('git status -sb');

    const serialized = serializeTelegramEntitiesToMarkdown(rawText, [
      { type: 'pre', offset: cmd1Offset, length: 'npm run build'.length, language: 'bash' },
      { type: 'pre', offset: cmd2Offset, length: 'git status -sb'.length, language: 'bash' },
    ]);

    expect(serialized.hasCodeBlocks).toBe(true);
    expect(serialized.markdown).toContain('```bash\nnpm run build\n```');
    expect(serialized.markdown).toContain('```bash\ngit status -sb\n```');
    expect(serialized.markdown).toContain('🚀 Полезные команды:');
  });

  it('extracts text from dropped .docx archives and stores voice recordings', async () => {
    const { pipeline, repo } = createTestEnv();

    const docxBuf = makeMinimalDocxBuffer('Договор аренды оборудования на 2026 год от ООО Вектор');
    const docItem = await pipeline.capture({
      fileBase64: docxBuf.toString('base64'),
      fileName: 'dogovor-2026.docx',
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();
    const refreshedDoc = repo.getItemById(docItem.id);
    expect(refreshedDoc?.dna).toBe('doc');
    expect(refreshedDoc?.mediaMeta?.fileName).toBe('dogovor-2026.docx');
    expect(refreshedDoc?.summary || refreshedDoc?.body).toContain('Договор аренды');

    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
    const voiceItem = await pipeline.capture({
      audioBase64: fakeWebm.toString('base64'),
      audioMime: 'audio/webm',
      audioDurationSec: 18,
      text: 'Созвон по дизайну экрана',
      source: 'capsule_drop',
    });
    expect(voiceItem.dna).toBe('voice');
    expect(voiceItem.mediaDurationSec).toBe(18);
    expect(voiceItem.mediaPath).toBeTruthy();
  });

  it('fires due ReminderScheduler notifications once and marks remindedAt', async () => {
    const { repo } = createTestEnv();
    const pastDue = Date.now() - 5000;
    const item = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Позвонить в сервис',
      body: 'Уточнить готовность',
      remindAt: pastDue,
      tags: [],
      source: 'vault_ui',
      contentHash: 'rem-1',
    });

    const firedIds: string[] = [];
    const scheduler = new ReminderScheduler(repo, (dueItem) => {
      firedIds.push(dueItem.id);
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 380));
    scheduler.refresh();
    await new Promise((r) => setTimeout(r, 320));
    scheduler.stop();

    expect(firedIds).toEqual([item.id]);
    const updated = repo.getItemById(item.id);
    expect(updated?.remindedAt).not.toBeNull();
  });

  it('answers inventory question about bank cards accurately without exposing raw PAN/CVV', async () => {
    const { pipeline, repo } = createTestEnv();

    await pipeline.capture({
      text: 'Т-Банк Black 2200 7007 1234 5676 09/29 CVV 384',
      source: 'vault_ui',
    });
    await pipeline.capture({
      text: 'Сбер Visa 4242 4242 4242 4242 11/28',
      source: 'vault_ui',
    });

    const res = await askVaultWithAi({
      repo,
      question: 'Сколько у меня сохранено карт?',
      provider: 'local',
      apiKey: null,
    });

    expect(res.answer).toContain('2');
    expect(res.answer).toMatch(/5676/);
    expect(res.answer).toMatch(/4242/);
    expect(res.answer).not.toContain('•••• 5676 •••• 5676');
    expect(res.answer).not.toContain('384');
    expect(res.answer).not.toContain('2200 7007');

    // When Master PIN lock is active, secret/card counts & last4 details are masked everywhere
    await pipeline.capture({
      text: 'Обычная заметка про дизайн интерфейса',
      source: 'vault_ui',
    });
    const unlockedSummary = repo.getVaultInventorySummary(Date.now(), false);
    expect(unlockedSummary.bankCardCount).toBe(2);
    expect(unlockedSummary.totalItems).toBe(3);

    const lockedSummary = repo.getVaultInventorySummary(Date.now(), true);
    expect(lockedSummary.vaultLocked).toBe(true);
    expect(lockedSummary.totalItems).toBe(1);
    expect(lockedSummary.byDna.secret).toBe(0);
    expect(lockedSummary.bankCardCount).toBe(0);
    expect(lockedSummary.bankCards).toEqual([]);
    expect(lockedSummary.passwordCount).toBe(0);
    expect(lockedSummary.apiKeyCount).toBe(0);
    expect(lockedSummary.secretServices).toEqual([]);
    expect(lockedSummary.byOrbit.every((o) => o.name !== 'Финансы' || o.count === 0)).toBe(true);

    const lockedChat = await askVaultWithAi({
      repo,
      question: 'Сколько у меня сохранено карт?',
      provider: 'local',
      apiKey: null,
      vaultLocked: true,
    });
    expect(lockedChat.answer).not.toContain('5676');
    expect(lockedChat.answer).not.toContain('4242');
    expect(lockedChat.answer).toMatch(/Сейф закрыт|разблок|PIN/i);

    const directLocalLocked = answerVaultLocally(
      'Покажи сохранённые пароли',
      [],
      lockedSummary,
      true
    );
    expect(directLocalLocked.answer).toMatch(/Сейф закрыт|разблок|PIN/i);
  });

  it('preserves explicit input.title, keeps offline voice transcript empty, dedupes keyPoints, and parses contacts cleanly', async () => {
    const { pipeline, repo } = createTestEnv();

    const docxBuf = makeMinimalDocxBuffer(
      'Итоговая смета 2026\nУтверждён бюджет 120000 рублей на оборудование'
    );
    const explicitDoc = await pipeline.capture({
      title: 'Смета проекта 2026 (утверждённая)',
      fileBase64: docxBuf.toString('base64'),
      fileName: 'smeta-custom.docx',
      source: 'vault_ui',
    });

    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
    const explicitVoice = await pipeline.capture({
      title: 'Утренний созвон по релизу',
      audioBase64: fakeWebm.toString('base64'),
      audioMime: 'audio/webm',
      audioDurationSec: 12,
      source: 'vault_ui',
    });

    await pipeline.waitForIdle();

    const savedDoc = repo.getItemById(explicitDoc.id);
    expect(savedDoc?.title).toBe('Смета проекта 2026 (утверждённая)');

    const savedVoice = repo.getItemById(explicitVoice.id);
    expect(savedVoice?.title).toBe('Утренний созвон по релизу');
    expect(savedVoice?.mediaMeta?.transcript ?? '').toBe('');

    const gmailOnly = extractContactActions({
      title: 'Почта команды',
      body: 'Пишите на support@gmail.com в любое время',
    } as unknown as VaultItem);
    expect(gmailOnly.email).toBe('support@gmail.com');
    expect(gmailOnly.telegram).toBeFalsy();

    const emailAndTg = extractContactActions({
      title: 'Алексей Орлов',
      body: 'Почта: alex@gmail.com, телеграм: @alex_dev',
    } as unknown as VaultItem);
    expect(emailAndTg.email).toBe('alex@gmail.com');
    expect(emailAndTg.telegram).toContain('alex_dev');

    expect(
      filterDistinctKeyPoints(
        ['Итоговая смета 2026', 'Краткий обзор сметы', 'Бюджет 120 000 ₽'],
        'Итоговая смета 2026',
        'Краткий обзор сметы'
      )
    ).toEqual(['Бюджет 120 000 ₽']);
  });

  it('preserves spacing for <w:tab/> and <w:br/> in DOCX and rejects composite browser chrome in screenshot titles', async () => {
    const { pipeline, repo } = createTestEnv();
    const xmlRunDoc = makeMinimalDocxBuffer(
      'Статья расходов</w:t><w:tab/><w:t>Итого</w:t><w:br/><w:t>Строка вторая на 2026 год</w:t><w:t>'
    );
    const docItem = await pipeline.capture({
      fileBase64: xmlRunDoc.toString('base64'),
      fileName: 'smeta.docx',
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();
    const refreshed = repo.getItemById(docItem.id);
    const extracted = `${refreshed?.summary ?? ''}\n${refreshed?.mediaMeta?.transcript ?? ''}`;
    expect(extracted).toContain('Статья расходов Итого');
    expect(extracted).toContain('Строка вторая');

    const titleFromOcr = pickCleanScreenshotTitle(
      '14:32 95% Google Chrome Файл Правка Вид История Закладки\nДоговор поставки оборудования 2026',
      '',
      null
    );
    expect(titleFromOcr).toContain('Договор поставки');
    expect(titleFromOcr).not.toMatch(/Google Chrome/i);
  });

  it('keeps browser_ext url+cover captures as link DNA while preserving vault_ui images as shot', async () => {
    const { pipeline, repo } = createTestEnv();
    // 1x1 transparent PNG bytes
    const samplePngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=';

    const linkWithCover = await pipeline.capture({
      url: 'https://svgartista.net/collections',
      text: 'Коллекция векторных иконок https://svgartista.net/collections',
      title: 'SVG Artista — Анимации',
      imageBase64: samplePngB64,
      source: 'browser_ext',
    });
    const plainShot = await pipeline.capture({
      text: 'макет экрана',
      imageBase64: Buffer.concat([Buffer.from(samplePngB64, 'base64'), Buffer.from('salt')]).toString(
        'base64'
      ),
      source: 'vault_ui',
    });

    await pipeline.waitForIdle();
    const freshLink = repo.getItemById(linkWithCover.id);
    const freshShot = repo.getItemById(plainShot.id);

    expect(freshLink?.dna).toBe('link');
    expect(freshLink?.imagePath).toBeTruthy();
    expect(freshShot?.dna).toBe('shot');
  });

  it('guards extended Russian financial queries when locked, reports 0-count sections honestly, preserves Design OCR headings, capitalizes audio titles, and strips multi-line doc heading from summary', async () => {
    const { pipeline, repo } = createTestEnv();

    // 1) Locked secret query coverage + 0-count section reply
    const emptySec = repo.createOrbit({
      name: 'Путешествия',
      description: 'Поездки и маршруты',
      icon: 'compass',
      color: '#38BDF8',
    });
    const emptySummary = repo.getVaultInventorySummary(Date.now(), false);
    expect(
      answerVaultLocally('Что в разделе Путешествия?', [], emptySummary, false).answer
    ).toContain('пока нет записей');

    for (const q of ['Покажи сид-фразу', 'Мои реквизиты счёта', 'Карта Т-Банк']) {
      const locked = answerVaultLocally(q, [], emptySummary, true);
      expect(locked.answer).toMatch(/Сейф сейчас закрыт|Разблокируй/i);
    }
    expect(emptySec.id).toBeTruthy();

    // 2) Design screenshot keeps detected heading
    const designTitle = pickCleanScreenshotTitle(
      'Figma Component Tokens 2026\nSpacing 8px radius 14px',
      '',
      'Дизайн'
    );
    expect(designTitle).toContain('Figma Component Tokens');

    // 3) Capitalized local audio fallback title + preserved context transcript
    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
    const voice = await pipeline.capture({
      audioBase64: fakeWebm.toString('base64'),
      audioMime: 'audio/webm',
      fileName: 'созвон по редизайну.webm',
      audioDurationSec: 25,
      text: 'Нужно проверить анимацию карточки к завтрашнему дню.',
      source: 'vault_ui',
    });

    // 4) Multi-line DOCX heading is excluded from summary
    const multiDocBuf = makeMinimalDocxBuffer(
      'Регламент дежурств</w:t><w:br/><w:t>Смена начинается в 09:00 по Москве. Отчёт отправляется до 18:00.'
    );
    const multiDoc = await pipeline.capture({
      fileBase64: multiDocBuf.toString('base64'),
      fileName: 'reglament.docx',
      source: 'vault_ui',
    });

    await pipeline.waitForIdle();
    const freshVoice = repo.getItemById(voice.id);
    expect(freshVoice?.title).toBe('Созвон по редизайну');
    expect(freshVoice?.mediaMeta?.transcript).toContain('проверить анимацию карточки');

    const freshDoc = repo.getItemById(multiDoc.id);
    expect(freshDoc?.title).toBe('Регламент дежурств');
    expect(freshDoc?.summary).toContain('Смена начинается в 09:00');
    expect(freshDoc?.summary).not.toContain('Регламент дежурств');
  });
});
