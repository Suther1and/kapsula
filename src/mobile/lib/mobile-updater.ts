import { mobileBridge } from '../native/bridge';
import { tm } from './mobile-i18n';

export const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/Suther1and/kapsula/releases/latest';

export const ALLOWED_APK_URL_PREFIXES = [
  'https://github.com/Suther1and/kapsula/',
  'https://objects.githubusercontent.com/',
  'https://release-assets.githubusercontent.com/',
] as const;

export type MobileUpdateStatus = 'up_to_date' | 'update_available' | 'error';

export interface MobileUpdateCheckResult {
  status: MobileUpdateStatus;
  currentVersion: string;
  currentVersionCode: number;
  latestVersion: string | null;
  latestVersionCode: number | null;
  apkUrl: string | null;
  sha256: string | null;
  releaseNotes: string;
  checkedAt: number;
  error?: string;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string | null;
}

interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  assets?: GitHubReleaseAsset[];
}

interface AndroidLatestManifest {
  versionName?: string;
  versionCode?: number;
  fileName?: string;
  sha256?: string;
}

export function isAllowedAndroidApkUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const clean = url.trim();
  return ALLOWED_APK_URL_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

export function normalizeSha256Hex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null;
}

export function parseSemver(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const clean = version.trim().replace(/^v/i, '').split(/[-+]/)[0]?.trim() ?? '';
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(clean);
  if (!match) return null;
  const maj = Number.parseInt(match[1] ?? '0', 10);
  const min = Number.parseInt(match[2] ?? '0', 10);
  const pat = Number.parseInt(match[3] ?? '0', 10);
  if (!Number.isFinite(maj) || !Number.isFinite(min) || !Number.isFinite(pat)) return null;
  return [maj, min, pat];
}

export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function isNewerAndroidRelease(
  current: { versionName: string; versionCode?: number | null },
  remote: { versionName: string | null; versionCode?: number | null }
): boolean {
  if (remote.versionName) {
    const cmp = compareSemver(remote.versionName, current.versionName);
    if (cmp > 0) return true;
    if (cmp < 0) return false;
  }
  const curCode = Number(current.versionCode ?? 0);
  const remCode = Number(remote.versionCode ?? 0);
  if (Number.isFinite(curCode) && Number.isFinite(remCode) && curCode > 0 && remCode > 0) {
    return remCode > curCode;
  }
  return false;
}

function pickAndroidApkAsset(
  assets: GitHubReleaseAsset[],
  preferredFileName?: string | null
): GitHubReleaseAsset | null {
  if (preferredFileName) {
    const exact = assets.find(
      (a) => typeof a.name === 'string' && a.name.toLowerCase() === preferredFileName.toLowerCase()
    );
    if (exact) return exact;
  }
  const releaseApk = assets.find(
    (a) => typeof a.name === 'string' && /^kapsula-.*-android(?:-release)?\.apk$/i.test(a.name)
  );
  if (releaseApk) return releaseApk;

  const anyReleaseApk = assets.find(
    (a) =>
      typeof a.name === 'string' &&
      a.name.toLowerCase().endsWith('.apk') &&
      !a.name.toLowerCase().includes('debug')
  );
  if (anyReleaseApk) return anyReleaseApk;

  return (
    assets.find((a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk')) ?? null
  );
}

function parseSha256FromSumsText(text: string, fileName: string): string | null {
  const lowerTarget = fileName.toLowerCase();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2]?.toLowerCase().endsWith(lowerTarget)) {
      return normalizeSha256Hex(m[1]);
    }
  }
  return null;
}

export async function checkForMobileUpdate(opts?: {
  currentVersion?: string;
  currentVersionCode?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MobileUpdateCheckResult> {
  const checkedAt = Date.now();
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  let currentVersion = opts?.currentVersion?.trim() || '';
  let currentVersionCode = opts?.currentVersionCode ?? 0;
  if (!currentVersion || !currentVersionCode) {
    const installed = await mobileBridge.getAppVersion();
    if (!currentVersion) currentVersion = installed.versionName;
    if (!currentVersionCode) currentVersionCode = installed.versionCode;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(GITHUB_LATEST_RELEASE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });

    if (resp.status === 404) {
      return {
        status: 'up_to_date',
        currentVersion,
        currentVersionCode,
        latestVersion: currentVersion,
        latestVersionCode: currentVersionCode,
        apkUrl: null,
        sha256: null,
        releaseNotes: '',
        checkedAt,
      };
    }

    if (resp.status === 403 || resp.status === 429) {
      return {
        status: 'error',
        currentVersion,
        currentVersionCode,
        latestVersion: null,
        latestVersionCode: null,
        apkUrl: null,
        sha256: null,
        releaseNotes: '',
        checkedAt,
        error: tm('updater.rateLimited'),
      };
    }

    if (!resp.ok) {
      return {
        status: 'error',
        currentVersion,
        currentVersionCode,
        latestVersion: null,
        latestVersionCode: null,
        apkUrl: null,
        sha256: null,
        releaseNotes: '',
        checkedAt,
        error: tm('updater.serverUnavailable'),
      };
    }

    const release = (await resp.json()) as GitHubReleasePayload;
    const assets = Array.isArray(release.assets) ? release.assets : [];

    // Optional android-latest.json metadata asset (contains exact versionCode + sha256)
    let manifest: AndroidLatestManifest | null = null;
    const manifestAsset = assets.find(
      (a) => typeof a.name === 'string' && a.name.toLowerCase() === 'android-latest.json'
    );
    if (manifestAsset?.browser_download_url && isAllowedAndroidApkUrl(manifestAsset.browser_download_url)) {
      try {
        const mResp = await fetchFn(manifestAsset.browser_download_url, {
          method: 'GET',
          signal: controller.signal,
        });
        if (mResp.ok) {
          manifest = (await mResp.json()) as AndroidLatestManifest;
        }
      } catch {
        // manifest is optional; fall back to release tag & APK asset
      }
    }

    const apkAsset = pickAndroidApkAsset(assets, manifest?.fileName);
    const rawApkUrl = apkAsset?.browser_download_url ?? null;
    const apkUrl = isAllowedAndroidApkUrl(rawApkUrl) ? rawApkUrl!.trim() : null;

    let sha256 =
      normalizeSha256Hex(manifest?.sha256) || normalizeSha256Hex(apkAsset?.digest);

    if (!sha256 && apkAsset?.name) {
      const sumsAsset = assets.find(
        (a) => typeof a.name === 'string' && a.name.toLowerCase() === 'sha256sums-android.txt'
      );
      if (sumsAsset?.browser_download_url && isAllowedAndroidApkUrl(sumsAsset.browser_download_url)) {
        try {
          const sResp = await fetchFn(sumsAsset.browser_download_url, {
            method: 'GET',
            signal: controller.signal,
          });
          if (sResp.ok) {
            sha256 = parseSha256FromSumsText(await sResp.text(), apkAsset.name);
          }
        } catch {
          // optional checksum file
        }
      }
    }

    const tagVersion = (release.tag_name || '').trim().replace(/^v/i, '') || null;
    const latestVersion =
      (typeof manifest?.versionName === 'string' && manifest.versionName.trim()
        ? manifest.versionName.trim().replace(/^v/i, '')
        : tagVersion) || currentVersion;
    const latestVersionCode =
      typeof manifest?.versionCode === 'number' && Number.isFinite(manifest.versionCode)
        ? manifest.versionCode
        : null;

    const releaseNotes = typeof release.body === 'string' ? release.body.trim().slice(0, 800) : '';
    const newer = isNewerAndroidRelease(
      { versionName: currentVersion, versionCode: currentVersionCode },
      { versionName: latestVersion, versionCode: latestVersionCode }
    );

    if (newer && apkUrl) {
      return {
        status: 'update_available',
        currentVersion,
        currentVersionCode,
        latestVersion,
        latestVersionCode,
        apkUrl,
        sha256,
        releaseNotes,
        checkedAt,
      };
    }

    return {
      status: 'up_to_date',
      currentVersion,
      currentVersionCode,
      latestVersion,
      latestVersionCode,
      apkUrl,
      sha256,
      releaseNotes,
      checkedAt,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      status: 'error',
      currentVersion,
      currentVersionCode,
      latestVersion: null,
      latestVersionCode: null,
      apkUrl: null,
      sha256: null,
      releaseNotes: '',
      checkedAt,
      error: isTimeout ? tm('updater.timeout') : tm('updater.networkError'),
    };
  } finally {
    clearTimeout(timer);
  }
}
