import { translate } from '@shared/i18n';

export interface RecordedWavResult {
  wavBase64: string;
  mime: 'audio/wav';
  durationSec: number;
  peaks: number[];
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function encodeFloat32ToWavBuffer(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM linear
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function decodeBlobToMono16kWav(
  blob: Blob,
  fallbackDurationSec: number
): Promise<RecordedWavResult> {
  // Never fetch(blobUrl) because strict CSP connect-src 'self' rejects blob: fetches
  const rawBytes = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(rawBytes.slice(0));
    const durationSec = Math.max(0.2, decoded.duration || fallbackDurationSec || 0.5);
    const targetRate = 16000;
    const frameCount = Math.max(1, Math.ceil(durationSec * targetRate));
    const offline = new OfflineAudioContext(1, frameCount, targetRate);

    const monoBuf = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const monoData = monoBuf.getChannelData(0);
    const chCount = decoded.numberOfChannels;
    for (let ch = 0; ch < chCount; ch += 1) {
      const src = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i += 1) {
        monoData[i] = (monoData[i] ?? 0) + (src[i] ?? 0) / chCount;
      }
    }

    const source = offline.createBufferSource();
    source.buffer = monoBuf;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);

    const wavBuffer = encodeFloat32ToWavBuffer(samples, targetRate);
    const peaks = computePeaks(samples, 36);
    return {
      wavBase64: arrayBufferToBase64(wavBuffer),
      mime: 'audio/wav',
      durationSec,
      peaks,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function computePeaks(samples: Float32Array, barCount = 36): number[] {
  const step = Math.max(1, Math.floor(samples.length / barCount));
  const out: number[] = [];
  for (let b = 0; b < barCount; b += 1) {
    const start = b * step;
    const end = Math.min(samples.length, start + step);
    let maxVal = 0;
    for (let i = start; i < end; i += 1) {
      const abs = Math.abs(samples[i] ?? 0);
      if (abs > maxVal) maxVal = abs;
    }
    out.push(Math.max(0.14, Math.min(1, maxVal * 1.35)));
  }
  return out;
}

export function generateSyntheticVoiceSample(durationSec = 1.6): RecordedWavResult {
  const sampleRate = 16000;
  const total = Math.max(1600, Math.round(durationSec * sampleRate));
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.sin(Math.min(1, t / 0.12) * Math.PI * 0.5) * Math.sin(Math.min(1, (durationSec - t) / 0.15) * Math.PI * 0.5);
    const voiceMod = 0.45 + 0.55 * Math.abs(Math.sin(t * 7.5));
    samples[i] =
      env *
      voiceMod *
      0.32 *
      (Math.sin(2 * Math.PI * 195 * t) * 0.6 + Math.sin(2 * Math.PI * 390 * t) * 0.25 + Math.sin(2 * Math.PI * 620 * t) * 0.15);
  }
  const wav = encodeFloat32ToWavBuffer(samples, sampleRate);
  return {
    wavBase64: arrayBufferToBase64(wav),
    mime: 'audio/wav',
    durationSec,
    peaks: computePeaks(samples, 36),
  };
}

export interface LiveVoiceSession {
  sampleBarLevel(): number;
  stopAndEncode(): Promise<RecordedWavResult>;
  cancel(): void;
}

export async function startLiveVoiceRecording(): Promise<LiveVoiceSession> {
  if (window.__KAPSULA_SYNTH_MIC__) {
    const startedAt = Date.now();
    return {
      sampleBarLevel: () => 0.25 + 0.65 * Math.abs(Math.sin(Date.now() / 160)),
      stopAndEncode: async () => {
        const dur = Math.max(1.2, Math.min(12, (Date.now() - startedAt) / 1000));
        return generateSyntheticVoiceSample(dur);
      },
      cancel: () => {},
    };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    const isEn = typeof document !== 'undefined' && document.documentElement?.lang === 'en';
    throw new Error(translate(isEn ? 'en' : 'ru', 'error.microphoneAccess'));
  }

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  const freqBins = new Uint8Array(analyser.frequencyBinCount);

  const preferredMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
  );
  const recorder = new MediaRecorder(stream, preferredMime ? { mimeType: preferredMime } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };
  const startedAt = Date.now();
  recorder.start(120);

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  return {
    sampleBarLevel: () => {
      analyser.getByteFrequencyData(freqBins);
      let sum = 0;
      const limit = Math.min(18, freqBins.length);
      for (let i = 0; i < limit; i += 1) {
        sum += freqBins[i] ?? 0;
      }
      const norm = limit > 0 ? sum / (limit * 255) : 0;
      return Math.max(0.12, Math.min(1, norm * 2.1));
    },
    stopAndEncode: async () => {
      const durationSec = Math.max(0.3, (Date.now() - startedAt) / 1000);
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        };
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        }
      });
      cleanup();
      return decodeBlobToMono16kWav(blob, durationSec);
    },
    cancel: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // ignore stop error
      }
      cleanup();
    },
  };
}
