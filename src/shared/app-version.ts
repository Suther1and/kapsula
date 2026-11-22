declare const __APP_VERSION__: string | undefined;
declare const __MOBILE_DIST_CHANNEL__: 'play' | 'direct' | undefined;

/**
 * Single source of truth for runtime fallback version strings across Desktop, Mobile, and Main.
 * Bundled builds inject `__APP_VERSION__` directly from `package.json`.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()
    ? __APP_VERSION__.trim()
    : '1.0.5';

export type MobileDistChannel = 'play' | 'direct';

export const BUILD_MOBILE_DIST_CHANNEL: MobileDistChannel =
  typeof __MOBILE_DIST_CHANNEL__ === 'string' && __MOBILE_DIST_CHANNEL__ === 'play'
    ? 'play'
    : 'direct';

export function computeVersionCodeFromSemver(version: string = APP_VERSION): number {
  const parts = String(version || '1.0.5')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((p) => Number.parseInt(p, 10) || 0);
  const [maj = 1, min = 0, pat = 0] = parts;
  return Math.max(1, maj * 10000 + min * 100 + pat) * 10000;
}
