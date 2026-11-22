import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const ANDROID_DIR = path.resolve(ROOT_DIR, 'android');
const RELEASE_DIR = path.resolve(ROOT_DIR, 'release');

const variantArg = process.argv.find((a) => a.startsWith('--variant='));
const flavorArg = process.argv.find((a) => a.startsWith('--flavor='));
const formatArg = process.argv.find((a) => a.startsWith('--format='));

const VARIANT =
  (variantArg ? variantArg.split('=')[1] : 'release')?.toLowerCase() === 'debug'
    ? 'debug'
    : 'release';

const FORMAT =
  (formatArg ? formatArg.split('=')[1] : 'apk')?.toLowerCase() === 'aab'
    ? 'aab'
    : 'apk';

const FLAVOR_RAW = (
  flavorArg ? flavorArg.split('=')[1] : FORMAT === 'aab' ? 'play' : 'direct'
)?.toLowerCase();
const FLAVOR = FLAVOR_RAW === 'play' ? 'play' : 'direct';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function findJavaHome() {
  const binName = process.platform === 'win32' ? 'java.exe' : 'java';
  const directCandidates = [
    process.env.JAVA_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'KapsulaToolchain', 'jdk-21'),
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    '/usr/lib/jvm/temurin-21-jdk-amd64',
    '/usr/lib/jvm/java-21-openjdk-amd64',
  ].filter(Boolean);

  for (const dir of directCandidates) {
    if (fs.existsSync(path.join(dir, 'bin', binName))) {
      return dir;
    }
  }

  const scanRoots =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Eclipse Adoptium',
          'C:\\Program Files\\Microsoft',
          'C:\\Program Files\\Java',
        ]
      : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];

  for (const root of scanRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/21/.test(entry.name)) continue;
        const candidate = path.join(root, entry.name);
        const macHome = path.join(candidate, 'Contents', 'Home');
        if (fs.existsSync(path.join(candidate, 'bin', binName))) return candidate;
        if (fs.existsSync(path.join(macHome, 'bin', binName))) return macHome;
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  return null;
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    '/usr/local/lib/android/sdk',
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'platforms'))) {
      return dir;
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd)) {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args], {
      stdio: 'inherit',
      cwd: opts.cwd ?? ROOT_DIR,
      env: opts.env ?? process.env,
    });
    return;
  }
  execFileSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? ROOT_DIR,
    env: opts.env ?? process.env,
  });
}

function computeVersionCode(version, buildNumber = 0) {
  const parts = String(version || '1.0.0')
    .split(/[^\d]+/)
    .map((p) => Number.parseInt(p, 10) || 0);
  const [maj = 1, min = 0, pat = 0] = parts;
  const base = Math.max(1, maj * 10000 + min * 100 + pat);
  const parsedBuild = Number.parseInt(String(buildNumber || '0'), 10);
  const buildOffset = Number.isFinite(parsedBuild) && parsedBuild > 0 ? Math.min(9999, parsedBuild) : 0;
  return base * 10000 + buildOffset;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version || '1.0.0';
  const explicitCode = Number.parseInt(process.env.ANDROID_VERSION_CODE || '', 10);
  const versionCode =
    Number.isFinite(explicitCode) && explicitCode > 0
      ? explicitCode
      : computeVersionCode(version, process.env.ANDROID_BUILD_NUMBER);

  const hasCustomKeystore = Boolean(
    process.env.ANDROID_KEYSTORE_PATH &&
      process.env.ANDROID_KEYSTORE_PASSWORD &&
      process.env.ANDROID_KEY_ALIAS &&
      process.env.ANDROID_KEY_PASSWORD &&
      fs.existsSync(process.env.ANDROID_KEYSTORE_PATH)
  );

  if (VARIANT === 'release' && !hasCustomKeystore) {
    throw new Error(
      'Релизная сборка Android требует постоянный keystore (ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD). Для локального тестового APK используй: npm run pack:android:debug'
    );
  }

  const javaHome = findJavaHome();
  const androidSdk = findAndroidSdk();
  if (!javaHome) {
    throw new Error(
      'JDK 21 не найден. Установи Temurin JDK 21 и задай JAVA_HOME (или запусти GitHub Actions сборку).'
    );
  }
  if (!androidSdk) {
    throw new Error(
      'Android SDK не найден. Установи Android SDK (android-36) и задай ANDROID_HOME.'
    );
  }

  console.log(
    `[pack:android] Flavor: ${FLAVOR} | Variant: ${VARIANT} | Format: ${FORMAT.toUpperCase()} (v${version}, code=${versionCode})`
  );
  console.log(
    `[pack:android] Signing: ${hasCustomKeystore ? 'RELEASE KEYSTORE' : 'DEBUG KEYSTORE'}`
  );
  console.log(`[pack:android] JAVA_HOME: ${javaHome}`);
  console.log(`[pack:android] ANDROID_HOME: ${androidSdk}`);

  const buildEnv = {
    ...process.env,
    VITE_DIST_CHANNEL: FLAVOR,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidSdk,
    ANDROID_SDK_ROOT: androidSdk,
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${path.join(androidSdk, 'platform-tools')}${path.delimiter}${process.env.PATH || ''}`,
  };

  const escapedSdk = androidSdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  fs.writeFileSync(path.join(ANDROID_DIR, 'local.properties'), `sdk.dir=${escapedSdk}\n`, 'utf8');

  // 1. Generate adaptive Android brand icons
  run(process.execPath, [path.join(ROOT_DIR, 'scripts', 'generate-android-icons.mjs')], {
    env: buildEnv,
  });

  // 2. Build mobile web bundle (dist/mobile) with channel flag
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  run(npxCmd, ['vite', 'build', '--config', 'vite.mobile.config.ts'], { env: buildEnv });

  // 3. Sync web bundle into Capacitor Android project
  run(npxCmd, ['cap', 'sync', 'android'], { env: buildEnv });

  // 4. Assemble APK or AAB via Gradle wrapper
  const gradlew = process.platform === 'win32'
    ? path.join(ANDROID_DIR, 'gradlew.bat')
    : path.join(ANDROID_DIR, 'gradlew');
  if (process.platform !== 'win32') {
    fs.chmodSync(gradlew, 0o755);
  }

  const taskPrefix = FORMAT === 'aab' ? 'bundle' : 'assemble';
  const gradleTask = `${taskPrefix}${capitalize(FLAVOR)}${capitalize(VARIANT)}`;
  run(
    gradlew,
    [
      gradleTask,
      '--no-daemon',
      `-PkapsulaVersionName=${version}`,
      `-PkapsulaVersionCode=${versionCode}`,
    ],
    { cwd: ANDROID_DIR, env: buildEnv }
  );

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  let srcArtifact;
  let outName;

  if (FORMAT === 'aab') {
    const bundleDir = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'bundle', `${FLAVOR}${capitalize(VARIANT)}`);
    const bundleName = fs.readdirSync(bundleDir).find((f) => f.endsWith('.aab'));
    if (!bundleName) {
      throw new Error(`AAB не найден в ${bundleDir}`);
    }
    srcArtifact = path.join(bundleDir, bundleName);
    outName = `Kapsula-${version}-android-${FLAVOR}${VARIANT === 'release' ? '' : `-${VARIANT}`}.aab`;
  } else {
    const apkDir = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', FLAVOR, VARIANT);
    const candidates = fs
      .readdirSync(apkDir)
      .filter((f) => f.endsWith('.apk') && !f.includes('unsigned'));
    const apkName = candidates[0] || fs.readdirSync(apkDir).find((f) => f.endsWith('.apk'));
    if (!apkName) {
      throw new Error(`APK не найден в ${apkDir}`);
    }
    srcArtifact = path.join(apkDir, apkName);
    outName =
      FLAVOR === 'direct' && VARIANT === 'release'
        ? `Kapsula-${version}-android.apk`
        : `Kapsula-${version}-android-${FLAVOR}-${VARIANT}.apk`;
  }

  const dstArtifact = path.join(RELEASE_DIR, outName);
  fs.copyFileSync(srcArtifact, dstArtifact);

  const bytes = fs.readFileSync(dstArtifact);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const sizeMb = (bytes.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`\n[pack:android] SUCCESS: ${dstArtifact} (${sizeMb} MB)`);
  console.log(`[pack:android] SHA-256: ${sha256}`);
}

main();
