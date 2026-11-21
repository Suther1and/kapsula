#!/usr/bin/env node
/**
 * Clean cross-platform builder for `release/Kapsula-for-Mac.zip`.
 *
 * Writes a standard UTF-8 ZIP archive in pure Node.js with Unix `versionMadeBy`
 * (`create_system = 3`) and explicit POSIX permissions (`0o100755 << 16` on
 * `Установить Kapsula на Mac.command` and `.sh` scripts, `0o100644 << 16` on regular files)
 * so macOS Finder / Archive Utility allows double-clicking the `.command` installer directly
 * even when packaged on Windows (unlike PowerShell `Compress-Archive` which zeroes permissions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const ZIP_ROOT_PREFIX = 'Kapsula-Mac';
const INSTALLER_FILENAME = 'Установить Kapsula на Mac.command';

const INCLUDED_DIRS = ['build', 'extension', 'scripts', 'src'];
const INCLUDED_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.mts',
];
const IGNORED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.git',
  'node_modules',
  'dist',
  'release',
  'android',
  '.tmp',
  '_bmad-output',
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    dosTime: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

/**
 * Pure-Node ZIP writer preserving UNIX create_system (3) and POSIX external attributes.
 * @param {Array<{ name: string; data: Buffer; mode?: number; mtime?: Date }>} entries
 * @returns {Buffer}
 */
export function createPosixZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Unix create_system = 3 (high byte), ZIP spec version 2.0 = 20 (low byte)
  const versionMadeBy = (3 << 8) | 20;
  const versionNeeded = 20;
  const utf8Flag = 0x0800;

  for (const entry of entries) {
    const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(normalizedName, 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = computeCrc32(uncompressed);
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime ?? new Date());

    let method = 0;
    let payload = uncompressed;
    if (uncompressed.length > 64) {
      const deflated = zlib.deflateRawSync(uncompressed, { level: 6 });
      if (deflated.length < uncompressed.length) {
        method = 8;
        payload = deflated;
      }
    }

    const posixMode = entry.mode ?? 0o100644;
    const externalAttr = (posixMode << 16) >>> 0;

    // Local File Header (30 bytes)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(versionNeeded, 4);
    lfh.writeUInt16LE(utf8Flag, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(uncompressed.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    // Central Directory Header (46 bytes)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(versionMadeBy, 4);
    cdh.writeUInt16LE(versionNeeded, 6);
    cdh.writeUInt16LE(utf8Flag, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(uncompressed.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(externalAttr, 38);
    cdh.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBuf, payload);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function collectFilesRecursive(dirAbs, rootDir) {
  const results = [];
  if (!fs.existsSync(dirAbs)) return results;
  const items = fs.readdirSync(dirAbs, { withFileTypes: true });
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (IGNORED_NAMES.has(item.name)) continue;
    const fullPath = path.join(dirAbs, item.name);
    if (item.isDirectory()) {
      results.push(...collectFilesRecursive(fullPath, rootDir));
    } else if (item.isFile()) {
      const relPosix = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      results.push({ fullPath, relPosix });
    }
  }
  return results;
}

function normalizeLfBuffer(buf) {
  const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return Buffer.from(text, 'utf8');
}

export function buildMacZip(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const outPath = path.resolve(options.outPath ?? path.join(rootDir, 'release', 'Kapsula-for-Mac.zip'));
  const installerSrc = path.join(rootDir, 'scripts', 'mac-installer', INSTALLER_FILENAME);

  if (!fs.existsSync(installerSrc)) {
    throw new Error(`Missing macOS installer script: ${installerSrc}`);
  }

  const zipEntries = [];
  const seenNames = new Set();

  const addEntry = (zipName, data, mode, mtime) => {
    if (seenNames.has(zipName)) return;
    seenNames.add(zipName);
    zipEntries.push({ name: zipName, data, mode, mtime });
  };

  // 1. Top-level one-click macOS installer (strict LF + executable POSIX 0o100755)
  const installerStat = fs.statSync(installerSrc);
  const installerLf = normalizeLfBuffer(fs.readFileSync(installerSrc));
  addEntry(`${ZIP_ROOT_PREFIX}/${INSTALLER_FILENAME}`, installerLf, 0o100755, installerStat.mtime);

  // 2. Root config & lock files
  for (const file of INCLUDED_ROOT_FILES) {
    const abs = path.join(rootDir, file);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing required root file for Mac package: ${file}`);
    }
    const stat = fs.statSync(abs);
    addEntry(`${ZIP_ROOT_PREFIX}/${file}`, fs.readFileSync(abs), 0o100644, stat.mtime);
  }

  // 3. Included source/asset directories
  for (const dirName of INCLUDED_DIRS) {
    const dirAbs = path.join(rootDir, dirName);
    const files = collectFilesRecursive(dirAbs, rootDir);
    for (const f of files) {
      const stat = fs.statSync(f.fullPath);
      const isScript = f.relPosix.endsWith('.command') || f.relPosix.endsWith('.sh');
      const rawBuf = fs.readFileSync(f.fullPath);
      const data = isScript ? normalizeLfBuffer(rawBuf) : rawBuf;
      const mode = isScript ? 0o100755 : 0o100644;
      addEntry(`${ZIP_ROOT_PREFIX}/${f.relPosix}`, data, mode, stat.mtime);
    }
  }

  const zipBuffer = createPosixZipBuffer(zipEntries);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zipBuffer);

  return {
    outPath,
    entryCount: zipEntries.length,
    byteSize: zipBuffer.length,
  };
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : undefined;
  const result = buildMacZip({ outPath });
  console.log(
    `[pack-mac-zip] Built ${result.outPath} (${result.entryCount} entries, ${(result.byteSize / 1024 / 1024).toFixed(2)} MB)`
  );
}
