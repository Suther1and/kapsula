import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.error(
    'Сборка macOS .dmg возможна только на macOS или через GitHub Actions (.github/workflows/build-macos.yml).'
  );
  process.exit(1);
}

const archArg = process.argv.find((a) => a.startsWith('--arch='));
const requestedArch = (archArg ? archArg.slice('--arch='.length) : process.arch === 'arm64' ? 'arm64' : 'x64').trim();

const validModes = new Set(['arm64', 'x64', 'universal', 'both']);
if (!validModes.has(requestedArch)) {
  console.error(`Неизвестная архитектура "${requestedArch}". Допустимо: arm64, x64, universal, both.`);
  process.exit(1);
}

const hasRealCert = Boolean(process.env.CSC_LINK && process.env.CSC_LINK.trim());
const env = {
  ...process.env,
  KAPSULA_MAC_ARCH: requestedArch,
};

if (!hasRealCert) {
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

console.log(`[pack:mac] Building Kapsula for macOS (${requestedArch})...`);
execFileSync('npm', ['run', 'build'], { stdio: 'inherit', env });

const builderArgs = ['electron-builder', '--mac', 'dmg', '--publish', 'never'];
if (requestedArch === 'both') {
  builderArgs.push('--arm64', '--x64');
} else {
  builderArgs.push(`--${requestedArch}`);
}

if (hasRealCert) {
  builderArgs.push(
    '-c.mac.hardenedRuntime=true',
    '-c.mac.entitlements=build/entitlements.mac.plist',
    '-c.mac.entitlementsInherit=build/entitlements.mac.plist'
  );
} else {
  builderArgs.push('-c.mac.identity=null');
}

execFileSync('npx', builderArgs, { stdio: 'inherit', env });

const releaseDir = path.resolve(process.cwd(), 'release');
if (fs.existsSync(releaseDir)) {
  const renameRules = [
    { suffix: '-arm64.dmg', targetSuffix: '-mac-apple-silicon.dmg' },
    { suffix: '-x64.dmg', targetSuffix: '-mac-intel.dmg' },
  ];
  for (const entry of fs.readdirSync(releaseDir)) {
    for (const rule of renameRules) {
      if (entry.endsWith(rule.suffix)) {
        const src = path.join(releaseDir, entry);
        const dst = path.join(releaseDir, `${entry.slice(0, -rule.suffix.length)}${rule.targetSuffix}`);
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.renameSync(src, dst);
      }
    }
  }

  const dmgs = fs
    .readdirSync(releaseDir)
    .filter((f) => f.endsWith('.dmg'))
    .sort();
  if (dmgs.length > 0) {
    console.log('\nГотовые установщики macOS:');
    for (const dmg of dmgs) {
      const fullPath = path.join(releaseDir, dmg);
      const sizeMb = (fs.statSync(fullPath).size / (1024 * 1024)).toFixed(1);
      console.log(`  - ${fullPath} (${sizeMb} MB)`);
    }
  }
}
