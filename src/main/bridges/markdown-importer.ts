import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SECTION_COLOR_PALETTE } from '@shared/constants';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import type {
  AppLocale,
  ContentDna,
  ExportResult,
  ImportResult,
  OrbitDef,
  VaultItem,
} from '@shared/types';
import type { VaultRepository } from '../db/repository';
import type { CapturePipeline } from '../pipeline/capture-pipeline';
import { htmlFragmentToCleanMarkdown } from '../pipeline/html-cleaner';
import { createZipBuffer, readZipEntries, ZipSecurityError, type ZipInputEntry } from '../utils/zip';

export interface MarkdownIoDeps {
  repo: VaultRepository;
  pipeline: CapturePipeline;
  onOrbitsChanged?: () => void;
  broadcastUpsert?: (item: VaultItem) => void;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '__MACOSX']);

const MIME_BY_IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export interface ParsedFrontmatter {
  title?: string;
  tags: string[];
  createdAt?: number;
  orbit?: string;
  url?: string;
  body: string;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  }
  return trimmed;
}

function parseFlexibleDate(raw: string): number | undefined {
  const cleaned = unquoteYamlScalar(raw);
  if (!cleaned) return undefined;
  if (/^\d{10,13}$/.test(cleaned)) {
    const num = Number(cleaned);
    return cleaned.length === 10 ? num * 1000 : num;
  }
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseYamlFrontmatter(rawMarkdown: string): ParsedFrontmatter {
  const normalized = rawMarkdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    return { tags: [], body: normalized };
  }

  const fmText = match[1] ?? '';
  const body = normalized.slice(match[0].length).replace(/^\n+/, '');
  const lines = fmText.split('\n');

  let title: string | undefined;
  let createdAt: number | undefined;
  let orbit: string | undefined;
  let url: string | undefined;
  const tags: string[] = [];

  let currentArrayKey: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentArrayKey && /^-\s+(.+)$/.test(trimmed)) {
      const itemVal = unquoteYamlScalar(trimmed.replace(/^-\s+/, ''));
      if (currentArrayKey === 'tags' && itemVal) {
        tags.push(itemVal.replace(/^#/, '').toLowerCase());
      }
      continue;
    }

    currentArrayKey = null;
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx <= 0) continue;

    const key = rawLine.slice(0, colonIdx).trim().toLowerCase();
    const rawVal = rawLine.slice(colonIdx + 1).trim();

    if (key === 'title') {
      const v = unquoteYamlScalar(rawVal);
      if (v) title = v;
    } else if (key === 'created' || key === 'date' || key === 'created_at' || key === 'createdat') {
      const ts = parseFlexibleDate(rawVal);
      if (ts !== undefined && createdAt === undefined) createdAt = ts;
    } else if (key === 'section' || key === 'orbit' || key === 'folder' || key === 'category') {
      const v = unquoteYamlScalar(rawVal);
      if (v) orbit = v;
    } else if (key === 'url' || key === 'source_url') {
      const v = unquoteYamlScalar(rawVal);
      if (/^https?:\/\//i.test(v)) url = v;
    } else if (key === 'tags' || key === 'tag') {
      if (!rawVal) {
        currentArrayKey = 'tags';
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        const inner = rawVal.slice(1, -1);
        for (const piece of inner.split(',')) {
          const t = unquoteYamlScalar(piece).replace(/^#/, '').toLowerCase();
          if (t) tags.push(t);
        }
      } else {
        for (const piece of rawVal.split(/[\s,]+/)) {
          const t = unquoteYamlScalar(piece).replace(/^#/, '').toLowerCase();
          if (t) tags.push(t);
        }
      }
    }
  }

  return {
    title,
    tags: [...new Set(tags)].slice(0, 6),
    createdAt,
    orbit,
    url,
    body,
  };
}

/**
 * Strips Notion's trailing 32-hex UUID suffix from a file or folder segment.
 * Example: `"Project Plan 3f8a9c12b4d54e6f8a9b0c1d2e3f4a5b"` -> `"Project Plan"`.
 */
export function stripNotionIdSuffix(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/(?:[\s_-]+)[0-9a-f]{32}$/i, '').trim();
  return stripped || trimmed;
}

function deriveTitleFromMarkdown(body: string, fallbackName: string, locale: AppLocale = 'ru'): string {
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1?.[1]?.trim()) {
    return h1[1].trim().slice(0, 120);
  }
  return fallbackName.trim().slice(0, 120) || (locale === 'en' ? 'Imported note' : 'Импортированная заметка');
}

function sanitizeExportSegment(name: string, fallback: string): string {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function escapeYamlString(val: string): string {
  if (/[:#[\]{}&*!|>'"%@`\n\r]/.test(val) || /^\s|\s$/.test(val)) {
    return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
  }
  return val;
}

function resolveOrCreateImportOrbit(
  repo: VaultRepository,
  orbitCache: Map<string, OrbitDef>,
  rawName: string,
  state: { created: number }
): string {
  const cleanName = rawName.trim().slice(0, 48);
  if (!cleanName) return '';
  const key = cleanName.toLowerCase();
  const cached = orbitCache.get(key);
  if (cached) return cached.id;

  const existing = repo
    .listOrbits()
    .find((o) => o.name.trim().toLowerCase() === key);
  if (existing) {
    orbitCache.set(key, existing);
    return existing.id;
  }

  const color = SECTION_COLOR_PALETTE[(orbitCache.size + state.created) % SECTION_COLOR_PALETTE.length]!;
  const isEn = repo.getLocale() === 'en';
  const created = repo.createOrbit({
    name: cleanName,
    description: isEn ? `Imported from "${cleanName}"` : `Импортировано из раздела «${cleanName}»`,
    color,
    icon: 'Folder',
  });
  orbitCache.set(key, created);
  state.created += 1;
  return created.id;
}

function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
  const normRoot =
    process.platform === 'win32' ? path.resolve(rootDir).toLowerCase() : path.resolve(rootDir);
  const normCandidate =
    process.platform === 'win32'
      ? path.resolve(candidatePath).toLowerCase()
      : path.resolve(candidatePath);
  const rel = path.relative(normRoot, normCandidate);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../')) return false;
  return !path.isAbsolute(rel);
}

function safeDecodeUriComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function walkDirectoryFiles(rootDir: string): { mdFiles: string[]; imageFiles: string[] } {
  const mdFiles: string[] = [];
  const imageFiles: string[] = [];

  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && IGNORED_DIRS.has(ent.name)) continue;
      if (IGNORED_DIRS.has(ent.name)) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(fullPath);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          mdFiles.push(fullPath);
        } else if (IMAGE_EXTS.has(ext)) {
          imageFiles.push(fullPath);
        }
      }
    }
  };

  visit(rootDir);
  mdFiles.sort((a, b) => a.localeCompare(b));
  return { mdFiles, imageFiles };
}

/**
 * Recursively imports an Obsidian vault or plain Markdown folder.
 * - Parses YAML frontmatter (`title`, `tags`, `created`/`date`).
 * - Resolves Obsidian `![[image.png]]` and standard relative `![alt](assets/img.png)` into `media/`
 *   as `kapsula-media://local/<filename>`.
 * - Preserves `[[wiki-links]]`.
 * - Maps top-level subfolders to `OrbitDef`s (reusing existing sections by name).
 */
export async function importMarkdownFolder(
  folderPath: string,
  deps: MarkdownIoDeps
): Promise<ImportResult> {
  const isEn = deps.repo.getLocale() === 'en';
  const errors: string[] = [];
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return {
      importedCount: 0,
      skippedCount: 0,
      orbitsCreated: 0,
      errors: [isEn ? 'Selected folder was not found.' : 'Выбранная папка не найдена.'],
    };
  }

  const rootAbs = path.resolve(folderPath);
  const { mdFiles, imageFiles } = walkDirectoryFiles(rootAbs);

  // Index images by relative POSIX path and by lowercase basename for Obsidian `![[img.png]]` lookups
  const imgByRelPath = new Map<string, string>();
  const imgByBaseName = new Map<string, string>();
  for (const imgAbs of imageFiles) {
    const relPosix = path.relative(rootAbs, imgAbs).replace(/\\/g, '/').toLowerCase();
    imgByRelPath.set(relPosix, imgAbs);
    const base = path.basename(imgAbs).toLowerCase();
    if (!imgByBaseName.has(base)) {
      imgByBaseName.set(base, imgAbs);
    }
  }

  const orbitCache = new Map<string, OrbitDef>();
  for (const o of deps.repo.listOrbits()) {
    orbitCache.set(o.name.trim().toLowerCase(), o);
  }
  const orbitState = { created: 0 };

  const existingHashes = new Set(
    deps.repo
      .queryItems({ includeArchived: true, includeSecrets: false, limit: 10_000 })
      .map((it) => it.contentHash)
  );

  let importedCount = 0;
  let skippedCount = 0;

  const resolveImageDiskPath = (rawTarget: string, mdFileDir: string): string | null => {
    const cleaned = safeDecodeUriComponent(rawTarget.trim().split('#')[0] || '')
      .replace(/\\/g, '/')
      .trim();
    if (!cleaned || /^(?:https?:|data:|kapsula-media:)/i.test(cleaned)) return null;

    // 1. Relative to current markdown file (strictly contained inside rootAbs, including symlinks)
    const directAbs = path.resolve(mdFileDir, cleaned);
    if (isPathInsideRoot(rootAbs, directAbs) && fs.existsSync(directAbs) && fs.statSync(directAbs).isFile()) {
      try {
        const realRoot = fs.realpathSync(rootAbs);
        const realDirect = fs.realpathSync(directAbs);
        if (isPathInsideRoot(realRoot, realDirect)) {
          const ext = path.extname(realDirect).toLowerCase();
          if (IMAGE_EXTS.has(ext)) return realDirect;
        }
      } catch {
        // Ignore unreadable or broken symlinks
      }
    }

    // 2. Relative to vault root
    const rootRelKey = cleaned.replace(/^\.?\//, '').toLowerCase();
    const byRel = imgByRelPath.get(rootRelKey);
    if (byRel) return byRel;

    // 3. Basename fallback (Obsidian shortest-path attachment style)
    const baseKey = path.basename(cleaned).toLowerCase();
    return imgByBaseName.get(baseKey) ?? null;
  };

  for (const mdAbs of mdFiles) {
    try {
      const relPosix = path.relative(rootAbs, mdAbs).replace(/\\/g, '/');
      const relHash = crypto.createHash('sha256').update(relPosix).digest('hex').slice(0, 24);
      const externalId = `md:${relHash}`;

      if (deps.repo.findBySourceExternalId('markdown_import', externalId)) {
        skippedCount += 1;
        continue;
      }

      const raw = fs.readFileSync(mdAbs, 'utf8');
      const contentHash = crypto.createHash('sha256').update(`md-folder|${relPosix}|${raw}`).digest('hex');
      if (existingHashes.has(contentHash)) {
        skippedCount += 1;
        continue;
      }

      const fm = parseYamlFrontmatter(raw);
      const mdDir = path.dirname(mdAbs);
      const baseTitle = path.basename(mdAbs, path.extname(mdAbs));
      let body = fm.body;
      let coverFilename: string | null = null;
      let coverThumb: string | null = null;

      // Replace Obsidian image embeds `![[image.png]]` or `![[path/image.png|caption]]`
      // Leave non-image `[[wiki-links]]` untouched!
      const obsidianEmbedRe = /!\[\[([^\]]+)\]\]/g;
      const obsidianMatches = [...body.matchAll(obsidianEmbedRe)];
      for (const m of obsidianMatches) {
        const inner = (m[1] ?? '').trim();
        const [rawRef, rawAlias] = inner.split('|');
        const refPath = (rawRef ?? '').trim();
        const ext = path.extname(refPath.split('#')[0] || '').toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;

        const diskPath = resolveImageDiskPath(refPath, mdDir);
        if (!diskPath) continue;
        const saved = await deps.pipeline.saveNoteImageAsset({
          filePath: diskPath,
          fileName: path.basename(diskPath),
          generateThumb: !coverFilename,
        });
        if (!coverFilename) {
          coverFilename = saved.filename;
          coverThumb = saved.thumbFilename ?? null;
        }
        const alt =
          rawAlias && !/^\d+(?:x\d+)?$/i.test(rawAlias.trim())
            ? rawAlias.trim()
            : path.basename(refPath, ext);
        body = body.replace(m[0], `![${alt}](${saved.mediaUrl})`);
      }

      // Replace standard relative Markdown images `![alt](path/to/img.png)`
      const mdImgRe = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
      const mdImgMatches = [...body.matchAll(mdImgRe)];
      for (const m of mdImgMatches) {
        const alt = m[1] ?? '';
        const rawHref = (m[2] ?? '').trim().replace(/^<|>$/g, '').split(/\s+"/)[0] || '';
        if (/^(?:https?:|data:|kapsula-media:)/i.test(rawHref)) continue;

        const diskPath = resolveImageDiskPath(rawHref, mdDir);
        if (!diskPath) continue;
        const saved = await deps.pipeline.saveNoteImageAsset({
          filePath: diskPath,
          fileName: path.basename(diskPath),
          generateThumb: !coverFilename,
        });
        if (!coverFilename) {
          coverFilename = saved.filename;
          coverThumb = saved.thumbFilename ?? null;
        }
        body = body.replace(m[0], `![${alt || path.basename(diskPath, path.extname(diskPath))}](${saved.mediaUrl})`);
      }

      // Map top-level subfolder (or frontmatter section) to OrbitDef
      const segments = relPosix.split('/');
      const topFolder = segments.length > 1 ? segments[0]! : '';
      const targetSectionName = fm.orbit || topFolder;
      const orbitId = targetSectionName
        ? resolveOrCreateImportOrbit(deps.repo, orbitCache, targetSectionName, orbitState)
        : '';

      const title = fm.title || deriveTitleFromMarkdown(body, baseTitle, isEn ? 'en' : 'ru');
      const stat = fs.statSync(mdAbs);
      const createdAt = fm.createdAt ?? Math.floor(stat.birthtimeMs || stat.mtimeMs || Date.now());

      const created = deps.repo.createItem({
        dna: 'note',
        orbit: orbitId,
        modeCaptured: 'autopilot',
        title,
        body: body.trim(),
        summary: '',
        url: fm.url ?? null,
        imagePath: coverFilename,
        thumbPath: coverThumb,
        tags: fm.tags,
        source: 'markdown_import',
        externalId,
        contentHash,
        aiStatus: 'local',
        createdAt,
      });

      existingHashes.add(contentHash);
      deps.broadcastUpsert?.(created);
      importedCount += 1;
    } catch (err) {
      const isEn = deps.repo.getLocale() === 'en';
      errors.push(`${path.basename(mdAbs)}: ${err instanceof Error ? err.message : isEn ? 'import error' : 'ошибка импорта'}`);
    }
  }

  if (orbitState.created > 0) {
    deps.onOrbitsChanged?.();
  }

  return {
    importedCount,
    skippedCount,
    orbitsCreated: orbitState.created,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Imports a Notion `.zip` export cleanly:
 * - Reads ZIP via pure-Node `src/main/utils/zip.ts` (including nested Export-*.zip wrapper).
 * - Strips Notion 32-hex ID suffixes from page & folder names.
 * - Imports `.md` notes + embedded media assets into `media/` as `kapsula-media://local/<filename>`.
 */
export async function importNotionZip(
  zipPath: string,
  deps: MarkdownIoDeps,
  options?: { maxTotalUncompressedBytes?: number }
): Promise<ImportResult> {
  const isEn = deps.repo.getLocale() === 'en';
  const errors: string[] = [];
  if (!zipPath || !fs.existsSync(zipPath)) {
    return {
      importedCount: 0,
      skippedCount: 0,
      orbitsCreated: 0,
      errors: [isEn ? 'Notion ZIP archive not found.' : 'ZIP-архив Notion не найден.'],
    };
  }

  const maxTotalBytes = options?.maxTotalUncompressedBytes ?? 250 * 1024 * 1024;
  let entries;
  try {
    const buf = fs.readFileSync(zipPath);
    entries = readZipEntries(buf, { maxTotalUncompressedBytes: maxTotalBytes });
    let totalExtractedBytes = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
    // Notion often wraps the real export inside one or more nested `Export-*.zip` files
    const mdDirect = entries.filter((e) => !e.isDirectory && /\.(?:md|markdown)$/i.test(e.name));
    if (mdDirect.length === 0) {
      const innerZips = entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.zip'));
      if (innerZips.length > 0) {
        const unpacked = [];
        for (const iz of innerZips) {
          const remainingBudget = maxTotalBytes - totalExtractedBytes;
          if (remainingBudget <= 0) {
            throw new ZipSecurityError('ZIP archive exceeds maximum total uncompressed size limit');
          }
          const innerEntries = readZipEntries(iz.data, {
            maxTotalUncompressedBytes: remainingBudget,
          });
          totalExtractedBytes += innerEntries.reduce((sum, e) => sum + e.uncompressedSize, 0);
          if (totalExtractedBytes > maxTotalBytes) {
            throw new ZipSecurityError('ZIP archive exceeds maximum total uncompressed size limit');
          }
          unpacked.push(...innerEntries);
        }
        if (unpacked.length > 0) entries = unpacked;
      }
    }
  } catch (err) {
    return {
      importedCount: 0,
      skippedCount: 0,
      orbitsCreated: 0,
      errors: [err instanceof Error ? err.message : isEn ? 'Could not read ZIP archive.' : 'Не удалось прочитать ZIP-архив.'],
    };
  }

  const imageByPath = new Map<string, { name: string; data: Buffer }>();
  const imageByBase = new Map<string, { name: string; data: Buffer }>();
  const mdEntries = [];

  for (const ent of entries) {
    if (ent.isDirectory) continue;
    if (ent.name.startsWith('__MACOSX/') || ent.name.includes('/._')) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (ext === '.md' || ext === '.markdown') {
      mdEntries.push(ent);
    } else if (IMAGE_EXTS.has(ext)) {
      const normKey = ent.name.toLowerCase();
      imageByPath.set(normKey, { name: ent.name, data: ent.data });
      const decodedKey = safeDecodeUriComponent(ent.name).toLowerCase();
      imageByPath.set(decodedKey, { name: ent.name, data: ent.data });
      const base = path.basename(ent.name).toLowerCase();
      if (!imageByBase.has(base)) {
        imageByBase.set(base, { name: ent.name, data: ent.data });
      }
    }
  }

  const orbitCache = new Map<string, OrbitDef>();
  for (const o of deps.repo.listOrbits()) {
    orbitCache.set(o.name.trim().toLowerCase(), o);
  }
  const orbitState = { created: 0 };

  const existingHashes = new Set(
    deps.repo
      .queryItems({ includeArchived: true, includeSecrets: false, limit: 10_000 })
      .map((it) => it.contentHash)
  );

  let importedCount = 0;
  let skippedCount = 0;

  const findZipImage = (rawHref: string, mdEntryPath: string): { name: string; data: Buffer } | null => {
    const cleaned = safeDecodeUriComponent(rawHref.trim().split('#')[0] || '')
      .replace(/\\/g, '/')
      .trim();
    if (!cleaned || /^(?:https?:|data:|kapsula-media:)/i.test(cleaned)) return null;

    const mdDir = path.posix.dirname(mdEntryPath);
    const joined = mdDir === '.' ? cleaned : path.posix.normalize(path.posix.join(mdDir, cleaned));
    const direct =
      imageByPath.get(joined.toLowerCase()) ??
      imageByPath.get(cleaned.replace(/^\.?\//, '').toLowerCase());
    if (direct) return direct;

    const base = path.posix.basename(cleaned).toLowerCase();
    return imageByBase.get(base) ?? null;
  };

  for (const ent of mdEntries) {
    try {
      const rawText = ent.data.toString('utf8');
      const extIdHash = crypto.createHash('sha256').update(`notion|${ent.name}`).digest('hex').slice(0, 24);
      const externalId = `notion:${extIdHash}`;

      if (deps.repo.findBySourceExternalId('markdown_import', externalId)) {
        skippedCount += 1;
        continue;
      }

      const contentHash = crypto.createHash('sha256').update(`notion-zip|${ent.name}|${rawText}`).digest('hex');
      if (existingHashes.has(contentHash)) {
        skippedCount += 1;
        continue;
      }

      const fm = parseYamlFrontmatter(rawText);
      const segments = ent.name.split('/').filter(Boolean);
      const rawFileBase = path.posix.basename(ent.name, path.posix.extname(ent.name));
      const cleanFileTitle = stripNotionIdSuffix(rawFileBase);

      // Top-level folder (if any) becomes an Orbit with Notion hex suffix stripped
      let topFolderClean = '';
      if (segments.length > 1) {
        const candidateFolder = stripNotionIdSuffix(segments[0]!);
        // Avoid turning generic Notion wrapper folders like "Export-xxxx" into sections
        if (!/^export(?:-[0-9a-f-]+)?$/i.test(candidateFolder)) {
          topFolderClean = candidateFolder;
        } else if (segments.length > 2) {
          topFolderClean = stripNotionIdSuffix(segments[1]!);
        }
      }

      let body = fm.body;
      let coverFilename: string | null = null;
      let coverThumb: string | null = null;

      // Resolve relative Markdown images inside the Notion ZIP
      const mdImgRe = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
      const imgMatches = [...body.matchAll(mdImgRe)];
      for (const m of imgMatches) {
        const alt = m[1] ?? '';
        const rawHref = (m[2] ?? '').trim().replace(/^<|>$/g, '').split(/\s+"/)[0] || '';
        const imgEntry = findZipImage(rawHref, ent.name);
        if (!imgEntry) continue;
        const ext = path.extname(imgEntry.name).toLowerCase();
        const saved = await deps.pipeline.saveNoteImageAsset({
          base64: imgEntry.data.toString('base64'),
          mimeType: MIME_BY_IMAGE_EXT[ext] ?? 'image/png',
          fileName: path.posix.basename(imgEntry.name),
          generateThumb: !coverFilename,
        });
        if (!coverFilename) {
          coverFilename = saved.filename;
          coverThumb = saved.thumbFilename ?? null;
        }
        body = body.replace(
          m[0],
          `![${alt || stripNotionIdSuffix(path.posix.basename(imgEntry.name, ext))}](${saved.mediaUrl})`
        );
      }

      // Clean Notion 32-hex IDs out of internal page markdown links (`[Page](Page%20<32hex>.md)` -> `[[Page]]`)
      body = body.replace(/\[([^\]]+)\]\(([^)\n]+?\.md)\)/gi, (_m, label: string) => {
        const cleanLabel = stripNotionIdSuffix(label);
        return `[[${cleanLabel}]]`;
      });

      // Clean Notion HTML callout/toggle wrappers (`<aside>`, `<details>`) outside fenced code blocks via real DOM
      if (/<(?:aside|details)\b/i.test(body)) {
        const fenced = body.split(/(```[\s\S]*?```)/g);
        body = fenced
          .map((seg, idx) => {
            if (idx % 2 === 1) return seg;
            return seg.replace(/<(aside|details)\b[^>]*>[\s\S]*?<\/\1>/gi, (blockHtml) => {
              const converted = htmlFragmentToCleanMarkdown(blockHtml, { mode: 'web' }).markdown;
              return converted ? `\n\n${converted}\n\n` : '';
            });
          })
          .join('')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const title = fm.title || deriveTitleFromMarkdown(body, cleanFileTitle, isEn ? 'en' : 'ru');
      const orbitId =
        fm.orbit || topFolderClean
          ? resolveOrCreateImportOrbit(deps.repo, orbitCache, fm.orbit || topFolderClean, orbitState)
          : '';

      const created = deps.repo.createItem({
        dna: 'note',
        orbit: orbitId,
        modeCaptured: 'autopilot',
        title,
        body: body.trim(),
        summary: '',
        url: fm.url ?? null,
        imagePath: coverFilename,
        thumbPath: coverThumb,
        tags: [...new Set(['notion', ...fm.tags])].slice(0, 6),
        source: 'markdown_import',
        externalId,
        contentHash,
        aiStatus: 'local',
        createdAt: fm.createdAt,
      });

      existingHashes.add(contentHash);
      deps.broadcastUpsert?.(created);
      importedCount += 1;
    } catch (err) {
      errors.push(`${ent.name}: ${err instanceof Error ? err.message : isEn ? 'import error' : 'ошибка импорта'}`);
    }
  }

  if (orbitState.created > 0) {
    deps.onOrbitsChanged?.();
  }

  return {
    importedCount,
    skippedCount,
    orbitsCreated: orbitState.created,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Exports all non-secret, non-deleted vault items as clean Markdown files with YAML frontmatter
 * grouped into folders by section name + an `assets/` folder with all cover and inline images
 * packaged into a single `.zip` via `src/main/utils/zip.ts`.
 */
export async function exportMarkdownZip(
  outputPath: string,
  deps: MarkdownIoDeps
): Promise<ExportResult> {
  try {
    const isEn = deps.repo.getLocale() === 'en';
    const items = deps.repo
      .queryItems({ includeArchived: true, includeSecrets: false, limit: 10_000 })
      .filter((it) => it.dna !== 'secret' && !it.deletedAt);

    const orbits = deps.repo.listOrbits();
    const orbitNameMap = new Map<string, string>();
    for (const o of orbits) {
      orbitNameMap.set(o.id, sanitizeExportSegment(o.name, isEn ? 'Section' : 'Раздел'));
    }

    const mediaDir = deps.pipeline.getMediaDir();
    const zipEntries: ZipInputEntry[] = [];
    const usedPaths = new Set<string>();
    const bundledAssets = new Set<string>();

    const attachMediaFile = (filename: string | null | undefined): string | null => {
      if (!filename) return null;
      const safe = path.basename(filename);
      if (!safe || safe === '.') return null;
      const abs = path.join(mediaDir, safe);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
      if (!bundledAssets.has(safe)) {
        bundledAssets.add(safe);
        zipEntries.push({
          name: `assets/${safe}`,
          data: fs.readFileSync(abs),
        });
      }
      return safe;
    };

    const noSecLabel = isEn ? 'No Section' : 'Без раздела';
    const untitledLabel = isEn ? 'Untitled' : 'Без названия';
    for (const item of items) {
      const folderName = item.orbit
        ? orbitNameMap.get(item.orbit) ?? sanitizeExportSegment(item.orbit, noSecLabel)
        : noSecLabel;

      const baseSlug = sanitizeExportSegment(item.title, `note-${item.id.slice(0, 8)}`);
      let candidatePath = `${folderName}/${baseSlug}.md`;
      let suffix = 2;
      while (usedPaths.has(candidatePath.toLowerCase())) {
        candidatePath = `${folderName}/${baseSlug}-${suffix}.md`;
        suffix += 1;
      }
      usedPaths.add(candidatePath.toLowerCase());

      // Bundle inline body images and rewrite `kapsula-media://local/<file>` -> `../assets/<file>`
      let exportedBody = (item.body || '').trim();
      const inlineFiles = extractInlineMediaFilenames(exportedBody);
      for (const fname of inlineFiles) {
        attachMediaFile(fname);
      }
      exportedBody = exportedBody.replace(
        /kapsula-media:\/\/local\/([^\s)"'<>]+)/gi,
        (_m, fname: string) => `../assets/${path.basename(fname)}`
      );

      // Bundle cover image and prepend it if not already present inline
      const coverSafe = attachMediaFile(item.imagePath);
      if (coverSafe && !exportedBody.includes(`assets/${coverSafe}`)) {
        const coverMd = `![${item.title.replace(/[[\]]/g, '')}](../assets/${coverSafe})`;
        exportedBody = exportedBody ? `${coverMd}\n\n${exportedBody}` : coverMd;
      }

      if (!exportedBody && item.summary) {
        exportedBody = item.summary;
      }
      if (item.url && !exportedBody.includes(item.url)) {
        exportedBody = exportedBody
          ? `${exportedBody}\n\n${isEn ? 'Source' : 'Источник'}: ${item.url}`
          : item.url;
      }

      const fmLines: string[] = [
        '---',
        `title: ${escapeYamlString(item.title || untitledLabel)}`,
        `id: ${item.id}`,
        `type: ${item.dna}`,
        `section: ${escapeYamlString(folderName)}`,
        `created: ${new Date(item.createdAt).toISOString()}`,
        `updated: ${new Date(item.updatedAt).toISOString()}`,
      ];
      if (item.url) fmLines.push(`url: ${escapeYamlString(item.url)}`);
      if (item.isPinned) fmLines.push('pinned: true');
      if (item.isArchived) fmLines.push('archived: true');
      if (item.tags.length > 0) {
        fmLines.push(`tags: [${item.tags.map((t) => escapeYamlString(t)).join(', ')}]`);
      }
      fmLines.push('---');

      const mdContent = `${fmLines.join('\n')}\n\n# ${item.title || untitledLabel}\n\n${exportedBody}\n`;
      zipEntries.push({
        name: candidatePath,
        data: Buffer.from(mdContent, 'utf8'),
      });
    }

    const zipBuf = createZipBuffer(zipEntries);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, zipBuf);

    return {
      ok: true,
      filePath: outputPath,
      count: items.length,
    };
  } catch (err) {
    const isEn = deps.repo.getLocale() === 'en';
    return {
      ok: false,
      error: err instanceof Error ? err.message : isEn ? 'Could not build Markdown archive.' : 'Не удалось создать архив Markdown.',
    };
  }
}

interface JsonBackupPayload {
  format?: string;
  orbits?: Array<{ id?: string; name?: string; description?: string; color?: string; icon?: string }>;
  boards?: Array<{ id?: string; name?: string; description?: string; color?: string; icon?: string }>;
  calendarEvents?: Array<{
    title?: string;
    notes?: string;
    location?: string;
    startAt?: number;
    endAt?: number;
    allDay?: boolean;
    color?: string;
    externalSource?: string | null;
    externalId?: string | null;
  }>;
  items?: Array<{
    id?: string;
    dna?: ContentDna;
    orbit?: string;
    focusBoardId?: string | null;
    title?: string;
    body?: string;
    summary?: string;
    url?: string | null;
    tags?: string[];
    isPinned?: boolean;
    isArchived?: boolean;
    remindAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    contentHash?: string;
  }>;
}

const VALID_IMPORT_DNA = new Set<ContentDna>(['link', 'shot', 'snippet', 'note', 'voice', 'doc']);

/**
 * Imports a Kapsula JSON backup safely:
 * - Restores missing sections, boards, and calendar events.
 * - Skips duplicates by `id` or `contentHash` and NEVER overwrites newer existing items.
 */
export async function importJsonBackup(
  filePath: string,
  deps: MarkdownIoDeps
): Promise<ImportResult> {
  const isEn = deps.repo.getLocale() === 'en';
  const errors: string[] = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      importedCount: 0,
      skippedCount: 0,
      orbitsCreated: 0,
      errors: [isEn ? 'Backup file not found.' : 'Файл резервной копии не найден.'],
    };
  }

  let parsed: JsonBackupPayload;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw) as unknown;
    if (Array.isArray(json)) {
      parsed = { items: json as JsonBackupPayload['items'] };
    } else if (json && typeof json === 'object') {
      parsed = json as JsonBackupPayload;
    } else {
      throw new Error(isEn ? 'Invalid JSON structure.' : 'Некорректная структура JSON.');
    }
  } catch (err) {
    return {
      importedCount: 0,
      skippedCount: 0,
      orbitsCreated: 0,
      errors: [err instanceof Error ? err.message : isEn ? 'Could not read backup file.' : 'Не удалось прочитать файл резервной копии.'],
    };
  }

  let orbitsCreated = 0;
  const orbitIdRemap = new Map<string, string>();
  const existingOrbits = deps.repo.listOrbits();

  for (const orb of parsed.orbits ?? []) {
    if (!orb?.name?.trim()) continue;
    const byId = orb.id ? existingOrbits.find((o) => o.id === orb.id) : undefined;
    if (byId) {
      if (orb.id) orbitIdRemap.set(orb.id, byId.id);
      continue;
    }
    const byName = existingOrbits.find(
      (o) => o.name.trim().toLowerCase() === orb.name!.trim().toLowerCase()
    );
    if (byName) {
      if (orb.id) orbitIdRemap.set(orb.id, byName.id);
      continue;
    }
    const created = deps.repo.createOrbit({
      name: orb.name.trim(),
      description: (orb.description || '').trim(),
      color: orb.color,
      icon: orb.icon,
    });
    existingOrbits.push(created);
    if (orb.id) orbitIdRemap.set(orb.id, created.id);
    orbitsCreated += 1;
  }

  const boardIdRemap = new Map<string, string>();
  const existingBoards = deps.repo.listFocusBoards();
  for (const b of parsed.boards ?? []) {
    if (!b?.name?.trim()) continue;
    const byId = b.id ? existingBoards.find((x) => x.id === b.id) : undefined;
    if (byId) {
      if (b.id) boardIdRemap.set(b.id, byId.id);
      continue;
    }
    const byName = existingBoards.find(
      (x) => x.name.trim().toLowerCase() === b.name!.trim().toLowerCase()
    );
    if (byName) {
      if (b.id) boardIdRemap.set(b.id, byName.id);
      continue;
    }
    const created = deps.repo.createFocusBoard(b.name.trim(), b.color, b.icon, b.description || '');
    existingBoards.push(created);
    if (b.id) boardIdRemap.set(b.id, created.id);
  }

  for (const ev of parsed.calendarEvents ?? []) {
    if (!ev?.title || typeof ev.startAt !== 'number' || typeof ev.endAt !== 'number') continue;
    try {
      const extId = ev.externalId || `backup:${ev.startAt}:${ev.title.slice(0, 32)}`;
      const exists = deps.repo.findCalendarEventByExternalId(ev.externalSource || 'backup', extId);
      if (!exists) {
        deps.repo.upsertCalendarEvent({
          title: ev.title,
          notes: ev.notes || '',
          location: ev.location || '',
          startAt: ev.startAt,
          endAt: ev.endAt,
          allDay: Boolean(ev.allDay),
          color: ev.color || '#E86A33',
          externalSource: ev.externalSource || 'backup',
          externalId: extId,
        });
      }
    } catch {
      // Non-fatal calendar event import error
    }
  }

  const existingItems = deps.repo.queryItems({
    includeArchived: true,
    includeDeleted: true,
    includeSecrets: true,
    limit: 20_000,
  });
  const existingById = new Map<string, VaultItem>(existingItems.map((it) => [it.id, it]));
  const existingHashes = new Set<string>(existingItems.map((it) => it.contentHash));

  let importedCount = 0;
  let skippedCount = 0;

  for (const rawItem of parsed.items ?? []) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    // Never import plaintext stubs marked as secret without encrypted payload
    if (rawItem.dna === 'secret') {
      skippedCount += 1;
      continue;
    }

    const dna: ContentDna =
      rawItem.dna && VALID_IMPORT_DNA.has(rawItem.dna) ? rawItem.dna : 'note';
    const title = (rawItem.title || (isEn ? 'Untitled' : 'Без названия')).trim();
    const body = typeof rawItem.body === 'string' ? rawItem.body : '';
    const summary = typeof rawItem.summary === 'string' ? rawItem.summary : '';
    const url = typeof rawItem.url === 'string' ? rawItem.url : null;
    const computedHash =
      rawItem.contentHash ||
      crypto.createHash('sha256').update(`${title}|${body}|${url ?? ''}`).digest('hex');

    const incomingId = typeof rawItem.id === 'string' && rawItem.id.trim() ? rawItem.id.trim() : undefined;
    const existingByIdMatch = incomingId
      ? (existingById.get(incomingId) ??
        deps.repo.getItemById(incomingId, { includeDeleted: true, includePurged: true }) ??
        undefined)
      : undefined;

    if (existingByIdMatch) {
      // Never allow JSON backup to overwrite an existing Vault secret (even via forged non-secret dna)
      if (existingByIdMatch.dna === 'secret') {
        skippedCount += 1;
        continue;
      }
      // Never overwrite existing item (especially never overwrite newer items)
      const incomingUpdated = typeof rawItem.updatedAt === 'number' ? rawItem.updatedAt : 0;
      if (
        existingByIdMatch.updatedAt >= incomingUpdated ||
        existingByIdMatch.deletedAt != null ||
        existingByIdMatch.purgedAt != null
      ) {
        skippedCount += 1;
        continue;
      }
      // Existing item is strictly older -> update safely without duplicating
      const mappedOrbit = rawItem.orbit ? orbitIdRemap.get(rawItem.orbit) ?? rawItem.orbit : '';
      const mappedBoard = rawItem.focusBoardId
        ? boardIdRemap.get(rawItem.focusBoardId) ?? null
        : null;
      const updated = deps.repo.updateItem(existingByIdMatch.id, {
        orbit: mappedOrbit,
        focusBoardId: mappedBoard,
        title,
        body,
        summary,
        url,
        tags: Array.isArray(rawItem.tags) ? rawItem.tags : existingByIdMatch.tags,
        isPinned: Boolean(rawItem.isPinned),
        isArchived: Boolean(rawItem.isArchived),
        remindAt: typeof rawItem.remindAt === 'number' ? rawItem.remindAt : null,
      });
      if (updated) {
        existingById.set(updated.id, updated);
        deps.broadcastUpsert?.(updated);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
      continue;
    }

    if (existingHashes.has(computedHash)) {
      skippedCount += 1;
      continue;
    }

    try {
      const mappedOrbit = rawItem.orbit ? orbitIdRemap.get(rawItem.orbit) ?? '' : '';
      const mappedBoard = rawItem.focusBoardId
        ? boardIdRemap.get(rawItem.focusBoardId) ?? null
        : null;
      const created = deps.repo.createItem({
        id: incomingId,
        dna,
        orbit: mappedOrbit,
        modeCaptured: 'autopilot',
        focusBoardId: mappedBoard,
        title,
        body,
        summary,
        url,
        tags: Array.isArray(rawItem.tags)
          ? rawItem.tags.filter((t): t is string => typeof t === 'string').slice(0, 6)
          : [],
        source: 'archive_import',
        contentHash: computedHash,
        aiStatus: 'local',
        isPinned: Boolean(rawItem.isPinned),
        remindAt: typeof rawItem.remindAt === 'number' ? rawItem.remindAt : null,
        createdAt: typeof rawItem.createdAt === 'number' ? rawItem.createdAt : undefined,
      });

      let finalItem = created;
      if (rawItem.isArchived) {
        finalItem = deps.repo.updateItem(created.id, { isArchived: true }) ?? created;
      }

      existingById.set(finalItem.id, finalItem);
      existingHashes.add(computedHash);
      deps.broadcastUpsert?.(finalItem);
      importedCount += 1;
    } catch (err) {
      errors.push(`${title}: ${err instanceof Error ? err.message : isEn ? 'restore error' : 'ошибка восстановления'}`);
    }
  }

  if (orbitsCreated > 0) {
    deps.onOrbitsChanged?.();
  }

  return {
    importedCount,
    skippedCount,
    orbitsCreated,
    errors: errors.length > 0 ? errors : undefined,
  };
}
