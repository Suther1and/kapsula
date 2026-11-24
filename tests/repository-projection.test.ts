import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { parseMarkdownTasks } from '@shared/task-helpers';

const repos: VaultRepository[] = [];

function createRepo(): VaultRepository {
  const repo = new VaultRepository(':memory:');
  repos.push(repo);
  return repo;
}

afterEach(() => {
  while (repos.length > 0) {
    repos.pop()!.close();
  }
});

describe('VaultRepository card projection', () => {
  it('projects heavy fields while preserving checkboxes, inline media, code fence, and full-text search', () => {
    const repo = createRepo();
    const tailMarker = 'уникальныймаркерхвоста991';
    const ocrMarker = 'секретныйпромокодocr772';
    const longParagraph = `${'Длинный подробный текст заметки для проверки проекции карточки. '.repeat(75)}\n\n`;
    const body =
      longParagraph +
      `- [ ] Первая задача\n` +
      `- [x] Вторая выполненная задача\n` +
      `- [ ] Третья задача\n` +
      `- [ ] Четвёртая задача\n` +
      `- [ ] Пятая задача\n` +
      `- [ ] Шестая задача\n\n` +
      `![](kapsula-media://local/cover-inline.jpg)\n\n` +
      tailMarker;

    const note = repo.createItem({
      dna: 'note',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Проектная заметка',
      body,
      summary: 'Краткая сводка',
      ocrText: `${'Много OCR текста '.repeat(180)} ${ocrMarker}`,
      annotations: [
        { id: 'ann-1', xPct: 20, yPct: 30, text: 'Важный пин на скриншоте' },
      ],
      extractedActions: Array.from({ length: 10 }, (_, idx) => ({
        type: 'url' as const,
        label: `Link ${idx}`,
        value: `https://example.com/${idx}`,
      })),
      source: 'vault_ui',
      contentHash: 'proj-note-1',
    });

    const snippetBody =
      '```typescript\n' +
      Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n') +
      '\n```\n\n' +
      'Описание после кода '.repeat(30);

    const snippet = repo.createItem({
      dna: 'snippet',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Длинный сниппет',
      body: snippetBody,
      source: 'vault_ui',
      contentHash: 'proj-snippet-1',
    });

    const voice = repo.createItem({
      dna: 'voice',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Голосовая запись',
      body: '',
      mediaMeta: {
        transcript: 'Очень длинная расшифровка голосового сообщения. '.repeat(20),
        waveformPeaks: [0.2, 0.5, 0.8],
        actionItems: ['Позвонить', 'Отправить отчёт'],
      },
      source: 'vault_ui',
      contentHash: 'proj-voice-1',
    });

    // Default projection is 'full'
    const fullAll = repo.queryItems({});
    const fullNote = fullAll.find((x) => x.id === note.id)!;
    expect(fullNote.isCardProjection).toBeUndefined();
    expect(fullNote.body).toBe(body);
    expect(fullNote.ocrText).toContain(ocrMarker);
    expect(fullNote.annotations).toHaveLength(1);
    expect(fullNote.extractedActions).toHaveLength(10);

    // 'card' projection strips heavy fields & keeps UI preview requirements
    const cardAll = repo.queryItems({ projection: 'card' });
    const cardNote = cardAll.find((x) => x.id === note.id)!;
    expect(cardNote.isCardProjection).toBe(true);
    expect(cardNote.isBodyTruncated).toBe(true);
    expect(cardNote.hasCheckbox).toBe(true);
    expect(cardNote.bodyLength).toBe(body.length);
    expect(cardNote.body.length).toBeLessThan(1200);
    expect(cardNote.body).toContain('- [ ] Первая задача');
    expect(cardNote.body).toContain('- [x] Вторая выполненная задача');
    expect(cardNote.body).toContain('kapsula-media://local/cover-inline.jpg');
    expect(cardNote.ocrText).toBe('');
    expect(cardNote.annotations).toEqual([]);
    expect(cardNote.extractedActions).toHaveLength(6);

    const cardSnippet = cardAll.find((x) => x.id === snippet.id)!;
    expect(cardSnippet.isCardProjection).toBe(true);
    expect(cardSnippet.isBodyTruncated).toBe(true);
    expect(cardSnippet.body).toMatch(/```typescript[\s\S]*```/);

    const cardVoice = cardAll.find((x) => x.id === voice.id)!;
    expect(cardVoice.isCardProjection).toBe(true);
    expect(cardVoice.isBodyTruncated).toBe(true);
    expect(cardVoice.mediaMeta?.transcript?.length).toBeLessThanOrEqual(240);
    expect(cardVoice.mediaMeta?.waveformPeaks).toEqual([0.2, 0.5, 0.8]);
    expect(cardVoice.mediaMeta?.actionItems).toEqual(['Позвонить', 'Отправить отчёт']);

    // Search still matches full body tail & OCR text even with projection: 'card'
    const tailHits = repo.queryItems({ search: tailMarker, projection: 'card' });
    expect(tailHits.map((x) => x.id)).toContain(note.id);
    expect(tailHits[0]?.isCardProjection).toBe(true);

    const ocrHits = repo.queryItems({ search: ocrMarker, projection: 'card' });
    expect(ocrHits.map((x) => x.id)).toContain(note.id);

    // getItemById always returns full record
    const hydrated = repo.getItemById(note.id)!;
    expect(hydrated.body).toBe(body);
    expect(hydrated.ocrText).toContain(ocrMarker);
    expect(hydrated.annotations).toHaveLength(1);
  });

  it('closes unclosed ~~~ fence with ~~~ so appended tasks remain parseable', () => {
    const repo = createRepo();
    const longCode = Array.from({ length: 30 }, (_, i) => `const line_${i} = "value_${i}";`).join('\n');
    const body = `~~~ts\n${longCode}\n~~~\n\n- [ ] Real task 0\n- [x] Real task 1\n`;

    const item = repo.createItem({
      dna: 'note',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Заметка с ~~~ блоком',
      body,
      source: 'vault_ui',
      contentHash: 'proj-tilde-fence-1',
    });

    const [projected] = repo.queryItems({ search: 'Заметка с ~~~ блоком', projection: 'card' });
    expect(projected?.id).toBe(item.id);
    expect(projected?.hasCheckbox).toBe(true);
    expect(projected?.body).toContain('\n~~~');
    const parsed = parseMarkdownTasks(projected!.body);
    expect(parsed.map((t) => t.text)).toEqual(['Real task 0', 'Real task 1']);
  });
});
