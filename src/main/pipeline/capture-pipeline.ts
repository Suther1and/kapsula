import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiProvider,
  AppLocale,
  CaptureInput,
  CaptureMode,
  ContentDna,
  ExtractedAction,
  MediaMeta,
  OrbitDef,
  SaveNoteImageResult,
  TranscribeItemResult,
  VaultItem,
} from '@shared/types';
import { DEFAULT_MONTHLY_CAP_USD } from '@shared/constants';
import { parseRussianEvent } from '@shared/russian-event-parser';
import type { CloudAiProxyConfig } from '../ai/cloud-proxy';
import type { FetchLike } from '../ai/decision-router';
import { analyzeImageWithVision, runAiPipeline, type ParsedAiCalendarEvent } from '../ai/enricher';
import {
  classifyLocally,
  detectContactInfo,
  isGenericImageTitle,
  pickCleanScreenshotTitle,
} from '../ai/local-heuristic';
import type { VaultRepository } from '../db/repository';
import { extractActionsFromText } from '../ocr/ocr-service';
import { defaultLocalOcrAdapter } from '../platform/platform-adapters';
import { analyzeForSecret } from '../security/secret-shield';
import type { VaultCrypto } from '../security/vault-crypto';
import {
  formatDurationCompact,
  processAudioIntelligence,
  saveAudioAsset,
  transcribeAudioFile,
} from './audio-pipeline';
import { processDocumentIntelligence, saveDocumentAsset } from './document-pipeline';
import { formatEmailAsNoteMarkdown, parseEmlBuffer } from './email-parser';
import { generateThumbnailAndAnalyze } from './thumbnail-service';
import { normalizeMetaText, sanitizeIngestedText } from './html-cleaner';
import { classifyPrivateTelegramUrl, downloadOgImage, sanitizeSafeExternalUrl, unfurlUrl } from './unfurler';
import { VideoCacheManager } from './video-cache';
import {
  detectSocialVideoPlatform,
  extractYouTubeVideoId,
  resolveAndCacheSocialVideo,
} from './video-extractor';

type MediaMetaWithTranscriptError = MediaMeta & { transcriptError?: string };

const GENERIC_VOICE_TITLE_RE =
  /^(?:голосов(?:ая|ое)\s+(?:заметка|сообщение)|аудиозапись|аудио|voice\s*(?:memo|note)|audio(?:\s+recording)?)(?:\s*(?:·|\()\s*\d+:\d{2}\)?)?$/i;

const MAX_NOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export function detectImageExtFromMagic(buf: Buffer): '.png' | '.jpg' | '.webp' | '.gif' | '.bmp' | null {
  if (!buf || buf.length < 2) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return '.png';
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return '.jpg';
  }
  // GIF: GIF87a / GIF89a
  if (buf.length >= 6) {
    const hdr6 = buf.subarray(0, 6).toString('ascii');
    if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') return '.gif';
  }
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return '.bmp';
  }
  return null;
}

function isContainedTarget(rootPath: string, targetPath: string): boolean {
  const normRoot = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  const normTarget = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const rel = path.relative(normRoot, normTarget);
  return !(
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith('../') ||
    path.isAbsolute(rel)
  );
}

/**
 * Resolves a requested `kapsula-media://` asset name strictly inside `mediaDir`
 * using `fs.realpathSync` so neither `..` traversal nor symlinks inside `mediaDir` can escape.
 */
export function resolveSafeMediaFilePath(
  mediaDir: string,
  rawPart: string
):
  | { ok: true; safeName: string; filePath: string; stat: fs.Stats }
  | { ok: false; status: 400 | 403 | 404 } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPart);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes('\0')) {
    return { ok: false, status: 400 };
  }
  const safeName = path.basename(decoded);
  if (!safeName || safeName === '.' || safeName === '..') {
    return { ok: false, status: 404 };
  }
  if (safeName.includes(':') || safeName.includes('\0')) {
    return { ok: false, status: 400 };
  }
  const candidate = path.join(mediaDir, safeName);
  let realMediaDir: string;
  let realTarget: string;
  try {
    realMediaDir = fs.realpathSync(mediaDir);
    realTarget = fs.realpathSync(candidate);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!isContainedTarget(realMediaDir, realTarget)) {
    return { ok: false, status: 403 };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404 };
  }
  return { ok: true, safeName, filePath: realTarget, stat };
}

/**
 * Async non-blocking variant of `resolveSafeMediaFilePath` for `kapsula-media://` requests.
 * Reuses a pre-resolved `cachedRealMediaDir` so only the target file is resolved/statted via `fs.promises`.
 */
export async function resolveSafeMediaFilePathAsync(
  mediaDir: string,
  rawPart: string,
  cachedRealMediaDir?: string
): Promise<
  | { ok: true; safeName: string; filePath: string; stat: fs.Stats }
  | { ok: false; status: 400 | 403 | 404 }
> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPart);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes('\0')) {
    return { ok: false, status: 400 };
  }
  const safeName = path.basename(decoded);
  if (!safeName || safeName === '.' || safeName === '..') {
    return { ok: false, status: 404 };
  }
  if (safeName.includes(':') || safeName.includes('\0')) {
    return { ok: false, status: 400 };
  }
  const candidate = path.join(mediaDir, safeName);
  let realMediaDir: string;
  let realTarget: string;
  try {
    realMediaDir = cachedRealMediaDir || (await fs.promises.realpath(mediaDir));
    realTarget = await fs.promises.realpath(candidate);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!isContainedTarget(realMediaDir, realTarget)) {
    // Handles Windows 8.3 short-path callers passed via cachedRealMediaDir
    // while keeping symlink containment strict against fs.promises.realpath(mediaDir).
    if (cachedRealMediaDir) {
      try {
        const freshRoot = await fs.promises.realpath(mediaDir);
        if (!isContainedTarget(freshRoot, realTarget)) {
          return { ok: false, status: 403 };
        }
      } catch {
        return { ok: false, status: 404 };
      }
    } else {
      return { ok: false, status: 403 };
    }
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realTarget);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404 };
  }
  return { ok: true, safeName, filePath: realTarget, stat };
}

export function isGenericVoiceTitle(raw?: string | null): boolean {
  const t = (raw ?? '').trim();
  return !t || GENERIC_VOICE_TITLE_RE.test(t);
}

const BARE_LINK_TITLE_RE =
  /^(?:ссылка(?:\s+из\s+другого\s+приложения)?|сохранённая\s+ссылка|link|saved\s+link|shared\s+link|x|twitter|telegram|instagram|youtube|github|reddit|tiktok|t\.me|x\.com|twitter\.com|instagram\.com|youtube\.com|youtu\.be)$/i;

export function isLinkStubTitle(
  rawTitle?: string | null,
  domain?: string | null,
  url?: string | null,
  platform?: string | null
): boolean {
  const t = (rawTitle ?? '').trim();
  if (!t) return true;
  if (isGenericImageTitle(t) || BARE_LINK_TITLE_RE.test(t)) return true;
  const lower = t.toLowerCase();
  const normDomain = domain ? domain.trim().replace(/^www\./i, '').toLowerCase() : null;
  const normPlatform = platform ? platform.trim().toLowerCase() : null;
  if (normDomain && lower === normDomain) return true;
  if (normPlatform && lower === normPlatform) return true;

  let cleanUrlLower: string | null = null;
  let hostLower: string | null = null;
  let fullHostLower: string | null = null;
  if (url) {
    const cleanUrl = url.trim();
    cleanUrlLower = cleanUrl.toLowerCase();
    if (lower === cleanUrlLower) return true;
    try {
      const u = new URL(cleanUrl);
      fullHostLower = u.hostname.toLowerCase();
      hostLower = fullHostLower.replace(/^www\./i, '');
      if (lower === hostLower || lower === fullHostLower) return true;
    } catch {
      // ignore invalid URL
    }
  }

  // Only treat "Ссылка: <host/url>" / "Link — <host/url>" as a stub when the suffix matches the link's own host/domain/URL
  const prefixed = /^(?:ссылка|link)\s*[:—–-]\s*(.+)$/i.exec(t);
  if (prefixed?.[1]) {
    const suffix = prefixed[1].trim().replace(/^www\./i, '').toLowerCase();
    if (
      (normDomain && suffix === normDomain) ||
      (normPlatform && suffix === normPlatform) ||
      (cleanUrlLower && suffix === cleanUrlLower) ||
      (hostLower && suffix === hostLower) ||
      (fullHostLower && suffix === fullHostLower)
    ) {
      return true;
    }
  }
  return false;
}

export function isLinkStubBody(rawBody?: string | null, url?: string | null): boolean {
  const b = (rawBody ?? '').trim();
  if (!b) return true;
  if (!url) return false;
  const cleanUrl = url.trim();
  if (b === cleanUrl) return true;
  const withoutUrl = b.replace(cleanUrl, '').trim();
  return withoutUrl.length === 0;
}

function isLinkStubSummary(rawSummary?: string | null, url?: string | null, domain?: string | null): boolean {
  const s = (rawSummary ?? '').trim();
  if (!s) return true;
  if (url && s === url.trim()) return true;
  if (domain && s.toLowerCase() === domain.trim().toLowerCase()) return true;
  if (s.startsWith('Сохранённая ссылка') || s.startsWith('Saved link')) return true;
  return false;
}

/**
 * Identifies genuine un-unfurled link stubs (e.g. shared from Android Share Target before desktop sync)
 * that are safe to enrich automatically without touching user-authored notes/titles or private links.
 */
export function isStubLinkItem(item: VaultItem): boolean {
  if (!item || item.dna !== 'link' || !item.url) return false;
  if (item.deletedAt || item.isArchived || item.isDemo) return false;
  if (item.mediaMeta?.linkAccess === 'private') return false;
  if (item.imagePath || item.thumbPath) return false;
  return (
    isLinkStubTitle(item.title, item.domain, item.url, item.platform) &&
    isLinkStubBody(item.body, item.url)
  );
}

/**
 * Identifies already-enriched synced link items (e.g. unfurled on Android with a remote `ogImageUrl`)
 * that still need Desktop's local cached cover (`imagePath`/`thumbPath`) downloaded without altering text/AI.
 */
export function needsLocalOgDownload(item: VaultItem): boolean {
  if (!item || item.dna !== 'link') return false;
  if (item.deletedAt || item.isArchived || item.isDemo) return false;
  if (item.mediaMeta?.linkAccess === 'private') return false;
  return Boolean(item.ogImageUrl && !item.imagePath && !item.thumbPath);
}

export interface PipelineRuntimeConfig {
  activeMode: CaptureMode;
  activeFocusBoardId: string | null;
  aiProvider: AiProvider;
  apiKey: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  cloudProxy?: CloudAiProxyConfig | null;
  monthlyCapUsd: number;
  enableAutoOcr: boolean;
  enableUrlUnfurl: boolean;
}

export type SamplePaletteFn = (imageAbsPath: string) => Promise<string[]> | string[];
export type PrepareVisionImageFn = (
  imageAbsPath: string
) => Promise<{ base64: string; mimeType: string } | null> | { base64: string; mimeType: string } | null;

export class CapturePipeline {
  private readonly mediaDir: string;
  private readonly videoCache: VideoCacheManager;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly syncedEnrichAttempts = new Map<string, number>();
  private readonly syncedEnrichActive = new Set<string>();
  private activeBgWorkers = 0;
  private readonly bgWaitQueue: Array<() => void> = [];
  private readonly maxBgConcurrency = 3;

  constructor(
    private readonly deps: {
      repo: VaultRepository;
      cryptoVault: VaultCrypto;
      dataDir: string;
      videoCache?: VideoCacheManager;
      getConfig: () => PipelineRuntimeConfig;
      samplePalette?: SamplePaletteFn;
      prepareVisionImage?: PrepareVisionImageFn;
      onItemUpserted?: (item: VaultItem) => void;
      onItemDeleted?: (itemId: string) => void;
      onSecurityNotice?: (notice: { title: string; body: string }) => void;
      onOrbitsChanged?: () => void;
      onReminderChanged?: () => void;
      onCalendarChanged?: () => void;
      fetchFn?: FetchLike;
    }
  ) {
    this.mediaDir = path.join(deps.dataDir, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    this.videoCache =
      deps.videoCache ?? new VideoCacheManager(path.join(deps.dataDir, 'video-cache'));
  }

  public getVideoCache(): VideoCacheManager {
    return this.videoCache;
  }

  public async ensureLinkVideo(itemId: string): Promise<VaultItem | null> {
    const current = this.deps.repo.getItemById(itemId);
    if (!current || !current.url || current.dna !== 'link') return current ?? null;
    if (
      current.mediaMeta?.linkAccess === 'private' ||
      Boolean(classifyPrivateTelegramUrl(current.url, 'ru'))
    ) {
      return current;
    }
    if (current.mediaMeta?.cachedVideoFile) {
      const check = await this.videoCache.resolveSafePathAsync(current.mediaMeta.cachedVideoFile);
      if (check.ok) {
        await this.videoCache.touchAsync(current.mediaMeta.cachedVideoFile);
        return current;
      }
    }
    const res = await resolveAndCacheSocialVideo({
      url: current.url,
      stem: current.contentHash.slice(0, 20),
      knownVideoUrl: current.mediaMeta?.videoUrl ?? null,
      videoCache: this.videoCache,
      enableBrowserFallback: true,
    });
    const nextMeta: MediaMeta = {
      ...(current.mediaMeta ?? {}),
      ...(res.cachedVideoFile ? { cachedVideoFile: res.cachedVideoFile } : {}),
      ...(res.youtubeVideoId ? { youtubeVideoId: res.youtubeVideoId } : {}),
      ...(res.videoUrl ? { videoUrl: res.videoUrl } : {}),
      videoExtractStatus: res.status,
    };
    const updated = this.deps.repo.updateItem(itemId, {
      mediaMeta: nextMeta,
      mediaDurationSec: res.durationSec ?? current.mediaDurationSec,
    });
    if (updated) this.deps.onItemUpserted?.(updated);
    return updated;
  }

  public getMediaDir(): string {
    return this.mediaDir;
  }

  public listOrbits(): OrbitDef[] {
    return this.deps.repo.listOrbits();
  }

  /**
   * Stores an image asset inside `media/` (+ optional thumbnail) WITHOUT creating a separate vault item.
   * Used for inline note photos (`![alt](kapsula-media://local/<filename>)`) and imported media.
   */
  public async saveNoteImageAsset(input: {
    base64?: string;
    bytes?: Uint8Array;
    filePath?: string;
    mimeType?: string;
    fileName?: string;
    generateThumb?: boolean;
  }): Promise<SaveNoteImageResult> {
    let buf: Buffer | null = null;
    let ext = '.png';

    const hintMime = (input.mimeType || '').toLowerCase();
    if (hintMime.includes('jpeg') || hintMime.includes('jpg')) ext = '.jpg';
    else if (hintMime.includes('webp')) ext = '.webp';
    else if (hintMime.includes('gif')) ext = '.gif';
    else if (hintMime.includes('bmp')) ext = '.bmp';

    const isEn = this.deps.repo.getLocale() === 'en';
    if (input.bytes && input.bytes.byteLength > 0) {
      if (input.bytes.byteLength > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Image is too large (max 25 MB)' : 'Изображение слишком большое (максимум 25 МБ)'
        );
      }
      buf = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    } else if (input.base64) {
      const dataUrlMatch = /^data:image\/([a-z0-9+.-]+);base64,/i.exec(input.base64);
      if (dataUrlMatch?.[1]) {
        const sub = dataUrlMatch[1].toLowerCase();
        if (sub === 'jpeg' || sub === 'jpg') ext = '.jpg';
        else if (sub === 'webp') ext = '.webp';
        else if (sub === 'gif') ext = '.gif';
        else if (sub === 'bmp') ext = '.bmp';
        else if (sub === 'png') ext = '.png';
      }
      const cleaned = input.base64.replace(/^data:image\/[^;]+;base64,/i, '').trim();
      const approxMaxBase64Chars = Math.ceil((MAX_NOTE_IMAGE_BYTES * 4) / 3) + 64;
      if (cleaned.length > approxMaxBase64Chars) {
        throw new Error(
          isEn ? 'Image is too large (max 25 MB)' : 'Изображение слишком большое (максимум 25 МБ)'
        );
      }
      buf = Buffer.from(cleaned, 'base64');
      if (buf.length > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Image is too large (max 25 MB)' : 'Изображение слишком большое (максимум 25 МБ)'
        );
      }
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      const stat = fs.statSync(input.filePath);
      if (!stat.isFile()) {
        throw new Error(isEn ? 'Image is empty or not found' : 'Изображение пустое или не найдено');
      }
      if (stat.size > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Image is too large (max 25 MB)' : 'Изображение слишком большое (максимум 25 МБ)'
        );
      }
      const parsedExt = path.extname(input.filePath).toLowerCase();
      if (parsedExt && !ALLOWED_IMAGE_EXTS.has(parsedExt)) {
        throw new Error(isEn ? 'Unsupported image format' : 'Неподдерживаемый формат изображения');
      }
      buf = fs.readFileSync(input.filePath);
      if (ALLOWED_IMAGE_EXTS.has(parsedExt)) {
        ext = parsedExt === '.jpeg' ? '.jpg' : parsedExt;
      }
    }

    if (input.fileName && ext === '.png' && !hintMime) {
      const nameExt = path.extname(input.fileName).toLowerCase();
      if (ALLOWED_IMAGE_EXTS.has(nameExt)) {
        ext = nameExt === '.jpeg' ? '.jpg' : nameExt;
      }
    }

    if (!buf || buf.length === 0) {
      throw new Error(isEn ? 'Image is empty or not found' : 'Изображение пустое или не найдено');
    }

    const magicExt = detectImageExtFromMagic(buf);
    if (!magicExt) {
      throw new Error(
        isEn ? 'File is not a supported image' : 'Файл не является поддерживаемым изображением'
      );
    }
    ext = magicExt;

    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const stem = sha.slice(0, 24);
    const filename = `${stem}${ext}`;
    const absPath = path.join(this.mediaDir, filename);
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf, { mode: 0o600 });
    }

    let thumbFilename: string | undefined;
    if (input.generateThumb) {
      try {
        const thumbRes = generateThumbnailAndAnalyze(buf, this.mediaDir, stem);
        if (thumbRes.thumbPath) {
          thumbFilename = thumbRes.thumbPath;
        }
      } catch {
        // Optional thumbnail — never block inline image insertion
      }
    }

    return {
      filename,
      mediaUrl: `kapsula-media://local/${filename}`,
      thumbFilename,
    };
  }

  public cleanupUnreferencedMedia(filenames: Array<string | null | undefined>): void {
    const unlinkIfUnreferenced = (candidate: string) => {
      if (this.deps.repo.countItemsByMediaRef(candidate) === 0) {
        const abs = path.join(this.mediaDir, candidate);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          fs.unlinkSync(abs);
        }
      }
    };

    for (const raw of filenames) {
      if (!raw) continue;
      const safe = path.basename(raw);
      if (!safe || safe === '.') continue;
      try {
        unlinkIfUnreferenced(safe);
        if (!safe.startsWith('thumb_')) {
          const stem = path.basename(safe, path.extname(safe));
          if (stem) {
            unlinkIfUnreferenced(`thumb_${stem}.jpg`);
            unlinkIfUnreferenced(`thumb_${stem}.png`);
          }
        }
      } catch {
        // Non-fatal cleanup error
      }
    }
  }

  private async runWithBgSlot(fn: () => Promise<void>): Promise<void> {
    if (this.activeBgWorkers >= this.maxBgConcurrency) {
      await new Promise<void>((resolve) => this.bgWaitQueue.push(resolve));
    }
    this.activeBgWorkers++;
    try {
      await fn();
    } finally {
      this.activeBgWorkers--;
      const next = this.bgWaitQueue.shift();
      next?.();
    }
  }

  public async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private resolveSecretOrbitId(_kind: string, explicitOrbit: string | null): string {
    // Keep secrets cleanly inside protected Сейф unless the user explicitly picked a section
    return explicitOrbit ?? '';
  }

  private resolveOrCreateOrbit(
    mode: CaptureMode,
    chosenOrbit: string,
    suggestedNewSection: string | null | undefined
  ): string {
    if (chosenOrbit) return chosenOrbit;
    if (mode !== 'autopilot' || !suggestedNewSection) return '';
    const beforeCount = this.deps.repo.listOrbits().length;
    const created = this.deps.repo.ensureOrganicOrbit(suggestedNewSection);
    if (created && this.deps.repo.listOrbits().length > beforeCount) {
      this.deps.onOrbitsChanged?.();
    }
    return created?.id ?? '';
  }

  private async storeImageAsset(input: CaptureInput): Promise<{
    filename: string | null;
    absPath: string | null;
    sha: string;
    buffer: Buffer | null;
  }> {
    let buf: Buffer | null = null;

    if (input.imageBytes && input.imageBytes.byteLength > 0) {
      if (input.imageBytes.byteLength <= MAX_NOTE_IMAGE_BYTES) {
        buf = Buffer.from(
          input.imageBytes.buffer,
          input.imageBytes.byteOffset,
          input.imageBytes.byteLength
        );
      }
    } else if (input.imageBase64) {
      const cleaned = input.imageBase64.replace(/^data:image\/[^;]+;base64,/i, '').trim();
      if (cleaned && cleaned.length <= Math.ceil(MAX_NOTE_IMAGE_BYTES * 1.4)) {
        const decoded = Buffer.from(cleaned, 'base64');
        if (decoded.length > 0 && decoded.length <= MAX_NOTE_IMAGE_BYTES) {
          buf = decoded;
        }
      }
    } else if (input.imageFilePath && fs.existsSync(input.imageFilePath)) {
      try {
        const st = fs.statSync(input.imageFilePath);
        if (st.isFile() && st.size > 0 && st.size <= MAX_NOTE_IMAGE_BYTES) {
          buf = fs.readFileSync(input.imageFilePath);
        }
      } catch {
        buf = null;
      }
    }

    if (!buf || buf.length === 0 || buf.length > MAX_NOTE_IMAGE_BYTES) {
      return { filename: null, absPath: null, sha: '', buffer: null };
    }

    const magicExt = detectImageExtFromMagic(buf);
    if (!magicExt) {
      return { filename: null, absPath: null, sha: '', buffer: null };
    }

    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const filename = `${sha.slice(0, 24)}${magicExt}`;
    const absPath = path.join(this.mediaDir, filename);
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf, { mode: 0o600 });
    }
    return { filename, absPath, sha, buffer: buf };
  }

  private async captureAudioInternal(input: CaptureInput): Promise<VaultItem> {
    const config = this.deps.getConfig();
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    if (input.externalId) {
      const existing = this.deps.repo.findBySourceExternalId(source, input.externalId);
      if (existing) return existing;
    }

    let buf: Buffer;
    if (input.audioBytes && input.audioBytes.byteLength > 0) {
      if (input.audioBytes.byteLength > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Audio file is too large (max 25 MB)' : 'Аудиофайл слишком большой (максимум 25 МБ)'
        );
      }
      buf = Buffer.from(input.audioBytes.buffer, input.audioBytes.byteOffset, input.audioBytes.byteLength);
    } else if (input.audioBase64) {
      const cleaned = input.audioBase64.replace(/^data:audio\/[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error(isEn ? 'Audio data not found' : 'Аудиоданные не найдены');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const saved = saveAudioAsset(this.mediaDir, sha.slice(0, 24), buf, input.audioMime);
    const durLabel =
      input.audioDurationSec && input.audioDurationSec > 0
        ? formatDurationCompact(input.audioDurationSec)
        : null;
    const caption = (input.text ?? '').trim();
    const hasExplicitTitle = Boolean(input.title?.trim());
    const baseVoiceTitle = isEn ? 'Voice note' : 'Голосовая заметка';
    const initialTitle =
      input.title?.trim() ||
      (durLabel ? `${baseVoiceTitle} · ${durLabel}` : baseVoiceTitle);

    const orbits = this.deps.repo.listOrbits();
    const explicitOrbit =
      input.orbitOverride && orbits.some((o) => o.id === input.orbitOverride)
        ? input.orbitOverride
        : null;
    const focusBoardId =
      input.focusBoardId !== undefined
        ? input.focusBoardId
        : mode === 'focus'
          ? config.activeFocusBoardId
          : null;

    const skipAudioAi = Boolean(input.skipAudioAi);
    const hasInitialTranscript = Boolean(input.mediaMeta?.transcript?.trim());

    const created = this.deps.repo.createItem({
      dna: 'voice',
      subKind: input.subKind ?? null,
      orbit: explicitOrbit ?? '',
      modeCaptured: mode,
      focusBoardId,
      title: initialTitle,
      body: caption,
      summary: caption
        ? caption.slice(0, 200)
        : skipAudioAi
          ? durLabel
            ? `${baseVoiceTitle} · ${durLabel}`
            : isEn
              ? 'Voice note saved.'
              : 'Голосовая заметка сохранена.'
          : durLabel
            ? isEn
              ? `Duration ${durLabel}. Transcribing…`
              : `Длительность ${durLabel}. Расшифровка готовится…`
            : isEn
              ? 'Voice note saved.'
              : 'Голосовая заметка сохранена.',
      mediaPath: saved.filename,
      mediaType: saved.mime,
      mediaDurationSec: input.audioDurationSec ?? null,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: input.fileName,
        fileSize: saved.byteLength,
      },
      extractedActions: extractActionsFromText(caption, locale),
      tags: [...new Set([isEn ? 'voice' : 'голос', ...(input.tags ?? [])])].slice(0, 4),
      source,
      externalId: input.externalId ?? null,
      contentHash: sha,
      aiStatus: skipAudioAi
        ? hasInitialTranscript
          ? 'enriched'
          : mode === 'buffer'
            ? 'raw_buffer'
            : 'local'
        : mode === 'buffer'
          ? 'raw_buffer'
          : 'pending',
      remindAt: input.remindAt ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.createdAt,
    });

    if (created.remindAt) this.deps.onReminderChanged?.();
    this.deps.onItemUpserted?.(created);

    if (!input.isDemo && !skipAudioAi) {
      const task = this.runWithBgSlot(async () => {
        const cfg = this.deps.getConfig();
        const budget = this.deps.repo.getMonthBudgetSummary(
          cfg.aiProvider,
          cfg.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
          true
        );
        const googleKey =
          cfg.googleAiKey ?? (cfg.aiProvider === 'google_ai_studio' ? cfg.apiKey : null);
        const openRouterKey =
          cfg.openRouterKey ?? (cfg.aiProvider === 'openrouter' ? cfg.apiKey : null);

        const aiAudio = await processAudioIntelligence({
          buffer: buf,
          mime: saved.mime,
          fileName: input.fileName,
          durationSec: input.audioDurationSec,
          contextHint: caption,
          aiProvider: cfg.aiProvider,
          googleAiKey: googleKey,
          openRouterKey,
          cloudProxy: cfg.cloudProxy,
          budgetReached: budget.limitReached,
          locale: this.deps.repo.getLocale(),
          onSpendUsd: (usd, isCloudProxy) => {
            if (usd > 0) {
              this.deps.repo.logAiUsage(
                cfg.aiProvider,
                'audio-intelligence',
                600,
                180,
                usd,
                Boolean(isCloudProxy)
              );
            }
          },
          fetchFn: this.deps.fetchFn,
        });

        const latest = this.deps.repo.getItemById(created.id);
        if (!latest) return;

        const targetOrbit = explicitOrbit
          ? explicitOrbit
          : mode === 'autopilot' && latest.orbit === created.orbit
            ? this.resolveOrCreateOrbit(mode, '', aiAudio.suggestedSection)
            : latest.orbit;

        const nextMeta: MediaMetaWithTranscriptError = {
          ...(latest.mediaMeta ?? {}),
          transcript: aiAudio.transcript || latest.mediaMeta?.transcript,
          keyPoints: aiAudio.keyPoints,
          actionItems: aiAudio.actionItems,
        };
        if (aiAudio.usedCloud) {
          delete nextMeta.transcriptError;
        } else if (aiAudio.transcriptError) {
          nextMeta.transcriptError = aiAudio.transcriptError;
        }

        const shouldFillBody =
          aiAudio.usedCloud &&
          Boolean(aiAudio.transcript.trim()) &&
          latest.body.trim().length === 0;
        const shouldUpdateTitle =
          !hasExplicitTitle &&
          (latest.title === initialTitle || isGenericVoiceTitle(latest.title)) &&
          Boolean(aiAudio.title?.trim());

        const updated = this.deps.repo.updateItem(created.id, {
          orbit: targetOrbit,
          title: shouldUpdateTitle ? aiAudio.title : latest.title,
          body: shouldFillBody ? aiAudio.transcript.trim() : undefined,
          summary: aiAudio.summary,
          mediaMeta: nextMeta as MediaMeta,
          extractedActions: aiAudio.extractedActions,
          tags: [...new Set([...aiAudio.tags, ...latest.tags])].slice(0, 4),
          aiStatus: aiAudio.usedCloud ? 'enriched' : mode === 'buffer' ? 'raw_buffer' : 'local',
        });
        if (updated) {
          this.deps.onItemUpserted?.(updated);
          if (!input.skipAutoCalendar) {
            const voiceEv = parseRussianEvent(aiAudio.transcript || caption);
            if (voiceEv?.isEventIntent) {
              this.syncAutoCalendarEvent(updated, voiceEv);
            }
          }
        }
      })
        .catch(() => {})
        .finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }

    return created;
  }

  private async captureDocumentInternal(input: CaptureInput): Promise<VaultItem> {
    const config = this.deps.getConfig();
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    if (input.externalId) {
      const existing = this.deps.repo.findBySourceExternalId(source, input.externalId);
      if (existing) return existing;
    }

    let buf: Buffer;
    const fileName =
      input.fileName ||
      (input.filePath ? path.basename(input.filePath) : 'document.txt');

    if (input.fileBytes && input.fileBytes.byteLength > 0) {
      if (input.fileBytes.byteLength > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Document is too large (max 25 MB)' : 'Документ слишком большой (максимум 25 МБ)'
        );
      }
      buf = Buffer.from(input.fileBytes.buffer, input.fileBytes.byteOffset, input.fileBytes.byteLength);
    } else if (input.fileBase64) {
      const cleaned = input.fileBase64.replace(/^data:[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error(isEn ? 'Document file not found' : 'Файл документа не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const saved = saveDocumentAsset(this.mediaDir, sha.slice(0, 24), buf, fileName, input.fileMime);
    const hasExplicitTitle = Boolean(input.title?.trim());
    const rawFileTitle =
      input.title?.trim() ||
      saved.safeOriginalName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
      (isEn ? 'Document' : 'Документ');
    const cleanFileTitle = hasExplicitTitle
      ? rawFileTitle
      : rawFileTitle.charAt(0).toUpperCase() + rawFileTitle.slice(1);

    const orbits = this.deps.repo.listOrbits();
    const explicitOrbit =
      input.orbitOverride && orbits.some((o) => o.id === input.orbitOverride)
        ? input.orbitOverride
        : null;
    const focusBoardId =
      input.focusBoardId !== undefined
        ? input.focusBoardId
        : mode === 'focus'
          ? config.activeFocusBoardId
          : null;

    const created = this.deps.repo.createItem({
      dna: 'doc',
      subKind: input.subKind ?? null,
      orbit: explicitOrbit ?? '',
      modeCaptured: mode,
      focusBoardId,
      title: cleanFileTitle,
      body: (input.text ?? '').trim(),
      summary: isEn
        ? `${saved.ext.toUpperCase()} file saved — extracting text and key points…`
        : `Файл ${saved.ext.toUpperCase()} сохранён — извлекаем текст и тезисы…`,
      mediaPath: saved.storedFileName,
      mediaType: saved.mime,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: saved.safeOriginalName,
        fileSize: saved.byteLength,
      },
      tags: [...new Set([saved.ext, isEn ? 'file' : 'файл', ...(input.tags ?? [])])].slice(0, 4),
      source,
      externalId: input.externalId ?? null,
      contentHash: sha,
      aiStatus: mode === 'buffer' ? 'raw_buffer' : 'pending',
      remindAt: input.remindAt ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.createdAt,
    });

    if (created.remindAt) this.deps.onReminderChanged?.();
    this.deps.onItemUpserted?.(created);

    if (!input.isDemo) {
      const task = this.runWithBgSlot(async () => {
        const cfg = this.deps.getConfig();
        const budget = this.deps.repo.getMonthBudgetSummary(
          cfg.aiProvider,
          cfg.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
          true
        );
        const googleKey =
          cfg.googleAiKey ?? (cfg.aiProvider === 'google_ai_studio' ? cfg.apiKey : null);
        const openRouterKey =
          cfg.openRouterKey ?? (cfg.aiProvider === 'openrouter' ? cfg.apiKey : null);

        const docRes = await processDocumentIntelligence({
          buffer: buf,
          fileName: saved.safeOriginalName,
          mime: saved.mime,
          aiProvider: cfg.aiProvider,
          googleAiKey: googleKey,
          openRouterKey,
          cloudProxy: cfg.cloudProxy,
          budgetReached: budget.limitReached,
          locale: this.deps.repo.getLocale(),
          onSpendUsd: (usd, isCloudProxy) => {
            if (usd > 0) {
              this.deps.repo.logAiUsage(
                cfg.aiProvider,
                'doc-summary',
                500,
                120,
                usd,
                Boolean(isCloudProxy)
              );
            }
          },
        });

        const latest = this.deps.repo.getItemById(created.id);
        if (!latest) return;

        const targetOrbit = explicitOrbit
          ? explicitOrbit
          : mode === 'autopilot' && latest.orbit === created.orbit
            ? this.resolveOrCreateOrbit(mode, '', docRes.suggestedSection)
            : latest.orbit;

        const nextMeta: MediaMeta = {
          ...(latest.mediaMeta ?? {}),
          fileName: saved.safeOriginalName,
          fileSize: saved.byteLength,
          pageCount: docRes.pageCount ?? undefined,
          keyPoints: docRes.keyPoints,
          actionItems: docRes.actionItems,
          // Keep full searchable document text accessible inside transcript/search without cluttering card front
          transcript: docRes.extractedText.slice(0, 12_000),
        };

        const updated = this.deps.repo.updateItem(created.id, {
          orbit: targetOrbit,
          title: !hasExplicitTitle && latest.title === cleanFileTitle ? docRes.title : latest.title,
          summary: docRes.summary,
          mediaMeta: nextMeta,
          extractedActions: docRes.extractedActions,
          tags: [...new Set([...docRes.tags, ...latest.tags])].slice(0, 4),
          aiStatus:
            docRes.costUsd > 0 ? 'enriched' : mode === 'buffer' ? 'raw_buffer' : 'local',
        });
        if (updated) this.deps.onItemUpserted?.(updated);
      })
        .catch(() => {})
        .finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }

    return created;
  }

  public saveStandaloneAudio(
    buffer: Buffer,
    mime: string
  ): { filename: string; mime: string; byteLength: number } {
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    return saveAudioAsset(this.mediaDir, sha.slice(0, 24), buffer, mime);
  }

  private async captureVideoInternal(input: CaptureInput): Promise<VaultItem> {
    const config = this.deps.getConfig();
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    let buf: Buffer;
    let ext = '.mp4';
    const rawName = input.fileName || (input.videoPath ? path.basename(input.videoPath) : 'video-reference.mp4');
    const parsedExt = path.extname(rawName).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.m4v'].includes(parsedExt)) {
      ext = parsedExt;
    }

    if (input.videoBytes && input.videoBytes.byteLength > 0) {
      const maxVideoBytes = 48 * 1024 * 1024;
      if (input.videoBytes.byteLength > maxVideoBytes) {
        throw new Error(
          isEn ? 'Video is too large (max 48 MB)' : 'Видео слишком большое (максимум 48 МБ)'
        );
      }
      buf = Buffer.from(input.videoBytes.buffer, input.videoBytes.byteOffset, input.videoBytes.byteLength);
    } else if (input.videoBase64) {
      const cleaned = input.videoBase64.replace(/^data:video\/[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.videoPath && fs.existsSync(input.videoPath)) {
      buf = fs.readFileSync(input.videoPath);
    } else {
      throw new Error(isEn ? 'Video file not found' : 'Видеофайл не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const filename = `vid_${sha.slice(0, 24)}${ext}`;
    const absPath = path.join(this.mediaDir, filename);
    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf, { mode: 0o600 });
    }

    const videoMime =
      input.videoMime ||
      (ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4');
    const cleanTitle =
      input.title?.trim() ||
      rawName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
      (isEn ? 'Video reference' : 'Видеореференс');

    const orbits = this.deps.repo.listOrbits();
    const explicitOrbit =
      input.orbitOverride && orbits.some((o) => o.id === input.orbitOverride)
        ? input.orbitOverride
        : null;
    const focusBoardId =
      input.focusBoardId !== undefined
        ? input.focusBoardId
        : mode === 'focus'
          ? config.activeFocusBoardId
          : null;

    const created = this.deps.repo.createItem({
      dna: 'shot',
      subKind: 'video_ref',
      orbit: explicitOrbit ?? '',
      modeCaptured: mode,
      focusBoardId,
      title: cleanTitle,
      body: (input.text ?? '').trim(),
      summary: `${isEn ? 'Video reference' : 'Видеореференс'} · ${rawName}`,
      mediaPath: filename,
      mediaType: videoMime,
      mediaDurationSec: input.videoDurationSec ?? null,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: rawName,
        fileSize: buf.length,
      },
      tags: [
        ...new Set([isEn ? 'video' : 'видео', isEn ? 'reference' : 'референс', ...(input.tags ?? [])]),
      ].slice(0, 4),
      source,
      externalId: input.externalId ?? null,
      contentHash: sha,
      aiStatus: mode === 'buffer' ? 'raw_buffer' : 'local',
      remindAt: input.remindAt ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.createdAt,
    });

    if (created.remindAt) this.deps.onReminderChanged?.();
    this.deps.onItemUpserted?.(created);
    return created;
  }

  private async captureEmailInternal(input: CaptureInput): Promise<VaultItem> {
    const config = this.deps.getConfig();
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'email_import';

    let buf: Buffer;
    const fileName =
      input.fileName || (input.filePath ? path.basename(input.filePath) : 'message.eml');

    if (input.fileBytes && input.fileBytes.byteLength > 0) {
      if (input.fileBytes.byteLength > MAX_NOTE_IMAGE_BYTES) {
        throw new Error(
          isEn ? 'Document is too large (max 25 MB)' : 'Документ слишком большой (максимум 25 МБ)'
        );
      }
      buf = Buffer.from(input.fileBytes.buffer, input.fileBytes.byteOffset, input.fileBytes.byteLength);
    } else if (input.fileBase64) {
      const cleaned = input.fileBase64.replace(/^data:[^;]+;base64,/i, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error(isEn ? 'Email file (.eml) not found' : 'Файл письма (.eml) не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const parsed = parseEmlBuffer(buf, locale);
    const externalId =
      input.externalId ??
      (parsed.messageId ? `eml:${parsed.messageId}` : `eml:sha:${sha.slice(0, 24)}`);

    const existing = this.deps.repo.findBySourceExternalId(source, externalId);
    if (existing) return existing;

    const savedImages: Array<{ filename: string; mediaUrl: string; thumbFilename?: string }> = [];
    for (const att of parsed.attachments) {
      if (!att.contentType.toLowerCase().startsWith('image/') || !att.data || att.data.byteLength === 0) {
        continue;
      }
      try {
        const stored = await this.saveNoteImageAsset({
          base64: Buffer.from(att.data).toString('base64'),
          mimeType: att.contentType,
          fileName: att.filename,
          generateThumb: savedImages.length === 0,
        });
        savedImages.push({
          filename: att.filename,
          mediaUrl: stored.mediaUrl,
          thumbFilename: stored.thumbFilename,
        });
      } catch {
        // Non-fatal attachment error
      }
    }

    const noteBody = formatEmailAsNoteMarkdown(parsed, savedImages, locale);
    const fallbackFileTitle =
      fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || (isEn ? 'Email' : 'Письмо');
    const finalTitle =
      input.title?.trim() ||
      (parsed.subject &&
      parsed.subject !== 'Письмо без темы' &&
      parsed.subject !== 'Untitled email'
        ? parsed.subject
        : fallbackFileTitle);
    const firstSummaryLine =
      parsed.bodyText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length >= 12) ?? '';
    const summary = parsed.fromName
      ? `${parsed.fromName}${firstSummaryLine ? ` · ${firstSummaryLine}` : ''}`.slice(0, 200)
      : firstSummaryLine.slice(0, 200);

    const orbits = this.deps.repo.listOrbits();
    const explicitOrbit = input.orbitOverride
      ? orbits.find((o) => o.id === input.orbitOverride)
        ? input.orbitOverride
        : this.deps.repo.findOrbitByNameOrSlug(input.orbitOverride)?.id ?? null
      : null;
    const focusBoardId =
      input.focusBoardId !== undefined
        ? input.focusBoardId
        : mode === 'focus'
          ? config.activeFocusBoardId
          : null;

    const firstImgFilename =
      savedImages[0]?.mediaUrl.replace(/^kapsula-media:\/\/local\//, '') ?? null;

    const created = this.deps.repo.createItem({
      dna: 'note',
      subKind: 'post',
      orbit: explicitOrbit ?? '',
      modeCaptured: mode,
      focusBoardId,
      title: finalTitle.slice(0, 120),
      body: noteBody,
      summary,
      imagePath: firstImgFilename,
      thumbPath: savedImages[0]?.thumbFilename ?? null,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName,
        fileSize: buf.length,
        forwardAuthor: parsed.fromName || parsed.from || undefined,
        publishedAt: parsed.date ? new Date(parsed.date).toISOString() : undefined,
      },
      extractedActions: extractActionsFromText(noteBody, locale),
      tags: [...new Set([isEn ? 'email' : 'письмо', ...(input.tags ?? [])])].slice(0, 4),
      source,
      externalId,
      contentHash: sha,
      aiStatus: mode === 'buffer' ? 'raw_buffer' : 'local',
      remindAt: input.remindAt ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.createdAt ?? parsed.date ?? undefined,
    });

    if (created.remindAt) this.deps.onReminderChanged?.();
    this.deps.onItemUpserted?.(created);
    return created;
  }

  public async capture(input: CaptureInput): Promise<VaultItem> {
    if (input.audioBase64 || input.audioBytes) {
      return this.captureAudioInternal(input);
    }
    if (input.videoBase64 || input.videoBytes || input.videoPath) {
      return this.captureVideoInternal(input);
    }
    const candidateFilePath = input.filePath || input.fileName || '';
    const candidateExt = path.extname(candidateFilePath).toLowerCase();
    const hasDocPayload = Boolean(input.filePath || input.fileBase64 || input.fileBytes);
    if (
      hasDocPayload &&
      (candidateExt === '.eml' || (input.fileMime ?? '').toLowerCase().includes('rfc822'))
    ) {
      return this.captureEmailInternal(input);
    }
    if (
      hasDocPayload &&
      (['.mp4', '.webm', '.mov', '.m4v'].includes(candidateExt) ||
        (input.fileMime ?? '').startsWith('video/'))
    ) {
      return this.captureVideoInternal({
        ...input,
        videoPath: input.filePath,
        videoBase64: input.fileBase64,
        videoBytes: input.fileBytes,
        videoMime: input.fileMime,
      });
    }
    if (hasDocPayload) {
      return this.captureDocumentInternal(input);
    }

    const config = this.deps.getConfig();
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    if (input.externalId) {
      const existing = this.deps.repo.findBySourceExternalId(source, input.externalId);
      if (existing) return existing;
    }

    const rawText = (input.text ?? '').trim();
    const safeExplicitTitle = isGenericImageTitle(input.title) ? '' : (input.title ?? '').trim();
    const orbits = this.deps.repo.listOrbits();
    const explicitOrbit = input.orbitOverride
      ? orbits.find((o) => o.id === input.orbitOverride)
        ? input.orbitOverride
        : this.deps.repo.findOrbitByNameOrSlug(input.orbitOverride)?.id ?? null
      : null;

    // 1. Pre-cloud Secret Shield check (always local & encrypted — never sent to AI)
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const secretScanText = [safeExplicitTitle, rawText, input.url].filter(Boolean).join('\n');
    const secretCheck = analyzeForSecret(secretScanText, {
      forceSecret: mode === 'ghost' || input.forceSecret,
      service: input.secretOverride?.service,
      login: input.secretOverride?.login,
      notes: input.secretOverride?.notes,
      locale,
    });

    if (secretCheck.isSecret && secretCheck.payload && secretCheck.meta) {
      // Fail closed cleanly before storing or unlinking any media when Vault is PIN-locked
      if (this.deps.cryptoVault.isLocked()) {
        throw new Error(
          isEn
            ? 'Vault is locked by master PIN — unlock Vault to safely save a secret'
            : 'Сейф заблокирован мастер-кодом — разблокируй Сейф, чтобы безопасно сохранить секрет'
        );
      }

      const secretImgAsset = await this.storeImageAsset(input);
      const payloadToEncrypt = { ...secretCheck.payload };
      const hasSecretImg = Boolean(secretImgAsset.filename && secretImgAsset.absPath);
      const deferSecretOcr = hasSecretImg && config.enableAutoOcr && !input.isDemo;
      if (hasSecretImg && !payloadToEncrypt.secretValue) {
        payloadToEncrypt.secretValue = isEn ? '[Screenshot in Vault]' : '[Скриншот в Сейфе]';
      }

      const encrypted = this.deps.cryptoVault.encryptSecret(payloadToEncrypt);
      const isBankCard = secretCheck.meta.kind === 'bank_card';
      const defaultSecretTitle = isBankCard
        ? secretCheck.meta.service
        : `${secretCheck.meta.service} · ${isEn ? 'Access' : 'Доступ'}`;

      const targetSecretOrbit = this.resolveSecretOrbitId(secretCheck.meta.kind, explicitOrbit);
      const humanSummary = isBankCard
        ? isEn
          ? 'Bank card · hidden in Vault'
          : 'Банковская карта · скрыта в Сейфе'
        : secretCheck.meta.kind === 'api_key'
          ? isEn
            ? 'Access key · hidden in Vault'
            : 'Ключ доступа · скрыт в Сейфе'
          : isEn
            ? 'Hidden in Vault'
            : 'Скрыто в Сейфе';

      const created = this.deps.repo.createItem({
        dna: 'secret',
        orbit: targetSecretOrbit,
        modeCaptured: mode,
        focusBoardId: input.focusBoardId ?? (mode === 'focus' ? config.activeFocusBoardId : null),
        title: safeExplicitTitle || defaultSecretTitle,
        body: '',
        summary: humanSummary,
        encryptedPayload: encrypted,
        secretMeta: secretCheck.meta,
        tags: [
          ...new Set([
            ...(input.tags ?? []),
            isBankCard ? (isEn ? 'card' : 'карта') : isEn ? 'vault' : 'сейф',
          ]),
        ].slice(0, 4),
        source,
        externalId: input.externalId ?? null,
        // Never store unsalted SHA-256 of raw plaintext secret in SQLite
        contentHash: crypto.randomUUID(),
        aiStatus: 'skipped_secret',
        remindAt: input.remindAt ?? null,
        isDemo: input.isDemo ?? false,
        createdAt: input.createdAt,
        skipSyncDirty: deferSecretOcr,
      });
      if (!deferSecretOcr && secretImgAsset.filename) {
        this.cleanupUnreferencedMedia([secretImgAsset.filename]);
      }
      if (created.remindAt) this.deps.onReminderChanged?.();
      this.deps.onItemUpserted?.(created);
      if (deferSecretOcr && secretImgAsset.absPath) {
        const hasExplicitOrbit = Boolean(explicitOrbit);
        const skipAutoCalendar = Boolean(input.skipAutoCalendar);
        const task = this.runWithBgSlot(() =>
          this.runBackgroundEnrichment(
            created.id,
            secretImgAsset.absPath,
            mode,
            false,
            hasExplicitOrbit,
            skipAutoCalendar,
            false,
            true
          )
        )
          .catch(() => {})
          .finally(() => {
            this.inFlight.delete(task);
          });
        this.inFlight.add(task);
      }
      return created;
    }

    const imgAsset = await this.storeImageAsset(input);
    let hasImage = Boolean(imgAsset.filename);
    const hashSource = `${rawText}|${input.url ?? ''}|${imgAsset.sha}`;
    const contentHash = crypto.createHash('sha256').update(hashSource).digest('hex');

    // 1.5. Defer sync_dirty until background OCR Secret Shield screens direct screenshots
    // (non-blocking capture: never blocks the main thread waiting up to 4s on cold WinRT OCR).
    const preScannedOcrText = '';
    const ocrPreScanned = false;
    const isDirectScreenshot =
      hasImage &&
      Boolean(imgAsset.absPath) &&
      config.enableAutoOcr &&
      !input.isDemo &&
      (!(source === 'browser_ext' && Boolean(input.url)) || Boolean(input.imageBase64));

    // 2. Clean pasted/clipped web text & HTML (never mutating secrets, which already returned above)
    let inputBaseUrl: URL | undefined;
    if (input.url) {
      try {
        inputBaseUrl = new URL(input.url);
      } catch {
        inputBaseUrl = undefined;
      }
    }
    const cleanText = sanitizeIngestedText(rawText, {
      baseUrl: inputBaseUrl,
      sanitizeUrl: sanitizeSafeExternalUrl,
      stripCookieNoise: source === 'browser_ext',
    });
    const cleanExplicitTitle = safeExplicitTitle ? normalizeMetaText(safeExplicitTitle) : '';
    const inlineMediaStrippedText = cleanText
      .replace(/!\[[^\]]*\]\(kapsula-media:\/\/[^)\s]+\)/gi, '')
      .trim();

    // 2.1 Fast Tier-0 local classification + synchronous link unfurl (so links open clean on first frame)
    let local = classifyLocally({
      text: cleanText,
      url: input.url ?? null,
      title: cleanExplicitTitle || null,
      ocrText: preScannedOcrText,
      hasImage,
      orbits,
      extraTags: input.tags,
      subKindHint: input.subKind ?? null,
      preferLinkForUrlWithImage: source === 'browser_ext' && Boolean(input.url),
      locale,
    });

    let effectiveBody = cleanText;
    let effectiveTitle = cleanExplicitTitle || local.title;
    if (
      hasImage &&
      !cleanExplicitTitle &&
      (effectiveTitle.includes('kapsula-media://') || /^!\[[^\]]*\]\(/i.test(effectiveTitle))
    ) {
      effectiveTitle = pickCleanScreenshotTitle(
        preScannedOcrText,
        inlineMediaStrippedText,
        local.suggestedNewSection,
        null,
        locale
      );
    }
    let effectiveSummary = local.summary;
    let effectiveDomain = local.domain;
    let effectivePlatform = input.platform ?? local.platform;
    let effectiveOgImageUrl: string | null = null;
    let syncMediaMeta: MediaMeta | undefined = input.mediaMeta ? { ...input.mediaMeta } : undefined;
    let syncExtraLinks: ExtractedAction[] = [];
    let syncImgFilename = imgAsset.filename;
    let syncImgAbsPath = imgAsset.absPath;
    let syncImgBuffer = imgAsset.buffer;
    let syncImgSha = imgAsset.sha;

    const isBodyUrlOrStub = (bodyCandidate: string, urlStr: string, titleCandidate: string): boolean => {
      const b = bodyCandidate.trim();
      if (!b || b === urlStr.trim()) return true;
      const withoutUrl = b.replace(urlStr.trim(), '').trim();
      if (!withoutUrl) return true;
      if (titleCandidate && withoutUrl.toLowerCase() === titleCandidate.trim().toLowerCase()) {
        return true;
      }
      return false;
    };

    const offlinePrivTg =
      local.dna === 'link' && local.url && !input.isDemo
        ? classifyPrivateTelegramUrl(local.url, locale)
        : null;

    if (offlinePrivTg && local.url) {
      if (offlinePrivTg.domain) effectiveDomain = offlinePrivTg.domain;
      if (offlinePrivTg.platform) effectivePlatform = offlinePrivTg.platform;
      if (
        offlinePrivTg.title &&
        !cleanExplicitTitle &&
        isLinkStubTitle(effectiveTitle, local.domain, local.url, local.platform)
      ) {
        effectiveTitle = offlinePrivTg.title;
      }
      const canFillBody = isBodyUrlOrStub(effectiveBody, local.url, cleanExplicitTitle || effectiveTitle);
      if (offlinePrivTg.bodyMarkdown && canFillBody) {
        effectiveBody = offlinePrivTg.bodyMarkdown;
      }
      if (offlinePrivTg.description) {
        effectiveSummary = offlinePrivTg.description;
      }
      syncMediaMeta = {
        ...(syncMediaMeta ?? {}),
        linkAccess: 'private',
        hasVideo: false,
      };
    } else if (local.dna === 'link' && local.url && config.enableUrlUnfurl && !input.isDemo) {
      const og = await Promise.race([
        unfurlUrl(local.url, locale).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5500)),
      ]);
      if (og) {
        if (og.domain) effectiveDomain = og.domain;
        if (og.platform) effectivePlatform = og.platform;
        if (
          og.title &&
          !cleanExplicitTitle &&
          isLinkStubTitle(effectiveTitle, local.domain, local.url, local.platform)
        ) {
          effectiveTitle = og.title;
        }
        const canFillBody = isBodyUrlOrStub(effectiveBody, local.url, cleanExplicitTitle || effectiveTitle);
        if (og.bodyMarkdown && canFillBody) {
          effectiveBody = og.bodyMarkdown;
        } else if (og.description && canFillBody) {
          effectiveBody = og.description;
        }
        if (og.description) {
          effectiveSummary = og.description;
        }
        if (og.ogImageUrl) {
          effectiveOgImageUrl = og.ogImageUrl;
        }
        if (
          og.author ||
          og.publishedAt ||
          og.videoUrl ||
          og.linkAccess ||
          og.hasVideo !== undefined
        ) {
          syncMediaMeta = {
            ...(syncMediaMeta ?? {}),
            forwardAuthor: og.author ?? syncMediaMeta?.forwardAuthor,
            publishedAt: og.publishedAt ?? syncMediaMeta?.publishedAt,
            videoUrl: og.videoUrl ?? syncMediaMeta?.videoUrl,
            ...(og.linkAccess ? { linkAccess: og.linkAccess } : {}),
            ...(og.hasVideo !== undefined ? { hasVideo: og.hasVideo } : {}),
          };
        }
        if (og.extractedLinks.length > 0) {
          syncExtraLinks = og.extractedLinks;
        }
        if (!hasImage && og.ogImageUrl) {
          const downloaded = await Promise.race([
            downloadOgImage(og.ogImageUrl, this.mediaDir, contentHash.slice(0, 20)).catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2600)),
          ]);
          if (downloaded) {
            syncImgFilename = downloaded.filename;
            syncImgAbsPath = path.join(this.mediaDir, downloaded.filename);
            syncImgBuffer = downloaded.buffer;
            syncImgSha = contentHash;
            hasImage = true;
          }
        }
        // Re-classify locally with rich unfurled content while preserving link card DNA
        const wasLink = local.dna === 'link';
        local = classifyLocally({
          text: effectiveBody,
          url: local.url,
          title: effectiveTitle || null,
          hasImage: false,
          orbits,
          extraTags: input.tags,
          subKindHint: input.subKind ?? null,
          preferLinkForUrlWithImage: true,
          locale,
        });
        if (wasLink && local.url) local.dna = 'link';
        if (!effectiveTitle) effectiveTitle = local.title;
        if (!effectiveSummary) effectiveSummary = local.summary;
        if (!effectiveDomain) effectiveDomain = local.domain;
        if (!effectivePlatform) effectivePlatform = local.platform;
      }
    }

    let palette: string[] = [];
    let thumbPath: string | null = null;
    let isLightBanner = syncMediaMeta?.ogIsLightBanner ?? false;
    let analyzedBitmap = false;

    if (syncImgBuffer && syncImgSha) {
      const thumbRes = generateThumbnailAndAnalyze(
        syncImgBuffer,
        this.mediaDir,
        syncImgSha.slice(0, 24)
      );
      thumbPath = thumbRes.thumbPath;
      isLightBanner = isLightBanner || thumbRes.isLightBanner;
      palette = thumbRes.palette;
      analyzedBitmap = thumbRes.width > 0 && thumbRes.height > 0;
    }

    if (!analyzedBitmap && palette.length === 0 && syncImgAbsPath && this.deps.samplePalette) {
      try {
        palette = await this.deps.samplePalette(syncImgAbsPath);
      } catch {
        palette = [];
      }
    }

    // Resolve organic section immediately if strong local signal (contacts, dev, finance) in autopilot
    const resolvedOrbit = explicitOrbit
      ? explicitOrbit
      : mode === 'buffer' || local.isFleetingScratch
        ? ''
        : mode === 'autopilot'
          ? this.resolveOrCreateOrbit(mode, local.orbit, local.suggestedNewSection)
          : local.orbit;

    const initialActions: ExtractedAction[] = [];
    for (const act of [
      ...syncExtraLinks,
      ...extractActionsFromText(`${effectiveBody}\n${preScannedOcrText}\n${input.url ?? ''}`, locale),
    ]) {
      const k = `${act.type}:${act.value}`;
      if (!initialActions.some((x) => `${x.type}:${x.value}` === k) && initialActions.length < 8) {
        initialActions.push(act);
      }
    }
    const focusBoardId =
      input.focusBoardId !== undefined
        ? input.focusBoardId
        : mode === 'focus'
          ? config.activeFocusBoardId
          : null;

    const mergedMediaMeta: MediaMeta | null =
      syncMediaMeta || local.mediaMetaPatch || isLightBanner
        ? {
            ...(local.mediaMetaPatch ?? {}),
            ...(syncMediaMeta ?? {}),
            ogIsLightBanner: isLightBanner || undefined,
          }
        : null;

    const isBlankDraftNote =
      !hasImage && !local.url && (rawText === 'Новая заметка' || rawText === 'New note');
    const deferSyncDirtyUntilOcr = isDirectScreenshot && !ocrPreScanned && !input.isDemo;
    const needsBackground =
      !isBlankDraftNote &&
      !local.isFleetingScratch &&
      !offlinePrivTg &&
      (deferSyncDirtyUntilOcr ||
        (hasImage && config.enableAutoOcr) ||
        (local.dna === 'link' && Boolean(local.url) && config.enableUrlUnfurl) ||
        mode === 'autopilot' ||
        mode === 'focus');

    const created = this.deps.repo.createItem({
      dna: local.dna,
      subKind: local.subKind,
      orbit: resolvedOrbit,
      modeCaptured: mode,
      focusBoardId,
      title: effectiveTitle || local.title,
      body: effectiveBody,
      summary: effectiveSummary || local.summary,
      url: local.url,
      domain: effectiveDomain,
      platform: effectivePlatform,
      imagePath: syncImgFilename,
      thumbPath,
      ogImageUrl: effectiveOgImageUrl,
      ocrText: preScannedOcrText,
      mediaMeta: mergedMediaMeta,
      colorPalette: palette,
      extractedActions: initialActions,
      tags: local.tags,
      source,
      externalId: input.externalId ?? null,
      contentHash,
      aiStatus:
        mode === 'buffer'
          ? 'raw_buffer'
          : needsBackground && !input.isDemo
            ? 'pending'
            : 'local',
      remindAt: input.remindAt ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.createdAt,
      skipSyncDirty: deferSyncDirtyUntilOcr,
    });

    if (created.remindAt) this.deps.onReminderChanged?.();
    if (!input.isDemo && !input.skipAutoCalendar && created.dna !== 'secret') {
      const override = input.calendarEventOverride;
      if (override && typeof override.startAt === 'number') {
        this.syncAutoCalendarEvent(created, {
          title: override.title || created.title,
          startAt: override.startAt,
          endAt: override.endAt ?? override.startAt + 3_600_000,
          allDay: override.allDay,
          hasEndTime: override.hasEndTime,
          location: override.location,
          notes: override.notes ?? rawText,
        });
      } else {
        const textForCalendar = rawText
          .replace(/!\[[^\]]*\]\(kapsula-media:\/\/[^)\s]+\)/gi, '')
          .trim();
        if (textForCalendar && !(input.url && textForCalendar === input.url.trim())) {
          const parsedEv = parseRussianEvent(textForCalendar, undefined, undefined, locale);
          if (parsedEv?.isEventIntent) {
            this.syncAutoCalendarEvent(created, parsedEv);
          }
        }
      }
    }
    this.deps.onItemUpserted?.(created);

    if (needsBackground && !input.isDemo) {
      const hasExplicitOrbit = Boolean(explicitOrbit);
      const skipAutoCalendar = Boolean(input.skipAutoCalendar);
      const task = this.runWithBgSlot(() =>
        this.runBackgroundEnrichment(
          created.id,
          syncImgAbsPath,
          mode,
          false,
          hasExplicitOrbit,
          skipAutoCalendar,
          ocrPreScanned,
          deferSyncDirtyUntilOcr
        )
      )
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(task);
        });
      this.inFlight.add(task);
    }

    return created;
  }

  private async runBackgroundEnrichment(
    itemId: string,
    imgAbsPath: string | null,
    mode: CaptureMode,
    bypassCache = false,
    hasExplicitOrbit = false,
    skipAutoCalendar = false,
    ocrAlreadyScanned = false,
    deferSyncDirtyUntilOcr = false,
    resultOut?: { linkUnfurlAttempted?: boolean; linkUnfurlSucceeded?: boolean }
  ): Promise<void> {
    const tempSecretImgName =
      imgAbsPath && path.dirname(path.resolve(imgAbsPath)) === path.resolve(this.mediaDir)
        ? path.basename(imgAbsPath)
        : null;

    const current = this.deps.repo.getItemById(itemId);
    if (!current) {
      if (tempSecretImgName) {
        this.cleanupUnreferencedMedia([tempSecretImgName]);
      }
      return;
    }

    if (current.dna === 'secret') {
      try {
        const cfg = this.deps.getConfig();
        let extractedOcrText = '';
        if (imgAbsPath && cfg.enableAutoOcr && !ocrAlreadyScanned) {
          try {
            const ocr = await defaultLocalOcrAdapter.extractText(imgAbsPath, this.deps.dataDir);
            extractedOcrText = ocr.text;
          } catch {
            extractedOcrText = '';
          }
        }
        const latestSecret = this.deps.repo.getItemById(itemId);
        if (!latestSecret || latestSecret.dna !== 'secret') {
          return;
        }
        // Fail closed: if Vault locked while OCR ran, never store plaintext or mark dirty
        if (this.deps.cryptoVault.isLocked()) {
          return;
        }
        if (extractedOcrText) {
          const rawEnc = this.deps.repo.getRawEncryptedPayload(itemId);
          if (rawEnc) {
            const prevPayload = this.deps.cryptoVault.decryptSecret(rawEnc);
            const nextPayload = { ...prevPayload };
            if (
              !nextPayload.secretValue ||
              nextPayload.secretValue === '[Скриншот в Сейфе]' ||
              nextPayload.secretValue === '[Screenshot in Vault]'
            ) {
              nextPayload.secretValue = extractedOcrText;
            } else {
              nextPayload.notes = [nextPayload.notes, extractedOcrText].filter(Boolean).join('\n\n');
            }
            const reEncrypted = this.deps.cryptoVault.encryptSecret(nextPayload);
            const updatedSecret = this.deps.repo.updateItem(
              itemId,
              { encryptedPayload: reEncrypted, ocrText: '' },
              { skipAutoRevision: true }
            );
            if (updatedSecret) this.deps.onItemUpserted?.(updatedSecret);
          } else if (deferSyncDirtyUntilOcr) {
            this.deps.repo.markItemDirty(itemId);
          }
        } else if (deferSyncDirtyUntilOcr) {
          this.deps.repo.markItemDirty(itemId);
        }
      } finally {
        if (tempSecretImgName) {
          this.cleanupUnreferencedMedia([tempSecretImgName]);
        }
      }
      return;
    }

    if (current.dna === 'voice' || current.dna === 'doc') {
      return;
    }

    const initialTitle = current.title;
    const initialOrbit = current.orbit;
    const initialTagsJson = JSON.stringify(current.tags);

    const config = this.deps.getConfig();
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    let ocrText = current.ocrText;
    let title = isGenericImageTitle(current.title) ? (isEn ? 'Screenshot' : 'Скриншот') : current.title;
    let body = current.body;
    let summary = current.summary;
    let domain = current.domain;
    let platform = current.platform;
    let ogImageUrl = current.ogImageUrl;
    let imagePath = current.imagePath;
    let thumbPath = current.thumbPath;
    let mediaPath = current.mediaPath;
    let mediaType = current.mediaType;
    let mediaDurationSec = current.mediaDurationSec;
    let mediaMeta: MediaMeta | null = current.mediaMeta ? { ...current.mediaMeta } : null;
    let colorPalette = [...current.colorPalette];
    let actions: ExtractedAction[] = [...current.extractedActions];
    let visionTitle: string | null = null;
    let visionSummary: string | null = null;
    let visionOrbitSuggestion: string | null = null;
    let visionTags: string[] = [];
    let visionUsed = false;
    let visionCalSuggestion: ParsedAiCalendarEvent | null = null;

    const pushUniqueAction = (act: ExtractedAction) => {
      if (actions.length >= 8) return;
      const key = `${act.type}:${act.value}`;
      if (!actions.some((a) => `${a.type}:${a.value}` === key)) {
        actions.push(act);
      }
    };

    // A. Offline OCR Secret Shield check + OCR extraction (always screen local screenshots
    // before Vision upload or deferred Sync enqueue, even when enableAutoOcr is disabled).
    let ocrScreenedClean = ocrAlreadyScanned;
    const mayAttemptCloudVision =
      mode !== 'ghost' &&
      Boolean(this.deps.prepareVisionImage) &&
      config.aiProvider !== 'local' &&
      Boolean(config.apiKey || config.googleAiKey || config.openRouterKey || config.cloudProxy);
    if (
      imgAbsPath &&
      current.dna !== 'link' &&
      !ocrAlreadyScanned &&
      (config.enableAutoOcr || mayAttemptCloudVision || deferSyncDirtyUntilOcr)
    ) {
      let ocr: Awaited<ReturnType<typeof defaultLocalOcrAdapter.extractText>> | null = null;
      try {
        ocr = await defaultLocalOcrAdapter.extractText(imgAbsPath, this.deps.dataDir);
        ocrScreenedClean = true;
      } catch {
        ocrScreenedClean = false;
      }
      if (ocr?.text) {
        if (config.enableAutoOcr) {
          ocrText = ocr.text;
        }

        const ocrSecret = analyzeForSecret(ocr.text, { locale });
        if (ocrSecret.isSecret && ocrSecret.payload && ocrSecret.meta) {
          const latestBeforeSecret = this.deps.repo.getItemById(itemId);
          if (!latestBeforeSecret || latestBeforeSecret.dna === 'secret') return;
          const prevImg = latestBeforeSecret.imagePath;
          const prevThumb = latestBeforeSecret.thumbPath;
          const prevMedia = latestBeforeSecret.mediaPath;

          if (this.deps.cryptoVault.isLocked()) {
            // NEVER leave a plaintext secret screenshot persisted as dna='shot' when Vault is locked!
            const { freedMedia } = this.deps.repo.purgeItemPermanently(itemId);
            const fallbackBase =
              imgAbsPath && path.dirname(path.resolve(imgAbsPath)) === path.resolve(this.mediaDir)
                ? path.basename(imgAbsPath)
                : null;
            this.cleanupUnreferencedMedia([prevImg, prevThumb, prevMedia, fallbackBase, ...freedMedia]);
            this.deps.onItemDeleted?.(itemId);
            this.deps.onSecurityNotice?.({
              title: isEn ? 'Screenshot removed for protection · Kapsula' : 'Скриншот удалён для защиты · Kapsula',
              body: isEn
                ? 'Sensitive data was found in the screenshot while Vault is locked. Unlock Vault and save it again.'
                : 'На скриншоте найдены конфиденциальные данные, но Сейф сейчас заблокирован. Разблокируй Сейф и сохрани их снова.',
            });
            return;
          }

          const encrypted = this.deps.cryptoVault.encryptSecret(ocrSecret.payload);
          const keepOrbit =
            hasExplicitOrbit || latestBeforeSecret.orbit !== initialOrbit
              ? latestBeforeSecret.orbit
              : this.resolveSecretOrbitId(ocrSecret.meta.kind, null);

          const secretTitle =
            ocrSecret.meta.kind === 'bank_card'
              ? ocrSecret.meta.last4
                ? `${ocrSecret.meta.service} · •••• ${ocrSecret.meta.last4}`
                : ocrSecret.meta.service
              : `${ocrSecret.meta.service} · ${isEn ? 'Access' : 'Доступ'}`;

          const updatedSecret = this.deps.repo.updateItem(itemId, {
            dna: 'secret',
            orbit: keepOrbit,
            title: secretTitle,
            body: '',
            summary: isEn ? 'Detected in screenshot · hidden in Vault' : 'Найдено на скриншоте · скрыто в Сейфе',
            imagePath: null,
            thumbPath: null,
            ogImageUrl: null,
            ocrText: '',
            extractedActions: [],
            encryptedPayload: encrypted,
            secretMeta: ocrSecret.meta,
            tags: [...new Set([...latestBeforeSecret.tags, isEn ? 'vault' : 'сейф'])].slice(0, 4),
            aiStatus: 'skipped_secret',
          });
          this.cleanupUnreferencedMedia([prevImg, prevThumb]);
          if (updatedSecret) this.deps.onItemUpserted?.(updatedSecret);
          return;
        }

        for (const act of extractActionsFromText(ocr.text, locale)) {
          pushUniqueAction(act);
        }
      }
      if (deferSyncDirtyUntilOcr && ocrScreenedClean) {
        this.deps.repo.markItemDirty(itemId);
      }
    }

    if (mode === 'ghost') {
      if (ocrText !== current.ocrText || current.aiStatus === 'pending') {
        const ghostUpdated = this.deps.repo.updateItem(
          itemId,
          {
            ocrText,
            aiStatus: current.aiStatus === 'pending' ? 'local' : current.aiStatus,
            extractedActions: actions,
          },
          { skipAutoRevision: true }
        );
        if (ghostUpdated) this.deps.onItemUpserted?.(ghostUpdated);
      }
      return;
    }

    // B. Deep multi-platform link unfurl (`t.me`, `x.com`, `youtube`, `github`, `instagram`, articles)
    // Skip re-fetching if synchronous capture() already populated full content (unless manually re-analyzed)
    const replacedCoverMedia: string[] = [];
    const alreadyUnfurled =
      current.dna === 'link' &&
      !isLinkStubTitle(current.title, current.domain, current.url, current.platform) &&
      !isLinkStubBody(current.body, current.url);

    if (current.url && config.enableUrlUnfurl && (!alreadyUnfurled || bypassCache)) {
      if (resultOut) resultOut.linkUnfurlAttempted = true;
      const og = await unfurlUrl(current.url, locale);
      const extractedAnyMetadata = Boolean(
        og.title ||
          og.description ||
          og.bodyMarkdown ||
          og.ogImageUrl ||
          og.videoUrl ||
          og.linkAccess
      );
      if (resultOut) resultOut.linkUnfurlSucceeded = extractedAnyMetadata;

      if (og.domain) domain = og.domain;
      if (og.platform) platform = og.platform;
      if (og.title && isLinkStubTitle(title, current.domain, current.url, current.platform)) {
        title = og.title;
      }
      if (og.description && (isLinkStubSummary(summary, current.url, current.domain) || bypassCache)) {
        summary = og.description;
      }
      if (og.bodyMarkdown && isLinkStubBody(body, current.url)) {
        body = og.bodyMarkdown;
      }
      if (
        og.author ||
        og.publishedAt ||
        og.videoUrl ||
        og.linkAccess ||
        og.hasVideo !== undefined
      ) {
        mediaMeta = {
          ...(mediaMeta ?? {}),
          forwardAuthor: og.author ?? mediaMeta?.forwardAuthor,
          publishedAt: og.publishedAt ?? mediaMeta?.publishedAt,
          videoUrl: og.videoUrl ?? mediaMeta?.videoUrl,
          ...(og.linkAccess ? { linkAccess: og.linkAccess } : {}),
          ...(og.hasVideo !== undefined ? { hasVideo: og.hasVideo } : {}),
        };
      }
      for (const act of og.extractedLinks) {
        pushUniqueAction(act);
      }

      if (og.ogImageUrl) {
        const shouldDownloadCover =
          (!imagePath && !thumbPath) || (bypassCache && og.ogImageUrl !== current.ogImageUrl);
        ogImageUrl = og.ogImageUrl;
        if (shouldDownloadCover) {
          const prevImg = imagePath;
          const prevThumb = thumbPath;
          const coverStem =
            bypassCache && (prevImg || prevThumb)
              ? `${current.contentHash.slice(0, 12)}_${crypto.createHash('sha256').update(og.ogImageUrl).digest('hex').slice(0, 8)}`
              : current.contentHash.slice(0, 20);
          const downloaded = await downloadOgImage(og.ogImageUrl, this.mediaDir, coverStem);
          if (downloaded) {
            imagePath = downloaded.filename;
            const thumbRes = generateThumbnailAndAnalyze(downloaded.buffer, this.mediaDir, coverStem);
            thumbPath = thumbRes.thumbPath;
            if (thumbRes.palette.length > 0 && (colorPalette.length === 0 || bypassCache)) {
              colorPalette = thumbRes.palette;
            }
            mediaMeta = { ...(mediaMeta ?? {}), ogIsLightBanner: Boolean(thumbRes.isLightBanner) };
            if (prevImg && prevImg !== imagePath) replacedCoverMedia.push(prevImg);
            if (prevThumb && prevThumb !== thumbPath) replacedCoverMedia.push(prevThumb);
          }
        }
      }

      // Download extra gallery images for multi-photo posts (up to 4 total)
      if (og.galleryUrls.length > 1) {
        const savedGallery: string[] = imagePath ? [imagePath] : [];
        for (let gIdx = 0; gIdx < og.galleryUrls.length && savedGallery.length < 4; gIdx++) {
          const gUrl = og.galleryUrls[gIdx]!;
          if (gUrl === og.ogImageUrl && imagePath) continue;
          const gDl = await downloadOgImage(
            gUrl,
            this.mediaDir,
            `${current.contentHash.slice(0, 14)}_g${gIdx}`
          );
          if (gDl && !savedGallery.includes(gDl.filename)) {
            savedGallery.push(gDl.filename);
          }
        }
        if (savedGallery.length > 1) {
          mediaMeta = { ...(mediaMeta ?? {}), galleryPaths: savedGallery };
        }
      }

      // Social video links (Instagram Reels, TikTok, Reddit, Telegram, YouTube) use the local bounded LRU cache
    }

    // Private Telegram posts & invite links (`t.me/c/...`, `t.me/+...`, `t.me/joinchat/...`)
    // MUST stay strictly local: classify offline even if enableUrlUnfurl is false or alreadyUnfurled is true,
    // persist localized metadata only, and exit BEFORE video/Vision/cloud AI.
    const privTg =
      current.dna === 'link' && current.url ? classifyPrivateTelegramUrl(current.url, locale) : null;
    if (privTg) {
      if (privTg.domain) domain = privTg.domain;
      if (privTg.platform) platform = privTg.platform;
      if (privTg.title && isLinkStubTitle(title, current.domain, current.url, current.platform)) {
        title = privTg.title;
      }
      if (privTg.description && isLinkStubSummary(summary, current.url, current.domain)) {
        summary = privTg.description;
      }
      if (privTg.bodyMarkdown && isLinkStubBody(body, current.url)) {
        body = privTg.bodyMarkdown;
      }
      mediaMeta = {
        ...(mediaMeta ?? {}),
        linkAccess: 'private',
        hasVideo: false,
      };
    }
    const isPrivateLink = mediaMeta?.linkAccess === 'private' || Boolean(privTg);
    if (current.dna === 'link' && isPrivateLink) {
      const latestPriv = this.deps.repo.getItemById(itemId);
      if (!latestPriv || latestPriv.dna === 'secret') return;
      const userEditedTitle = latestPriv.title !== initialTitle;
      const latestBodyIsStub = isLinkStubBody(latestPriv.body, latestPriv.url);
      const nextTitle =
        !userEditedTitle &&
        title &&
        isLinkStubTitle(latestPriv.title, latestPriv.domain, latestPriv.url, latestPriv.platform)
          ? title
          : latestPriv.title;
      const updatedPriv = this.deps.repo.updateItem(itemId, {
        title: nextTitle,
        summary: summary || latestPriv.summary,
        body: latestBodyIsStub && body ? body : undefined,
        domain,
        platform,
        mediaMeta,
        aiStatus: latestPriv.aiStatus === 'raw_buffer' ? 'raw_buffer' : 'local',
      });
      if (updatedPriv) this.deps.onItemUpserted?.(updatedPriv);
      return;
    }
    // When invoked from manual link refresh (`reprocessItem`), abort immediately on unfurl failure
    // so video extraction, Vision AI, Cloud AI, and repo.updateItem do not run or corrupt existing data.
    if (
      current.dna === 'link' &&
      resultOut &&
      resultOut.linkUnfurlAttempted &&
      !resultOut.linkUnfurlSucceeded
    ) {
      return;
    }
    const knownNoVideo = mediaMeta?.hasVideo === false;
    if (current.dna === 'link' && current.url && config.enableUrlUnfurl && !isPrivateLink) {
      const ytId = mediaMeta?.youtubeVideoId ?? extractYouTubeVideoId(current.url);
      if (ytId) {
        mediaMeta = {
          ...(mediaMeta ?? {}),
          youtubeVideoId: ytId,
          hasVideo: true,
          videoExtractStatus: 'ready',
        };
      } else if (!mediaPath && !knownNoVideo) {
        const hasValidCached =
          Boolean(mediaMeta?.cachedVideoFile) &&
          (await this.videoCache.resolveSafePathAsync(mediaMeta!.cachedVideoFile!)).ok;
        const vidPlatform = detectSocialVideoPlatform(current.url);
        const isIgVideoUrl =
          vidPlatform === 'instagram' && /\/(?:reel|reels|tv)\//i.test(current.url);
        const isVReddIt = vidPlatform === 'reddit' && /v\.redd\.it/i.test(current.url);
        const shouldAttemptVideo =
          Boolean(mediaMeta?.videoUrl) ||
          mediaMeta?.hasVideo === true ||
          isIgVideoUrl ||
          vidPlatform === 'tiktok' ||
          isVReddIt;
        if (
          !hasValidCached &&
          shouldAttemptVideo &&
          (bypassCache || !mediaMeta?.videoExtractStatus)
        ) {
          const vidRes = await resolveAndCacheSocialVideo({
            url: current.url,
            stem: current.contentHash.slice(0, 20),
            knownVideoUrl: mediaMeta?.videoUrl ?? null,
            videoCache: this.videoCache,
            enableBrowserFallback: true,
          });
          mediaMeta = {
            ...(mediaMeta ?? {}),
            ...(vidRes.cachedVideoFile ? { cachedVideoFile: vidRes.cachedVideoFile } : {}),
            ...(vidRes.videoUrl ? { videoUrl: vidRes.videoUrl } : {}),
            videoExtractStatus: vidRes.status,
          };
          if (vidRes.durationSec && !mediaDurationSec) {
            mediaDurationSec = vidRes.durationSec;
          }
        }
      }
    }

    // C. Multimodal Vision AI enrichment for screenshots, visual-only social posts, & empty-body links
    // Skip Vision when a link/Telegram post already extracted a real title and meaningful body copy
    const effectiveImgAbs = imgAbsPath || (imagePath ? path.join(this.mediaDir, imagePath) : null);
    const isSocialPostWithMedia =
      platform === 'telegram' || platform === 'instagram' || platform === 'x';
    const hasRichExtractedLinkTitle =
      current.dna === 'link' &&
      !isLinkStubTitle(title, domain || current.domain, current.url, platform || current.platform);
    const hasRichExtractedLinkBody =
      current.dna === 'link' &&
      body.trim().length >= 40 &&
      body.trim() !== (current.url || '').trim();
    const strippedShotBody = current.body
      .replace(/!\[[^\]]*\]\(kapsula-media:\/\/[^)\s]+\)/gi, '')
      .trim();
    const hasUserCaptionShot =
      current.dna === 'shot' &&
      strippedShotBody.length > 0 &&
      !isGenericImageTitle(strippedShotBody) &&
      Boolean(current.title.trim()) &&
      !isGenericImageTitle(current.title) &&
      !/^!\[[^\]]*\]\(kapsula-media:\/\//i.test(current.title.trim());
    const preserveExistingTitle = hasRichExtractedLinkTitle || hasUserCaptionShot;
    const preserveExtractedLinkCopy = hasRichExtractedLinkTitle && hasRichExtractedLinkBody;
    const linkNeedsVisualBody =
      current.dna === 'link' && (!body.trim() || body.trim() === (current.url || '').trim());
    const shouldRunVision =
      mode !== 'buffer' &&
      (current.dna !== 'link' ||
        (!preserveExtractedLinkCopy && (isSocialPostWithMedia || linkNeedsVisualBody)));
    if (
      shouldRunVision &&
      (current.dna === 'link' || ocrScreenedClean) &&
      effectiveImgAbs &&
      fs.existsSync(effectiveImgAbs) &&
      this.deps.prepareVisionImage &&
      config.aiProvider !== 'local' &&
      (config.apiKey || config.googleAiKey || config.openRouterKey || config.cloudProxy)
    ) {
      const prepared = await Promise.resolve(this.deps.prepareVisionImage(effectiveImgAbs)).catch(() => null);
      if (prepared?.base64) {
        const vision = await analyzeImageWithVision({
          repo: this.deps.repo,
          provider: config.aiProvider,
          apiKey: config.apiKey,
          googleAiKey: config.googleAiKey,
          openRouterKey: config.openRouterKey,
          cloudProxy: config.cloudProxy,
          imageBase64: prepared.base64,
          imageMime: prepared.mimeType,
          captionHint: current.dna === 'link' ? title : body,
          ocrHint: ocrText,
          orbits: this.deps.repo.listOrbits(),
          capUsd: config.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
          fetchFn: this.deps.fetchFn,
        });
        if (vision) {
          visionUsed = true;
          visionTitle = preserveExistingTitle ? null : vision.title;
          visionSummary =
            hasRichExtractedLinkBody && summary.trim().length >= 25
              ? null
              : vision.summary || null;
          visionOrbitSuggestion = vision.suggestedOrbitId || vision.suggestedNewSection;
          visionTags = vision.tags;
          visionCalSuggestion = vision.calendarEvent ?? null;

          for (const lk of vision.links) {
            pushUniqueAction({
              type: 'url',
              label: lk.label || lk.url.replace(/^https?:\/\//, '').slice(0, 32),
              value: lk.url,
              description: lk.description,
            });
          }

          if (current.dna !== 'link') {
            if (vision.title && !hasUserCaptionShot) title = vision.title;
            if (vision.summary) summary = vision.summary;
            if (vision.bodyMarkdown && !body.trim()) {
              body = vision.bodyMarkdown;
            }
          } else if (vision.bodyMarkdown && (!body.trim() || body.trim() === current.url)) {
            body = vision.bodyMarkdown;
          } else if (
            !hasRichExtractedLinkBody &&
            vision.bodyMarkdown &&
            body.trim() &&
            !body.includes(vision.bodyMarkdown.slice(0, 40))
          ) {
            body = `${body.trim()}\n\n### ${isEn ? 'In the image' : 'На изображении'}\n${vision.bodyMarkdown}`;
          }
        }
      }
    }

    const latestMid = this.deps.repo.getItemById(itemId);
    if (!latestMid || latestMid.dna === 'secret') return;

    const latestBodyWasBlank = !latestMid.body.trim() || latestMid.body.trim() === (latestMid.url ?? '').trim();
    const effectiveBody = latestBodyWasBlank ? body : latestMid.body;

    const orbits = this.deps.repo.listOrbits();
    const combinedText = [title, effectiveBody, ocrText, summary, latestMid.url]
      .filter(Boolean)
      .join('\n');

    const localRecheck = classifyLocally({
      text: effectiveBody || latestMid.url || '',
      url: latestMid.url,
      title:
        title !== 'Скриншот' &&
        title !== 'Screenshot' &&
        !isLinkStubTitle(title, latestMid.domain, latestMid.url, latestMid.platform)
          ? title
          : null,
      ocrText,
      hasImage: Boolean(imagePath || latestMid.imagePath),
      orbits,
      extraTags: [...latestMid.tags, ...visionTags],
      subKindHint: latestMid.subKind,
      preferLinkForUrlWithImage: latestMid.dna === 'link' && Boolean(latestMid.url),
      locale,
    });

    if (localRecheck.mediaMetaPatch) {
      mediaMeta = { ...(localRecheck.mediaMetaPatch), ...(mediaMeta ?? {}) };
    }

    const chosenLocalTitle = preserveExistingTitle
      ? title.trim()
      : visionTitle ||
        (isGenericImageTitle(localRecheck.title)
          ? isEn
            ? 'Screenshot'
            : 'Скриншот'
          : localRecheck.title);
    const chosenLocalSummary =
      hasRichExtractedLinkBody && summary.trim().length >= 25
        ? summary.trim()
        : visionSummary || summary || localRecheck.summary;

    if (mode === 'buffer') {
      const userEditedTitle = latestMid.title !== initialTitle;
      const updated = this.deps.repo.updateItem(itemId, {
        subKind: latestMid.subKind ?? localRecheck.subKind,
        title: userEditedTitle ? latestMid.title : chosenLocalTitle,
        body: latestBodyWasBlank && body ? body : undefined,
        summary: chosenLocalSummary,
        domain,
        platform,
        imagePath,
        thumbPath,
        mediaPath,
        mediaType,
        mediaDurationSec,
        mediaMeta,
        colorPalette,
        ogImageUrl,
        ocrText,
        extractedActions: actions,
        aiStatus: 'raw_buffer',
      });
      if (replacedCoverMedia.length > 0) {
        this.cleanupUnreferencedMedia(replacedCoverMedia);
      }
      if (updated) this.deps.onItemUpserted?.(updated);
      return;
    }

    const preservedOrbit =
      hasExplicitOrbit || latestMid.orbit !== initialOrbit
        ? latestMid.orbit
        : visionOrbitSuggestion || localRecheck.orbit;

    const allowPostCover = latestMid.subKind === 'post' || localRecheck.subKind === 'post';

    // D. Tier 1 + Tier 2 AI Routing & Micro-Enrichment
    const aiResult = await runAiPipeline({
      repo: this.deps.repo,
      provider: config.aiProvider,
      apiKey: config.apiKey,
      googleAiKey: config.googleAiKey,
      openRouterKey: config.openRouterKey,
      cloudProxy: config.cloudProxy,
      capUsd: config.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
      contentHash: latestMid.contentHash,
      rawText: combinedText,
      domain,
      hasImage: Boolean(imagePath || latestMid.imagePath),
      allowPostCover,
      orbits,
      localBaseline: {
        orbit: preservedOrbit,
        suggestedNewSection: localRecheck.suggestedNewSection,
        dna: latestMid.dna,
        title: chosenLocalTitle,
        summary: chosenLocalSummary,
        tags: [...new Set([...visionTags, ...localRecheck.tags])].slice(0, 4),
      },
      fetchFn: this.deps.fetchFn,
      bypassCache,
    });

    // Re-read item right before final write so concurrent user edits are preserved
    const latest = this.deps.repo.getItemById(itemId);
    if (!latest || latest.dna === 'secret') return;

    const userEditedTitle = latest.title !== initialTitle;
    const userEditedOrbit = latest.orbit !== initialOrbit;
    const userEditedTags = JSON.stringify(latest.tags) !== initialTagsJson;
    const latestStillBlankBody =
      !latest.body.trim() || latest.body.trim() === (latest.url ?? '').trim();

    const finalOrbit =
      hasExplicitOrbit || userEditedOrbit
        ? latest.orbit
        : mode === 'autopilot'
          ? this.resolveOrCreateOrbit(
              mode,
              visionOrbitSuggestion && orbits.some((o) => o.id === visionOrbitSuggestion)
                ? visionOrbitSuggestion
                : aiResult.orbit,
              localRecheck.isFleetingScratch ? null : aiResult.suggestedNewSection
            )
          : latest.orbit;

    const finalTags = userEditedTags
      ? latest.tags
      : [...new Set([...visionTags, ...aiResult.tags, ...latest.tags])].slice(0, 4);

    // Avoid forcing Telegram photo posts into 'shot' screenshots
    const finalDna: ContentDna =
      (imagePath || latest.imagePath) && latest.dna === 'shot' && !allowPostCover
        ? 'shot'
        : aiResult.dna;

    const contactCheck = !latest.subKind ? detectContactInfo(effectiveBody) : null;
    const finalSubKind =
      latest.subKind ?? (contactCheck?.isContact ? 'contact' : localRecheck.subKind);

    const bestFinalTitle = preserveExistingTitle
      ? title.trim()
      : visionTitle ||
        (!isGenericImageTitle(aiResult.title) ? aiResult.title : chosenLocalTitle);
    const bestFinalSummary =
      hasRichExtractedLinkBody && summary.trim().length >= 25
        ? summary.trim()
        : visionSummary || aiResult.summary || chosenLocalSummary;

    const updated = this.deps.repo.updateItem(itemId, {
      orbit: finalOrbit,
      dna: finalDna,
      subKind: finalSubKind,
      title: userEditedTitle ? latest.title : bestFinalTitle,
      body: latestStillBlankBody && body ? body : undefined,
      summary: bestFinalSummary,
      domain,
      platform,
      imagePath,
      thumbPath,
      mediaPath,
      mediaType,
      mediaDurationSec,
      mediaMeta,
      colorPalette,
      ogImageUrl,
      ocrText,
      extractedActions: actions,
      tags: finalTags,
      aiStatus: aiResult.usedCloud || visionUsed ? 'enriched' : 'local',
      aiConfidence: aiResult.confidence,
    });
    if (replacedCoverMedia.length > 0) {
      this.cleanupUnreferencedMedia(replacedCoverMedia);
    }
    if (updated) {
      this.deps.onItemUpserted?.(updated);
      const aiCal = !skipAutoCalendar ? visionCalSuggestion || aiResult.calendarEvent : null;
      if (aiCal) {
        const existingAuto = this.deps.repo.findCalendarEventByExternalId('vault_auto', updated.id);
        const existingLinked = this.deps.repo.findCalendarEventByLinkedItemId(updated.id);
        if (!existingAuto && !existingLinked) {
          this.syncAutoCalendarEvent(updated, aiCal);
        }
      }
    }
  }

  private syncAutoCalendarEvent(
    item: VaultItem,
    candidate: {
      title: string;
      startAt: number;
      endAt: number;
      allDay?: boolean;
      hasEndTime?: boolean;
      location?: string;
      notes?: string;
    }
  ): void {
    try {
      this.deps.repo.upsertCalendarEvent({
        title: candidate.title || item.title,
        notes: (candidate.notes || '').trim(),
        location: (candidate.location || '').trim(),
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        allDay: Boolean(candidate.allDay),
        hasEndTime: Boolean(candidate.hasEndTime),
        kind: 'event',
        linkedItemId: item.id,
        color: '#E86A33',
        externalSource: 'vault_auto',
        externalId: item.id,
      });
      if (!item.remindAt && !candidate.allDay && candidate.startAt > Date.now()) {
        this.deps.repo.updateItem(item.id, { remindAt: candidate.startAt });
        this.deps.onReminderChanged?.();
      }
      this.deps.onCalendarChanged?.();
    } catch {
      // Never block primary capture if secondary calendar sync encounters an error
    }
  }

  /**
   * Explicitly transcribes an existing voice note (or any item with an audio attachment) via cloud AI.
   * Saves a `'voice'` revision snapshot if body is non-empty, populates `item.body` and `mediaMeta.transcript`,
   * optionally appends extracted tasks as a Markdown checklist, updates generic voice titles, and surfaces
   * clear human-readable Russian errors without silently swallowing failures.
   */
  public async transcribeExistingItem(input: {
    itemId: string;
    wavBase64Fallback?: string;
    extractTasks?: boolean;
  }): Promise<TranscribeItemResult> {
    const locale: AppLocale = this.deps.repo.getLocale();
    const isEn = locale === 'en';
    const item = this.deps.repo.getItemById(input.itemId);
    if (!item) {
      return { ok: false, error: isEn ? 'Note not found.' : 'Запись не найдена.' };
    }
    if (item.dna === 'secret') {
      return {
        ok: false,
        error: isEn
          ? 'Vault items are never sent to Cloud AI.'
          : 'Записи из Сейфа не отправляются в облачный ИИ.',
      };
    }

    const audioPath = item.mediaPath
      ? path.join(this.mediaDir, path.basename(item.mediaPath))
      : undefined;
    const hasDiskAudio = Boolean(audioPath && fs.existsSync(audioPath));
    if (!hasDiskAudio && !input.wavBase64Fallback) {
      return {
        ok: false,
        item,
        error: isEn
          ? 'Audio file for this note was not found on disk.'
          : 'Аудиофайл этой записи не найден на диске.',
      };
    }

    const cfg = this.deps.getConfig();
    const budget = this.deps.repo.getMonthBudgetSummary(
      cfg.aiProvider,
      cfg.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
      true
    );
    const googleKey =
      cfg.googleAiKey ?? (cfg.aiProvider === 'google_ai_studio' ? cfg.apiKey : null);
    const openRouterKey =
      cfg.openRouterKey ?? (cfg.aiProvider === 'openrouter' ? cfg.apiKey : null);

    const res = await transcribeAudioFile({
      audioPath: hasDiskAudio ? audioPath : undefined,
      mime: item.mediaType ?? undefined,
      fileName: item.mediaMeta?.fileName,
      durationSec: item.mediaDurationSec,
      contextHint: item.body.trim() || (!isGenericVoiceTitle(item.title) ? item.title : undefined),
      wavBase64Fallback: input.wavBase64Fallback,
      extractTasks: input.extractTasks,
      aiProvider: cfg.aiProvider,
      googleAiKey: googleKey,
      openRouterKey,
      cloudProxy: cfg.cloudProxy,
      budgetReached: budget.limitReached,
      locale,
      onSpendUsd: (usd, isCloudProxy) => {
        if (usd > 0) {
          this.deps.repo.logAiUsage(
            cfg.aiProvider,
            'audio-transcribe',
            600,
            220,
            usd,
            Boolean(isCloudProxy)
          );
        }
      },
      fetchFn: this.deps.fetchFn,
    });

    const transcribeErrFallback = isEn
      ? 'Could not transcribe the recording.'
      : 'Не удалось расшифровать запись.';
    if (!res.ok || !res.result) {
      const latestOnErr = this.deps.repo.getItemById(input.itemId);
      if (latestOnErr) {
        const errMeta: MediaMetaWithTranscriptError = {
          ...(latestOnErr.mediaMeta ?? {}),
          transcriptError: res.error || transcribeErrFallback,
        };
        const updatedErr = this.deps.repo.updateItem(input.itemId, {
          mediaMeta: errMeta as MediaMeta,
        });
        if (updatedErr) this.deps.onItemUpserted?.(updatedErr);
        return {
          ok: false,
          item: updatedErr ?? latestOnErr,
          error: res.error || transcribeErrFallback,
        };
      }
      return { ok: false, error: res.error || transcribeErrFallback };
    }

    const aiAudio = res.result;
    const latest = this.deps.repo.getItemById(input.itemId);
    if (!latest) {
      return {
        ok: false,
        error: isEn
          ? 'Note was deleted during transcription.'
          : 'Запись была удалена во время расшифровки.',
      };
    }

    if (latest.body.trim().length > 0) {
      this.deps.repo.saveItemRevision({
        itemId: latest.id,
        title: latest.title,
        content: latest.body,
        source: 'voice',
      });
    }

    let nextBody = aiAudio.transcript.trim();
    if (input.extractTasks && aiAudio.actionItems.length > 0) {
      const checklist = aiAudio.actionItems.map((t) => `- [ ] ${t}`).join('\n');
      const tasksHeading = isEn ? '## Tasks' : '## Задачи';
      nextBody = nextBody ? `${nextBody}\n\n${tasksHeading}\n${checklist}` : `${tasksHeading}\n${checklist}`;
    }

    const nextMeta: MediaMetaWithTranscriptError = {
      ...(latest.mediaMeta ?? {}),
      transcript: aiAudio.transcript,
      keyPoints: aiAudio.keyPoints,
      actionItems: aiAudio.actionItems,
    };
    delete nextMeta.transcriptError;

    const shouldReplaceTitle =
      isGenericVoiceTitle(latest.title) &&
      Boolean(aiAudio.title?.trim()) &&
      !isGenericVoiceTitle(aiAudio.title);

    const updated = this.deps.repo.updateItem(latest.id, {
      title: shouldReplaceTitle ? aiAudio.title : latest.title,
      body: nextBody,
      summary: aiAudio.summary,
      mediaMeta: nextMeta as MediaMeta,
      extractedActions: aiAudio.extractedActions,
      tags: [...new Set([...aiAudio.tags, ...latest.tags])].slice(0, 4),
      aiStatus: 'enriched',
    });

    if (updated) {
      this.deps.onItemUpserted?.(updated);
      const voiceEv = parseRussianEvent(aiAudio.transcript, undefined, undefined, locale);
      if (voiceEv?.isEventIntent) {
        const existingAuto = this.deps.repo.findCalendarEventByExternalId('vault_auto', updated.id);
        const existingLinked = this.deps.repo.findCalendarEventByLinkedItemId(updated.id);
        if (!existingAuto && !existingLinked) {
          this.syncAutoCalendarEvent(updated, voiceEv);
        }
      }
    }

    return {
      ok: true,
      item: updated ?? latest,
      transcript: aiAudio.transcript,
      extractedTasks: aiAudio.actionItems,
    };
  }

  /**
   * Lightweight local-only cover image download for already-enriched synced links
   * (e.g. unfurled on Android with a remote `ogImageUrl` but lacking local cached `imagePath`/`thumbPath`).
   * Never modifies title, body, summary, orbit, or calls cloud AI.
   */
  private async downloadLocalOgCoverOnly(itemId: string): Promise<void> {
    const item = this.deps.repo.getItemById(itemId);
    if (!item || !needsLocalOgDownload(item) || !item.ogImageUrl) return;
    const stem = item.contentHash.slice(0, 20);
    const downloaded = await downloadOgImage(item.ogImageUrl, this.mediaDir, stem);
    if (!downloaded) return;
    const thumbRes = generateThumbnailAndAnalyze(downloaded.buffer, this.mediaDir, stem);

    const latest = this.deps.repo.getItemById(itemId);
    if (!latest || !needsLocalOgDownload(latest)) {
      this.cleanupUnreferencedMedia([downloaded.filename, thumbRes.thumbPath].filter((f): f is string => Boolean(f)));
      return;
    }

    const updated = this.deps.repo.updateItem(
      itemId,
      {
        imagePath: downloaded.filename,
        thumbPath: thumbRes.thumbPath,
        ...(thumbRes.palette.length > 0 && latest.colorPalette.length === 0
          ? { colorPalette: thumbRes.palette }
          : {}),
        ...(thumbRes.isLightBanner
          ? { mediaMeta: { ...(latest.mediaMeta ?? {}), ogIsLightBanner: true } }
          : {}),
      },
      { skipAutoRevision: true }
    );
    if (updated) {
      this.deps.onItemUpserted?.(updated);
    }
  }

  private enqueueSyncedLinkEnrichmentTask(itemOrId: VaultItem | string): Promise<void> | null {
    const config = this.deps.getConfig();
    if (!config.enableUrlUnfurl) return null;
    const item =
      typeof itemOrId === 'string' ? this.deps.repo.getItemById(itemOrId) : itemOrId;
    if (!item || item.modeCaptured === 'ghost') return null;

    const isStub = isStubLinkItem(item);
    const needsCoverOnly = !isStub && needsLocalOgDownload(item);
    if (!isStub && !needsCoverOnly) return null;

    const attempts = this.syncedEnrichAttempts.get(item.id) ?? 0;
    if (attempts >= 1 || this.syncedEnrichActive.has(item.id)) {
      return null;
    }

    this.syncedEnrichAttempts.set(item.id, attempts + 1);
    this.syncedEnrichActive.add(item.id);

    const task = this.runWithBgSlot(() => {
      if (needsCoverOnly) {
        return this.downloadLocalOgCoverOnly(item.id);
      }
      const effectiveMode: CaptureMode =
        item.modeCaptured === 'buffer' || (config.activeMode === 'buffer' && !item.orbit)
          ? 'buffer'
          : 'autopilot';
      const preserveExistingOrbit = Boolean(item.orbit) || effectiveMode === 'buffer';
      return this.runBackgroundEnrichment(
        item.id,
        null,
        effectiveMode,
        false,
        preserveExistingOrbit,
        true
      );
    })
      .catch(() => {})
      .finally(() => {
        this.syncedEnrichActive.delete(item.id);
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
    return task;
  }

  /**
   * Queues bounded, deduplicated background unfurling & local cover download for synced links
   * (for example, links saved via Android Share Target while Desktop was offline).
   * Never overwrites user-edited titles/bodies, ghost items, or private links; capped at 1 auto-attempt per item per session.
   */
  public enqueueSyncedLinkEnrichment(itemOrId: VaultItem | string): boolean {
    return this.enqueueSyncedLinkEnrichmentTask(itemOrId) !== null;
  }

  /**
   * Scans link items across pages for genuine un-unfurled stubs or remote-only OG covers and queues
   * bounded chunks (`maxBatch`) for automatic background enrichment, chaining the next chunk after
   * the current batch settles while remaining strictly capped at 1 attempt per item per session.
   */
  public scanAndEnrichStubLinks(maxBatch = 12): number {
    const config = this.deps.getConfig();
    if (!config.enableUrlUnfurl || maxBatch <= 0) return 0;

    const pageSize = 200;
    let offset = 0;
    let enqueued = 0;
    let hasMore = false;
    const chunkTasks: Array<Promise<void>> = [];

    while (true) {
      const page = this.deps.repo.queryItems({ dna: 'link', limit: pageSize, offset });
      if (page.length === 0) break;

      for (const item of page) {
        if (item.modeCaptured === 'ghost') continue;
        const eligible = isStubLinkItem(item) || needsLocalOgDownload(item);
        if (!eligible) continue;
        if ((this.syncedEnrichAttempts.get(item.id) ?? 0) >= 1 || this.syncedEnrichActive.has(item.id)) {
          continue;
        }
        if (enqueued >= maxBatch) {
          hasMore = true;
          break;
        }
        const task = this.enqueueSyncedLinkEnrichmentTask(item);
        if (task) {
          enqueued += 1;
          chunkTasks.push(task);
        }
      }

      if (hasMore || page.length < pageSize) break;
      offset += pageSize;
    }

    if (hasMore && chunkTasks.length > 0) {
      const continuation = Promise.allSettled(chunkTasks)
        .then(() => {
          this.scanAndEnrichStubLinks(maxBatch);
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(continuation);
        });
      this.inFlight.add(continuation);
    }

    return enqueued;
  }

  public async reprocessItem(id: string): Promise<VaultItem | null> {
    const item = this.deps.repo.getItemById(id);
    if (!item || item.dna === 'secret' || item.dna === 'doc') return item;
    if (item.dna === 'voice') {
      const res = await this.transcribeExistingItem({ itemId: id });
      return res.item ?? this.deps.repo.getItemById(id);
    }
    const config = this.deps.getConfig();
    if (item.dna === 'link' && item.url && !config.enableUrlUnfurl) {
      return null;
    }
    const absImg = item.imagePath ? path.join(this.mediaDir, item.imagePath) : null;
    const effectiveMode: CaptureMode =
      item.modeCaptured === 'ghost'
        ? 'ghost'
        : item.dna === 'link' && (item.modeCaptured === 'buffer' || item.aiStatus === 'raw_buffer')
          ? 'buffer'
          : 'autopilot';
    const preserveExistingOrbit =
      effectiveMode === 'buffer' || (Boolean(item.orbit) && item.aiStatus !== 'raw_buffer');
    const outcome: { linkUnfurlAttempted?: boolean; linkUnfurlSucceeded?: boolean } = {};
    await this.runBackgroundEnrichment(
      id,
      absImg,
      effectiveMode,
      true,
      preserveExistingOrbit,
      false,
      false,
      false,
      outcome
    );
    if (
      item.dna === 'link' &&
      item.url &&
      outcome.linkUnfurlAttempted &&
      !outcome.linkUnfurlSucceeded
    ) {
      return null;
    }
    return this.deps.repo.getItemById(id);
  }

  public async reprocessBufferAll(): Promise<number> {
    const bufferItems = this.deps.repo.queryItems({ unassignedOnly: true, limit: 100 });
    let count = 0;
    for (const item of bufferItems) {
      if (item.dna === 'secret') continue;
      const absImg = item.imagePath ? path.join(this.mediaDir, item.imagePath) : null;
      await this.runBackgroundEnrichment(item.id, absImg, 'autopilot');
      count++;
    }
    return count;
  }
}
