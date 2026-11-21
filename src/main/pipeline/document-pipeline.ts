import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeHtmlEntities } from '@shared/html-entities';
import type { AiProvider, AppLocale, ExtractedAction, ParsedEmailSummary } from '@shared/types';
import {
  postGeminiGenerateContent,
  postOpenRouterChatCompletions,
  resolveAiRoute,
  type CloudAiProxyConfig,
} from '../ai/cloud-proxy';
import type { FetchLike } from '../ai/decision-router';
import { extractActionsFromText } from '../ocr/ocr-service';
import { analyzeForSecret, redactSecrets } from '../security/secret-shield';
import { readZipEntries, readZipEntry } from '../utils/zip';
import { formatEmailAsNoteMarkdown, parseEmlBuffer } from './email-parser';
import {
  extractReadablePage,
  htmlFragmentToCleanMarkdown,
  sanitizeIngestedText,
} from './html-cleaner';
import { sanitizeSafeExternalUrl } from './unfurler';

export interface DocumentExtractionResult {
  fileName: string;
  fileSize: number;
  mime: string;
  ext: string;
  pageCount: number | null;
  extractedText: string;
  bodyMarkdown?: string;
  emailSummary?: ParsedEmailSummary;
  title: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  extractedActions: ExtractedAction[];
  tags: string[];
  suggestedSection: string | null;
  costUsd: number;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

export function inferDocumentExt(fileName: string, mime?: string): string {
  const fromName = path.extname(fileName || '').toLowerCase().replace(/^\./, '');
  if (fromName && MIME_BY_EXT[fromName]) return fromName;
  const m = (mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || m.includes('docx')) return 'docx';
  if (m.includes('spreadsheetml') || m.includes('xlsx')) return 'xlsx';
  if (m.includes('presentationml') || m.includes('pptx')) return 'pptx';
  if (m.includes('rfc822') || m.includes('eml')) return 'eml';
  if (m.includes('text/html') || m.includes('xhtml')) return 'html';
  if (m.includes('markdown')) return 'md';
  if (m.includes('csv')) return 'csv';
  if (m.includes('json')) return 'json';
  return fromName || 'txt';
}

export function saveDocumentAsset(
  mediaDir: string,
  fileStem: string,
  buffer: Buffer,
  fileName: string,
  mime?: string
): { storedFileName: string; safeOriginalName: string; mime: string; ext: string; byteLength: number } {
  fs.mkdirSync(mediaDir, { recursive: true });
  const ext = inferDocumentExt(fileName, mime);
  const safeBase = path
    .basename(fileName || `document.${ext}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 100);
  const storedFileName = `doc_${fileStem}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, storedFileName), buffer);
  return {
    storedFileName,
    safeOriginalName: safeBase || `document.${ext}`,
    mime: mime || MIME_BY_EXT[ext] || 'application/octet-stream',
    ext,
    byteLength: buffer.length,
  };
}

function decodeXmlEntities(text: string): string {
  return decodeHtmlEntities(text);
}

/**
 * Extracts readable text from `.docx` via `src/main/utils/zip.ts`.
 */
function extractDocxText(buffer: Buffer): { text: string; pageCount: number | null } {
  try {
    const xmlBuf = readZipEntry(buffer, 'word/document.xml', { rejectUnsafePaths: false });
    if (!xmlBuf) return { text: '', pageCount: null };

    const xml = xmlBuf.toString('utf8');
    const paragraphs = xml
      .split(/<\/w:p>/i)
      .map((chunk) => {
        const parts: string[] = [];
        for (const m of chunk.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/?>/gi)) {
          if (m[2]) {
            parts.push(m[2].toLowerCase() === 'br' ? '\n' : ' ');
          } else {
            parts.push(decodeXmlEntities(m[1] || ''));
          }
        }
        return parts
          .join('')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
      })
      .filter(Boolean);

    const joined = paragraphs.join('\n').trim();
    const approxPages = joined.length > 0 ? Math.max(1, Math.ceil(joined.length / 2200)) : null;
    return { text: joined, pageCount: approxPages };
  } catch {
    return { text: '', pageCount: null };
  }
}

/**
 * Extracts readable text rows from `.xlsx` workbooks via `src/main/utils/zip.ts`.
 */
function extractXlsxText(buffer: Buffer): { text: string; pageCount: number | null } {
  try {
    const entries = readZipEntries(buffer, { rejectUnsafePaths: false });
    const sharedStringsEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
    const sharedStrings: string[] = [];
    if (sharedStringsEntry) {
      const ssXml = sharedStringsEntry.data.toString('utf8');
      for (const si of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
        const inner = si[1] ?? '';
        const runs: string[] = [];
        for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
          runs.push(decodeXmlEntities(t[1] || ''));
        }
        sharedStrings.push(runs.join(''));
      }
    }

    const sheetEntries = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const lines: string[] = [];
    for (const sheet of sheetEntries) {
      const sheetXml = sheet.data.toString('utf8');
      for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
        const rowXml = rowMatch[1] ?? '';
        const cells: string[] = [];
        for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
          const attrs = cellMatch[1] ?? '';
          const inner = cellMatch[2] ?? '';
          const typeMatch = /\bt="([^"]+)"/.exec(attrs);
          const cellType = typeMatch?.[1] ?? '';
          if (cellType === 'inlineStr') {
            const parts: string[] = [];
            for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
              parts.push(decodeXmlEntities(t[1] || ''));
            }
            const val = parts.join('').trim();
            if (val) cells.push(val);
          } else {
            const vMatch = /<v>([\s\S]*?)<\/v>/i.exec(inner);
            if (!vMatch?.[1]) continue;
            const rawVal = decodeXmlEntities(vMatch[1].trim());
            if (cellType === 's') {
              const idx = Number(rawVal);
              const resolved = Number.isInteger(idx) ? sharedStrings[idx] : undefined;
              if (resolved?.trim()) cells.push(resolved.trim());
            } else if (rawVal) {
              cells.push(rawVal);
            }
          }
        }
        if (cells.length > 0) {
          lines.push(cells.join(' | '));
        }
        if (lines.length >= 400) break;
      }
    }

    return {
      text: lines.join('\n').trim(),
      pageCount: sheetEntries.length > 0 ? sheetEntries.length : null,
    };
  } catch {
    return { text: '', pageCount: null };
  }
}

/**
 * Extracts slide text from `.pptx` presentations via `src/main/utils/zip.ts`.
 */
function extractPptxText(buffer: Buffer): { text: string; pageCount: number | null } {
  try {
    const entries = readZipEntries(buffer, { rejectUnsafePaths: false });
    const slideEntries = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const slides: string[] = [];
    for (let i = 0; i < slideEntries.length; i++) {
      const xml = slideEntries[i]!.data.toString('utf8');
      const paras = xml
        .split(/<\/a:p>/i)
        .map((chunk) => {
          const runs: string[] = [];
          for (const t of chunk.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)) {
            runs.push(decodeXmlEntities(t[1] || ''));
          }
          return runs.join('').replace(/[ \t]{2,}/g, ' ').trim();
        })
        .filter(Boolean);
      if (paras.length > 0) {
        slides.push(paras.join('\n'));
      }
    }

    return {
      text: slides.join('\n\n').trim(),
      pageCount: slideEntries.length > 0 ? slideEntries.length : null,
    };
  } catch {
    return { text: '', pageCount: null };
  }
}

/**
 * Pure-Node fallback PDF text scanner for uncompressed & FlateDecode text streams.
 */
function extractPdfFallbackText(buffer: Buffer): { text: string; pageCount: number | null } {
  const raw = buffer.toString('latin1');
  const pageMatches = raw.match(/\/Type\s*\/Page\b(?!s)/g);
  const pageCount = pageMatches ? pageMatches.length : null;

  const chunks: string[] = [];
  const collectPdfStrings = (source: string) => {
    for (const block of source.matchAll(/BT([\s\S]*?)ET/g)) {
      const inner = block[1] || '';
      const lineParts: string[] = [];
      for (const lit of inner.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
        const unescaped = (lit[1] || '')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, ' ')
          .replace(/\\t/g, ' ')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\');
        if (unescaped.trim()) lineParts.push(unescaped);
      }
      if (lineParts.length > 0) chunks.push(lineParts.join(' '));
    }
  };

  collectPdfStrings(raw);

  // Inspect compressed FlateDecode streams if literal scan yielded little
  if (chunks.join(' ').trim().length < 24) {
    let searchFrom = 0;
    while (searchFrom < buffer.length) {
      const streamPos = buffer.indexOf('stream', searchFrom, 'latin1');
      if (streamPos === -1) break;
      let start = streamPos + 6;
      if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
      else if (buffer[start] === 0x0a) start += 1;
      const endStreamPos = buffer.indexOf('endstream', start, 'latin1');
      if (endStreamPos === -1) break;
      try {
        const compressed = buffer.subarray(start, endStreamPos);
        const inflated = zlib.inflateSync(compressed).toString('utf8');
        collectPdfStrings(inflated);
      } catch {
        // Non-Flate stream (e.g. image/font) — ignore cleanly
      }
      searchFrom = endStreamPos + 9;
      if (chunks.join('\n').length > 25_000) break;
    }
  }

  return {
    text: chunks.join('\n').replace(/\s+\n/g, '\n').trim(),
    pageCount,
  };
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number | null }> {
  try {
    const unpdf = await import('unpdf');
    if (typeof unpdf.extractText === 'function') {
      const result = await unpdf.extractText(new Uint8Array(buffer), { mergePages: true });
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (text.length > 0 || (result.totalPages ?? 0) > 0) {
        return {
          text,
          pageCount: typeof result.totalPages === 'number' && result.totalPages > 0 ? result.totalPages : null,
        };
      }
    }
  } catch {
    // Fallback below handles CJS/asar edge cases or unconventional PDFs
  }
  return extractPdfFallbackText(buffer);
}

function buildLocalDocumentSummary(
  text: string,
  cleanFileTitle: string,
  ext: string,
  pageCount: number | null,
  locale: AppLocale = 'ru'
): { title: string; summary: string; keyPoints: string[]; actionItems: string[] } {
  const isEn = locale === 'en';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const firstMeaningful =
    lines[0]?.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 76) ?? '';
  const looksLikeHeading =
    firstMeaningful.length >= 4 &&
    firstMeaningful.length <= 72 &&
    !/^(?:https?:\/\/|page\s+\d|стр\.?\s*\d|[\d\s\p{P}\p{S}]+$)/iu.test(firstMeaningful);
  const title = looksLikeHeading ? firstMeaningful : cleanFileTitle;
  const normSnippet = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
  const titleNorm = normSnippet(title);

  // Exclude the extracted heading line when body lines follow so summary doesn't repeat the title.
  const summaryLines = looksLikeHeading && lines.length > 1 ? lines.slice(1) : lines;
  const sentences = summaryLines
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 16 && normSnippet(s) !== titleNorm);

  const summary =
    sentences.slice(0, 2).join(' ').slice(0, 240) ||
    summaryLines.slice(0, 2).join(' · ').slice(0, 240) ||
    (isEn
      ? `${ext.toUpperCase()} document${pageCount ? ` · ${pageCount} pp.` : ''} ready for preview and search.`
      : `Документ ${ext.toUpperCase()}${pageCount ? ` · ${pageCount} стр.` : ''} готов к просмотру и поиску.`);

  const summaryNorm = normSnippet(summary);
  const keyPoints = sentences
    .map((s) => s.slice(0, 140))
    .filter((kp) => {
      const n = normSnippet(kp);
      if (!n) return false;
      if (titleNorm && (n === titleNorm || titleNorm.includes(n))) return false;
      if (summaryNorm && (summaryNorm.includes(n) || n.includes(summaryNorm))) return false;
      return true;
    })
    .slice(0, 3);
  const actionItems = lines
    .filter((l) => /(?:до\s+\d|срок|оплат|подпис|отправ|провер|позвон|нужно|todo|action)/i.test(l))
    .slice(0, 4)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').slice(0, 120));

  return { title, summary, keyPoints, actionItems };
}

async function summarizeDocumentWithCloud(params: {
  text: string;
  fileName: string;
  aiProvider: AiProvider;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  budgetReached?: boolean;
  locale?: AppLocale;
  onSpendUsd?: (usd: number) => void;
  fetchFn?: FetchLike;
}): Promise<{
  title?: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  suggestedSection?: string | null;
  tags?: string[];
  costUsd: number;
} | null> {
  if (params.aiProvider === 'local') return null;
  if (analyzeForSecret(params.text).isSecret || analyzeForSecret(params.fileName).isSecret) {
    return null;
  }
  const route = await resolveAiRoute({
    provider: params.aiProvider,
    googleAiKey: params.googleAiKey,
    openRouterKey: params.openRouterKey,
    cloudProxy: params.cloudProxy,
  });
  if (route.mode === 'local' || route.provider === 'local') return null;
  if (route.mode === 'personal' && params.budgetReached) return null;

  const snippet = redactSecrets(params.text.trim()).slice(0, 6000);
  if (snippet.length < 40) return null;
  const safeFileName = redactSecrets(params.fileName);
  const isEn = params.locale === 'en';

  const prompt = (
    isEn
      ? [
          'You help the user organize their personal Kapsula vault in English.',
          'From the document text, create a short clear title, a 1-2 sentence summary, up to 4 key points, and up to 4 concrete action steps (if present).',
          'Return STRICT JSON without markdown:',
          '{"title":"...","summary":"...","keyPoints":["..."],"actionItems":["..."],"suggestedSection":"Documents | Finance | Work | Learning | null","tags":["tag1","tag2"]}',
          `File name: ${safeFileName}`,
          `Text:\n${snippet}`,
        ]
      : [
          'Ты помогаешь пользователю в личном хранилище Kapsula на русском языке.',
          'По тексту документа сделай короткий понятный заголовок, суть на 1-2 предложения, до 4 ключевых пунктов и до 4 конкретных шагов (если есть).',
          'Верни СТРОГО JSON без markdown:',
          '{"title":"...","summary":"...","keyPoints":["..."],"actionItems":["..."],"suggestedSection":"Документы | Финансы | Работа | Учёба | null","tags":["тег1","тег2"]}',
          `Имя файла: ${safeFileName}`,
          `Текст:\n${snippet}`,
        ]
  ).join('\n');

  try {
    if (route.provider === 'google_ai_studio') {
      const json = (await postGeminiGenerateContent({
        model: 'gemini-2.5-flash-lite',
        apiKey: route.apiKey,
        proxy: route.proxy,
        accessToken: route.accessToken,
        timeoutMs: 8000,
        fetchFn: params.fetchFn,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 600,
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
      })) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const raw = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('');
      const cost =
        ((json.usageMetadata?.promptTokenCount ?? 700) * 0.0001 +
          (json.usageMetadata?.candidatesTokenCount ?? 150) * 0.0004) /
        1000;
      params.onSpendUsd?.(cost);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) {
        const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        return {
          title: typeof obj.title === 'string' ? obj.title.trim().slice(0, 96) : undefined,
          summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 260) : undefined,
          keyPoints: Array.isArray(obj.keyPoints)
            ? obj.keyPoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
            : undefined,
          actionItems: Array.isArray(obj.actionItems)
            ? obj.actionItems.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
            : undefined,
          suggestedSection:
            typeof obj.suggestedSection === 'string' && obj.suggestedSection.trim()
              ? obj.suggestedSection.trim().slice(0, 32)
              : null,
          tags: Array.isArray(obj.tags)
            ? obj.tags
                .map((x) => String(x).toLowerCase().trim().replace(/^#/, ''))
                .filter(Boolean)
                .slice(0, 4)
            : undefined,
          costUsd: cost,
        };
      }
    } else {
      const json = (await postOpenRouterChatCompletions({
        apiKey: route.apiKey,
        proxy: route.proxy,
        accessToken: route.accessToken,
        timeoutMs: 8000,
        fetchFn: params.fetchFn,
        body: {
          model: 'google/gemini-2.5-flash-lite',
          temperature: 0.15,
          max_tokens: 450,
          messages: [{ role: 'user', content: prompt }],
        },
      })) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const raw = json.choices?.[0]?.message?.content ?? '';
      const cost = ((json.usage?.total_tokens ?? 900) * 0.00015) / 1000;
      params.onSpendUsd?.(cost);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) {
        const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        return {
          title: typeof obj.title === 'string' ? obj.title.trim().slice(0, 96) : undefined,
          summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 260) : undefined,
          keyPoints: Array.isArray(obj.keyPoints)
            ? obj.keyPoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
            : undefined,
          actionItems: Array.isArray(obj.actionItems)
            ? obj.actionItems.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
            : undefined,
          suggestedSection:
            typeof obj.suggestedSection === 'string' && obj.suggestedSection.trim()
              ? obj.suggestedSection.trim().slice(0, 32)
              : null,
          tags: Array.isArray(obj.tags)
            ? obj.tags
                .map((x) => String(x).toLowerCase().trim().replace(/^#/, ''))
                .filter(Boolean)
                .slice(0, 4)
            : undefined,
          costUsd: cost,
        };
      }
    }
  } catch {
    // Fall back cleanly to deterministic summary
  }
  return null;
}

export async function processDocumentIntelligence(params: {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  aiProvider: AiProvider;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  budgetReached?: boolean;
  locale?: AppLocale;
  onSpendUsd?: (usd: number) => void;
  fetchFn?: FetchLike;
}): Promise<DocumentExtractionResult> {
  const locale: AppLocale = params.locale ?? 'ru';
  const isEn = locale === 'en';
  const ext = inferDocumentExt(params.fileName, params.mime);
  const mime = params.mime || MIME_BY_EXT[ext] || 'application/octet-stream';
  const cleanFileTitle =
    params.fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
    (isEn ? 'Document' : 'Документ');
  const prettyFileTitle = cleanFileTitle.charAt(0).toUpperCase() + cleanFileTitle.slice(1);

  let extractedText = '';
  let bodyMarkdown: string | undefined;
  let emailSummary: ParsedEmailSummary | undefined;
  let pageCount: number | null = null;

  if (ext === 'pdf') {
    const res = await extractPdfText(params.buffer);
    extractedText = res.text;
    pageCount = res.pageCount;
  } else if (ext === 'docx') {
    const res = extractDocxText(params.buffer);
    extractedText = res.text;
    pageCount = res.pageCount;
  } else if (ext === 'xlsx') {
    const res = extractXlsxText(params.buffer);
    extractedText = res.text;
    pageCount = res.pageCount;
  } else if (ext === 'pptx') {
    const res = extractPptxText(params.buffer);
    extractedText = res.text;
    pageCount = res.pageCount;
  } else if (ext === 'eml') {
    emailSummary = parseEmlBuffer(params.buffer, locale);
    bodyMarkdown = formatEmailAsNoteMarkdown(emailSummary, [], locale);
    extractedText = [
      emailSummary.subject,
      emailSummary.from ? `${isEn ? 'From' : 'От'}: ${emailSummary.from}` : '',
      emailSummary.bodyText,
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
  } else if (ext === 'html' || ext === 'htm') {
    const rawHtml = params.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const page = extractReadablePage(rawHtml, new URL('https://local.document/'), sanitizeSafeExternalUrl);
    const cleanedMd =
      page.bodyMarkdown && page.bodyMarkdown !== 'https://local.document/'
        ? page.bodyMarkdown
        : htmlFragmentToCleanMarkdown(rawHtml, {
            mode: 'web',
            stripBoilerplate: true,
            sanitizeUrl: sanitizeSafeExternalUrl,
          }).markdown;
    bodyMarkdown = cleanedMd;
    extractedText = [page.title || '', cleanedMd].filter(Boolean).join('\n\n').trim();
  } else {
    let raw = params.buffer.toString('utf8').replace(/^\uFEFF/, '');
    if (ext === 'json') {
      try {
        raw = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Keep raw JSON text
      }
    } else if (ext === 'txt' || ext === 'md') {
      raw = sanitizeIngestedText(raw);
    }
    extractedText = raw.trim();
  }

  const trimmedText = extractedText.slice(0, 20_000);
  const local = buildLocalDocumentSummary(trimmedText, prettyFileTitle, ext, pageCount, locale);

  const hasExtractedHeading = local.title !== prettyFileTitle && local.title.trim().length >= 4;
  let title =
    emailSummary?.subject &&
    emailSummary.subject !== 'Письмо без темы' &&
    emailSummary.subject !== 'Untitled email'
      ? emailSummary.subject
      : hasExtractedHeading
        ? local.title
        : prettyFileTitle.length >= 3
          ? prettyFileTitle
          : local.title;
  let summary = local.summary;
  let keyPoints = local.keyPoints;
  let actionItems = local.actionItems;
  let tags = [ext === 'md' ? 'markdown' : ext === 'eml' ? (isEn ? 'email' : 'письмо') : ext];
  let suggestedSection: string | null =
    ext === 'eml' ? (isEn ? 'Work' : 'Работа') : isEn ? 'Documents' : 'Документы';
  let costUsd = 0;

  const containsSecret =
    analyzeForSecret(trimmedText).isSecret || analyzeForSecret(params.fileName).isSecret;

  if (
    !containsSecret &&
    params.aiProvider !== 'local' &&
    trimmedText.length >= 60
  ) {
    const cloud = await summarizeDocumentWithCloud({
      text: trimmedText,
      fileName: params.fileName,
      aiProvider: params.aiProvider,
      googleAiKey: params.googleAiKey,
      openRouterKey: params.openRouterKey,
      cloudProxy: params.cloudProxy,
      budgetReached: params.budgetReached,
      locale,
      onSpendUsd: params.onSpendUsd,
      fetchFn: params.fetchFn,
    });
    if (cloud) {
      title = cloud.title || title;
      summary = cloud.summary || summary;
      keyPoints = cloud.keyPoints?.length ? cloud.keyPoints : keyPoints;
      actionItems = cloud.actionItems?.length ? cloud.actionItems : actionItems;
      suggestedSection = cloud.suggestedSection ?? suggestedSection;
      tags = cloud.tags?.length ? cloud.tags : tags;
      costUsd = cloud.costUsd;
    }
  }

  return {
    fileName: params.fileName,
    fileSize: params.buffer.length,
    mime,
    ext,
    pageCount,
    extractedText: trimmedText,
    bodyMarkdown,
    emailSummary,
    title,
    summary,
    keyPoints,
    actionItems,
    extractedActions: extractActionsFromText(trimmedText, locale),
    tags,
    suggestedSection,
    costUsd,
  };
}
