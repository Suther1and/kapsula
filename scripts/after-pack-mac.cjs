const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Electron-builder afterPack hook:
 * On macOS builds without a real Apple Developer certificate (CSC_LINK),
 * applies a clean ad-hoc signature (`-`) so Apple Silicon Macs execute
 * Kapsula.app and its unpacked Apple Vision OCR helper without AMFI SIGKILL.
 *
 * IMPORTANT: For `--arch=universal`, electron-builder calls afterPack on the
 * temporary `*-x64-temp` and `*-arm64-temp` staging folders BEFORE `@electron/universal`
 * merges them. Signing those temp bundles writes arch-specific `_CodeSignature/CodeResources`
 * which breaks the SHA-256 parity check during universal merge, so we skip temp staging dirs
 * and sign only the final merged `.app`.
 */
module.exports = async function afterPackMac(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  if (
    context.appOutDir.endsWith('-x64-temp') ||
    context.appOutDir.endsWith('-arm64-temp')
  ) {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Ensure unpacked Apple Vision OCR helper is executable inside the bundle
  const visionBin = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'main',
    'macos-vision-ocr'
  );
  if (fs.existsSync(visionBin)) {
    fs.chmodSync(visionBin, 0o755);
  }

  if (Boolean(process.env.CSC_LINK && process.env.CSC_LINK.trim())) {
    console.log('[afterPack] CSC_LINK detected — delegating signing to electron-builder.');
    return;
  }

  if (!fs.existsSync(appPath)) {
    throw new Error(`[afterPack] Expected macOS bundle not found at ${appPath}`);
  }

  if (fs.existsSync(visionBin)) {
    execFileSync('codesign', ['--force', '--sign', '-', visionBin], {
      stdio: 'inherit',
    });
  }

  console.log(`[afterPack] Applying ad-hoc codesign to ${appPath} ...`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  console.log('[afterPack] Ad-hoc codesign complete.');
};
