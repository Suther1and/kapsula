import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { KapsulaHighlight, TextColorMark, TextSizeMark } from '@shared/tiptap-rich-marks';
import { stripMarkdownPreview } from '@renderer/lib/format';
import { VaultRepository } from '../src/main/db/repository';
import { sanitizeUpdateItemPatch } from '../src/main/ipc';
import { sanitizeIngestedText } from '../src/main/pipeline/html-cleaner';

describe('v1.1.0 rich text marks & markdown round-trip', () => {
  const mm = new MarkdownManager({
    extensions: [StarterKit, KapsulaHighlight, TextColorMark, TextSizeMark],
  });

  it('round-trips text colors, sizes, multicolor highlights, and underline losslessly', () => {
    const input =
      'Обычный **жирный** <u>подчёркнутый</u> <span data-k-color="red">красный</span> <span data-k-size="lg">крупный</span> <mark data-k-bg="amber">маркер</mark> ==обычный маркер==';
    const doc = mm.parse(input);
    const out = mm.serialize(doc);

    expect(out).toContain('**жирный**');
    expect(out).toContain('<u>подчёркнутый</u>');
    expect(out).toContain('<span data-k-color="red">красный</span>');
    expect(out).toContain('<span data-k-size="lg">крупный</span>');
    expect(out).toContain('<mark data-k-bg="amber">маркер</mark>');
    expect(out).toContain('==обычный маркер==');

    // Second round-trip is identical
    expect(mm.serialize(mm.parse(out))).toBe(out);
  });

  it('supports nested marks (bold inside colored text)', () => {
    const input = '<span data-k-color="blue">**важно** и *курсив*</span>';
    const doc = mm.parse(input);
    const out = mm.serialize(doc);
    expect(out).toContain('data-k-color="blue"');
    expect(out).toContain('**важно**');
    expect(out).toContain('*курсив*');
  });

  it('strips rich HTML formatting tags cleanly in card preview snippets', () => {
    const raw =
      '<span data-k-size="lg">Привет</span> <span data-k-color="green">мир</span> <mark data-k-bg="blue">тест</mark> <u>линия</u> ==марк==';
    const preview = stripMarkdownPreview(raw);
    expect(preview).toBe('Привет мир тест линия марк');
  });

  it('preserves Kapsula rich marks and markdown structure during capture sanitizeIngestedText', () => {
    const richDraft =
      '## Заголовок\n\n<span data-k-size="lg">Крупный</span> <span data-k-color="red">красный</span> и <mark data-k-bg="amber">маркер</mark> <u>подчёркнутый</u>\n\n- [ ] Задача 1\n- [x] Задача 2';
    const sanitized = sanitizeIngestedText(richDraft);
    expect(sanitized).toBe(richDraft);
  });
});

describe('v1.1.0 card mute persistence & IPC patch sanitization', () => {
  it('persists isMuted across createItem, updateItem, and sanitizeUpdateItemPatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-mute-test-'));
    const repo = new VaultRepository(path.join(tmpDir, 'vault.db'));
    try {
      const created = repo.createItem({
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Тестовая карточка',
        body: 'Текст для проверки mute',
        source: 'vault_ui',
        contentHash: 'hash-mute-1',
      });
      expect(created.isMuted).toBe(false);

      const cleanPatch = sanitizeUpdateItemPatch({ isMuted: true, unknownField: 123 });
      expect(cleanPatch.isMuted).toBe(true);

      const muted = repo.updateItem(created.id, cleanPatch);
      expect(muted?.isMuted).toBe(true);

      const fetched = repo.getItemById(created.id);
      expect(fetched?.isMuted).toBe(true);

      const unmuted = repo.updateItem(created.id, { isMuted: false });
      expect(unmuted?.isMuted).toBe(false);
    } finally {
      repo.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
