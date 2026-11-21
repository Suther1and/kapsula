import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiProvider,
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
import { classifyLocally, detectContactInfo, isGenericImageTitle } from '../ai/local-heuristic';
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
import { downloadOgImage, downloadVideoAsset, sanitizeSafeExternalUrl, unfurlUrl } from './unfurler';

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
  const normRoot = process.platform === 'win32' ? realMediaDir.toLowerCase() : realMediaDir;
  const normTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
  const rel = path.relative(normRoot, normTarget);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith('../') ||
    path.isAbsolute(rel)
  ) {
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

export function isGenericVoiceTitle(raw?: string | null): boolean {
  const t = (raw ?? '').trim();
  return !t || GENERIC_VOICE_TITLE_RE.test(t);
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
  private readonly inFlight = new Set<Promise<void>>();
  private activeBgWorkers = 0;
  private readonly bgWaitQueue: Array<() => void> = [];
  private readonly maxBgConcurrency = 3;

  constructor(
    private readonly deps: {
      repo: VaultRepository;
      cryptoVault: VaultCrypto;
      dataDir: string;
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
    fs.mkdirSync(this.mediaDir, { recursive: true });
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
    filePath?: string;
    mimeType?: string;
    fileName?: string;
  }): Promise<SaveNoteImageResult> {
    let buf: Buffer | null = null;
    let ext = '.png';

    const hintMime = (input.mimeType || '').toLowerCase();
    if (hintMime.includes('jpeg') || hintMime.includes('jpg')) ext = '.jpg';
    else if (hintMime.includes('webp')) ext = '.webp';
    else if (hintMime.includes('gif')) ext = '.gif';
    else if (hintMime.includes('bmp')) ext = '.bmp';

    if (input.base64) {
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
        throw new Error('Изображение слишком большое (максимум 25 МБ)');
      }
      buf = Buffer.from(cleaned, 'base64');
      if (buf.length > MAX_NOTE_IMAGE_BYTES) {
        throw new Error('Изображение слишком большое (максимум 25 МБ)');
      }
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      const stat = fs.statSync(input.filePath);
      if (!stat.isFile()) {
        throw new Error('Изображение пустое или не найдено');
      }
      if (stat.size > MAX_NOTE_IMAGE_BYTES) {
        throw new Error('Изображение слишком большое (максимум 25 МБ)');
      }
      const parsedExt = path.extname(input.filePath).toLowerCase();
      if (parsedExt && !ALLOWED_IMAGE_EXTS.has(parsedExt)) {
        throw new Error('Неподдерживаемый формат изображения');
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
      throw new Error('Изображение пустое или не найдено');
    }

    const magicExt = detectImageExtFromMagic(buf);
    if (!magicExt) {
      throw new Error('Файл не является поддерживаемым изображением');
    }
    ext = magicExt;

    fs.mkdirSync(this.mediaDir, { recursive: true });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const stem = sha.slice(0, 24);
    const filename = `${stem}${ext}`;
    const absPath = path.join(this.mediaDir, filename);
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf);
    }

    let thumbFilename: string | undefined;
    try {
      const thumbRes = generateThumbnailAndAnalyze(buf, this.mediaDir, stem);
      if (thumbRes.thumbPath) {
        thumbFilename = thumbRes.thumbPath;
      }
    } catch {
      // Optional thumbnail — never block inline image insertion
    }

    return {
      filename,
      mediaUrl: `kapsula-media://local/${filename}`,
      thumbFilename,
    };
  }

  public cleanupUnreferencedMedia(filenames: Array<string | null | undefined>): void {
    for (const raw of filenames) {
      if (!raw) continue;
      const safe = path.basename(raw);
      if (!safe || safe === '.') continue;
      try {
        if (this.deps.repo.countItemsByMediaRef(safe) === 0) {
          const abs = path.join(this.mediaDir, safe);
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            fs.unlinkSync(abs);
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
    let ext = '.png';

    if (input.imageBase64) {
      const cleaned = input.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
      if (input.imageBase64.startsWith('data:image/jpeg')) ext = '.jpg';
      else if (input.imageBase64.startsWith('data:image/webp')) ext = '.webp';
    } else if (input.imageFilePath && fs.existsSync(input.imageFilePath)) {
      buf = fs.readFileSync(input.imageFilePath);
      const parsedExt = path.extname(input.imageFilePath).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(parsedExt)) {
        ext = parsedExt;
      }
    }

    if (!buf || buf.length === 0) {
      return { filename: null, absPath: null, sha: '', buffer: null };
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const filename = `${sha.slice(0, 24)}${ext}`;
    const absPath = path.join(this.mediaDir, filename);
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf);
    }
    return { filename, absPath, sha, buffer: buf };
  }

  private async captureAudioInternal(input: CaptureInput): Promise<VaultItem> {
    const config = this.deps.getConfig();
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    if (input.externalId) {
      const existing = this.deps.repo.findBySourceExternalId(source, input.externalId);
      if (existing) return existing;
    }

    let buf: Buffer;
    if (input.audioBase64) {
      const cleaned = input.audioBase64.replace(/^data:audio\/[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error('Аудиоданные не найдены');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const saved = saveAudioAsset(this.mediaDir, sha.slice(0, 24), buf, input.audioMime);
    const durLabel =
      input.audioDurationSec && input.audioDurationSec > 0
        ? formatDurationCompact(input.audioDurationSec)
        : null;
    const caption = (input.text ?? '').trim();
    const hasExplicitTitle = Boolean(input.title?.trim());
    const initialTitle =
      input.title?.trim() ||
      (durLabel ? `Голосовая заметка · ${durLabel}` : 'Голосовая заметка');

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
            ? `Голосовая заметка · ${durLabel}`
            : 'Голосовая заметка сохранена.'
          : durLabel
            ? `Длительность ${durLabel}. Расшифровка готовится…`
            : 'Голосовая заметка сохранена.',
      mediaPath: saved.filename,
      mediaType: saved.mime,
      mediaDurationSec: input.audioDurationSec ?? null,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: input.fileName,
        fileSize: saved.byteLength,
      },
      extractedActions: extractActionsFromText(caption),
      tags: [...new Set(['голос', ...(input.tags ?? [])])].slice(0, 4),
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
          onSpendUsd: (usd) => {
            if (usd > 0) this.deps.repo.logAiUsage(cfg.aiProvider, 'audio-intelligence', 600, 180, usd);
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

    if (input.fileBase64) {
      const cleaned = input.fileBase64.replace(/^data:[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error('Файл документа не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const saved = saveDocumentAsset(this.mediaDir, sha.slice(0, 24), buf, fileName, input.fileMime);
    const hasExplicitTitle = Boolean(input.title?.trim());
    const rawFileTitle =
      input.title?.trim() ||
      saved.safeOriginalName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
      'Документ';
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
      summary: `Файл ${saved.ext.toUpperCase()} сохранён — извлекаем текст и тезисы…`,
      mediaPath: saved.storedFileName,
      mediaType: saved.mime,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: saved.safeOriginalName,
        fileSize: saved.byteLength,
      },
      tags: [...new Set([saved.ext, 'файл', ...(input.tags ?? [])])].slice(0, 4),
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
          onSpendUsd: (usd) => {
            if (usd > 0) this.deps.repo.logAiUsage(cfg.aiProvider, 'doc-summary', 500, 120, usd);
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
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'vault_ui';

    let buf: Buffer;
    let ext = '.mp4';
    const rawName = input.fileName || (input.videoPath ? path.basename(input.videoPath) : 'video-reference.mp4');
    const parsedExt = path.extname(rawName).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.m4v'].includes(parsedExt)) {
      ext = parsedExt;
    }

    if (input.videoBase64) {
      const cleaned = input.videoBase64.replace(/^data:video\/[^;]+;base64,/, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.videoPath && fs.existsSync(input.videoPath)) {
      buf = fs.readFileSync(input.videoPath);
    } else {
      throw new Error('Видеофайл не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const filename = `vid_${sha.slice(0, 24)}${ext}`;
    const absPath = path.join(this.mediaDir, filename);
    fs.mkdirSync(this.mediaDir, { recursive: true });
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, buf);
    }

    const videoMime =
      input.videoMime ||
      (ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4');
    const cleanTitle =
      input.title?.trim() ||
      rawName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
      'Видеореференс';

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
      summary: `Видеореференс · ${rawName}`,
      mediaPath: filename,
      mediaType: videoMime,
      mediaDurationSec: input.videoDurationSec ?? null,
      mediaMeta: {
        ...(input.mediaMeta ?? {}),
        fileName: rawName,
        fileSize: buf.length,
      },
      tags: [...new Set(['видео', 'референс', ...(input.tags ?? [])])].slice(0, 4),
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
    const mode: CaptureMode = input.mode ?? config.activeMode;
    const source = input.source ?? 'email_import';

    let buf: Buffer;
    const fileName =
      input.fileName || (input.filePath ? path.basename(input.filePath) : 'message.eml');

    if (input.fileBase64) {
      const cleaned = input.fileBase64.replace(/^data:[^;]+;base64,/i, '');
      buf = Buffer.from(cleaned, 'base64');
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      buf = fs.readFileSync(input.filePath);
    } else {
      throw new Error('Файл письма (.eml) не найден');
    }

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const parsed = parseEmlBuffer(buf);
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

    const noteBody = formatEmailAsNoteMarkdown(parsed, savedImages);
    const fallbackFileTitle =
      fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Письмо';
    const finalTitle =
      input.title?.trim() ||
      (parsed.subject && parsed.subject !== 'Письмо без темы' ? parsed.subject : fallbackFileTitle);
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
      extractedActions: extractActionsFromText(noteBody),
      tags: [...new Set(['письмо', ...(input.tags ?? [])])].slice(0, 4),
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
    if (input.audioBase64) {
      return this.captureAudioInternal(input);
    }
    if (input.videoBase64 || input.videoPath) {
      return this.captureVideoInternal(input);
    }
    const candidateFilePath = input.filePath || input.fileName || '';
    const candidateExt = path.extname(candidateFilePath).toLowerCase();
    if (
      (input.filePath || input.fileBase64) &&
      (candidateExt === '.eml' || (input.fileMime ?? '').toLowerCase().includes('rfc822'))
    ) {
      return this.captureEmailInternal(input);
    }
    if (
      (input.filePath || input.fileBase64) &&
      (['.mp4', '.webm', '.mov', '.m4v'].includes(candidateExt) ||
        (input.fileMime ?? '').startsWith('video/'))
    ) {
      return this.captureVideoInternal({
        ...input,
        videoPath: input.filePath,
        videoBase64: input.fileBase64,
        videoMime: input.fileMime,
      });
    }
    if (input.fileBase64 || input.filePath) {
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
    const secretScanText = [safeExplicitTitle, rawText, input.url].filter(Boolean).join('\n');
    const secretCheck = analyzeForSecret(secretScanText, {
      forceSecret: mode === 'ghost' || input.forceSecret,
      service: input.secretOverride?.service,
      login: input.secretOverride?.login,
      notes: input.secretOverride?.notes,
    });

    if (secretCheck.isSecret && secretCheck.payload && secretCheck.meta) {
      // Fail closed cleanly before storing or unlinking any media when Vault is PIN-locked
      if (this.deps.cryptoVault.isLocked()) {
        throw new Error(
          'Сейф заблокирован мастер-кодом — разблокируй Сейф, чтобы безопасно сохранить секрет'
        );
      }

      const secretImgAsset = await this.storeImageAsset(input);
      const payloadToEncrypt = { ...secretCheck.payload };
      if (secretImgAsset.filename && secretImgAsset.absPath) {
        let ocrSecretText = '';
        if (config.enableAutoOcr && !input.isDemo) {
          const ocr = await defaultLocalOcrAdapter.extractText(
            secretImgAsset.absPath,
            this.deps.dataDir
          );
          ocrSecretText = ocr.text;
        }
        if (!payloadToEncrypt.secretValue) {
          payloadToEncrypt.secretValue = ocrSecretText || '[Скриншот в Сейфе]';
        } else if (ocrSecretText) {
          payloadToEncrypt.notes = [payloadToEncrypt.notes, ocrSecretText].filter(Boolean).join('\n\n');
        }
      }

      const encrypted = this.deps.cryptoVault.encryptSecret(payloadToEncrypt);
      const isBankCard = secretCheck.meta.kind === 'bank_card';
      const defaultSecretTitle = isBankCard
        ? secretCheck.meta.service
        : `${secretCheck.meta.service} · Доступ`;

      const targetSecretOrbit = this.resolveSecretOrbitId(secretCheck.meta.kind, explicitOrbit);
      const humanSummary = isBankCard
        ? 'Банковская карта · скрыта в Сейфе'
        : secretCheck.meta.kind === 'api_key'
          ? 'Ключ доступа · скрыт в Сейфе'
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
        tags: [...new Set([...(input.tags ?? []), isBankCard ? 'карта' : 'сейф'])].slice(0, 4),
        source,
        externalId: input.externalId ?? null,
        // Never store unsalted SHA-256 of raw plaintext secret in SQLite
        contentHash: crypto.randomUUID(),
        aiStatus: 'skipped_secret',
        remindAt: input.remindAt ?? null,
        isDemo: input.isDemo ?? false,
        createdAt: input.createdAt,
      });
      if (secretImgAsset.filename) {
        this.cleanupUnreferencedMedia([secretImgAsset.filename]);
      }
      if (created.remindAt) this.deps.onReminderChanged?.();
      this.deps.onItemUpserted?.(created);
      return created;
    }

    const imgAsset = await this.storeImageAsset(input);
    let hasImage = Boolean(imgAsset.filename);
    const hashSource = `${rawText}|${input.url ?? ''}|${imgAsset.sha}`;
    const contentHash = crypto.createHash('sha256').update(hashSource).digest('hex');

    // 1.5. Pre-persist OCR Secret Shield check for screenshots (prevents OCR-before-Sync race
    // where a plaintext bank-card/password screenshot could be synced before OCR scrubs it).
    let preScannedOcrText = '';
    let ocrPreScanned = false;
    const isDirectScreenshot =
      hasImage &&
      Boolean(imgAsset.absPath) &&
      config.enableAutoOcr &&
      !input.isDemo &&
      !(source === 'browser_ext' && Boolean(input.url));

    if (isDirectScreenshot && imgAsset.absPath) {
      const preOcr = await Promise.race([
        defaultLocalOcrAdapter.extractText(imgAsset.absPath, this.deps.dataDir).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (preOcr) {
        ocrPreScanned = true;
        preScannedOcrText = preOcr.text || '';
        if (preScannedOcrText) {
          const ocrSecret = analyzeForSecret(preScannedOcrText);
          if (ocrSecret.isSecret && ocrSecret.payload && ocrSecret.meta) {
            if (this.deps.cryptoVault.isLocked()) {
              // Fail closed: remove our temporary copy inside media/ without persisting plaintext secret
              this.cleanupUnreferencedMedia([imgAsset.filename]);
              throw new Error(
                'Сейф заблокирован мастер-кодом — на скриншоте найдены конфиденциальные данные. Разблокируй Сейф и повтори сохранение'
              );
            }
            const encrypted = this.deps.cryptoVault.encryptSecret(ocrSecret.payload);
            const isBankCard = ocrSecret.meta.kind === 'bank_card';
            const secretTitle = isBankCard
              ? ocrSecret.meta.last4
                ? `${ocrSecret.meta.service} · •••• ${ocrSecret.meta.last4}`
                : ocrSecret.meta.service
              : `${ocrSecret.meta.service} · Доступ`;
            const targetSecretOrbit = this.resolveSecretOrbitId(ocrSecret.meta.kind, explicitOrbit);
            const createdSecret = this.deps.repo.createItem({
              dna: 'secret',
              orbit: targetSecretOrbit,
              modeCaptured: mode,
              focusBoardId:
                input.focusBoardId ?? (mode === 'focus' ? config.activeFocusBoardId : null),
              title: safeExplicitTitle || secretTitle,
              body: '',
              summary: 'Найдено на скриншоте · скрыто в Сейфе',
              imagePath: null,
              thumbPath: null,
              ogImageUrl: null,
              ocrText: '',
              extractedActions: [],
              encryptedPayload: encrypted,
              secretMeta: ocrSecret.meta,
              tags: [...new Set([...(input.tags ?? []), isBankCard ? 'карта' : 'сейф'])].slice(0, 4),
              source,
              externalId: input.externalId ?? null,
              contentHash: crypto.randomUUID(),
              aiStatus: 'skipped_secret',
              remindAt: input.remindAt ?? null,
              isDemo: input.isDemo ?? false,
              createdAt: input.createdAt,
            });
            // Delete temporary plaintext screenshot copy only after encrypted secret is safely persisted
            this.cleanupUnreferencedMedia([imgAsset.filename]);
            if (createdSecret.remindAt) this.deps.onReminderChanged?.();
            this.deps.onItemUpserted?.(createdSecret);
            return createdSecret;
          }
        }
      }
    }

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
    });

    let effectiveBody = cleanText;
    let effectiveTitle = cleanExplicitTitle || local.title;
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

    if (local.dna === 'link' && local.url && config.enableUrlUnfurl && !input.isDemo) {
      const og = await Promise.race([
        unfurlUrl(local.url).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5500)),
      ]);
      if (og) {
        if (og.domain) effectiveDomain = og.domain;
        if (og.platform) effectivePlatform = og.platform;
        if (
          og.title &&
          !cleanExplicitTitle &&
          (!effectiveTitle ||
            effectiveTitle === local.domain ||
            effectiveTitle === local.url ||
            effectiveTitle.startsWith('Ссылка'))
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
        if (og.author || og.publishedAt || og.videoUrl) {
          syncMediaMeta = {
            ...(syncMediaMeta ?? {}),
            forwardAuthor: og.author ?? syncMediaMeta?.forwardAuthor,
            publishedAt: og.publishedAt ?? syncMediaMeta?.publishedAt,
            videoUrl: og.videoUrl ?? syncMediaMeta?.videoUrl,
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
      ...extractActionsFromText(`${effectiveBody}\n${preScannedOcrText}\n${input.url ?? ''}`),
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

    const isBlankDraftNote = !hasImage && !local.url && rawText === 'Новая заметка';
    const needsBackground =
      !isBlankDraftNote &&
      !local.isFleetingScratch &&
      ((hasImage && config.enableAutoOcr) ||
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
      } else if (!(input.url && rawText.trim() === input.url.trim())) {
        const parsedEv = parseRussianEvent(rawText);
        if (parsedEv?.isEventIntent) {
          this.syncAutoCalendarEvent(created, parsedEv);
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
          ocrPreScanned
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
    ocrAlreadyScanned = false
  ): Promise<void> {
    const current = this.deps.repo.getItemById(itemId);
    if (
      !current ||
      current.dna === 'secret' ||
      current.dna === 'voice' ||
      current.dna === 'doc' ||
      mode === 'ghost'
    ) {
      return;
    }

    const initialTitle = current.title;
    const initialOrbit = current.orbit;
    const initialTagsJson = JSON.stringify(current.tags);

    const config = this.deps.getConfig();
    let ocrText = current.ocrText;
    let title = isGenericImageTitle(current.title) ? 'Скриншот' : current.title;
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

    // A. Offline OCR via platform adapter for screenshots (kept silent for search — never dumped as card text)
    if (imgAbsPath && current.dna !== 'link' && config.enableAutoOcr && !ocrAlreadyScanned) {
      const ocr = await defaultLocalOcrAdapter.extractText(imgAbsPath, this.deps.dataDir);
      if (ocr.text) {
        ocrText = ocr.text;

        const ocrSecret = analyzeForSecret(ocrText);
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
              title: 'Скриншот удалён для защиты · Kapsula',
              body: 'На скриншоте найдены конфиденциальные данные, но Сейф сейчас заблокирован. Разблокируй Сейф и сохрани их снова.',
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
              : `${ocrSecret.meta.service} · Доступ`;

          const updatedSecret = this.deps.repo.updateItem(itemId, {
            dna: 'secret',
            orbit: keepOrbit,
            title: secretTitle,
            body: '',
            summary: 'Найдено на скриншоте · скрыто в Сейфе',
            imagePath: null,
            thumbPath: null,
            ogImageUrl: null,
            ocrText: '',
            extractedActions: [],
            encryptedPayload: encrypted,
            secretMeta: ocrSecret.meta,
            tags: [...new Set([...latestBeforeSecret.tags, 'сейф'])].slice(0, 4),
            aiStatus: 'skipped_secret',
          });
          this.cleanupUnreferencedMedia([prevImg, prevThumb]);
          if (updatedSecret) this.deps.onItemUpserted?.(updatedSecret);
          return;
        }

        for (const act of extractActionsFromText(ocr.text)) {
          pushUniqueAction(act);
        }
      }
    }

    // B. Deep multi-platform link unfurl (`t.me`, `x.com`, `youtube`, `github`, `instagram`, articles)
    // Skip re-fetching if synchronous capture() already populated full content (unless manually re-analyzed)
    const alreadyUnfurled =
      current.dna === 'link' &&
      Boolean(current.title && current.title !== current.domain && current.title !== current.url) &&
      Boolean(current.body && current.body.trim() !== (current.url || '').trim());

    if (current.url && config.enableUrlUnfurl && (!alreadyUnfurled || bypassCache)) {
      const og = await unfurlUrl(current.url);
      if (og.domain) domain = og.domain;
      if (og.platform) platform = og.platform;
      if (
        og.title &&
        (title === current.domain ||
          title.startsWith('Ссылка') ||
          title === current.url ||
          isGenericImageTitle(title))
      ) {
        title = og.title;
      }
      if (og.description && (!summary || summary === current.url || summary.startsWith('Сохранённая ссылка'))) {
        summary = og.description;
      }
      if (
        og.bodyMarkdown &&
        (!body.trim() || body.trim() === current.url.trim())
      ) {
        body = og.bodyMarkdown;
      }
      if (og.author || og.publishedAt || og.videoUrl) {
        mediaMeta = {
          ...(mediaMeta ?? {}),
          forwardAuthor: og.author ?? mediaMeta?.forwardAuthor,
          publishedAt: og.publishedAt ?? mediaMeta?.publishedAt,
          videoUrl: og.videoUrl ?? mediaMeta?.videoUrl,
        };
      }
      for (const act of og.extractedLinks) {
        pushUniqueAction(act);
      }

      if (og.ogImageUrl) {
        ogImageUrl = og.ogImageUrl;
        if (!imagePath && !thumbPath) {
          const downloaded = await downloadOgImage(
            og.ogImageUrl,
            this.mediaDir,
            current.contentHash.slice(0, 20)
          );
          if (downloaded) {
            imagePath = downloaded.filename;
            const thumbRes = generateThumbnailAndAnalyze(
              downloaded.buffer,
              this.mediaDir,
              current.contentHash.slice(0, 20)
            );
            thumbPath = thumbRes.thumbPath;
            if (thumbRes.palette.length > 0 && colorPalette.length === 0) {
              colorPalette = thumbRes.palette;
            }
            if (thumbRes.isLightBanner) {
              mediaMeta = { ...(mediaMeta ?? {}), ogIsLightBanner: true };
            }
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

      // Download embeddable post video (e.g. Telegram t.me `.mp4`) for inline playback
      if (og.videoUrl && !mediaPath) {
        const dlVid = await downloadVideoAsset(
          og.videoUrl,
          this.mediaDir,
          current.contentHash.slice(0, 20)
        );
        if (dlVid) {
          mediaPath = dlVid.filename;
          mediaType = dlVid.mime;
          mediaDurationSec = og.videoDurationSec ?? mediaDurationSec;
        }
      }
    }

    // C. Multimodal Vision AI enrichment for screenshots, social post media, & empty-body links
    // Skip Vision on generic web og:image banners when we already extracted clean title + description/body
    const effectiveImgAbs = imgAbsPath || (imagePath ? path.join(this.mediaDir, imagePath) : null);
    const isSocialPostWithMedia =
      platform === 'telegram' || platform === 'instagram' || platform === 'x';
    const linkNeedsVisualBody =
      current.dna === 'link' && (!body.trim() || body.trim() === (current.url || '').trim());
    const shouldRunVision =
      current.dna !== 'link' || isSocialPostWithMedia || linkNeedsVisualBody;
    if (
      shouldRunVision &&
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
          visionTitle = vision.title;
          visionSummary = vision.summary || null;
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
            if (vision.title) title = vision.title;
            if (vision.summary) summary = vision.summary;
            if (vision.bodyMarkdown && !body.trim()) {
              body = vision.bodyMarkdown;
            }
          } else if (vision.bodyMarkdown && (!body.trim() || body.trim() === current.url)) {
            body = vision.bodyMarkdown;
          } else if (vision.bodyMarkdown && body.trim() && !body.includes(vision.bodyMarkdown.slice(0, 40))) {
            body = `${body.trim()}\n\n### На изображении\n${vision.bodyMarkdown}`;
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
        title !== latestMid.domain &&
        !title.startsWith('Ссылка') &&
        !isGenericImageTitle(title)
          ? title
          : null,
      ocrText,
      hasImage: Boolean(imagePath || latestMid.imagePath),
      orbits,
      extraTags: [...latestMid.tags, ...visionTags],
      subKindHint: latestMid.subKind,
      preferLinkForUrlWithImage: latestMid.dna === 'link' && Boolean(latestMid.url),
    });

    if (localRecheck.mediaMetaPatch) {
      mediaMeta = { ...(localRecheck.mediaMetaPatch), ...(mediaMeta ?? {}) };
    }

    const chosenLocalTitle = visionTitle || (isGenericImageTitle(localRecheck.title) ? 'Скриншот' : localRecheck.title);
    const chosenLocalSummary = visionSummary || summary || localRecheck.summary;

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

    const bestFinalTitle =
      visionTitle ||
      (!isGenericImageTitle(aiResult.title) ? aiResult.title : chosenLocalTitle);
    const bestFinalSummary = visionSummary || aiResult.summary || chosenLocalSummary;

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
    const item = this.deps.repo.getItemById(input.itemId);
    if (!item) {
      return { ok: false, error: 'Запись не найдена.' };
    }
    if (item.dna === 'secret') {
      return { ok: false, error: 'Записи из Сейфа не отправляются в облачный ИИ.' };
    }

    const audioPath = item.mediaPath
      ? path.join(this.mediaDir, path.basename(item.mediaPath))
      : undefined;
    const hasDiskAudio = Boolean(audioPath && fs.existsSync(audioPath));
    if (!hasDiskAudio && !input.wavBase64Fallback) {
      return { ok: false, item, error: 'Аудиофайл этой записи не найден на диске.' };
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
      onSpendUsd: (usd) => {
        if (usd > 0) this.deps.repo.logAiUsage(cfg.aiProvider, 'audio-transcribe', 600, 220, usd);
      },
      fetchFn: this.deps.fetchFn,
    });

    if (!res.ok || !res.result) {
      const latestOnErr = this.deps.repo.getItemById(input.itemId);
      if (latestOnErr) {
        const errMeta: MediaMetaWithTranscriptError = {
          ...(latestOnErr.mediaMeta ?? {}),
          transcriptError: res.error || 'Не удалось расшифровать запись.',
        };
        const updatedErr = this.deps.repo.updateItem(input.itemId, {
          mediaMeta: errMeta as MediaMeta,
        });
        if (updatedErr) this.deps.onItemUpserted?.(updatedErr);
        return {
          ok: false,
          item: updatedErr ?? latestOnErr,
          error: res.error || 'Не удалось расшифровать запись.',
        };
      }
      return { ok: false, error: res.error || 'Не удалось расшифровать запись.' };
    }

    const aiAudio = res.result;
    const latest = this.deps.repo.getItemById(input.itemId);
    if (!latest) {
      return { ok: false, error: 'Запись была удалена во время расшифровки.' };
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
      nextBody = nextBody ? `${nextBody}\n\n## Задачи\n${checklist}` : `## Задачи\n${checklist}`;
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
      const voiceEv = parseRussianEvent(aiAudio.transcript);
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

  public async reprocessItem(id: string): Promise<VaultItem | null> {
    const item = this.deps.repo.getItemById(id);
    if (!item || item.dna === 'secret' || item.dna === 'doc') return item;
    if (item.dna === 'voice') {
      const res = await this.transcribeExistingItem({ itemId: id });
      return res.item ?? this.deps.repo.getItemById(id);
    }
    const absImg = item.imagePath ? path.join(this.mediaDir, item.imagePath) : null;
    const preserveExistingOrbit = Boolean(item.orbit) && item.aiStatus !== 'raw_buffer';
    await this.runBackgroundEnrichment(id, absImg, 'autopilot', true, preserveExistingOrbit);
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
