import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoCacheStats } from '@shared/types';

export const DEFAULT_VIDEO_CACHE_LIMIT_MB = 500;
export const ALLOWED_VIDEO_CACHE_LIMITS_MB = [250, 500, 1024, 2048] as const;
export const MAX_VIDEO_FILE_BYTES = 60 * 1024 * 1024; // 60 MB hard single-file ceiling
export const MIN_VIDEO_FILE_BYTES = 1024;

const WINDOWS_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const SAFE_BASENAME_RE = /^[a-zA-Z0-9._-]+$/;

export function sanitizeVideoCacheLimitMb(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_VIDEO_CACHE_LIMIT_MB;
  for (const allowed of ALLOWED_VIDEO_CACHE_LIMITS_MB) {
    if (Math.round(num) === allowed) return allowed;
  }
  return Math.max(250, Math.min(2048, Math.round(num)));
}

export function sanitizeCacheFilename(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.trim());
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('..')) {
    return null;
  }
  const base = path.basename(decoded);
  if (
    !base ||
    base === '.' ||
    base === '..' ||
    base.startsWith('.tmp-') ||
    !SAFE_BASENAME_RE.test(base) ||
    WINDOWS_RESERVED_NAME_RE.test(base)
  ) {
    return null;
  }
  return base;
}

export type HttpByteRangeResult =
  | { status: 200 }
  | { status: 416 }
  | { status: 206; start: number; end: number };

/**
 * RFC 9110 byte-range parser handling explicit ranges (`bytes=a-b`),
 * open-ended ranges (`bytes=a-`), and suffix ranges (`bytes=-n`).
 */
export function parseHttpByteRange(rangeHeader: string | null, totalSize: number): HttpByteRangeResult {
  if (!rangeHeader || totalSize <= 0) return { status: 200 };
  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) return { status: 416 };

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw && !endRaw) return { status: 416 };

  if (!startRaw) {
    // Suffix byte-range-spec: `bytes=-N` -> last N bytes
    const suffixLen = Number(endRaw);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { status: 416 };
    const start = Math.max(0, totalSize - suffixLen);
    const end = totalSize - 1;
    return { status: 206, start, end };
  }

  const start = Number(startRaw);
  const end = endRaw ? Math.min(totalSize - 1, Number(endRaw)) : totalSize - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    start >= totalSize
  ) {
    return { status: 416 };
  }
  return { status: 206, start, end };
}

export class VideoCacheManager {
  private limitMb: number;
  private readonly realCacheDir: string;

  constructor(
    private readonly cacheDir: string,
    limitMb: number = DEFAULT_VIDEO_CACHE_LIMIT_MB
  ) {
    this.limitMb = sanitizeVideoCacheLimitMb(limitMb);
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    this.realCacheDir = (fs.realpathSync.native ?? fs.realpathSync)(this.cacheDir);
  }

  public getCacheDir(): string {
    return this.cacheDir;
  }

  public getLimitMb(): number {
    return this.limitMb;
  }

  public setLimitMb(nextMb: number): VideoCacheStats {
    this.limitMb = sanitizeVideoCacheLimitMb(nextMb);
    this.evictToBudget();
    return this.getStats();
  }

  public ensureDir(): void {
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  public resolveSafePath(rawPart: string):
    | { ok: true; safeName: string; filePath: string; stat: fs.Stats }
    | { ok: false; status: 400 | 403 | 404 } {
    const safeName = sanitizeCacheFilename(rawPart);
    if (!safeName) return { ok: false, status: 400 };
    const joined = path.resolve(this.cacheDir, safeName);
    let realTarget: string;
    let stat: fs.Stats;
    try {
      realTarget = (fs.realpathSync.native ?? fs.realpathSync)(joined);
      stat = fs.statSync(realTarget);
    } catch {
      return { ok: false, status: 404 };
    }
    const rel = path.relative(this.realCacheDir, realTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, status: 403 };
    }
    if (!stat.isFile()) return { ok: false, status: 404 };
    return { ok: true, safeName, filePath: realTarget, stat };
  }

  public touch(filename: string): void {
    const resolved = this.resolveSafePath(filename);
    if (!resolved.ok) return;
    try {
      const now = new Date();
      fs.utimesSync(resolved.filePath, now, now);
    } catch {
      // ignore non-fatal mtime update errors
    }
  }

  public putBuffer(
    buf: Buffer,
    stem: string,
    ext: '.mp4' | '.webm' = '.mp4'
  ): { filename: string; mime: string; byteLength: number } | null {
    if (!buf || buf.length < MIN_VIDEO_FILE_BYTES || buf.length > MAX_VIDEO_FILE_BYTES) {
      return null;
    }
    this.ensureDir();
    const cleanStem = (stem || 'vid').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 14) || 'vid';
    const hashShort = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const filename = `vc_${cleanStem}_${hashShort}${ext}`;
    const finalPath = path.join(this.cacheDir, filename);
    const tmpPath = path.join(this.cacheDir, `.tmp-${crypto.randomUUID()}${ext}`);

    try {
      fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
      fs.renameSync(tmpPath, finalPath);
      const now = new Date();
      try {
        fs.utimesSync(finalPath, now, now);
      } catch {
        // ignore
      }
      this.evictToBudget();
      return {
        filename,
        mime: ext === '.webm' ? 'video/webm' : 'video/mp4',
        byteLength: buf.length,
      };
    } catch {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      return null;
    }
  }

  private listEntries(): Array<{ name: string; filePath: string; size: number; mtimeMs: number; atimeMs: number }> {
    this.ensureDir();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.cacheDir);
    } catch {
      return [];
    }
    const entries: Array<{ name: string; filePath: string; size: number; mtimeMs: number; atimeMs: number }> = [];
    for (const name of names) {
      if (name.startsWith('.tmp-')) continue;
      const safe = sanitizeCacheFilename(name);
      if (!safe) continue;
      const fp = path.join(this.cacheDir, safe);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        entries.push({
          name: safe,
          filePath: fp,
          size: st.size,
          mtimeMs: st.mtimeMs,
          atimeMs: st.atimeMs,
        });
      } catch {
        // ignore
      }
    }
    return entries;
  }

  public evictToBudget(limitMbOverride?: number): void {
    const budgetMb = limitMbOverride !== undefined ? sanitizeVideoCacheLimitMb(limitMbOverride) : this.limitMb;
    const budgetBytes = budgetMb * 1024 * 1024;
    const entries = this.listEntries();
    let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes <= budgetBytes) return;

    // Evict least-recently-used (oldest mtimeMs, tie-break oldest atimeMs)
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.atimeMs - b.atimeMs);
    for (const entry of entries) {
      if (totalBytes <= budgetBytes) break;
      try {
        fs.unlinkSync(entry.filePath);
        totalBytes -= entry.size;
      } catch {
        // ignore
      }
    }
  }

  public getStats(): VideoCacheStats {
    const entries = this.listEntries();
    const bytesUsed = entries.reduce((sum, e) => sum + e.size, 0);
    return {
      bytesUsed,
      fileCount: entries.length,
      limitMb: this.limitMb,
    };
  }

  public clear(): VideoCacheStats {
    const entries = this.listEntries();
    for (const entry of entries) {
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        // ignore
      }
    }
    return {
      bytesUsed: 0,
      fileCount: 0,
      limitMb: this.limitMb,
    };
  }
}
