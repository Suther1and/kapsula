import type { SupabaseClient } from '@supabase/supabase-js';
import { SYNC_STORAGE_BUCKET, type SyncMediaRef } from '@shared/sync-contract';
import { tm } from '../lib/mobile-i18n';
import type { MobileVaultStore } from '../storage/mobile-store';
import {
  computePlaintextSha256,
  decryptMediaBlob,
  deriveOpaqueBlobId,
  encryptMediaBlob,
} from './mobile-crypto';

const MAX_SYNC_BLOB_BYTES = 48 * 1024 * 1024;
const BLOB_ID_RE = /^[a-f0-9]{64}$/i;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function sanitizeMobileMediaFilename(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  ) {
    return null;
  }
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

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase().slice(0, 16);
}

export function guessMimeFromFilename(name: string): string {
  const ext = getFileExtension(name);
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.m4a':
    case '.aac':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.mp3':
      return 'audio/mpeg';
    case '.webm':
      return 'audio/webm';
    case '.mp4':
      return 'video/mp4';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

export class MobileSyncMediaManager {
  constructor(private readonly store: MobileVaultStore) {}

  public async ensureUploaded(
    client: SupabaseClient,
    userId: string,
    dek: Uint8Array,
    localNames: Array<string | null | undefined>
  ): Promise<{ refs: SyncMediaRef[]; uploadedCount: number }> {
    const uniqueNames = Array.from(
      new Set(
        localNames
          .map((n) => sanitizeMobileMediaFilename(n))
          .filter((n): n is string => Boolean(n))
      )
    );
    const refs: SyncMediaRef[] = [];
    let uploadedCount = 0;

    for (const localName of uniqueNames) {
      const file = await this.store.loadMediaFile(localName);
      if (!file || file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_SYNC_BLOB_BYTES) {
        continue;
      }

      const ext = getFileExtension(localName);
      const cached = this.store.getBlobCache(localName);
      if (
        cached &&
        cached.byteSize === file.bytes.byteLength &&
        cached.updatedAt === file.updatedAt &&
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

      const sha256 = await computePlaintextSha256(file.bytes);
      const blobId = await deriveOpaqueBlobId(dek, sha256);

      const { data: existingBlob, error: lookupErr } = await client
        .from('sync_blobs')
        .select('blob_id')
        .eq('user_id', userId)
        .eq('blob_id', blobId)
        .maybeSingle();
      if (lookupErr) {
        throw new Error(
          tm('media.checkErr', { name: localName, msg: lookupErr.message }, this.store.getLocale())
        );
      }

      if (!existingBlob) {
        const encrypted = await encryptMediaBlob(dek, userId, blobId, file.bytes);
        const storagePath = `${userId}/${blobId}.enc`;
        const { error: uploadErr } = await client.storage
          .from(SYNC_STORAGE_BUCKET)
          .upload(storagePath, encrypted, {
            contentType: 'application/octet-stream',
            upsert: true,
          });
        if (uploadErr) {
          throw new Error(
            tm('media.uploadErr', { name: localName, msg: uploadErr.message }, this.store.getLocale())
          );
        }

        const { error: regErr } = await client.from('sync_blobs').upsert(
          {
            user_id: userId,
            blob_id: blobId,
            byte_size: file.bytes.byteLength,
            ext,
          },
          { onConflict: 'user_id,blob_id' }
        );
        if (regErr) {
          throw new Error(
            tm('media.registerErr', { name: localName, msg: regErr.message }, this.store.getLocale())
          );
        }
        uploadedCount += 1;
      }

      await this.store.upsertBlobCache({
        localName,
        blobId,
        sha256,
        byteSize: file.bytes.byteLength,
        updatedAt: file.updatedAt,
        uploadedForUser: userId,
      });

      refs.push({
        localName,
        blobId,
        ext,
        byteSize: file.bytes.byteLength,
      });
    }

    return { refs, uploadedCount };
  }

  public async ensureDownloaded(
    client: SupabaseClient,
    userId: string,
    dek: Uint8Array,
    refs: SyncMediaRef[] | undefined
  ): Promise<number> {
    if (!Array.isArray(refs) || refs.length === 0) return 0;
    let downloadedCount = 0;

    for (const ref of refs) {
      const safeName = sanitizeMobileMediaFilename(ref.localName);
      if (!safeName || !ref.blobId || !BLOB_ID_RE.test(ref.blobId)) continue;

      const existing = await this.store.loadMediaFile(safeName);
      if (existing && existing.bytes.byteLength > 0) {
        const cached = this.store.getBlobCache(safeName);
        if (cached && cached.blobId === ref.blobId && cached.byteSize === existing.bytes.byteLength) {
          continue;
        }
        const sha = await computePlaintextSha256(existing.bytes);
        const existingBlobId = await deriveOpaqueBlobId(dek, sha);
        if (existingBlobId === ref.blobId) {
          await this.store.upsertBlobCache({
            localName: safeName,
            blobId: existingBlobId,
            sha256: sha,
            byteSize: existing.bytes.byteLength,
            updatedAt: existing.updatedAt,
            uploadedForUser: userId,
          });
          continue;
        }
      }

      const storagePath = `${userId}/${ref.blobId}.enc`;
      const { data, error } = await client.storage.from(SYNC_STORAGE_BUCKET).download(storagePath);
      if (error) {
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('404')) {
          continue;
        }
        throw new Error(
          tm('media.downloadErr', { name: safeName, msg: error.message }, this.store.getLocale())
        );
      }
      if (!data) continue;

      const encryptedBytes = new Uint8Array(await data.arrayBuffer());
      const plaintext = await decryptMediaBlob(dek, userId, ref.blobId, encryptedBytes);
      const sha256 = await computePlaintextSha256(plaintext);
      const verifiedBlobId = await deriveOpaqueBlobId(dek, sha256);
      if (verifiedBlobId !== ref.blobId) {
        throw new Error(tm('media.integrityErr', { name: safeName }, this.store.getLocale()));
      }

      const mime = guessMimeFromFilename(safeName);
      await this.store.saveMediaFile(safeName, mime, plaintext);
      const saved = await this.store.loadMediaFile(safeName);
      await this.store.upsertBlobCache({
        localName: safeName,
        blobId: ref.blobId,
        sha256,
        byteSize: plaintext.byteLength,
        updatedAt: saved?.updatedAt ?? Date.now(),
        uploadedForUser: userId,
      });
      downloadedCount += 1;
    }

    return downloadedCount;
  }
}
