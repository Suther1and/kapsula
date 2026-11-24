const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const afterPackMac = require('./after-pack-mac.cjs');

function normalizePeVersion(rawVersion) {
  const nums = String(rawVersion || '1.0.0')
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return `${nums[0]}.${nums[1]}.${nums[2]}.0`;
}

function embedWindowsMetadata(exePath) {
  const rootDir = path.resolve(__dirname, '..');
  const iconPath = path.join(rootDir, 'build', 'icon.ico');
  const pkgPath = path.join(rootDir, 'package.json');

  if (!fs.existsSync(exePath)) {
    return { applied: false, reason: 'missing_exe' };
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[afterPack:win] Missing Windows icon at ${iconPath}`);
  }

  const rceditCandidates = [
    path.join(rootDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(rootDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
    path.join(rootDir, 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
  ];
  const rcedit = rceditCandidates.find((p) => fs.existsSync(p));
  if (!rcedit) {
    return { applied: false, reason: 'missing_rcedit' };
  }

  let pkgVersion = '1.0.4';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.version) pkgVersion = String(pkg.version).trim();
  } catch {
    // fallback to default
  }
  const peVersion = normalizePeVersion(pkgVersion);

  execFileSync(
    rcedit,
    [
      exePath,
      '--set-icon',
      iconPath,
      '--set-file-version',
      peVersion,
      '--set-product-version',
      peVersion,
      '--set-version-string',
      'ProductName',
      'Kapsula',
      '--set-version-string',
      'FileDescription',
      'Kapsula — Encrypted Notes, Tasks & Vault',
      '--set-version-string',
      'CompanyName',
      'Kapsula',
      '--set-version-string',
      'LegalCopyright',
      'Copyright (c) 2026 Suther1and',
      '--set-version-string',
      'OriginalFilename',
      'Kapsula.exe',
      '--set-version-string',
      'InternalName',
      'Kapsula',
    ],
    { stdio: 'inherit' }
  );

  return { applied: true, iconPath, peVersion };
}

/**
 * Unified electron-builder afterPack hook:
 * - On macOS (`darwin`), delegates cleanly to `scripts/after-pack-mac.cjs` (ad-hoc codesign + Apple Vision OCR +x).
 * - On Windows (`win32`), embeds `build/icon.ico` and complete PE metadata into `Kapsula.exe`
 *   BEFORE NSIS wraps `win-unpacked`, so both portable `win-unpacked/Kapsula.exe` and
 *   `Kapsula-<version>-windows.exe` carry clean metadata even with `signAndEditExecutable=false`.
 */
module.exports = async function afterPackUnified(context) {
  if (context.electronPlatformName === 'darwin') {
    return afterPackMac(context);
  }

  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const productFilename =
    (context.packager &&
      context.packager.appInfo &&
      context.packager.appInfo.productFilename) ||
    'Kapsula';
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);

  if (!fs.existsSync(context.appOutDir)) {
    return;
  }

  const res = embedWindowsMetadata(exePath);
  if (!res.applied) {
    console.warn(`[afterPack:win] Skipped icon/PE embed (${res.reason}) for ${exePath}.`);
    return;
  }

  console.log(`[afterPack:win] Embedded ${res.iconPath} + PE v${res.peVersion} into ${exePath}`);

  const localesDir = path.join(context.appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    const expectedPaks = ['en-GB.pak', 'en-US.pak', 'ru.pak'];
    const actualPaks = fs
      .readdirSync(localesDir)
      .filter((name) => name.toLowerCase().endsWith('.pak'))
      .sort();
    const mismatch =
      actualPaks.length !== expectedPaks.length ||
      expectedPaks.some((name, idx) => actualPaks[idx] !== name);
    if (mismatch) {
      throw new Error(
        `[afterPack:win] Unexpected locales/ contents: expected [${expectedPaks.join(', ')}], got [${actualPaks.join(', ')}]`
      );
    }
    const totalBytes = actualPaks.reduce(
      (sum, name) => sum + fs.statSync(path.join(localesDir, name)).size,
      0
    );
    console.log(
      `[afterPack:win] Verified pruned locales/ (${actualPaks.join(', ')}): ${(totalBytes / (1024 * 1024)).toFixed(2)} MiB`
    );
  }
};

module.exports.embedWindowsMetadata = embedWindowsMetadata;
module.exports.normalizePeVersion = normalizePeVersion;
