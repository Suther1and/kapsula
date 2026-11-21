import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const distMainDir = path.resolve(process.cwd(), 'dist/main');
const distPreloadDir = path.resolve(process.cwd(), 'dist/preload');
fs.mkdirSync(distMainDir, { recursive: true });
fs.mkdirSync(distPreloadDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.resolve(process.cwd(), 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: path.join(distMainDir, 'index.js'),
  external: ['electron', 'unpdf', 'unpdf/*', 'node:*'],
  sourcemap: false,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.resolve(process.cwd(), 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: path.join(distPreloadDir, 'index.js'),
  external: ['electron', 'node:*'],
  sourcemap: false,
  logLevel: 'info',
});

const psSrc = path.resolve(process.cwd(), 'src/main/ocr/winrt-ocr.ps1');
if (fs.existsSync(psSrc)) {
  fs.copyFileSync(psSrc, path.join(distMainDir, 'winrt-ocr.ps1'));
}

const swiftSrc = path.resolve(process.cwd(), 'src/main/ocr/macos-vision-ocr.swift');
if (fs.existsSync(swiftSrc)) {
  fs.copyFileSync(swiftSrc, path.join(distMainDir, 'macos-vision-ocr.swift'));

  if (process.platform === 'darwin') {
    const outBin = path.join(distMainDir, 'macos-vision-ocr');
    if (fs.existsSync(outBin)) {
      fs.unlinkSync(outBin);
    }

    const requestedArch = (process.env.KAPSULA_MAC_ARCH || '').trim();
    const needsUniversal = !requestedArch || requestedArch === 'both' || requestedArch === 'universal';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-vision-build-'));

    const resolveSdkArgs = () => {
      try {
        const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        return sdkPath ? ['-sdk', sdkPath] : [];
      } catch {
        return [];
      }
    };

    try {
      const sdkArgs = resolveSdkArgs();
      if (needsUniversal) {
        const armBin = path.join(tmpDir, 'macos-vision-ocr-arm64');
        const x64Bin = path.join(tmpDir, 'macos-vision-ocr-x86_64');
        execFileSync(
          'swiftc',
          ['-O', ...sdkArgs, '-target', 'arm64-apple-macos12.0', swiftSrc, '-o', armBin],
          { stdio: 'pipe' }
        );
        execFileSync(
          'swiftc',
          ['-O', ...sdkArgs, '-target', 'x86_64-apple-macos12.0', swiftSrc, '-o', x64Bin],
          { stdio: 'pipe' }
        );
        execFileSync('lipo', ['-create', armBin, x64Bin, '-output', outBin], { stdio: 'pipe' });
        const lipoInfo = execFileSync('lipo', ['-info', outBin], { encoding: 'utf8' });
        if (!lipoInfo.includes('arm64') || !lipoInfo.includes('x86_64')) {
          throw new Error(`Universal lipo verification failed: ${lipoInfo.trim()}`);
        }
        fs.chmodSync(outBin, 0o755);
        console.log('Compiled Apple Vision OCR helper (universal arm64+x86_64): dist/main/macos-vision-ocr');
      } else {
        const targetTriple =
          requestedArch === 'x64' ? 'x86_64-apple-macos12.0' : 'arm64-apple-macos12.0';
        execFileSync(
          'swiftc',
          ['-O', ...sdkArgs, '-target', targetTriple, swiftSrc, '-o', outBin],
          { stdio: 'pipe' }
        );
        fs.chmodSync(outBin, 0o755);
        console.log(`Compiled Apple Vision OCR helper (${requestedArch}): dist/main/macos-vision-ocr`);
      }
    } catch (err) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err && err.stderr
          ? String(err.stderr).trim()
          : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (fs.existsSync(outBin)) {
        fs.unlinkSync(outBin);
      }
      if (process.env.CI === 'true' || requestedArch) {
        console.error(`Failed to compile Apple Vision OCR helper for ${requestedArch || 'universal'}: ${msg}`);
        if (stderr) console.error(stderr);
        process.exit(1);
      }
      console.warn(`Skipped Apple Vision OCR helper compilation: ${msg}${stderr ? `\n${stderr}` : ''}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

console.log('Built Electron main & preload bundles.');
