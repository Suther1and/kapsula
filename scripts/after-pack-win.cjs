const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const afterPackMac = require('./after-pack-mac.cjs');

/**
 * Unified electron-builder afterPack hook:
 * - On macOS (`darwin`), delegates cleanly to `scripts/after-pack-mac.cjs` (ad-hoc codesign + Apple Vision OCR +x).
 * - On Windows (`win32`), embeds `build/icon.ico` and Russian product metadata into `Kapsula.exe`
 *   BEFORE NSIS wraps `win-unpacked`, so both portable `win-unpacked/Kapsula.exe` and
 *   `Kapsula-<version>-windows.exe` carry the crisp Kapsula icon even with `signAndEditExecutable=false`.
 */
module.exports = async function afterPackUnified(context) {
  if (context.electronPlatformName === 'darwin') {
    return afterPackMac(context);
  }

  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const rootDir = path.resolve(__dirname, '..');
  const productFilename =
    (context.packager &&
      context.packager.appInfo &&
      context.packager.appInfo.productFilename) ||
    'Kapsula';
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(rootDir, 'build', 'icon.ico');

  if (!fs.existsSync(context.appOutDir)) {
    return;
  }
  if (!fs.existsSync(exePath)) {
    console.warn(`[afterPack:win] Executable not found at ${exePath}, skipping icon embed.`);
    return;
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
    console.warn('[afterPack:win] rcedit.exe not found in node_modules; skipping icon embed.');
    return;
  }

  execFileSync(
    rcedit,
    [
      exePath,
      '--set-icon',
      iconPath,
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
    { stdio: 'inherit' }
  );

  console.log(`[afterPack:win] Embedded ${iconPath} into ${exePath}`);
};
