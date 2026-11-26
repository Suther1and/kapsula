import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  APP_VERSION,
  BUILD_MOBILE_DIST_CHANNEL,
  computeVersionCodeFromSemver,
  type MobileDistChannel,
} from '@shared/app-version';
import { isSafeExternalUrl } from '@shared/url-safety';
import { tm } from '../lib/mobile-i18n';
import { base64ToBytes } from '../sync/mobile-crypto';

export interface NativeDeviceInfo {
  model: string;
  manufacturer: string;
  osVersion: string;
  platform: 'android' | 'web';
}

export interface NativeFoldState {
  posture: 'flat' | 'half-opened';
  isSeparating: boolean;
  hingeOrientation: 'vertical' | 'horizontal' | 'none';
  hingeBounds: { left: number; top: number; right: number; bottom: number } | null;
}

export interface NativeKeyboardState {
  visible: boolean;
  heightDp: number;
}

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'error';

export interface SharedFilePayload {
  name: string;
  mime: string;
  base64?: string;
  stagedPath?: string;
  size: number;
}

export interface SharedIntentPayload {
  id: string;
  action: 'send' | 'send_multiple';
  text?: string;
  subject?: string;
  url?: string;
  files?: SharedFilePayload[];
  truncatedCount?: number;
  receivedAt: number;
}

export interface PickedFilePayload {
  name: string;
  mime: string;
  base64?: string;
  stagedPath?: string;
  size: number;
}

export interface VoiceRecordingStopResult {
  ok: boolean;
  base64?: string;
  stagedPath?: string;
  mime?: string;
  durationSec?: number;
  peaks?: number[];
  error?: string;
}

export interface NativeAppVersion {
  versionName: string;
  versionCode: number;
  distChannel?: MobileDistChannel;
  allowSelfUpdate?: boolean;
}

export interface ApkInstallResult {
  ok: boolean;
  needsPermission?: boolean;
  error?: string;
}

export interface ExternalTextFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  error?: string;
}

interface KapsulaNativePluginInterface {
  getDeviceInfo(): Promise<NativeDeviceInfo>;
  getAppVersion(): Promise<NativeAppVersion>;
  isKeystoreAvailable(): Promise<{ available: boolean }>;
  keystoreEncrypt(options: { plainText: string }): Promise<{ cipherText: string }>;
  keystoreDecrypt(options: { cipherText: string }): Promise<{ plainText: string }>;
  isAuthKeystoreAvailable(): Promise<{ available: boolean }>;
  keystoreAuthEncrypt(options: { plainText: string }): Promise<{ cipherText: string }>;
  keystoreAuthDecrypt(options: { cipherText: string }): Promise<{ plainText: string }>;
  checkBiometric(): Promise<{ available: boolean; biometryType: string }>;
  authenticateBiometric(options: {
    title: string;
    subtitle?: string;
    negativeButtonText?: string;
  }): Promise<{ ok: boolean; reason?: string; error?: string }>;
  copySensitive(options: {
    text: string;
    wipeSeconds: number;
    sensitive?: boolean;
  }): Promise<{ ok: boolean; wipeSeconds: number }>;
  setScreenSecure(options: { enabled: boolean }): Promise<{ ok: boolean }>;
  minimizeApp(): Promise<void>;
  consumePendingShares(): Promise<{ shares: SharedIntentPayload[] }>;
  consumePendingAuthCallback(): Promise<{ url: string | null }>;
  downloadAndInstallApk(options: { url: string; sha256?: string | null }): Promise<ApkInstallResult>;
  startVoiceRecording(): Promise<{ ok: boolean; error?: string }>;
  stopVoiceRecording(): Promise<VoiceRecordingStopResult>;
  cancelVoiceRecording(): Promise<{ ok: boolean }>;
  capturePhoto(): Promise<{ ok: boolean; file?: PickedFilePayload; error?: string }>;
  pickFile(options: { mime?: string; multiple?: boolean }): Promise<{
    ok: boolean;
    files?: PickedFilePayload[];
    truncated?: boolean;
    error?: string;
  }>;
  deleteStagedFile(options: { stagedPath: string }): Promise<{ ok: boolean }>;
  getFoldState(): Promise<NativeFoldState>;
  getKeyboardState(): Promise<NativeKeyboardState>;
  hideKeyboard(): Promise<{ ok: boolean }>;
  hapticImpact(options: { style: HapticStyle }): Promise<{ ok: boolean }>;
  setSystemBarsTheme(options: {
    theme: 'dark' | 'light';
    backgroundHex?: string;
  }): Promise<{ ok: boolean }>;
  openExternalUrl(options: { url: string }): Promise<{ ok: boolean }>;
  fetchExternalText(options: {
    url: string;
    accept?: string;
    userAgent?: string;
    timeoutMs?: number;
  }): Promise<ExternalTextFetchResult>;
  addListener(
    eventName: 'shareReceived',
    listenerFunc: (payload: SharedIntentPayload) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'authCallbackUrl',
    listenerFunc: (payload: { url: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'apkDownloadProgress',
    listenerFunc: (payload: { percent: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'foldStateChanged',
    listenerFunc: (state: NativeFoldState) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'keyboardStateChanged',
    listenerFunc: (state: NativeKeyboardState) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'voiceAmplitude',
    listenerFunc: (data: { level: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'appLifecycle',
    listenerFunc: (data: { state: 'resumed' | 'paused' }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'backPressed',
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
}

const KapsulaNative = registerPlugin<KapsulaNativePluginInterface>('KapsulaNative');

export function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

let webClipboardWipeTimer: ReturnType<typeof setTimeout> | null = null;

// Web fallback voice recorder state
let webMediaRecorder: MediaRecorder | null = null;
let webMediaStream: MediaStream | null = null;
let webAudioChunks: Blob[] = [];
let webVoiceStartedAt = 0;
let webVoicePeaks: number[] = [];
let webAudioCtx: AudioContext | null = null;
let webAmpInterval: ReturnType<typeof setInterval> | null = null;
const webAmpListeners = new Set<(level: number) => void>();

function cleanupWebRecorder(): void {
  if (webAmpInterval) {
    clearInterval(webAmpInterval);
    webAmpInterval = null;
  }
  if (webAudioCtx) {
    void webAudioCtx.close().catch(() => {});
    webAudioCtx = null;
  }
  if (webMediaStream) {
    webMediaStream.getTracks().forEach((t) => t.stop());
    webMediaStream = null;
  }
  webMediaRecorder = null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error(tm('bridge.fileReadErr')));
    reader.readAsDataURL(blob);
  });
}

const MAX_PICK_SINGLE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PICK_TOTAL_BYTES = 24 * 1024 * 1024;

function pickFilesWeb(
  accept: string,
  multiple: boolean
): Promise<{ files: PickedFilePayload[]; truncated: boolean }> {
  if (typeof document === 'undefined') return Promise.resolve({ files: [], truncated: false });
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (files: PickedFilePayload[], truncated: boolean) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve({ files, truncated });
    };

    input.onchange = async () => {
      const list = Array.from(input.files ?? []);
      const out: PickedFilePayload[] = [];
      let totalBytes = 0;
      let truncated = false;
      for (const file of list) {
        if (file.size > MAX_PICK_SINGLE_FILE_BYTES) {
          truncated = true;
          continue;
        }
        if (out.length > 0 && totalBytes + file.size > MAX_PICK_TOTAL_BYTES) {
          truncated = true;
          break;
        }
        try {
          const base64 = await blobToBase64(file);
          totalBytes += file.size;
          out.push({
            name: file.name || `file-${Date.now()}`,
            mime: file.type || 'application/octet-stream',
            base64,
            size: file.size,
          });
        } catch {
          // skip unreadable file
        }
      }
      finish(out, truncated);
    };

    input.oncancel = () => finish([], false);
    input.click();
  });
}

let activeNativeUiFlows = 0;

function beginNativeUiFlow(): () => void {
  activeNativeUiFlows += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeNativeUiFlows = Math.max(0, activeNativeUiFlows - 1);
  };
}

export function isNativeExternalFlowInFlight(): boolean {
  return activeNativeUiFlows > 0;
}

export const mobileBridge = {
  isNativeAndroid,

  async getDeviceInfo(): Promise<NativeDeviceInfo> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.getDeviceInfo();
      } catch {
        // fallback below
      }
    }
    return {
      model: 'Android Fold',
      manufacturer: 'Samsung',
      osVersion: '15',
      platform: isNativeAndroid() ? 'android' : 'web',
    };
  },

  async isKeystoreAvailable(): Promise<boolean> {
    if (!isNativeAndroid()) return false;
    try {
      const res = await KapsulaNative.isKeystoreAvailable();
      return Boolean(res?.available);
    } catch {
      return false;
    }
  },

  async keystoreEncrypt(plainText: string): Promise<string> {
    if (!isNativeAndroid()) {
      throw new Error(tm('bridge.keystoreDeviceOnly'));
    }
    const res = await KapsulaNative.keystoreEncrypt({ plainText });
    return res.cipherText;
  },

  async keystoreDecrypt(cipherText: string): Promise<string> {
    if (!isNativeAndroid()) {
      throw new Error(tm('bridge.keystoreDeviceOnly'));
    }
    const res = await KapsulaNative.keystoreDecrypt({ cipherText });
    return res.plainText;
  },

  async isAuthKeystoreAvailable(): Promise<boolean> {
    if (!isNativeAndroid()) return false;
    try {
      const res = await KapsulaNative.isAuthKeystoreAvailable();
      return Boolean(res?.available);
    } catch {
      return false;
    }
  },

  async keystoreAuthEncrypt(plainText: string): Promise<string> {
    if (!isNativeAndroid()) {
      throw new Error(tm('bridge.keystoreDeviceOnly'));
    }
    const res = await KapsulaNative.keystoreAuthEncrypt({ plainText });
    return res.cipherText;
  },

  async keystoreAuthDecrypt(cipherText: string): Promise<string> {
    if (!isNativeAndroid()) {
      throw new Error(tm('bridge.keystoreDeviceOnly'));
    }
    const res = await KapsulaNative.keystoreAuthDecrypt({ cipherText });
    return res.plainText;
  },

  async checkBiometric(): Promise<{ available: boolean; biometryType: string }> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.checkBiometric();
      } catch {
        return { available: false, biometryType: 'none' };
      }
    }
    return { available: true, biometryType: 'biometric_preview' };
  },

  async authenticateBiometric(
    title: string,
    subtitle?: string
  ): Promise<{ ok: boolean; reason?: string; error?: string }> {
    const endFlow = beginNativeUiFlow();
    try {
      if (isNativeAndroid()) {
        try {
          return await KapsulaNative.authenticateBiometric({
            title,
            subtitle,
            negativeButtonText: tm('common.cancel'),
          });
        } catch (err) {
          return {
            ok: false,
            reason: 'error',
            error: err instanceof Error ? err.message : tm('bridge.biometricFailed'),
          };
        }
      }
      return { ok: true };
    } finally {
      endFlow();
    }
  },

  async copySensitive(
    text: string,
    wipeSeconds = 30,
    sensitive = wipeSeconds > 0
  ): Promise<{ ok: boolean; wipeSeconds: number }> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.copySensitive({ text, wipeSeconds, sensitive });
      } catch {
        // fall through to web clipboard
      }
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // ignore clipboard denial in headless preview
    }
    if (webClipboardWipeTimer) clearTimeout(webClipboardWipeTimer);
    if (wipeSeconds > 0 && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      webClipboardWipeTimer = setTimeout(() => {
        void navigator.clipboard.writeText('').catch(() => {});
      }, wipeSeconds * 1000);
    }
    return { ok: true, wipeSeconds };
  },

  async setScreenSecure(enabled: boolean): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await KapsulaNative.setScreenSecure({ enabled });
      } catch {
        // ignore
      }
    }
  },

  async minimizeApp(): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await KapsulaNative.minimizeApp();
      } catch {
        // ignore
      }
    }
  },

  onBackPressed(cb: () => void): () => void {
    if (!isNativeAndroid()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void KapsulaNative.addListener('backPressed', cb)
      .then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  },

  async copyPlain(text: string): Promise<boolean> {
    return (await this.copySensitive(text, 0)).ok;
  },

  async consumePendingShares(): Promise<SharedIntentPayload[]> {
    if (isNativeAndroid()) {
      try {
        const res = await KapsulaNative.consumePendingShares();
        return Array.isArray(res?.shares) ? res.shares : [];
      } catch {
        return [];
      }
    }
    return [];
  },

  onShareReceived(cb: (payload: SharedIntentPayload) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('shareReceived', cb)
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }

    // Allow Playwright / web preview testing of Android Share Target via CustomEvent
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<SharedIntentPayload>).detail;
      if (detail) cb(detail);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('kapsula:android-share', handler);
      return () => window.removeEventListener('kapsula:android-share', handler);
    }
    return () => {};
  },

  async startVoiceRecording(): Promise<{ ok: boolean; error?: string }> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.startVoiceRecording();
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : tm('bridge.micDenied'),
        };
      }
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: tm('bridge.micUnavailable') };
    }
    try {
      cleanupWebRecorder();
      webAudioChunks = [];
      webVoicePeaks = [];
      webMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      webMediaRecorder = mimeType
        ? new MediaRecorder(webMediaStream, { mimeType })
        : new MediaRecorder(webMediaStream);
      webMediaRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) webAudioChunks.push(ev.data);
      };
      webMediaRecorder.start(200);
      webVoiceStartedAt = Date.now();

      try {
        webAudioCtx = new AudioContext();
        const src = webAudioCtx.createMediaStreamSource(webMediaStream);
        const analyser = webAudioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        webAmpInterval = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const amp = Math.abs((data[i]! - 128) / 128);
            if (amp > peak) peak = amp;
          }
          const level = Math.min(1, peak * 2.4);
          webVoicePeaks.push(Number(level.toFixed(3)));
          if (webVoicePeaks.length > 120) webVoicePeaks.shift();
          webAmpListeners.forEach((fn) => fn(level));
        }, 120);
      } catch {
        // amplitude visualization is optional
      }

      return { ok: true };
    } catch {
      cleanupWebRecorder();
      return { ok: false, error: tm('bridge.micPermissionVoice') };
    }
  },

  async stopVoiceRecording(): Promise<VoiceRecordingStopResult> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.stopVoiceRecording();
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : tm('bridge.voiceSaveErr'),
        };
      }
    }

    if (!webMediaRecorder) {
      return { ok: false, error: tm('bridge.recordingInactive') };
    }
    const recorder = webMediaRecorder;
    const durationSec = Math.max(1, Math.round((Date.now() - webVoiceStartedAt) / 1000));
    const peaks = webVoicePeaks.length > 0 ? [...webVoicePeaks] : [0.25, 0.5, 0.35, 0.7, 0.4];

    return new Promise<VoiceRecordingStopResult>((resolve) => {
      recorder.onstop = async () => {
        try {
          const mime = recorder.mimeType || 'audio/webm';
          const blob = new Blob(webAudioChunks, { type: mime });
          const base64 = await blobToBase64(blob);
          cleanupWebRecorder();
          resolve({ ok: true, base64, mime, durationSec, peaks });
        } catch {
          cleanupWebRecorder();
          resolve({ ok: false, error: tm('bridge.recordingProcessErr') });
        }
      };
      try {
        recorder.stop();
      } catch {
        cleanupWebRecorder();
        resolve({ ok: false, error: tm('bridge.recordingStopErr') });
      }
    });
  },

  async cancelVoiceRecording(): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await KapsulaNative.cancelVoiceRecording();
      } catch {
        // ignore
      }
      return;
    }
    try {
      webMediaRecorder?.stop();
    } catch {
      // ignore
    }
    cleanupWebRecorder();
  },

  onVoiceAmplitude(cb: (level: number) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('voiceAmplitude', (d) => cb(d.level))
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }
    webAmpListeners.add(cb);
    return () => {
      webAmpListeners.delete(cb);
    };
  },

  async capturePhoto(): Promise<PickedFilePayload | null> {
    const endFlow = beginNativeUiFlow();
    try {
      if (isNativeAndroid()) {
        try {
          const res = await KapsulaNative.capturePhoto();
          return res.ok && res.file ? res.file : null;
        } catch {
          return null;
        }
      }
      const { files } = await pickFilesWeb('image/*', false);
      return files[0] ?? null;
    } finally {
      endFlow();
    }
  },

  async pickFileWithMeta(
    mime = '*/*',
    multiple = false
  ): Promise<{ files: PickedFilePayload[]; truncated: boolean }> {
    const endFlow = beginNativeUiFlow();
    try {
      if (isNativeAndroid()) {
        try {
          const res = await KapsulaNative.pickFile({ mime, multiple });
          return {
            files: res.ok && Array.isArray(res.files) ? res.files : [],
            truncated: Boolean(res.truncated),
          };
        } catch {
          return { files: [], truncated: false };
        }
      }
      return await pickFilesWeb(mime, multiple);
    } finally {
      endFlow();
    }
  },

  async pickFile(mime = '*/*', multiple = false): Promise<PickedFilePayload[]> {
    const res = await this.pickFileWithMeta(mime, multiple);
    return res.files;
  },

  async getFoldState(): Promise<NativeFoldState> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.getFoldState();
      } catch {
        // default below
      }
    }
    return {
      posture: 'flat',
      isSeparating: false,
      hingeOrientation: 'none',
      hingeBounds: null,
    };
  },

  onFoldStateChanged(cb: (state: NativeFoldState) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('foldStateChanged', cb)
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }
    if (typeof window === 'undefined') return () => {};
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<NativeFoldState>).detail;
      if (detail) cb(detail);
    };
    window.addEventListener('kapsula:fold-state', handler);
    return () => window.removeEventListener('kapsula:fold-state', handler);
  },

  async getKeyboardState(): Promise<NativeKeyboardState> {
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.getKeyboardState();
      } catch {
        // default below
      }
    }
    return { visible: false, heightDp: 0 };
  },

  onKeyboardStateChanged(cb: (state: NativeKeyboardState) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('keyboardStateChanged', cb)
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }
    if (typeof window === 'undefined') return () => {};
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<NativeKeyboardState>).detail;
      if (detail) cb(detail);
    };
    window.addEventListener('kapsula:keyboard-state', handler);
    return () => window.removeEventListener('kapsula:keyboard-state', handler);
  },

  async hideKeyboard(): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await KapsulaNative.hideKeyboard();
      } catch {
        // ignore
      }
    }
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  },

  haptic(style: HapticStyle = 'light'): void {
    if (isNativeAndroid()) {
      void KapsulaNative.hapticImpact({ style }).catch(() => {});
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        if (style === 'error') {
          navigator.vibrate([14, 40, 14]);
        } else {
          const ms = style === 'heavy' ? 18 : style === 'medium' || style === 'success' ? 12 : 6;
          navigator.vibrate(ms);
        }
      }
    } catch {
      // ignore on unsupported browsers
    }
  },

  onAppLifecycle(cb: (state: 'resumed' | 'paused') => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('appLifecycle', (d) => cb(d.state))
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }

    if (typeof document === 'undefined') return () => {};
    const onVis = () => {
      cb(document.visibilityState === 'visible' ? 'resumed' : 'paused');
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  },

  async setSystemBarsTheme(theme: 'dark' | 'light', backgroundHex?: string): Promise<void> {
    if (isNativeAndroid()) {
      try {
        await KapsulaNative.setSystemBarsTheme({ theme, ...(backgroundHex ? { backgroundHex } : {}) });
      } catch {
        // ignore
      }
    }
  },

  async openExternalUrl(url: string): Promise<void> {
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean) && !/^mailto:/i.test(clean) && !/^tel:/i.test(clean)) {
      return;
    }
    const endFlow = beginNativeUiFlow();
    try {
      if (isNativeAndroid()) {
        try {
          await KapsulaNative.openExternalUrl({ url: clean });
          return;
        } catch {
          // fallback
        }
      }
      if (typeof window !== 'undefined') {
        window.open(clean, '_blank', 'noopener,noreferrer');
      }
    } finally {
      endFlow();
    }
  },

  async fetchExternalText(options: {
    url: string;
    accept?: string;
    userAgent?: string;
    timeoutMs?: number;
  }): Promise<ExternalTextFetchResult> {
    const cleanUrl = options.url.trim();
    if (!isSafeExternalUrl(cleanUrl)) {
      return {
        ok: false,
        status: 0,
        finalUrl: cleanUrl,
        contentType: '',
        body: '',
        error: 'blocked_url',
      };
    }

    const timeoutMs = Math.max(1000, Math.min(8000, options.timeoutMs ?? 4500));

    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.fetchExternalText({
          url: cleanUrl,
          accept: options.accept,
          userAgent: options.userAgent,
          timeoutMs,
        });
      } catch {
        return {
          ok: false,
          status: 0,
          finalUrl: cleanUrl,
          contentType: '',
          body: '',
        };
      }
    }

    // Web / preview / Vitest fallback with SSRF-safe manual redirect validation
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let currentUrl = cleanUrl;
    try {
      const headers: Record<string, string> = {};
      if (options.accept) headers.Accept = options.accept;
      const maxHops = 4;
      for (let hop = 0; hop <= maxHops; hop++) {
        if (!isSafeExternalUrl(currentUrl)) {
          return {
            ok: false,
            status: 0,
            finalUrl: currentUrl,
            contentType: '',
            body: '',
            error: 'blocked_url',
          };
        }
        const resp = await fetch(currentUrl, {
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc || hop >= maxHops) {
            return {
              ok: false,
              status: resp.status,
              finalUrl: currentUrl,
              contentType: '',
              body: '',
              error: 'blocked_url',
            };
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(loc.trim(), currentUrl).toString();
          } catch {
            return {
              ok: false,
              status: 0,
              finalUrl: currentUrl,
              contentType: '',
              body: '',
              error: 'blocked_url',
            };
          }
          if (!isSafeExternalUrl(nextUrl)) {
            return {
              ok: false,
              status: 0,
              finalUrl: nextUrl,
              contentType: '',
              body: '',
              error: 'blocked_url',
            };
          }
          currentUrl = nextUrl;
          continue;
        }
        const resolvedFinal = resp.url || currentUrl;
        if (!isSafeExternalUrl(resolvedFinal)) {
          return {
            ok: false,
            status: 0,
            finalUrl: resolvedFinal,
            contentType: '',
            body: '',
            error: 'blocked_url',
          };
        }
        const text = await resp.text();
        return {
          ok: resp.ok,
          status: resp.status,
          finalUrl: resolvedFinal,
          contentType: resp.headers.get('content-type') || '',
          body: text.slice(0, 260_000),
        };
      }
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        body: '',
      };
    } catch {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        body: '',
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async consumePendingAuthCallback(): Promise<string | null> {
    if (isNativeAndroid()) {
      try {
        const res = await KapsulaNative.consumePendingAuthCallback();
        return typeof res?.url === 'string' && res.url.trim() ? res.url.trim() : null;
      } catch {
        return null;
      }
    }
    return null;
  },

  onAuthCallbackUrl(cb: (url: string) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('authCallbackUrl', (data) => {
        if (typeof data?.url === 'string' && data.url.trim()) {
          cb(data.url.trim());
        }
      })
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }
    if (typeof window === 'undefined') return () => {};
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ url?: string } | string>).detail;
      const url = typeof detail === 'string' ? detail : detail?.url;
      if (typeof url === 'string' && url.trim()) cb(url.trim());
    };
    window.addEventListener('kapsula:auth-callback', handler);
    return () => window.removeEventListener('kapsula:auth-callback', handler);
  },

  async deleteStagedFile(stagedPath?: string | null): Promise<void> {
    if (!stagedPath || !isNativeAndroid()) return;
    try {
      await KapsulaNative.deleteStagedFile({ stagedPath });
    } catch {
      // ignore cleanup error
    }
  },

  async readNativeFileBytes(file: { base64?: string | null; stagedPath?: string | null }): Promise<Uint8Array> {
    if (file.stagedPath) {
      try {
        const src = Capacitor.convertFileSrc(file.stagedPath);
        const resp = await fetch(src);
        if (!resp.ok) {
          throw new Error(`Failed to read staged file (${resp.status})`);
        }
        return new Uint8Array(await resp.arrayBuffer());
      } finally {
        await mobileBridge.deleteStagedFile(file.stagedPath);
      }
    }
    if (file.base64) {
      return base64ToBytes(file.base64);
    }
    return new Uint8Array(0);
  },

  async getAppVersion(): Promise<NativeAppVersion> {
    if (isNativeAndroid()) {
      try {
        const res = await KapsulaNative.getAppVersion();
        if (res?.versionName) {
          const distChannel: MobileDistChannel =
            res.distChannel === 'play'
              ? 'play'
              : res.distChannel === 'direct'
                ? 'direct'
                : BUILD_MOBILE_DIST_CHANNEL;
          const allowSelfUpdate =
            typeof res.allowSelfUpdate === 'boolean'
              ? res.allowSelfUpdate && distChannel !== 'play'
              : distChannel !== 'play';
          return {
            versionName: String(res.versionName),
            versionCode: Number(res.versionCode) || 1,
            distChannel,
            allowSelfUpdate,
          };
        }
      } catch {
        // fallback below
      }
    }
    return {
      versionName: APP_VERSION,
      versionCode: computeVersionCodeFromSemver(APP_VERSION),
      distChannel: BUILD_MOBILE_DIST_CHANNEL,
      allowSelfUpdate: BUILD_MOBILE_DIST_CHANNEL !== 'play',
    };
  },

  async downloadAndInstallApk(url: string, sha256?: string | null): Promise<ApkInstallResult> {
    const cleanSha = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(cleanSha)) {
      return {
        ok: false,
        error: tm('bridge.apkChecksumMissing'),
      };
    }
    if (isNativeAndroid()) {
      try {
        return await KapsulaNative.downloadAndInstallApk({
          url,
          sha256: cleanSha,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : tm('bridge.apkInstallErr'),
        };
      }
    }
    return {
      ok: false,
      error: tm('bridge.apkAndroidOnly'),
    };
  },

  onApkDownloadProgress(cb: (percent: number) => void): () => void {
    if (isNativeAndroid()) {
      let handle: PluginListenerHandle | null = null;
      let cancelled = false;
      void KapsulaNative.addListener('apkDownloadProgress', (data) => {
        if (typeof data?.percent === 'number' && Number.isFinite(data.percent)) {
          cb(Math.max(0, Math.min(100, Math.round(data.percent))));
        }
      })
        .then((h) => {
          if (cancelled) void h.remove();
          else handle = h;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (handle) void handle.remove();
      };
    }
    if (typeof window === 'undefined') return () => {};
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ percent?: number }>).detail;
      if (typeof detail?.percent === 'number' && Number.isFinite(detail.percent)) {
        cb(Math.max(0, Math.min(100, Math.round(detail.percent))));
      }
    };
    window.addEventListener('kapsula:apk-download-progress', handler);
    return () => window.removeEventListener('kapsula:apk-download-progress', handler);
  },
};
