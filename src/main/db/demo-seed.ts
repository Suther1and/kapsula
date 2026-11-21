import zlib from 'node:zlib';
import type { VaultRepository } from './repository';
import type { VaultCrypto } from '../security/vault-crypto';
import type { CapturePipeline } from '../pipeline/capture-pipeline';

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function generateDemoShotPngBase64(): string {
  const width = 560;
  const height = 280;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowOff + 1 + x * 4;
      const nx = x / width;
      const ny = y / height;

      let r = 18 + nx * 16;
      let g = 21 + ny * 12;
      let b = 29 + (1 - nx) * 18;

      if (y >= 24 && y <= 58 && x >= 28 && x <= width - 28) {
        r = 28;
        g = 32;
        b = 43;
      }

      if (y >= 82 && y <= 148 && x >= 36 && x <= 320) {
        const edge = x === 36 || x === 320 || y === 82 || y === 148;
        r = edge ? 245 : 42;
        g = edge ? 165 : 32;
        b = edge ? 36 : 20;
      }

      if (y >= 100 && y <= 130 && x >= 56 && x <= 230) {
        r = 245;
        g = 165;
        b = 36;
      }

      if (y >= 176 && y <= 232 && x >= 36 && x <= width - 36) {
        r = 16;
        g = y <= 184 ? 185 : 42;
        b = y <= 184 ? 129 : 36;
      }

      const dist = Math.hypot(x - 455, y - 115);
      if (dist < 46) {
        const blend = (1 - dist / 46) * 0.65;
        r = Math.round(r * (1 - blend) + 59 * blend);
        g = Math.round(g * (1 - blend) + 130 * blend);
        b = Math.round(b * (1 - blend) + 246 * blend);
      }

      raw[px] = Math.min(255, Math.round(r));
      raw[px + 1] = Math.min(255, Math.round(g));
      raw[px + 2] = Math.min(255, Math.round(b));
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

export async function ensureDemoSeeded(
  repo: VaultRepository,
  _cryptoVault: VaultCrypto,
  pipeline: CapturePipeline,
  force = false
): Promise<number> {
  const alreadySeeded = repo.getSetting('seed_done');
  const stats = repo.getStats();
  if (!force && (alreadySeeded === 'true' || stats.total > 0)) return 0;

  const now = Date.now();
  const locale = repo.getLocale();

  if (locale === 'en') {
    const workSection = repo.ensureOrganicOrbit('Work');
    const personalSection = repo.ensureOrganicOrbit('Personal');
    const ideasSection = repo.ensureOrganicOrbit('Ideas');
    const readingSection = repo.ensureOrganicOrbit('Reading');

    await pipeline.capture({
      text: 'https://fs.blog/smart-notes/ — how to collect notes and ideas so they genuinely compound in work and study',
      title: 'How to Build a Personal Knowledge Base',
      orbitOverride: readingSection?.id ?? undefined,
      source: 'demo',
      tags: ['article', 'reading'],
      isDemo: true,
      createdAt: now - 1000 * 60 * 45,
    });

    await pipeline.capture({
      text: 'Service: Work Email\nLogin: demo@example.com\nPassword: DemoSecret-Kapsula-2026!',
      source: 'demo',
      isDemo: true,
      createdAt: now - 1000 * 60 * 90,
    });

    await pipeline.capture({
      text: [
        '## Weekend Trip Prep',
        '',
        '- [x] Double-check tickets and hotel booking',
        '- [ ] Pack chargers and passport',
        '- [ ] Map out Saturday walking route',
        '- [ ] Download offline city map',
      ].join('\n'),
      title: 'Weekend Trip Checklist',
      orbitOverride: personalSection?.id ?? undefined,
      remindAt: now + 1000 * 60 * 120,
      source: 'demo',
      tags: ['travel', 'plan'],
      isDemo: true,
      createdAt: now - 1000 * 60 * 140,
    });

    await pipeline.capture({
      text: [
        '## Project Sync Notes',
        '',
        'Aligned on goals for the next month and split key milestones:',
        '',
        '- Finalize presentation outline before Wednesday',
        '- Gather team feedback on the updated timeline',
        '- [ ] Share summary roadmap with stakeholders',
      ].join('\n'),
      title: 'Project Sync Notes',
      orbitOverride: workSection?.id ?? undefined,
      source: 'demo',
      tags: ['meeting', 'project'],
      isDemo: true,
      createdAt: now - 1000 * 60 * 180,
    });

    await pipeline.capture({
      text: [
        'Reading list for this quarter:',
        '',
        '- "How to Take Smart Notes" — Sönke Ahrens',
        '- "Thinking, Fast and Slow" — Daniel Kahneman',
        '- "The Design of Everyday Things" — Don Norman',
      ].join('\n'),
      title: 'Quarter Reading List',
      orbitOverride: ideasSection?.id ?? undefined,
      source: 'demo',
      tags: ['books', 'study'],
      isDemo: true,
      createdAt: now - 1000 * 60 * 210,
    });

    const shotDemo = await pipeline.capture({
      imageBase64: generateDemoShotPngBase64(),
      title: 'Project Visual Reference',
      orbitOverride: ideasSection?.id ?? undefined,
      source: 'demo',
      tags: ['reference', 'ideas'],
      isDemo: true,
      createdAt: now - 1000 * 60 * 25,
    });

    repo.updateItem(shotDemo.id, {
      dna: 'shot',
      ocrText: 'Project Overview · Quarterly Metrics & Palette Swatches',
      summary: '',
      extractedActions: [],
      colorPalette: ['#161922', '#F5A524', '#10B981', '#3B82F6'],
    });

    repo.setSetting('seed_done', 'true');
    return 6;
  }

  const workSection = repo.ensureOrganicOrbit('Работа');
  const personalSection = repo.ensureOrganicOrbit('Личное');
  const ideasSection = repo.ensureOrganicOrbit('Идеи');
  const readingSection = repo.ensureOrganicOrbit('Чтение');

  await pipeline.capture({
    text: 'https://fs.blog/smart-notes/ — как собирать заметки и идеи так, чтобы они реально помогали в работе и обучении',
    title: 'Как вести личную базу знаний',
    orbitOverride: readingSection?.id ?? undefined,
    source: 'demo',
    tags: ['статья', 'чтение'],
    isDemo: true,
    createdAt: now - 1000 * 60 * 45,
  });

  await pipeline.capture({
    text: 'Сервис: Рабочая почта\nЛогин: demo@example.com\nПароль: DemoSecret-Kapsula-2026!',
    source: 'demo',
    isDemo: true,
    createdAt: now - 1000 * 60 * 90,
  });

  await pipeline.capture({
    text: [
      '## Подготовка к поездке на выходные',
      '',
      '- [x] Проверить билеты и бронь отеля',
      '- [ ] Собрать зарядки и документы',
      '- [ ] Составить маршрут прогулок на субботу',
      '- [ ] Сохранить оффлайн-карту города',
    ].join('\n'),
    title: 'Чек-лист поездки на выходные',
    orbitOverride: personalSection?.id ?? undefined,
    remindAt: now + 1000 * 60 * 120,
    source: 'demo',
    tags: ['поездки', 'план'],
    isDemo: true,
    createdAt: now - 1000 * 60 * 140,
  });

  await pipeline.capture({
    text: [
      '## Итоги встречи по проекту',
      '',
      'Обсудили цели на ближайший месяц и распределили ключевые этапы:',
      '',
      '- Утвердить структуру презентации до среды',
      '- Собрать обратную связь от команды по новому графику',
      '- [ ] Подготовить сводный план и отправить участникам',
    ].join('\n'),
    title: 'Итоги встречи по проекту',
    orbitOverride: workSection?.id ?? undefined,
    source: 'demo',
    tags: ['встреча', 'проект'],
    isDemo: true,
    createdAt: now - 1000 * 60 * 180,
  });

  await pipeline.capture({
    text: [
      'Список книг и материалов на ближайший квартал:',
      '',
      '- «Как делать полезные заметки» — Зонке Аренс',
      '- «Думай медленно… решай быстро» — Даниэль Канеман',
      '- «Дизайн привычных вещей» — Дональд Норман',
    ].join('\n'),
    title: 'Список книг к прочтению',
    orbitOverride: ideasSection?.id ?? undefined,
    source: 'demo',
    tags: ['книги', 'обучение'],
    isDemo: true,
    createdAt: now - 1000 * 60 * 210,
  });

  const shotDemo = await pipeline.capture({
    imageBase64: generateDemoShotPngBase64(),
    title: 'Визуальный референс проекта',
    orbitOverride: ideasSection?.id ?? undefined,
    source: 'demo',
    tags: ['референс', 'идеи'],
    isDemo: true,
    createdAt: now - 1000 * 60 * 25,
  });

  repo.updateItem(shotDemo.id, {
    dna: 'shot',
    ocrText: 'Обзор проекта · Квартальные метрики и акценты палитры',
    summary: '',
    extractedActions: [],
    colorPalette: ['#161922', '#F5A524', '#10B981', '#3B82F6'],
  });

  repo.setSetting('seed_done', 'true');
  return 6;
}
