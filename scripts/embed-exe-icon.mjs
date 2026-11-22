import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { embedWindowsMetadata } = require('./after-pack-win.cjs');

const ROOT_DIR = process.cwd();
const EXE_PATH = process.argv[2]
  ? path.resolve(ROOT_DIR, process.argv[2])
  : path.resolve(ROOT_DIR, 'release', 'win-unpacked', 'Kapsula.exe');

if (!fs.existsSync(EXE_PATH)) {
  console.error(`[embed-exe-icon] Missing executable at ${EXE_PATH}`);
  process.exit(1);
}

const res = embedWindowsMetadata(EXE_PATH);
if (!res.applied) {
  console.error(`[embed-exe-icon] Failed to embed metadata (${res.reason}) into ${EXE_PATH}`);
  process.exit(1);
}

console.log(`[embed-exe-icon] Embedded ${res.iconPath} + PE v${res.peVersion} into ${EXE_PATH}`);
