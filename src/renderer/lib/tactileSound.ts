export type TactileTickKind = 'soft' | 'success' | 'copy' | 'toggle' | 'check';

let audioCtx: AudioContext | null = null;
let globalSoundEnabled = false;

export function setGlobalTactileSoundEnabled(enabled: boolean): void {
  globalSoundEnabled = Boolean(enabled);
}

export function isGlobalTactileSoundEnabled(): boolean {
  return globalSoundEnabled;
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playTactileSound(kind: TactileTickKind = 'soft'): void {
  playTactileTick(globalSoundEnabled, kind);
}

export function playTactileTick(enabled: boolean, kind: TactileTickKind = 'soft'): void {
  if (!enabled) return;
  const ctx = ensureCtx();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const attack = 0.0025; // 2.5ms anti-click ramp
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sine';
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.Q.setValueAtTime(0.7, now);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    if (kind === 'success') {
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.065);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.032, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.096);
      return;
    }

    if (kind === 'check') {
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(740, now + 0.045);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.026, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.052);
      osc.start(now);
      osc.stop(now + 0.058);
      return;
    }

    if (kind === 'toggle') {
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.exponentialRampToValueAtTime(490, now + 0.028);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.022, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.034);
      osc.start(now);
      osc.stop(now + 0.04);
      return;
    }

    if (kind === 'copy') {
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.045);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.024, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
      osc.start(now);
      osc.stop(now + 0.062);
      return;
    }

    osc.frequency.setValueAtTime(420, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.018, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.start(now);
    osc.stop(now + 0.042);
  } catch {
    // Non-fatal audio failure
  }
}
