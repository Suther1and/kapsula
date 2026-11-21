import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClipperServer } from '@main/bridges/clipper-server';
import { exportEventsToIcal, parseIcalFeed } from '@main/bridges/google-calendar';
import {
  exportMarkdownZip,
  importJsonBackup,
  importMarkdownFolder,
  importNotionZip,
  stripNotionIdSuffix,
} from '@main/bridges/markdown-importer';
import { VaultRepository } from '@main/db/repository';
import { registerV8IntegrationIpc } from '@main/ipc-integrations';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { processDocumentIntelligence } from '@main/pipeline/document-pipeline';
import { parseEmlBuffer } from '@main/pipeline/email-parser';
import { VaultCrypto } from '@main/security/vault-crypto';
import { createZipBuffer, readZipEntries, ZipSecurityError } from '@main/utils/zip';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

const SAMPLE_PNG_BUF = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64'
);

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v8-io-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
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
  cleanups.push(() => repo.close());
  return { dir, repo, cryptoVault, pipeline };
}

/** Builds a deliberately malicious ZIP buffer containing a `../evil.txt` Zip-Slip entry. */
function buildMaliciousZipSlipBuffer(badName: string): Buffer {
  const nameBuf = Buffer.from(badName, 'utf8');
  const data = Buffer.from('pwned', 'utf8');

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0x0800, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0x0800, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);

  const cdOffset = lfh.length + nameBuf.length + data.length;
  const cdSize = cdh.length + nameBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, nameBuf, data, cdh, nameBuf, eocd]);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula v8 Pure-Node ZIP, Email .eml, Obsidian/Notion/MD IO & Clipper', () => {
  it('round-trips Store & Deflate entries with UTF-8 Cyrillic paths and rejects Zip-Slip traversal', () => {
    const longRussianText = 'Заметка на русском языке для проверки сжатия Deflate. '.repeat(25);
    const zipBuf = createZipBuffer([
      { name: 'Работа/Отчёт 2026.md', data: Buffer.from(longRussianText, 'utf8') },
      { name: 'assets/pixel.png', data: SAMPLE_PNG_BUF },
    ]);

    const entries = readZipEntries(zipBuf);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe('Работа/Отчёт 2026.md');
    expect(entries[0]?.method).toBe(8); // Deflate chosen for compressible text
    expect(entries[0]?.data.toString('utf8')).toBe(longRussianText);
    expect(entries[1]?.name).toBe('assets/pixel.png');
    expect(entries[1]?.data.equals(SAMPLE_PNG_BUF)).toBe(true);

    // Reject path traversal & absolute paths
    for (const badPath of ['../outside.txt', 'safe/../../escape.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      const evilZip = buildMaliciousZipSlipBuffer(badPath);
      expect(() => readZipEntries(evilZip)).toThrow(ZipSecurityError);
    }
  });

  it('parses RFC 5322 Russian UTF-8/B/Q/windows-1251 .eml with multipart HTML->Markdown & image attachment and captures into Kapsula', async () => {
    const subjUtf8B = Buffer.from('Итоги встречи по проекту', 'utf8').toString('base64');
    // "Анна" in windows-1251 bytes: C0 ED ED E0
    const fromWin1251Q = '=?windows-1251?Q?=C0=ED=ED=E0?= <anna@company.example>';
    const htmlQpBody = [
      '<h2>=D0=93=D0=BB=D0=B0=D0=B2=D0=BD=D1=8B=D0=B5 =D0=B8=D1=82=D0=BE=D0=B3=D0=B8</h2>',
      '<p>=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82! =D0=9F=D0=BE=D1=81=D0=BC=D0=BE=D1=82=D1=80=D0=B8 <a href="https://example.com/plan">=D0=BF=D0=BB=D0=B0=D0=BD =D1=80=D0=B5=D0=BB=D0=B8=D0=B7=D0=B0</a>.</p>',
      '<ul><li>=D0=9F=D1=80=D0=BE=D0=B2=D0=B5=D1=80=D0=B8=D1=82=D1=8C =D0=B3=D1=80=D0=B0=D1=84=D0=B8=D0=BA</li><li>=D0=9E=D1=82=D0=BF=D1=80=D0=B0=D0=B2=D0=B8=D1=82=D1=8C =D0=BE=D1=82=D1=87=D1=91=D1=82</li></ul>',
    ].join('\r\n');

    const emlRaw = [
      `From: ${fromWin1251Q}`,
      'To: team@company.example',
      `Subject: =?UTF-8?B?${subjUtf8B}?=`,
      'Date: Tue, 17 Nov 2026 14:30:00 +0300',
      'Message-ID: <meeting-2026-01@company.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="MIX_BOUNDARY"',
      '',
      '--MIX_BOUNDARY',
      'Content-Type: multipart/alternative; boundary="ALT_BOUNDARY"',
      '',
      '--ALT_BOUNDARY',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('Короткий текстовый вариант без ссылок.', 'utf8').toString('base64'),
      '--ALT_BOUNDARY',
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      htmlQpBody,
      '--ALT_BOUNDARY--',
      '--MIX_BOUNDARY',
      'Content-Type: image/png; name="chart.png"',
      'Content-Disposition: attachment; filename="chart.png"',
      'Content-Transfer-Encoding: base64',
      '',
      SAMPLE_PNG_BUF.toString('base64'),
      '--MIX_BOUNDARY--',
      '',
    ].join('\r\n');

    const parsed = parseEmlBuffer(Buffer.from(emlRaw, 'utf8'));
    expect(parsed.subject).toBe('Итоги встречи по проекту');
    expect(parsed.fromName).toBe('Анна');
    expect(parsed.fromAddress).toBe('anna@company.example');
    expect(parsed.messageId).toBe('meeting-2026-01@company.example');
    expect(parsed.bodyMarkdown).toContain('## Главные итоги');
    expect(parsed.bodyMarkdown).toContain('[план релиза](https://example.com/plan)');
    expect(parsed.bodyMarkdown).toContain('- Проверить график');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('chart.png');
    expect(parsed.attachments[0]?.contentType).toBe('image/png');

    // Dropping the .eml into CapturePipeline creates a richly formatted note with embedded image!
    const { pipeline } = makeEnv();
    const item = await pipeline.capture({
      fileBase64: Buffer.from(emlRaw, 'utf8').toString('base64'),
      fileName: 'meeting.eml',
      fileMime: 'message/rfc822',
    });
    expect(item.dna).toBe('note');
    expect(item.title).toBe('Итоги встречи по проекту');
    expect(item.body).toContain('**От:** Анна <anna@company.example>');
    expect(item.body).toContain('[план релиза](https://example.com/plan)');
    expect(item.body).toMatch(/!\[chart\.png\]\(kapsula-media:\/\/local\/[a-f0-9]+\.png\)/);
    expect(item.imagePath).toBeTruthy();

    // Also verify .xlsx & .pptx document extraction via zip.ts
    const xlsxBuf = createZipBuffer([
      {
        name: 'xl/sharedStrings.xml',
        data: Buffer.from('<sst><si><t>Бюджет</t></si><si><t>Январь</t></si></sst>', 'utf8'),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.from(
          '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>50000</v></c></row></sheetData></worksheet>',
          'utf8'
        ),
      },
    ]);
    const xlsxRes = await processDocumentIntelligence({
      buffer: xlsxBuf,
      fileName: 'budget.xlsx',
      aiProvider: 'local',
    });
    expect(xlsxRes.extractedText).toContain('Бюджет | Январь | 50000');

    const pptxBuf = createZipBuffer([
      {
        name: 'ppt/slides/slide1.xml',
        data: Buffer.from('<p:sld><a:p><a:r><a:t>Презентация квартала</a:t></a:r></a:p></p:sld>', 'utf8'),
      },
    ]);
    const pptxRes = await processDocumentIntelligence({
      buffer: pptxBuf,
      fileName: 'deck.pptx',
      aiProvider: 'local',
    });
    expect(pptxRes.extractedText).toContain('Презентация квартала');
  });

  it('imports Obsidian Markdown folder with frontmatter, ![[img]], relative images, [[wiki-links]] & subfolder orbits', async () => {
    const { dir, repo, pipeline } = makeEnv();
    const vaultDir = path.join(dir, 'obsidian-vault');
    fs.mkdirSync(path.join(vaultDir, 'Проекты'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'assets', 'hero.png'), SAMPLE_PNG_BUF);
    fs.writeFileSync(path.join(vaultDir, 'Проекты', 'diagram.png'), SAMPLE_PNG_BUF);

    const mdContent = [
      '---',
      'title: Архитектура нового портала',
      'tags: [архитектура, работа]',
      'created: 2026-10-15T12:00:00Z',
      '---',
      '',
      'Связано с [[План релиза]].',
      '',
      '![[hero.png|Главная схема]]',
      '',
      '![Диаграмма](./diagram.png)',
    ].join('\n');
    fs.writeFileSync(path.join(vaultDir, 'Проекты', 'portal.md'), mdContent, 'utf8');

    const res1 = await importMarkdownFolder(vaultDir, { repo, pipeline });
    expect(res1.importedCount).toBe(1);
    expect(res1.orbitsCreated).toBe(1);

    const orbits = repo.listOrbits();
    expect(orbits.some((o) => o.name === 'Проекты')).toBe(true);

    const items = repo.queryItems({ limit: 10 });
    expect(items).toHaveLength(1);
    const note = items[0]!;
    expect(note.title).toBe('Архитектура нового портала');
    expect(note.tags).toEqual(expect.arrayContaining(['архитектура', 'работа']));
    expect(note.body).toContain('[[План релиза]]');
    expect(note.body).toMatch(/!\[Главная схема\]\(kapsula-media:\/\/local\/[a-f0-9]+\.png\)/);
    expect(note.body).toMatch(/!\[Диаграмма\]\(kapsula-media:\/\/local\/[a-f0-9]+\.png\)/);

    // Re-importing the same folder skips duplicates idempotently
    const res2 = await importMarkdownFolder(vaultDir, { repo, pipeline });
    expect(res2.importedCount).toBe(0);
    expect(res2.skippedCount).toBe(1);
    expect(res2.orbitsCreated).toBe(0);
  });

  it('imports Notion ZIP stripping 32-hex ID suffixes and exports Markdown ZIP excluding secrets', async () => {
    const { dir, repo, cryptoVault, pipeline } = makeEnv();

    expect(stripNotionIdSuffix('Roadmap 2026 3f8a9c12b4d54e6f8a9b0c1d2e3f4a5b')).toBe('Roadmap 2026');

    const notionZipPath = path.join(dir, 'notion-export.zip');
    const notionZipBuf = createZipBuffer([
      {
        name: 'Обучение 11112222333344445555666677778888/Конспект курса aabbccddeeff00112233445566778899.md',
        data: Buffer.from(
          'Основные идеи курса.\n\n![Схема](%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.png)\n\nСм. [Следующий урок](Next%20aabbccddeeff00112233445566778800.md)',
          'utf8'
        ),
      },
      {
        name: 'Обучение 11112222333344445555666677778888/Схема.png',
        data: SAMPLE_PNG_BUF,
      },
    ]);
    fs.writeFileSync(notionZipPath, notionZipBuf);

    const notionRes = await importNotionZip(notionZipPath, { repo, pipeline });
    expect(notionRes.importedCount).toBe(1);
    expect(notionRes.orbitsCreated).toBe(1);
    expect(repo.listOrbits().some((o) => o.name === 'Обучение')).toBe(true);

    const importedNote = repo.queryItems({ limit: 10 })[0]!;
    expect(importedNote.title).toBe('Конспект курса');
    expect(importedNote.body).toMatch(/!\[Схема\]\(kapsula-media:\/\/local\/[a-f0-9]+\.png\)/);
    expect(importedNote.body).toContain('[[Следующий урок]]');

    // Add a Vault secret — MUST NEVER appear in Markdown ZIP export!
    repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'Главный пароль банка',
      body: '',
      summary: 'Секрет',
      encryptedPayload: cryptoVault.encryptSecret({
        service: 'Банк',
        login: 'user',
        secretValue: 'TOP_SECRET_999',
        notes: '',
      }),
      source: 'vault_ui',
      contentHash: 'secret-export-check',
      aiStatus: 'skipped_secret',
    });

    const exportZipPath = path.join(dir, 'kapsula-export.zip');
    const expRes = await exportMarkdownZip(exportZipPath, { repo, pipeline });
    expect(expRes.ok).toBe(true);
    expect(expRes.count).toBe(1);

    const exportedEntries = readZipEntries(fs.readFileSync(exportZipPath));
    const names = exportedEntries.map((e) => e.name);
    expect(names.some((n) => n.startsWith('Обучение/') && n.endsWith('.md'))).toBe(true);
    expect(names.some((n) => n.startsWith('assets/') && n.endsWith('.png'))).toBe(true);
    const allExportedText = exportedEntries
      .filter((e) => e.name.endsWith('.md'))
      .map((e) => e.data.toString('utf8'))
      .join('\n');
    expect(allExportedText).not.toContain('Главный пароль банка');
    expect(allExportedText).not.toContain('TOP_SECRET_999');
    expect(allExportedText).toContain('../assets/');

    // JSON Backup Import: restores missing items and never overwrites newer items
    const backupPath = path.join(dir, 'backup.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify({
        format: 'kapsula-backup',
        version: 1,
        orbits: [{ id: 'o-travel', name: 'Путешествия', description: 'Маршруты' }],
        items: [
          {
            id: importedNote.id,
            dna: 'note',
            title: 'Старая версия из бэкапа',
            body: 'Старый текст',
            updatedAt: importedNote.updatedAt - 10_000,
          },
          {
            id: 'restored-item-1',
            dna: 'note',
            orbit: 'o-travel',
            title: 'Маршрут по Алтаю',
            body: 'День 1: озеро и горы',
            tags: ['поездки'],
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
          },
        ],
      }),
      'utf8'
    );

    const backupRes = await importJsonBackup(backupPath, { repo, pipeline });
    expect(backupRes.importedCount).toBe(1);
    expect(backupRes.skippedCount).toBe(1);
    expect(backupRes.orbitsCreated).toBe(1);
    expect(repo.getItemById(importedNote.id)?.title).toBe('Конспект курса'); // newer item untouched!
    expect(repo.getItemById('restored-item-1')?.title).toBe('Маршрут по Алтаю');
  });

  it('exposes GET /api/orbits + orbitId on ClipperServer, clean Kapsula iCal PRODID, and all 8 v8 integration IPC channels', async () => {
    const { dir, repo, pipeline } = makeEnv();
    const work = repo.createOrbit({ name: 'Работа', description: 'Задачи', color: '#3B82F6', icon: 'Briefcase' });

    const server = new ClipperServer(pipeline, () => 'clip-token-v8');
    const port = await server.start();
    cleanups.push(() => server.stop());

    // Unauthenticated GET /api/orbits rejected
    const unauthOrbits = await fetch(`http://127.0.0.1:${port}/api/orbits`);
    expect(unauthOrbits.status).toBe(403);

    // Authenticated GET /api/orbits returns user sections
    const authOrbits = await fetch(`http://127.0.0.1:${port}/api/orbits`, {
      headers: { 'X-Kapsula-Token': 'clip-token-v8' },
    });
    expect(authOrbits.status).toBe(200);
    const orbitJson = (await authOrbits.json()) as { ok: boolean; orbits: Array<{ id: string; name: string; color: string }> };
    expect(orbitJson.ok).toBe(true);
    expect(orbitJson.orbits).toEqual([{ id: work.id, name: 'Работа', color: '#3B82F6' }]);

    // POST /api/clip respects optional orbitId
    const clipRes = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'clip-token-v8',
      },
      body: JSON.stringify({
        url: 'https://example.com/article',
        title: 'Рабочая статья',
        text: 'Полезный разбор https://example.com/article',
        orbitId: work.id,
      }),
    });
    expect(clipRes.status).toBe(200);
    const clipJson = (await clipRes.json()) as { id: string; orbit: string };
    expect(clipJson.orbit).toBe(work.id);
    await pipeline.waitForIdle();

    // Google Calendar iCal uses clean Kapsula branding & round-trips location + allDay
    const ics = exportEventsToIcal([
      {
        id: 'ev-v8',
        title: 'Конференция',
        notes: 'Главный зал',
        location: 'Центр событий',
        startAt: new Date(2026, 10, 20, 0, 0, 0).getTime(),
        endAt: new Date(2026, 10, 20, 23, 59, 0).getTime(),
        allDay: true,
      },
    ]);
    expect(ics).toContain('PRODID:-//Kapsula//Calendar//RU');
    expect(ics).not.toContain('Notes+');
    const parsedIcs = parseIcalFeed(ics);
    expect(parsedIcs[0]?.location).toBe('Центр событий');
    expect(parsedIcs[0]?.allDay).toBe(true);

    // Register & verify all 8 v8 integration IPC channels
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerV8IntegrationIpc({
      ipcMain: {
        handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
          handlers.set(channel, listener);
        },
      } as never,
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'ipc-export.zip') }),
      } as never,
      getMainWindow: () => null,
      repo,
      pipeline,
      documentsDir: dir,
    });

    const expectedChannels = [
      'media:save-note-image',
      'ai:transcribe-item',
      'integrations:import-eml',
      'integrations:import-markdown-folder',
      'integrations:import-notion-zip',
      'integrations:import-json-backup',
      'integrations:export-markdown-zip',
      'integrations:rotate-email-token',
    ];
    for (const ch of expectedChannels) {
      expect(handlers.has(ch), `Missing IPC handler: ${ch}`).toBe(true);
    }

    const rotated = (await handlers.get('integrations:rotate-email-token')!({})) as {
      address: string;
      token: string;
    };
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(rotated.address).toBe(`in+${rotated.token}@mail.kapsula.app`);
    expect(repo.getSetting('email_inbound_token')).toBe(rotated.token);
    expect(repo.getSetting('email_inbound_address')).toBe(rotated.address);

    const exportedViaIpc = (await handlers.get('integrations:export-markdown-zip')!({})) as {
      ok: boolean;
      filePath?: string;
      count?: number;
    };
    expect(exportedViaIpc.ok).toBe(true);
    expect(exportedViaIpc.count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(dir, 'ipc-export.zip'))).toBe(true);
  });
});
