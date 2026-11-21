import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipInputEntry {
  name: string;
  data: Buffer;
}

export interface ReadZipOptions {
  /** Reject entries with path traversal (`..`), absolute paths, or null bytes. Default: true. */
  rejectUnsafePaths?: boolean;
  /** Maximum number of entries allowed. Default: 10000. */
  maxEntries?: number;
  /** Maximum uncompressed size per entry in bytes. Default: 50MB. */
  maxEntryBytes?: number;
  /** Maximum total uncompressed size across the archive in bytes. Default: 250MB. */
  maxTotalUncompressedBytes?: number;
}

export class ZipSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipSecurityError';
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Validates and normalizes a ZIP entry path to prevent Zip-Slip path traversal attacks.
 * Returns normalized POSIX-style relative path, or `null` if unsafe.
 */
export function normalizeSafeZipPath(rawName: string): string | null {
  if (!rawName || rawName.includes('\0')) return null;
  const slashNorm = rawName.replace(/\\/g, '/');

  // Reject absolute paths (POSIX root, Windows drive letter, UNC prefix)
  if (slashNorm.startsWith('/') || /^[a-zA-Z]:/.test(slashNorm)) {
    return null;
  }

  const isDir = slashNorm.endsWith('/');
  const rawSegments = slashNorm.split('/');
  const cleanSegments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (/^[a-zA-Z]:/.test(seg)) return null;
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) return null;
  const joined = cleanSegments.join('/');
  return isDir ? `${joined}/` : joined;
}

export function assertSafeZipPath(rawName: string): string {
  const safe = normalizeSafeZipPath(rawName);
  if (!safe) {
    throw new ZipSecurityError(`Unsafe zip-slip path detected in archive: ${rawName}`);
  }
  return safe;
}

function decodeZipFilename(nameBytes: Buffer, flags: number): string {
  const isUtf8 = (flags & 0x0800) !== 0;
  if (isUtf8) {
    return nameBytes.toString('utf8');
  }
  // Many archives write UTF-8 without setting bit 11 — try strict UTF-8 first, then CP866/latin1 fallback
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  } catch {
    return nameBytes.toString('latin1');
  }
}

interface CentralDirRecord {
  rawName: string;
  safeName: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function locateEocd(buffer: Buffer): number {
  if (buffer.length < 22) return -1;
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buffer.length) {
        return i;
      }
    }
  }
  // Secondary scan ignoring trailing garbage if comment length didn't match exact end
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

function parseCentralDirectory(buffer: Buffer, options: ReadZipOptions = {}): CentralDirRecord[] {
  const rejectUnsafePaths = options.rejectUnsafePaths !== false;
  const maxEntries = options.maxEntries ?? 10_000;
  const eocdOffset = locateEocd(buffer);
  if (eocdOffset === -1) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= buffer.length) return [];

  const records: CentralDirRecord[] = [];
  let cursor = cdOffset;
  const limit = Math.min(totalEntries, maxEntries);

  for (let idx = 0; idx < limit && cursor + 46 <= buffer.length; idx++) {
    if (
      buffer[cursor] !== 0x50 ||
      buffer[cursor + 1] !== 0x4b ||
      buffer[cursor + 2] !== 0x01 ||
      buffer[cursor + 3] !== 0x02
    ) {
      break;
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buffer.length) break;

    const rawName = decodeZipFilename(buffer.subarray(nameStart, nameEnd), flags);
    cursor = nameEnd + extraLen + commentLen;

    const safeName = normalizeSafeZipPath(rawName);
    if (!safeName) {
      if (rejectUnsafePaths) {
        throw new ZipSecurityError(`Unsafe zip-slip path detected in archive: ${rawName}`);
      }
      continue;
    }

    records.push({
      rawName,
      safeName,
      isDirectory: safeName.endsWith('/'),
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }

  return records;
}

function extractRecordData(
  buffer: Buffer,
  rec: CentralDirRecord,
  maxEntryBytes: number
): Buffer | null {
  if (rec.isDirectory) return Buffer.alloc(0);
  if (rec.uncompressedSize > maxEntryBytes) {
    throw new ZipSecurityError(`ZIP entry exceeds size limit (${rec.safeName})`);
  }
  if (rec.localHeaderOffset + 30 > buffer.length) return null;
  if (
    buffer[rec.localHeaderOffset] !== 0x50 ||
    buffer[rec.localHeaderOffset + 1] !== 0x4b ||
    buffer[rec.localHeaderOffset + 2] !== 0x03 ||
    buffer[rec.localHeaderOffset + 3] !== 0x04
  ) {
    return null;
  }

  const lfhNameLen = buffer.readUInt16LE(rec.localHeaderOffset + 26);
  const lfhExtraLen = buffer.readUInt16LE(rec.localHeaderOffset + 28);
  const dataStart = rec.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const dataEnd = dataStart + rec.compressedSize;
  if (dataStart > buffer.length || dataEnd > buffer.length) return null;

  const payload = buffer.subarray(dataStart, dataEnd);
  if (rec.method === 0) {
    if (payload.length > maxEntryBytes) {
      throw new ZipSecurityError(`ZIP entry exceeds size limit (${rec.safeName})`);
    }
    return Buffer.from(payload);
  }
  if (rec.method === 8) {
    return zlib.inflateRawSync(payload, { maxOutputLength: maxEntryBytes });
  }
  return null;
}

/**
 * Reads all safe entries from a ZIP buffer (supports Store method 0 & Deflate method 8, UTF-8 names,
 * and strict Zip-Slip protection).
 */
export function readZipEntries(buffer: Buffer, options: ReadZipOptions = {}): ZipEntry[] {
  const maxEntryBytes = options.maxEntryBytes ?? 50 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalUncompressedBytes ?? 250 * 1024 * 1024;
  const records = parseCentralDirectory(buffer, options);

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;

  for (const rec of records) {
    if (rec.isDirectory) {
      entries.push({
        name: rec.safeName,
        data: Buffer.alloc(0),
        isDirectory: true,
        method: rec.method,
        compressedSize: 0,
        uncompressedSize: 0,
      });
      continue;
    }

    const remainingBudget = maxTotalBytes - totalUncompressed;
    if (remainingBudget < 0) {
      throw new ZipSecurityError('ZIP archive exceeds maximum total uncompressed size limit');
    }
    const effectiveMaxEntry = Math.min(maxEntryBytes, remainingBudget);
    const data = extractRecordData(buffer, rec, effectiveMaxEntry);
    if (!data) continue;

    totalUncompressed += data.length;
    if (totalUncompressed > maxTotalBytes) {
      throw new ZipSecurityError('ZIP archive exceeds maximum total uncompressed size limit');
    }

    entries.push({
      name: rec.safeName,
      data,
      isDirectory: false,
      method: rec.method,
      compressedSize: rec.compressedSize,
      uncompressedSize: data.length,
    });
  }

  return entries;
}

/**
 * Reads a single entry by normalized path from a ZIP buffer without inflating unrelated entries.
 */
export function readZipEntry(
  buffer: Buffer,
  targetName: string,
  options: ReadZipOptions = {}
): Buffer | null {
  const wanted = normalizeSafeZipPath(targetName);
  if (!wanted) return null;
  const maxEntryBytes = options.maxEntryBytes ?? 50 * 1024 * 1024;
  const records = parseCentralDirectory(buffer, options);
  const match = records.find((r) => !r.isDirectory && r.safeName === wanted);
  if (!match) return null;
  return extractRecordData(buffer, match, maxEntryBytes);
}

/**
 * Lists all safe entry names in a ZIP buffer without inflating payloads.
 */
export function listZipEntryNames(buffer: Buffer, options: ReadZipOptions = {}): string[] {
  return parseCentralDirectory(buffer, options).map((r) => r.safeName);
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Creates a standard UTF-8 ZIP archive buffer in pure Node.js (zero external dependencies).
 * Automatically chooses Deflate (method 8) when it saves space, or Store (method 0) otherwise.
 */
export function createZipBuffer(entries: ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { dosTime, dosDate } = toDosTimeDate(new Date());

  for (const entry of entries) {
    const safeName = assertSafeZipPath(entry.name);
    const nameBuf = Buffer.from(safeName, 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = computeCrc32(uncompressed);

    let method = 0;
    let payload: Buffer = uncompressed;
    if (uncompressed.length > 64) {
      const deflated = zlib.deflateRawSync(uncompressed, { level: 6 });
      if (deflated.length < uncompressed.length) {
        method = 8;
        payload = deflated;
      }
    }

    // UTF-8 filename flag (bit 11 = 0x0800)
    const flags = 0x0800;

    // Local File Header (30 bytes)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(uncompressed.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    // Central Directory Header (46 bytes)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(uncompressed.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset

    localParts.push(lfh, nameBuf, payload);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}
