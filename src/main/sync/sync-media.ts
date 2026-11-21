import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SYNC_STORAGE_BUCKET,
  type SyncMediaRef,
} from '@shared/sync-contract';
import type { VaultRepository } from '../db/repository';
import {
  computePlaintextSha256,
  decryptMediaBlob,
  deriveOpaqueBlobId,
  encryptMediaBlob,
} from './sync-crypto';

const MAX_SYNC_BLOB_BYTES = 48 * 1024 * 1024; // 48 MB plaintext cap (fits comfortably under 50 MB bucket limit)
const BLOB_ID_RE = /^[a-f0-9]{64}$/i;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function sanitizeMediaFilename(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:')
  ) {
    return null;
  }
  // Cross-platform basename stripping both '/' and '\'
  const parts = trimmed.split(/[\\/]+/);
  const base = parts[parts.length - 1]?.trim() ?? '';
  if (
    !base ||
    base === '.' ||
    base === '..' ||
    base.includes('\0') ||
    base.includes(':') ||
    base.includes('..') ||
    /[\x00-\x1f<>|"?*]/.test(base) ||
    WINDOWS_RESERVED_RE.test(base)
  ) {
    return null;
  }
  return base;
}

export class SyncMediaManager {
  private readonly resolvedMediaRoot: string;

  constructor(
    private readonly mediaDir: string,
    private readonly repo: VaultRepository
  ) {
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.resolvedMediaRoot = path.resolve(this.mediaDir);
  }

  private resolveSafePath(localName: string): string | null {
    const safe = sanitizeMediaFilename(localName);
    if (!safe) return null;
    const resolved = path.resolve(this.resolvedMediaRoot, safe);
    if (!resolved.startsWith(this.resolvedMediaRoot + path.sep)) {
      return null;
    }
    return resolved;
  }

  public async ensureUploaded(
    client: SupabaseClient,
    userId: string,
    dek: Buffer,
    localNames: Array<string | null | undefined>
  ): Promise<{ refs: SyncMediaRef[]; uploadedCount: number }> {
    const uniqueNames = Array.from(
      new Set(
        localNames
          .map((n) => sanitizeMediaFilename(n))
          .filter((n): n is string => Boolean(n))
      )
    );
    const refs: SyncMediaRef[] = [];
    let uploadedCount = 0;

    for (const localName of uniqueNames) {
      const fullPath = this.resolveSafePath(localName);
      if (!fullPath) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SYNC_BLOB_BYTES) {
        continue;
      }

      const ext = path.extname(localName).toLowerCase().slice(0, 16);
      const cached = this.repo.getBlobCache(localName);
      if (
        cached &&
        cached.byteSize === stat.size &&
        Math.abs(cached.mtimeMs - stat.mtimeMs) < 1 &&
        cached.uploadedForUser === userId
      ) {
        refs.push({
          localName,
          blobId: cached.blobId,
          ext,
          byteSize: cached.byteSize,
        });
        continue;
      }

      const plaintext = await fs.promises.readFile(fullPath);
      const sha256 = computePlaintextSha256(plaintext);
      const blobId = deriveOpaqueBlobId(dek, sha256);

      // Cross-device dedup check in sync_blobs
      const { data: existingBlob, error: lookupErr } = await client
        .from('sync_blobs')
        .select('blob_id')
        .eq('user_id', userId)
        .eq('blob_id', blobId)
        .maybeSingle();
      if (lookupErr) {
        const isEn = this.repo.getLocale() === 'en';
        throw new Error(
          isEn
            ? `Failed to verify file ${localName}: ${lookupErr.message}`
            : `Ошибка проверки файла ${localName}: ${lookupErr.message}`
        );
      }

      if (!existingBlob) {
        const encryptedBuf = encryptMediaBlob(dek, userId, blobId, plaintext);
        const storagePath = `${userId}/${blobId}.enc`;
        const { error: uploadErr } = await client.storage
          .from(SYNC_STORAGE_BUCKET)
          .upload(storagePath, encryptedBuf, {
            contentType: 'application/octet-stream',
            upsert: true,
          });
        if (uploadErr) {
          const isEn = this.repo.getLocale() === 'en';
          throw new Error(
            isEn
              ? `Failed to upload file ${localName}: ${uploadErr.message}`
              : `Ошибка загрузки файла ${localName}: ${uploadErr.message}`
          );
        }

        const { error: regErr } = await client.from('sync_blobs').upsert(
          {
            user_id: userId,
            blob_id: blobId,
            byte_size: plaintext.length,
            ext,
          },
          { onConflict: 'user_id,blob_id' }
        );
        if (regErr) {
          const isEn = this.repo.getLocale() === 'en';
          throw new Error(
            isEn
              ? `Failed to register file ${localName}: ${regErr.message}`
              : `Ошибка регистрации файла ${localName}: ${regErr.message}`
          );
        }
        uploadedCount++;
      }

      this.repo.upsertBlobCache({
        localName,
        blobId,
        sha256,
        byteSize: plaintext.length,
        mtimeMs: stat.mtimeMs,
        uploadedForUser: userId,
      });

      refs.push({
        localName,
        blobId,
        ext,
        byteSize: plaintext.length,
      });
    }

    return { refs, uploadedCount };
  }

  public async ensureDownloaded(
    client: SupabaseClient,
    userId: string,
    dek: Buffer,
    refs: SyncMediaRef[] | undefined
  ): Promise<number> {
    if (!Array.isArray(refs) || refs.length === 0) return 0;
    let downloadedCount = 0;

    for (const ref of refs) {
      const safeName = sanitizeMediaFilename(ref.localName);
      if (!safeName || !ref.blobId || !BLOB_ID_RE.test(ref.blobId)) continue;
      const targetPath = this.resolveSafePath(safeName);
      if (!targetPath) continue;

      // Skip only if local file exists AND matches the expected blobId
      try {
        const st = await fs.promises.stat(targetPath);
        if (st.isFile() && st.size > 0) {
          const cached = this.repo.getBlobCache(safeName);
          if (
            cached &&
            cached.blobId === ref.blobId &&
            cached.byteSize === st.size &&
            Math.abs(cached.mtimeMs - st.mtimeMs) < 1
          ) {
            continue;
          }
          const existingBytes = await fs.promises.readFile(targetPath);
          const existingBlobId = deriveOpaqueBlobId(dek, computePlaintextSha256(existingBytes));
          if (existingBlobId === ref.blobId) {
            this.repo.upsertBlobCache({
              localName: safeName,
              blobId: existingBlobId,
              sha256: computePlaintextSha256(existingBytes),
              byteSize: existingBytes.length,
              mtimeMs: st.mtimeMs,
              uploadedForUser: userId,
            });
            continue;
          }
        }
      } catch {
        // File missing locally — proceed to download & decrypt
      }

      const storagePath = `${userId}/${ref.blobId}.enc`;
      const { data, error } = await client.storage
        .from(SYNC_STORAGE_BUCKET)
        .download(storagePath);

      if (error) {
        const errMsg = (error.message || '').toLowerCase();
        // Genuine 404/object-not-found won't fix itself on retry; skip cleanly.
        // Transient network / 5xx errors MUST throw so last_cursor does not permanently skip this file!
        if (errMsg.includes('not found') || errMsg.includes('404')) {
          continue;
        }
        const isEn = this.repo.getLocale() === 'en';
        throw new Error(
          isEn
            ? `Failed to download attachment ${safeName}: ${error.message}`
            : `Ошибка загрузки вложения ${safeName}: ${error.message}`
        );
      }
      if (!data) continue;

      const encryptedBuf = Buffer.from(await data.arrayBuffer());
      const plaintext = decryptMediaBlob(dek, userId, ref.blobId, encryptedBuf);
      const sha256 = computePlaintextSha256(plaintext);
      const verifiedBlobId = deriveOpaqueBlobId(dek, sha256);
      if (verifiedBlobId !== ref.blobId) {
        const isEn = this.repo.getLocale() === 'en';
        throw new Error(
          isEn
            ? `Integrity verification failed for ${safeName}`
            : `Проверка целостности файла ${safeName} не пройдена`
        );
      }

      const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, plaintext);
        await fs.promises.rename(tmpPath, targetPath);
      } catch (writeErr) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {
          // ignore temp cleanup failure
        }
        throw writeErr;
      }

      const finalStat = await fs.promises.stat(targetPath);
      this.repo.upsertBlobCache({
        localName: safeName,
        blobId: ref.blobId,
        sha256,
        byteSize: plaintext.length,
        mtimeMs: finalStat.mtimeMs,
        uploadedForUser: userId,
      });
      downloadedCount++;
    }

    return downloadedCount;
  }
}
