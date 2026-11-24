import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen, systemPreferences } from 'electron';
import { defaultPlatformPasteAdapter } from './platform/platform-adapters';

export interface SurfaceWindows {
  vault: BrowserWindow;
  hud: BrowserWindow | null;
}

export const HUD_WINDOW_SIZE = { width: 860, height: 580 };

export interface HudBoundsStore {
  getPosition: (displayId: string) => { x: number; y: number } | null;
  savePosition: (displayId: string, x: number, y: number) => void;
}

export class WindowManager {
  public vault: BrowserWindow | null = null;
  public hud: BrowserWindow | null = null;
  private hudPreventBlurClose = false;
  private isQuitting = false;
  private hudMoveSaveTimer: NodeJS.Timeout | null = null;
  private hudWarmupTimer: NodeJS.Timeout | null = null;
  private hudLoaded = false;
  private hudShowPending = false;
  private hudContentProtection = false;
  private onHudHide?: () => void;

  constructor(
    private readonly preloadPath: string,
    private readonly rendererEntry: { url?: string; htmlPath?: string },
    private readonly iconPath?: string,
    private readonly hudBoundsStore?: HudBoundsStore
  ) {}

  public setQuitting(quitting: boolean): void {
    this.isQuitting = quitting;
    if (quitting && this.hudWarmupTimer) {
      clearTimeout(this.hudWarmupTimer);
      this.hudWarmupTimer = null;
    }
  }

  public setOnHudHide(cb?: () => void): void {
    this.onHudHide = cb;
  }

  public setHudContentProtection(enabled: boolean): void {
    const envDisabled =
      !app.isPackaged && process.env.KAPSULA_DISABLE_CONTENT_PROTECTION === '1';
    const effective = envDisabled ? false : Boolean(enabled);
    this.hudContentProtection = effective;
    if (this.hud && !this.hud.isDestroyed()) {
      try {
        this.hud.setContentProtection(effective);
      } catch {
        // Optional depending on OS compositor / headless environment
      }
    }
  }

  private hardenWindow(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, targetUrl) => {
      if (!this.isAllowedSurfaceUrl(targetUrl)) {
        e.preventDefault();
      }
    });
  }

  private loadSurface(win: BrowserWindow, surface: 'vault' | 'hud'): void {
    this.hardenWindow(win);
    if (this.rendererEntry.url) {
      void win.loadURL(`${this.rendererEntry.url}?surface=${surface}`);
    } else if (this.rendererEntry.htmlPath) {
      void win.loadFile(this.rendererEntry.htmlPath, { query: { surface } });
    }
  }

  public createAll(): SurfaceWindows {
    const workArea = screen.getPrimaryDisplay().workArea;
    const isMac = process.platform === 'darwin';

    // 1. Main Vault Workspace
    this.vault = new BrowserWindow({
      width: Math.min(1360, workArea.width - 48),
      height: Math.min(880, workArea.height - 48),
      minWidth: 960,
      minHeight: 620,
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 16, y: 17 },
          }
        : {
            frame: false,
          }),
      backgroundColor: '#0f0f11',
      show: false,
      icon: this.iconPath,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.loadSurface(this.vault, 'vault');
    this.vault.once('ready-to-show', () => {
      this.vault?.show();
      if (!this.isQuitting && !this.hud && !this.hudWarmupTimer) {
        this.hudWarmupTimer = setTimeout(() => {
          this.hudWarmupTimer = null;
          if (!this.isQuitting && !this.hud) {
            try {
              this.ensureHudWindow();
            } catch {
              // On-demand fallback in showHud() will still create HUD if warm-up hits shutdown
            }
          }
        }, 1200);
        this.hudWarmupTimer.unref?.();
      }
    });
    this.vault.on('enter-full-screen', () => {
      this.vault?.webContents.send('window:fullscreen-changed', true);
    });
    this.vault.on('leave-full-screen', () => {
      this.vault?.webContents.send('window:fullscreen-changed', false);
    });
    this.vault.on('close', (e) => {
      if (!this.isQuitting && process.env.KAPSULA_E2E_QUIT_ON_CLOSE !== '1') {
        e.preventDefault();
        this.hideVaultSafely();
      }
    });

    return {
      vault: this.vault,
      hud: this.hud,
    };
  }

  public ensureHudWindow(): BrowserWindow {
    if (this.hud && !this.hud.isDestroyed()) {
      return this.hud;
    }
    if (this.hudWarmupTimer) {
      clearTimeout(this.hudWarmupTimer);
      this.hudWarmupTimer = null;
    }
    this.hudLoaded = false;

    const workArea = screen.getPrimaryDisplay().workArea;
    const isMac = process.platform === 'darwin';
    const hudW = Math.min(HUD_WINDOW_SIZE.width, workArea.width - 32);
    const hudH = Math.min(HUD_WINDOW_SIZE.height, workArea.height - 48);
    const initialBounds = this.computeHudBounds(screen.getPrimaryDisplay(), hudW, hudH);
    const hud = new BrowserWindow({
      width: hudW,
      height: hudH,
      x: initialBounds.x,
      y: initialBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      thickFrame: false,
      roundedCorners: false,
      ...(isMac
        ? {
            type: 'panel' as const,
            hiddenInMissionControl: true,
          }
        : {}),
      show: false,
      backgroundColor: '#00000000',
      icon: this.iconPath,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.hud = hud;
    hud.setAlwaysOnTop(true, 'screen-saver');
    try {
      hud.setVisibleOnAllWorkspaces(
        true,
        isMac
          ? { visibleOnFullScreen: true, skipTransformProcessType: true }
          : { visibleOnFullScreen: true }
      );
    } catch {
      // Optional depending on OS compositor
    }
    if (this.hudContentProtection) {
      try {
        hud.setContentProtection(true);
      } catch {
        // Optional depending on OS compositor / headless environment
      }
    }
    hud.on('close', (e) => {
      if (!this.isQuitting && process.env.KAPSULA_E2E_QUIT_ON_CLOSE !== '1') {
        e.preventDefault();
        this.hud?.hide();
      }
    });
    hud.webContents.once('did-finish-load', () => {
      this.hudLoaded = true;
    });
    this.loadSurface(hud, 'hud');
    hud.on('moved', () => {
      if (!this.hud || this.hud.isDestroyed() || !this.hud.isVisible()) return;
      if (this.hudMoveSaveTimer) clearTimeout(this.hudMoveSaveTimer);
      this.hudMoveSaveTimer = setTimeout(() => {
        if (!this.hud || this.hud.isDestroyed()) return;
        const b = this.hud.getBounds();
        const disp = screen.getDisplayMatching(b);
        this.hudBoundsStore?.savePosition(String(disp.id), b.x, b.y);
      }, 150);
    });
    hud.on('blur', () => {
      if (process.env.KAPSULA_E2E_KEEP_HUD !== '1' && !this.hudPreventBlurClose) {
        this.hud?.hide();
      }
    });
    hud.on('hide', () => {
      this.onHudHide?.();
    });
    hud.once('closed', () => {
      if (this.hud === hud) {
        this.hud = null;
        this.hudLoaded = false;
      }
    });
    return hud;
  }

  private computeHudBounds(
    display: Electron.Display,
    hudW: number,
    hudH: number
  ): { x: number; y: number; width: number; height: number } {
    const workArea = display.workArea;
    const minX = workArea.x + 8;
    const maxX = Math.max(minX, workArea.x + workArea.width - hudW - 8);
    const minY = workArea.y + 8;
    const maxY = Math.max(minY, workArea.y + workArea.height - hudH - 8);

    const saved = this.hudBoundsStore?.getPosition(String(display.id));
    if (saved) {
      return {
        x: Math.min(maxX, Math.max(minX, Math.round(saved.x))),
        y: Math.min(maxY, Math.max(minY, Math.round(saved.y))),
        width: hudW,
        height: hudH,
      };
    }

    const aspect = workArea.width / Math.max(1, workArea.height);
    // Ultrawide monitors feel slightly left-skewed when dead centered horizontally
    const horizontalRatio = aspect >= 2.05 ? 0.525 : 0.5;
    return {
      x: Math.min(maxX, Math.max(minX, workArea.x + Math.round((workArea.width - hudW) * horizontalRatio))),
      y: Math.min(maxY, Math.max(minY, workArea.y + Math.round(workArea.height * 0.14))),
      width: hudW,
      height: hudH,
    };
  }

  public hideVaultSafely(): void {
    if (!this.vault || this.vault.isDestroyed()) return;
    if (process.platform === 'darwin' && this.vault.isFullScreen()) {
      this.vault.once('leave-full-screen', () => {
        if (this.vault && !this.vault.isDestroyed()) {
          this.vault.hide();
        }
      });
      this.vault.setFullScreen(false);
      return;
    }
    this.vault.hide();
  }

  public showVault(): void {
    if (!this.vault || this.vault.isDestroyed()) return;
    if (process.platform === 'darwin') {
      app.show();
    }
    if (this.vault.isMinimized()) this.vault.restore();
    this.vault.show();
    this.vault.focus();
  }

  public showHud(): void {
    if (this.isQuitting) return;
    const hud = this.ensureHudWindow();
    const present = () => {
      if (this.isQuitting || hud.isDestroyed()) return;
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const workArea = display.workArea;
      const hudW = Math.min(HUD_WINDOW_SIZE.width, workArea.width - 32);
      const hudH = Math.min(HUD_WINDOW_SIZE.height, workArea.height - 48);
      hud.setBounds(this.computeHudBounds(display, hudW, hudH));
      hud.show();
      hud.focus();
      hud.webContents.send('hud:opened');
    };
    if (this.hudLoaded || !hud.webContents.isLoadingMainFrame()) {
      present();
      return;
    }
    if (this.hudShowPending) return;
    this.hudShowPending = true;
    let settled = false;
    let fallbackTimer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.hudShowPending = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (!hud.isDestroyed()) {
        hud.webContents.removeListener('did-finish-load', finish);
      }
      present();
    };
    hud.webContents.once('did-finish-load', finish);
    fallbackTimer = setTimeout(finish, 1500);
    fallbackTimer.unref?.();
  }

  public hideHud(): void {
    if (this.hud && !this.hud.isDestroyed() && this.hud.isVisible()) {
      this.hud.hide();
      if (
        process.platform === 'darwin' &&
        (!this.vault || this.vault.isDestroyed() || !this.vault.isVisible())
      ) {
        app.hide();
      }
    }
  }

  public toggleHud(): void {
    if (this.hud && !this.hud.isDestroyed() && this.hud.isVisible()) {
      this.hideHud();
      return;
    }
    this.showHud();
  }

  public setHudPreventBlurClose(prevent: boolean): void {
    this.hudPreventBlurClose = Boolean(prevent);
  }

  public pasteBackFromHud(): boolean {
    if (this.hud && !this.hud.isDestroyed()) {
      this.hud.hide();
    }
    if (process.env.KAPSULA_SKIP_SENDKEYS === '1') {
      return true;
    }
    if (process.platform === 'darwin') {
      let trusted = false;
      try {
        trusted = systemPreferences.isTrustedAccessibilityClient(false);
        if (!trusted) {
          // Prompt/register Kapsula in System Settings → Privacy & Security → Accessibility
          systemPreferences.isTrustedAccessibilityClient(true);
        }
      } catch {
        trusted = false;
      }
      if (!trusted) {
        return false;
      }
      // Return macOS foreground focus to the previously active app before sending Cmd+V
      app.hide();
      setTimeout(() => {
        void defaultPlatformPasteAdapter.triggerPasteShortcut();
      }, 130);
      return true;
    }
    setTimeout(() => {
      void defaultPlatformPasteAdapter.triggerPasteShortcut();
    }, 80);
    return true;
  }

  public isOwnWebContents(wcId: number): boolean {
    return [this.vault, this.hud].some(
      (win) => win !== null && !win.isDestroyed() && win.webContents.id === wcId
    );
  }

  public isAllowedSurfaceUrl(rawUrl?: string): boolean {
    if (!rawUrl) return false;
    try {
      const u = new URL(rawUrl);
      if (this.rendererEntry.url) {
        const expected = new URL(this.rendererEntry.url);
        return u.origin === expected.origin;
      }
      if (this.rendererEntry.htmlPath) {
        if (u.protocol !== 'file:') return false;
        const resolvedTarget = path.resolve(fileURLToPath(u)).toLowerCase();
        const resolvedEntry = path.resolve(this.rendererEntry.htmlPath).toLowerCase();
        return resolvedTarget === resolvedEntry;
      }
      return false;
    } catch {
      return false;
    }
  }

  public setContentProtection(enabled: boolean): void {
    const envDisabled =
      !app.isPackaged && process.env.KAPSULA_DISABLE_CONTENT_PROTECTION === '1';
    const effective = envDisabled ? false : Boolean(enabled);
    this.hudContentProtection = effective;
    for (const win of [this.vault, this.hud]) {
      if (win && !win.isDestroyed()) {
        try {
          win.setContentProtection(effective);
        } catch {
          // Optional depending on OS compositor / headless environment
        }
      }
    }
  }

  public setVaultBackgroundColor(hex: string): void {
    if (!this.vault || this.vault.isDestroyed()) return;
    if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) return;
    try {
      this.vault.setBackgroundColor(hex);
    } catch {
      // ignore invalid or unsupported background color updates
    }
  }

  /**
   * Applies optional OS translucency ONLY to the main Vault window.
   * Quick Launch HUD stays strictly solid (opaque) at all times.
   *
   * On Windows 11 (DWM Mica/Acrylic) and macOS (NSVisualEffectView vibrancy),
   * Chromium paints an opaque backing store unless `setBackgroundColor('#00000000')`
   * is applied alongside the native material.
   */
  public setVaultGlassMaterial(
    material: 'none' | 'mica' | 'acrylic',
    enabled: boolean,
    opaqueFallbackHex?: string
  ): void {
    if (!this.vault || this.vault.isDestroyed()) return;
    const win = this.vault as BrowserWindow & {
      setBackgroundMaterial?: (mat: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed') => void;
    };
    const activeNative = enabled && material !== 'none';
    try {
      if (activeNative) {
        this.vault.setBackgroundColor('#00000000');
      }
      if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
        win.setBackgroundMaterial(activeNative ? material : 'none');
      } else if (process.platform === 'darwin' && typeof this.vault.setVibrancy === 'function') {
        this.vault.setVibrancy(
          activeNative
            ? material === 'acrylic'
              ? 'hud'
              : 'under-window'
            : null
        );
      }
      if (!activeNative && opaqueFallbackHex && /^#[0-9a-f]{6}$/i.test(opaqueFallbackHex)) {
        this.vault.setBackgroundColor(opaqueFallbackHex);
      }
    } catch {
      // ignore OS material errors on older Windows builds or headless CI
      if (opaqueFallbackHex && /^#[0-9a-f]{6}$/i.test(opaqueFallbackHex)) {
        try {
          this.vault.setBackgroundColor(opaqueFallbackHex);
        } catch {
          // ignore
        }
      }
    }
  }

  public broadcast(channel: string, payload: unknown): void {
    for (const win of [this.vault, this.hud]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}

export function resolveIconPath(): string | undefined {
  // Runtime nativeImage.createFromPath requires PNG/ICO (not .icns on macOS)
  const names = process.platform === 'win32' ? ['build/icon.ico', 'build/icon.png'] : ['build/icon.png'];
  const candidates: string[] = [];
  for (const rel of names) {
    if (app.isReady()) {
      candidates.push(path.join(app.getAppPath(), rel));
    }
    candidates.push(
      path.resolve(process.cwd(), rel),
      path.join(__dirname, `../../${rel}`)
    );
  }
  return candidates.find((p) => fs.existsSync(p));
}

export function resolveTrayIconPath():
  | { path: string; path2x?: string; isTemplate: boolean }
  | undefined {
  const relList =
    process.platform === 'darwin'
      ? [
          { rel: 'build/trayTemplate.png', rel2x: 'build/trayTemplate@2x.png', isTemplate: true },
          { rel: 'build/tray.png', rel2x: undefined, isTemplate: false },
        ]
      : [{ rel: 'build/tray.png', rel2x: undefined, isTemplate: false }];
  for (const entry of relList) {
    const candidates: string[] = [];
    if (app.isReady()) {
      const appPath = app.getAppPath();
      if (appPath.includes('app.asar')) {
        candidates.push(path.join(appPath.replace('app.asar', 'app.asar.unpacked'), entry.rel));
      }
      candidates.push(path.join(appPath, entry.rel));
    }
    candidates.push(
      path.resolve(process.cwd(), entry.rel),
      path.join(__dirname, `../../${entry.rel}`)
    );
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      const found2x = entry.rel2x
        ? path.join(path.dirname(found), path.basename(entry.rel2x))
        : undefined;
      return {
        path: found,
        path2x: found2x && fs.existsSync(found2x) ? found2x : undefined,
        isTemplate: entry.isTemplate,
      };
    }
  }
  return undefined;
}
