import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const EXE_PATH = process.argv[2]
  ? path.resolve(ROOT_DIR, process.argv[2])
  : path.resolve(ROOT_DIR, 'release', 'win-unpacked', 'Kapsula.exe');
const ICON_PATH = path.resolve(ROOT_DIR, 'build', 'icon.ico');
const RCEDIT_CANDIDATES = [
  path.resolve(ROOT_DIR, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
  path.resolve(ROOT_DIR, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  path.resolve(ROOT_DIR, 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
];

if (!fs.existsSync(EXE_PATH)) {
  console.error(`[embed-exe-icon] Missing executable at ${EXE_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(ICON_PATH)) {
  console.error(`[embed-exe-icon] Missing icon at ${ICON_PATH}`);
  process.exit(1);
}

const rcedit = RCEDIT_CANDIDATES.find((p) => fs.existsSync(p));
if (!rcedit) {
  console.error('[embed-exe-icon] rcedit.exe not found in node_modules');
  process.exit(1);
}

execFileSync(
  rcedit,
  [
    EXE_PATH,
    '--set-icon',
    ICON_PATH,
    '--set-version-string',
    'ProductName',
    'Kapsula',
    '--set-version-string',
    'FileDescription',
    'Kapsula — Умное хранилище заметок и знаний',
    '--set-version-string',
    'CompanyName',
    'Kapsula',
  ],
  { stdio: 'inherit' },
);

console.log(`[embed-exe-icon] Embedded ${ICON_PATH} into ${EXE_PATH}`);
