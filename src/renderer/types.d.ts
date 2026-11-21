import type { KapsulaBridgeApi } from '../preload/index';

declare global {
  interface Window {
    kapsula: KapsulaBridgeApi;
    __KAPSULA_SYNTH_MIC__?: boolean;
  }
}

export {};
