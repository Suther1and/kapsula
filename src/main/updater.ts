import type { AppUpdaterState } from '@shared/types';
import type { FetchLike } from './ai/decision-router';

export const GITHUB_OWNER = 'Suther1and';
export const GITHUB_REPO = 'kapsula';
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

const STARTUP_CHECK_DELAY_MS = 10_000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GITHUB_API_TIMEOUT_MS = 10_000;

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubReleaseAsset[];
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Returns > 0 if `a > b`, 0 if equal, < 0 if `a < b`.
 * Stable releases sort higher than pre-releases of the same numeric version (`1.0.2 > 1.0.2-beta.1`).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return (pa.prerelease ?? '').localeCompare(pb.prerelease ?? '', undefined, { numeric: true });
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

export function isAllowedDownloadUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'github.com') {
      return u.pathname.toLowerCase().startsWith(`/${GITHUB_OWNER.toLowerCase()}/${GITHUB_REPO.toLowerCase()}/`);
    }
    return (
      host === 'objects.githubusercontent.com' ||
      host === 'release-assets.githubusercontent.com'
    );
  } catch {
    return false;
  }
}

export function sanitizeReleaseNotes(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const cleaned = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return cleaned ? cleaned.slice(0, 1200) : null;
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'note' in entry) {
          return String((entry as { note?: unknown }).note ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
    return sanitizeReleaseNotes(joined);
  }
  return null;
}

export function selectReleaseAsset(
  assets: GithubReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string
): GithubReleaseAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const valid = assets.filter(
    (a) =>
      a &&
      typeof a.name === 'string' &&
      typeof a.browser_download_url === 'string' &&
      isAllowedDownloadUrl(a.browser_download_url)
  );
  if (valid.length === 0) return null;

  const lowerArch = (arch || '').toLowerCase();

  if (platform === 'darwin') {
    const dmgs = valid.filter((a) => a.name.toLowerCase().endsWith('.dmg'));
    if (dmgs.length > 0) {
      if (lowerArch === 'arm64' || lowerArch === 'aarch64') {
        const exact = dmgs.find((a) => /arm64|aarch64|apple[-_]?silicon/i.test(a.name));
        if (exact) return exact;
      } else if (lowerArch === 'x64' || lowerArch === 'amd64' || lowerArch === 'intel') {
        const exact = dmgs.find((a) => /x64|x86_64|intel/i.test(a.name));
        if (exact) return exact;
      }
      const universal = dmgs.find((a) => /universal/i.test(a.name));
      if (universal) return universal;
      return dmgs[0] ?? null;
    }
    const macZips = valid.filter(
      (a) => a.name.toLowerCase().endsWith('.zip') && /mac|darwin|osx/i.test(a.name)
    );
    if (macZips.length > 0) {
      const exactZip = macZips.find((a) => a.name.toLowerCase().includes(lowerArch));
      return exactZip ?? macZips[0] ?? null;
    }
    return null;
  }

  if (platform === 'win32') {
    const exes = valid.filter((a) => a.name.toLowerCase().endsWith('.exe'));
    const setupExe = exes.find((a) => /setup|installer/i.test(a.name));
    if (setupExe) return setupExe;
    if (exes.length > 0) return exes[0] ?? null;
    const winZip = valid.find(
      (a) => a.name.toLowerCase().endsWith('.zip') && /win/i.test(a.name)
    );
    return winZip ?? null;
  }

  return null;
}

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL?: (options: Record<string, unknown>) => void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdaterControllerOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged: boolean;
  disableTimers?: boolean;
  onStateChanged?: (state: AppUpdaterState) => void;
  openExternal?: (url: string) => Promise<void> | void;
  getDismissedVersion?: () => string | null;
  setDismissedVersion?: (version: string) => void;
  fetchFn?: FetchLike;
  loadAutoUpdater?: () => Promise<AutoUpdaterLike | null>;
}

export class AppUpdaterController {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly isPackaged: boolean;
  private readonly disableTimers: boolean;
  private readonly fetchFn: FetchLike;
  private readonly openExternal?: (url: string) => Promise<void> | void;
  private readonly onStateChanged?: (state: AppUpdaterState) => void;
  private readonly getDismissedVersion?: () => string | null;
  private readonly setDismissedVersion?: (version: string) => void;
  private readonly loadAutoUpdaterFn?: () => Promise<AutoUpdaterLike | null>;

  private state: AppUpdaterState;
  private autoUpdater: AutoUpdaterLike | null = null;
  private autoUpdaterWired = false;
  private checkInFlight: Promise<AppUpdaterState> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: AppUpdaterControllerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.isPackaged = Boolean(opts.isPackaged);
    this.disableTimers = Boolean(opts.disableTimers);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.openExternal = opts.openExternal;
    this.onStateChanged = opts.onStateChanged;
    this.getDismissedVersion = opts.getDismissedVersion;
    this.setDismissedVersion = opts.setDismissedVersion;
    this.loadAutoUpdaterFn = opts.loadAutoUpdater;

    const initialMode: AppUpdaterState['mode'] =
      this.platform === 'win32' && this.isPackaged ? 'auto' : 'manual-download';

    this.state = {
      status: 'idle',
      currentVersion: opts.currentVersion,
      latestVersion: null,
      releaseNotes: null,
      downloadUrl: null,
      percent: null,
      error: null,
      mode: initialMode,
      checkedAt: null,
      dismissedVersion: opts.getDismissedVersion?.() ?? null,
    };
  }

  public getState(): AppUpdaterState {
    return {
      ...this.state,
      dismissedVersion: this.getDismissedVersion?.() ?? this.state.dismissedVersion ?? null,
    };
  }

  private setState(patch: Partial<AppUpdaterState>): void {
    this.state = {
      ...this.state,
      ...patch,
      dismissedVersion: this.getDismissedVersion?.() ?? this.state.dismissedVersion ?? null,
    };
    if (!this.disposed) {
      this.onStateChanged?.(this.getState());
    }
  }

  public start(): void {
    if (this.disableTimers || !this.isPackaged || this.disposed) return;

    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      void this.checkForUpdates({ silent: true }).catch(() => {});
    }, STARTUP_CHECK_DELAY_MS);
    this.startupTimer.unref?.();

    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(() => {
      void this.checkForUpdates({ silent: true }).catch(() => {});
    }, PERIODIC_CHECK_INTERVAL_MS);
    this.periodicTimer.unref?.();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private async ensureWindowsAutoUpdater(): Promise<AutoUpdaterLike | null> {
    if (this.platform !== 'win32' || !this.isPackaged) return null;
    if (this.autoUpdater) return this.autoUpdater;

    try {
      let loaded: AutoUpdaterLike | null = null;
      if (this.loadAutoUpdaterFn) {
        loaded = await this.loadAutoUpdaterFn();
      } else {
        const mod = await import('electron-updater');
        const raw =
          mod?.autoUpdater ??
          (mod as unknown as { default?: { autoUpdater?: unknown } })?.default?.autoUpdater ??
          null;
        loaded = raw as unknown as AutoUpdaterLike | null;
      }
      if (!loaded) return null;

      this.autoUpdater = loaded;
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppQuit = true;
      try {
        this.autoUpdater.setFeedURL?.({
          provider: 'github',
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
        });
      } catch {
        // electron-builder app-update.yml already configures feed
      }

      if (!this.autoUpdaterWired) {
        this.autoUpdaterWired = true;
        this.autoUpdater.on('checking-for-update', () => {
          this.setState({ status: 'checking', error: null });
        });
        this.autoUpdater.on('update-available', (rawInfo: unknown) => {
          const info = (rawInfo ?? {}) as { version?: string; releaseNotes?: unknown };
          const nextVer = String(info.version ?? '').replace(/^v/i, '').trim() || null;
          this.setState({
            status: 'available',
            mode: 'auto',
            latestVersion: nextVer,
            releaseNotes: sanitizeReleaseNotes(info.releaseNotes),
            downloadUrl: GITHUB_RELEASES_PAGE,
            percent: null,
            error: null,
            checkedAt: Date.now(),
          });
        });
        this.autoUpdater.on('update-not-available', () => {
          this.setState({
            status: 'up-to-date',
            latestVersion: this.state.currentVersion,
            percent: null,
            error: null,
            checkedAt: Date.now(),
          });
        });
        this.autoUpdater.on('download-progress', (rawProg: unknown) => {
          const prog = (rawProg ?? {}) as { percent?: number };
          const pct = Number.isFinite(prog.percent) ? Math.max(0, Math.min(100, Math.round(prog.percent!))) : 0;
          this.setState({
            status: 'downloading',
            mode: 'auto',
            percent: pct,
            error: null,
          });
        });
        this.autoUpdater.on('update-downloaded', (rawInfo: unknown) => {
          const info = (rawInfo ?? {}) as { version?: string; releaseNotes?: unknown };
          const nextVer = String(info.version ?? '').replace(/^v/i, '').trim() || this.state.latestVersion;
          this.setState({
            status: 'downloaded',
            mode: 'auto',
            latestVersion: nextVer,
            releaseNotes: sanitizeReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
            percent: 100,
            error: null,
          });
        });
        this.autoUpdater.on('error', () => {
          // Handled explicitly in checkForUpdates / downloadUpdate catch blocks so silent checks stay quiet
        });
      }
      return this.autoUpdater;
    } catch {
      return null;
    }
  }

  private async checkViaGithubApi(silent: boolean): Promise<AppUpdaterState> {
    try {
      const resp = await this.fetchFn(GITHUB_LATEST_RELEASE_API, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Kapsula-Desktop/${this.state.currentVersion}`,
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });

      if (resp.status === 404) {
        // Repository has no published releases yet
        this.setState({
          status: silent ? 'idle' : 'up-to-date',
          latestVersion: this.state.currentVersion,
          error: null,
          checkedAt: Date.now(),
          mode: 'manual-download',
        });
        return this.getState();
      }

      if (!resp.ok) {
        throw new Error(`GitHub HTTP ${resp.status}`);
      }

      const payload = (await resp.json()) as GithubReleasePayload;
      const latestRaw = String(payload.tag_name || payload.name || '')
        .trim()
        .replace(/^v/i, '');

      if (!latestRaw || !parseSemver(latestRaw)) {
        this.setState({
          status: silent ? 'idle' : 'up-to-date',
          latestVersion: this.state.currentVersion,
          error: null,
          checkedAt: Date.now(),
          mode: 'manual-download',
        });
        return this.getState();
      }

      if (!isNewerVersion(latestRaw, this.state.currentVersion)) {
        this.setState({
          status: silent ? 'idle' : 'up-to-date',
          latestVersion: latestRaw,
          releaseNotes: null,
          downloadUrl: null,
          percent: null,
          error: null,
          checkedAt: Date.now(),
          mode: 'manual-download',
        });
        return this.getState();
      }

      const asset = selectReleaseAsset(payload.assets ?? [], this.platform, this.arch);
      const fallbackUrl =
        payload.html_url && isAllowedDownloadUrl(payload.html_url)
          ? payload.html_url
          : GITHUB_RELEASES_PAGE;

      this.setState({
        status: 'available',
        mode: 'manual-download',
        latestVersion: latestRaw,
        releaseNotes: sanitizeReleaseNotes(payload.body),
        downloadUrl: asset?.browser_download_url ?? fallbackUrl,
        percent: null,
        error: null,
        checkedAt: Date.now(),
      });
      return this.getState();
    } catch {
      if (silent) {
        if (this.state.status === 'checking') {
          this.setState({ status: 'idle', error: null });
        }
        return this.getState();
      }
      this.setState({
        status: 'error',
        error: 'Не удалось проверить обновления — проверь подключение к интернету',
        checkedAt: Date.now(),
      });
      return this.getState();
    }
  }

  public async checkForUpdates(opts?: { silent?: boolean }): Promise<AppUpdaterState> {
    if (this.checkInFlight) return this.checkInFlight;
    const silent = Boolean(opts?.silent);

    this.checkInFlight = (async () => {
      if (!silent) {
        this.setState({ status: 'checking', error: null });
      }

      if (this.platform === 'win32' && this.isPackaged) {
        const updater = await this.ensureWindowsAutoUpdater();
        if (updater) {
          try {
            const res = (await updater.checkForUpdates()) as {
              updateInfo?: { version?: string; releaseNotes?: unknown };
            } | null;
            const latestVer = String(res?.updateInfo?.version ?? '').replace(/^v/i, '').trim();
            if (latestVer && isNewerVersion(latestVer, this.state.currentVersion)) {
              this.setState({
                status: 'available',
                mode: 'auto',
                latestVersion: latestVer,
                releaseNotes: sanitizeReleaseNotes(res?.updateInfo?.releaseNotes),
                downloadUrl: GITHUB_RELEASES_PAGE,
                error: null,
                checkedAt: Date.now(),
              });
            } else {
              this.setState({
                status: silent ? 'idle' : 'up-to-date',
                mode: 'auto',
                latestVersion: latestVer || this.state.currentVersion,
                error: null,
                checkedAt: Date.now(),
              });
            }
            return this.getState();
          } catch {
            // Fallback cleanly to GitHub Releases REST API (e.g. if latest.yml or app-update.yml is not ready)
            return this.checkViaGithubApi(silent);
          }
        }
      }

      return this.checkViaGithubApi(silent);
    })().finally(() => {
      this.checkInFlight = null;
    });

    return this.checkInFlight;
  }

  public async downloadUpdate(): Promise<AppUpdaterState> {
    if (this.state.mode === 'auto' && this.platform === 'win32' && this.isPackaged) {
      const updater = await this.ensureWindowsAutoUpdater();
      if (updater) {
        try {
          this.setState({ status: 'downloading', percent: 0, error: null });
          await updater.downloadUpdate();
          return this.getState();
        } catch {
          // If auto-download fails, fall back cleanly to opening the release download URL in browser
          const fallbackUrl =
            this.state.downloadUrl && isAllowedDownloadUrl(this.state.downloadUrl)
              ? this.state.downloadUrl
              : GITHUB_RELEASES_PAGE;
          if (this.openExternal) {
            await this.openExternal(fallbackUrl);
            this.setState({
              status: 'available',
              mode: 'manual-download',
              downloadUrl: fallbackUrl,
              percent: null,
              error: null,
            });
            return this.getState();
          }
          this.setState({
            status: 'error',
            percent: null,
            error: 'Не удалось скачать обновление — попробуй ещё раз чуть позже',
          });
          return this.getState();
        }
      }
    }

    const url =
      this.state.downloadUrl && isAllowedDownloadUrl(this.state.downloadUrl)
        ? this.state.downloadUrl
        : GITHUB_RELEASES_PAGE;
    if (this.openExternal) {
      await this.openExternal(url);
    }
    return this.getState();
  }

  public async installUpdate(): Promise<{ ok: boolean }> {
    if (this.state.status === 'downloaded' && this.state.mode === 'auto' && this.autoUpdater) {
      this.autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    }
    if (this.state.downloadUrl && isAllowedDownloadUrl(this.state.downloadUrl) && this.openExternal) {
      await this.openExternal(this.state.downloadUrl);
      return { ok: true };
    }
    return { ok: false };
  }

  public dismissUpdate(version?: string): AppUpdaterState {
    const target = (version || this.state.latestVersion || '').trim();
    if (target) {
      this.setDismissedVersion?.(target);
      this.setState({ dismissedVersion: target });
    }
    return this.getState();
  }
}
