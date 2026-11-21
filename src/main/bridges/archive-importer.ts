import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveImportResult } from '@shared/types';
import type { CapturePipeline } from '../pipeline/capture-pipeline';
import {
  domNodeToMarkdown,
  normalizeMetaText,
  parseHtmlDocument,
  type DomNodeLike,
} from '../pipeline/html-cleaner';
import type { VaultRepository } from '../db/repository';

function flattenTelegramText(textField: unknown): { markdown: string; hasCodeBlocks: boolean } {
  if (typeof textField === 'string') {
    return {
      markdown: textField,
      hasCodeBlocks: /```[\s\S]+?```/.test(textField),
    };
  }
  if (!Array.isArray(textField)) return { markdown: '', hasCodeBlocks: false };
  let hasCodeBlocks = false;
  const markdown = textField
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const obj = part as { type?: string; text?: string; href?: string; language?: string };
        const txt = obj.text || '';
        switch (obj.type) {
          case 'pre': {
            hasCodeBlocks = true;
            const lang = (obj.language || '').replace(/[^a-zA-Z0-9_+#.-]/g, '');
            return `\n\`\`\`${lang}\n${txt.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n`;
          }
          case 'code':
            return `\`${txt.replace(/`/g, "'")}\``;
          case 'bold':
            return `**${txt}**`;
          case 'italic':
            return `*${txt}*`;
          case 'strikethrough':
            return `~~${txt}~~`;
          case 'blockquote':
            return txt
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n');
          case 'text_link':
            return obj.href ? `[${txt || obj.href}](${obj.href})` : txt;
          default:
            if (obj.href && txt && !txt.includes(obj.href)) {
              return `[${txt}](${obj.href})`;
            }
            return txt || obj.href || '';
        }
      }
      return '';
    })
    .join('')
    .trim();
  return { markdown, hasCodeBlocks };
}

function parseTelegramHtmlDateMs(dateTitle: string): number {
  const m = dateTitle.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
    const tz = dateTitle.match(/UTC\s*([+-]\d{2}):?(\d{2})/i);
    const parsed = Date.parse(tz ? `${iso}${tz[1]}:${tz[2]}` : iso);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const direct = Date.parse(dateTitle);
  return Number.isFinite(direct) && direct > 0 ? direct : Date.now();
}

async function importTelegramHtml(
  rawHtml: string,
  pipeline: CapturePipeline,
  repo: VaultRepository
): Promise<ArchiveImportResult> {
  const doc = parseHtmlDocument(rawHtml);
  const messageEls = Array.from(doc.querySelectorAll('.message.default'));
  if (messageEls.length === 0) {
    return { format: 'unknown', imported: 0, skippedDuplicates: 0, errors: 1 };
  }

  let imported = 0;
  let skippedDuplicates = 0;
  let errors = 0;

  for (let i = 0; i < messageEls.length; i++) {
    try {
      const msgEl = messageEls[i]!;
      const msgId = msgEl.getAttribute('id') || `row-${i}`;

      const textEls = Array.from(msgEl.querySelectorAll('.text'));
      if (textEls.length === 0) continue;

      const mdParts: string[] = [];
      let hasCodeBlocks = false;
      for (const textEl of textEls) {
        // Avoid duplicating nested `.text` elements inside another `.text`
        if (textEl.parentElement?.closest('.text')) continue;
        const parsed = domNodeToMarkdown(textEl as unknown as DomNodeLike, { mode: 'archive' });
        if (parsed.hasCodeBlocks) hasCodeBlocks = true;
        if (parsed.markdown) mdParts.push(parsed.markdown);
      }

      const markdown = mdParts.join('\n\n').trim();
      if (!markdown) continue;

      const extId = `tg_html:${msgId}`;
      if (repo.findBySourceExternalId('archive_import', extId)) {
        skippedDuplicates++;
        continue;
      }

      const dateEl = msgEl.querySelector('.date[title]');
      const dateTitle = dateEl?.getAttribute('title') || '';
      const createdAt = dateTitle ? parseTelegramHtmlDateMs(dateTitle) : Date.now();

      let forwardAuthor: string | undefined;
      const fwdFromEl = msgEl.querySelector('.forwarded.body .from_name');
      if (fwdFromEl) {
        const clone = fwdFromEl.cloneNode(true) as Element;
        for (const nestedDate of Array.from(clone.querySelectorAll('.date'))) {
          nestedDate.remove();
        }
        const cleanedAuthor = normalizeMetaText(clone.textContent);
        if (cleanedAuthor) forwardAuthor = cleanedAuthor;
      }

      await pipeline.capture({
        text: markdown,
        subKind: hasCodeBlocks || Boolean(forwardAuthor) ? 'post' : undefined,
        mediaMeta: forwardAuthor ? { forwardAuthor } : undefined,
        mode: 'buffer',
        source: 'archive_import',
        externalId: extId,
        tags: ['telegram'],
        createdAt,
      });
      imported++;
    } catch {
      errors++;
    }
  }

  return { format: 'telegram_html', imported, skippedDuplicates, errors };
}

export async function importArchiveFromPath(
  filePath: string,
  pipeline: CapturePipeline,
  repo: VaultRepository
): Promise<ArchiveImportResult> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return importArchiveJson(raw, pipeline, repo, path.dirname(filePath));
}

export async function importArchiveJson(
  rawJson: string,
  pipeline: CapturePipeline,
  repo: VaultRepository,
  baseDir?: string
): Promise<ArchiveImportResult> {
  const trimmedInput = rawJson.trim();
  if (/^<!DOCTYPE\s+html/i.test(trimmedInput) || /<div\s+class="message\s+default\b/i.test(trimmedInput)) {
    return importTelegramHtml(trimmedInput, pipeline, repo);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedInput);
  } catch {
    return { format: 'unknown', imported: 0, skippedDuplicates: 0, errors: 1 };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { format: 'unknown', imported: 0, skippedDuplicates: 0, errors: 1 };
  }

  const root = parsed as Record<string, unknown>;

  // 1. Meta Instagram saved_posts.json
  const igList = Array.isArray(root.saved_saved_media)
    ? root.saved_saved_media
    : Array.isArray(root.saved_posts)
      ? root.saved_posts
      : null;

  if (igList) {
    let imported = 0;
    let skippedDuplicates = 0;
    let errors = 0;

    for (const entry of igList) {
      try {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const mapData = item.string_map_data as
          | Record<string, { href?: string; value?: string; timestamp?: number }>
          | undefined;

        let href: string | undefined;
        let timestamp: number | undefined;
        let extraVal = '';

        if (mapData) {
          for (const v of Object.values(mapData)) {
            if (v?.href) href = v.href;
            if (typeof v?.timestamp === 'number' && v.timestamp > 0) timestamp = v.timestamp * 1000;
            if (v?.value && !v.href) extraVal = v.value;
          }
        }
        if (!href && typeof item.href === 'string') href = item.href;
        if (!href && typeof item.url === 'string') href = item.url;
        if (!timestamp && typeof item.timestamp === 'number' && item.timestamp > 0) {
          timestamp = item.timestamp * 1000;
        }

        if (!href) continue;

        const author = typeof item.title === 'string' && item.title ? `@${item.title.replace(/^@/, '')}` : '';
        const extId = `ig:${href}`;
        if (repo.findBySourceExternalId('archive_import', extId)) {
          skippedDuplicates++;
          continue;
        }

        const isEn = repo.getLocale() === 'en';
        const text = [href, author ? `${isEn ? 'Author' : 'Автор'}: ${author}` : '', extraVal]
          .filter(Boolean)
          .join('\n');
        await pipeline.capture({
          text,
          url: href,
          title: author ? `Instagram · ${author}` : isEn ? 'Instagram Saved Post' : 'Сохранёнка Instagram',
          platform: 'instagram',
          mode: 'buffer',
          tags: ['instagram', isEn ? 'archive' : 'архив'],
          source: 'archive_import',
          externalId: extId,
          createdAt: timestamp,
        });
        imported++;
      } catch {
        errors++;
      }
    }

    return { format: 'instagram_json', imported, skippedDuplicates, errors };
  }

  // 2. Telegram Desktop result.json
  let tgEntries: Array<{ chatKey: string; raw: unknown }> | null = null;
  if (Array.isArray(root.messages)) {
    const singleChatKey = String(root.id ?? root.name ?? 'saved');
    tgEntries = root.messages.map((raw) => ({ chatKey: singleChatKey, raw }));
  } else if (root.chats && typeof root.chats === 'object') {
    const chatsObj = root.chats as { list?: Array<{ id?: unknown; name?: unknown; messages?: unknown[] }> };
    if (Array.isArray(chatsObj.list)) {
      tgEntries = chatsObj.list.flatMap((c, idx) => {
        const chatKey = String(c.id ?? c.name ?? idx);
        return Array.isArray(c.messages) ? c.messages.map((raw) => ({ chatKey, raw })) : [];
      });
    }
  }

  if (tgEntries) {
    let imported = 0;
    let skippedDuplicates = 0;
    let errors = 0;

    for (const { chatKey, raw: msgRaw } of tgEntries) {
      try {
        if (!msgRaw || typeof msgRaw !== 'object') continue;
        const msg = msgRaw as Record<string, unknown>;
        if (msg.type && msg.type !== 'message') continue;

        const parsedText = flattenTelegramText(msg.text);
        const relPhoto = typeof msg.photo === 'string' && msg.photo ? msg.photo : null;
        const resolvedPhoto =
          baseDir && relPhoto && fs.existsSync(path.resolve(baseDir, relPhoto))
            ? path.resolve(baseDir, relPhoto)
            : undefined;
        if (!parsedText.markdown && !resolvedPhoto) continue;

        const msgId = String(msg.id ?? '');
        const extId = msgId ? `tg_export:${chatKey}:${msgId}` : null;
        if (extId && repo.findBySourceExternalId('archive_import', extId)) {
          skippedDuplicates++;
          continue;
        }

        const unixRaw = msg.date_unixtime;
        const unixNum = Number(unixRaw);
        const hasValidUnix =
          unixRaw !== '' &&
          unixRaw !== null &&
          unixRaw !== undefined &&
          Number.isFinite(unixNum) &&
          unixNum > 0;
        const ts = hasValidUnix
          ? unixNum * 1000
          : typeof msg.date === 'string'
            ? Date.parse(msg.date) || Date.now()
            : Date.now();

        const forwardAuthor =
          typeof msg.forwarded_from === 'string' && msg.forwarded_from.trim()
            ? msg.forwarded_from.trim()
            : undefined;
        await pipeline.capture({
          text: parsedText.markdown,
          imageFilePath: resolvedPhoto,
          subKind: parsedText.hasCodeBlocks || Boolean(forwardAuthor) ? 'post' : undefined,
          mediaMeta: forwardAuthor ? { forwardAuthor } : undefined,
          mode: 'buffer',
          source: 'archive_import',
          externalId: extId,
          tags: ['telegram'],
          createdAt: ts,
        });
        imported++;
      } catch {
        errors++;
      }
    }

    return { format: 'telegram_json', imported, skippedDuplicates, errors };
  }

  return { format: 'unknown', imported: 0, skippedDuplicates: 0, errors: 1 };
}
