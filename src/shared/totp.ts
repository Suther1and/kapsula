import type { TotpAlgorithm, TotpCodeSnapshot } from './types';

const MASK32 = 0xffffffff;
const MASK64 = 0xffffffffffffffffn;

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | ((x << (64n - n)) & MASK64)) & MASK64;
}

/**
 * Pure TypeScript synchronous SHA-1 (FIPS 180-4).
 */
export function sha1(message: Uint8Array): Uint8Array {
  const bitLen = BigInt(message.length) * 8n;
  const paddedLen = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl32((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5a827999;
      } else if (i < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8f1bbcdc;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure TypeScript synchronous SHA-256 (FIPS 180-4).
 */
export function sha256(message: Uint8Array): Uint8Array {
  const bitLen = BigInt(message.length) * 8n;
  const paddedLen = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) & MASK32;
    h1 = (h1 + b) & MASK32;
    h2 = (h2 + c) & MASK32;
    h3 = (h3 + d) & MASK32;
    h4 = (h4 + e) & MASK32;
    h5 = (h5 + f) & MASK32;
    h6 = (h6 + g) & MASK32;
    h7 = (h7 + h) & MASK32;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0 >>> 0, false);
  outView.setUint32(4, h1 >>> 0, false);
  outView.setUint32(8, h2 >>> 0, false);
  outView.setUint32(12, h3 >>> 0, false);
  outView.setUint32(16, h4 >>> 0, false);
  outView.setUint32(20, h5 >>> 0, false);
  outView.setUint32(24, h6 >>> 0, false);
  outView.setUint32(28, h7 >>> 0, false);
  return out;
}

const SHA512_K: readonly bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

/**
 * Pure TypeScript synchronous SHA-512 (FIPS 180-4) using ES2020 BigInt.
 */
export function sha512(message: Uint8Array): Uint8Array {
  const bitLen = BigInt(message.length) * 8n;
  const paddedLen = Math.ceil((message.length + 17) / 128) * 128;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(paddedLen - 16, (bitLen >> 64n) & MASK64, false);
  view.setBigUint64(paddedLen - 8, bitLen & MASK64, false);

  let h0 = 0x6a09e667f3bcc908n;
  let h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn;
  let h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n;
  let h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn;
  let h7 = 0x5be0cd19137e2179n;

  const w = new Array<bigint>(80).fill(0n);

  for (let offset = 0; offset < paddedLen; offset += 128) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getBigUint64(offset + i * 8, false);
    }
    for (let i = 16; i < 80; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr64(w15, 1n) ^ rotr64(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr64(w2, 19n) ^ rotr64(w2, 61n) ^ (w2 >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 80; i += 1) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ ((~e & MASK64) & g);
      const temp1 = (h + S1 + ch + SHA512_K[i]! + w[i]!) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & MASK64;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }

    h0 = (h0 + a) & MASK64;
    h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64;
    h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64;
    h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64;
    h7 = (h7 + h) & MASK64;
  }

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  outView.setBigUint64(0, h0, false);
  outView.setBigUint64(8, h1, false);
  outView.setBigUint64(16, h2, false);
  outView.setBigUint64(24, h3, false);
  outView.setBigUint64(32, h4, false);
  outView.setBigUint64(40, h5, false);
  outView.setBigUint64(48, h6, false);
  outView.setBigUint64(56, h7, false);
  return out;
}

/**
 * Pure TypeScript synchronous HMAC (RFC 2104) supporting SHA1, SHA256, and SHA512.
 */
export function computeHmac(
  algorithm: TotpAlgorithm,
  key: Uint8Array,
  message: Uint8Array
): Uint8Array {
  const hashFn = algorithm === 'SHA512' ? sha512 : algorithm === 'SHA256' ? sha256 : sha1;
  const blockSize = algorithm === 'SHA512' ? 128 : 64;

  const keyBlock = new Uint8Array(blockSize);
  if (key.length > blockSize) {
    keyBlock.set(hashFn(key));
  } else {
    keyBlock.set(key);
  }

  const innerPad = new Uint8Array(blockSize + message.length);
  const outerPad = new Uint8Array(blockSize + (algorithm === 'SHA512' ? 64 : algorithm === 'SHA256' ? 32 : 20));
  for (let i = 0; i < blockSize; i += 1) {
    innerPad[i] = keyBlock[i]! ^ 0x36;
    outerPad[i] = keyBlock[i]! ^ 0x5c;
  }
  innerPad.set(message, blockSize);
  const innerDigest = hashFn(innerPad);
  outerPad.set(innerDigest, blockSize);
  return hashFn(outerPad);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE32_ALPHABET.length; i += 1) {
  BASE32_LOOKUP[BASE32_ALPHABET.charCodeAt(i)] = i;
}

/**
 * Decodes an RFC 4648 Base32 string into raw bytes.
 * Case-insensitive; ignores spaces, hyphens, and optional trailing `=` padding.
 */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = (input || '').replace(/[\s-]+/g, '').toUpperCase().replace(/=+$/, '');
  if (!cleaned) {
    throw new Error('Empty Base32 input');
  }

  const out = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  let buffer = 0;
  let bitsLeft = 0;
  let outIdx = 0;

  for (let i = 0; i < cleaned.length; i += 1) {
    const code = cleaned.charCodeAt(i);
    const val = code < 128 ? BASE32_LOOKUP[code]! : -1;
    if (val < 0) {
      throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    }
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out[outIdx] = (buffer >>> bitsLeft) & 0xff;
      outIdx += 1;
    }
  }

  if (outIdx === 0) {
    throw new Error('Base32 secret is too short');
  }

  return out.subarray(0, outIdx);
}

export interface ParsedTotpConfig {
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
}

function normalizeAlgorithm(raw: string | null): TotpAlgorithm | null {
  if (!raw || !raw.trim()) return 'SHA1';
  const norm = raw.trim().toUpperCase().replace(/-/g, '');
  if (norm === 'SHA1') return 'SHA1';
  if (norm === 'SHA256') return 'SHA256';
  if (norm === 'SHA512') return 'SHA512';
  return null;
}

/**
 * Parses either an `otpauth://totp/...` URI or a raw Base32 secret string.
 * Returns `null` if invalid or unsupported (e.g. `hotp`, invalid Base32, invalid digits/period).
 */
export function parseOtpAuthUri(uriOrSecret: string): ParsedTotpConfig | null {
  const trimmed = (uriOrSecret || '').trim();
  if (!trimmed) return null;

  if (/^otpauth:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== 'totp') {
      return null;
    }

    const rawSecret = url.searchParams.get('secret');
    if (!rawSecret) return null;
    const normalizedSecret = rawSecret.replace(/[\s-]+/g, '').toUpperCase().replace(/=+$/, '');
    try {
      const decoded = decodeBase32(normalizedSecret);
      if (decoded.length === 0) return null;
    } catch {
      return null;
    }

    const algorithm = normalizeAlgorithm(url.searchParams.get('algorithm'));
    if (!algorithm) return null;

    const rawDigits = url.searchParams.get('digits');
    let digits: 6 | 8 = 6;
    if (rawDigits !== null && rawDigits.trim() !== '') {
      const parsedDigits = Number(rawDigits.trim());
      if (parsedDigits !== 6 && parsedDigits !== 8) return null;
      digits = parsedDigits;
    }

    const rawPeriod = url.searchParams.get('period');
    let period = 30;
    if (rawPeriod !== null && rawPeriod.trim() !== '') {
      const parsedPeriod = Number(rawPeriod.trim());
      if (!Number.isInteger(parsedPeriod) || parsedPeriod < 5 || parsedPeriod > 300) return null;
      period = parsedPeriod;
    }

    let label = '';
    try {
      label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      label = url.pathname.replace(/^\/+/, '');
    }

    let labelIssuer: string | undefined;
    let account: string | undefined;
    const colonIdx = label.indexOf(':');
    if (colonIdx >= 0) {
      const iss = label.slice(0, colonIdx).trim();
      const acc = label.slice(colonIdx + 1).trim();
      if (iss) labelIssuer = iss;
      if (acc) account = acc;
    } else if (label.trim()) {
      account = label.trim();
    }

    const queryIssuer = url.searchParams.get('issuer')?.trim();
    const issuer = queryIssuer || labelIssuer;

    return {
      secret: normalizedSecret,
      ...(issuer ? { issuer } : {}),
      ...(account ? { account } : {}),
      algorithm,
      digits,
      period,
    };
  }

  // Reject other URI schemes (e.g. https://, mailto:)
  if (trimmed.includes('://')) return null;

  const normalizedSecret = trimmed.replace(/[\s-]+/g, '').toUpperCase().replace(/=+$/, '');
  if (normalizedSecret.length < 8) return null;
  try {
    const decoded = decodeBase32(normalizedSecret);
    if (decoded.length < 5) return null;
  } catch {
    return null;
  }

  return {
    secret: normalizedSecret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  };
}

/**
 * Generates an RFC 6238 TOTP code snapshot synchronously.
 */
export function generateTotp(params: {
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: 6 | 8;
  period?: number;
  nowMs?: number;
}): TotpCodeSnapshot {
  const algorithm: TotpAlgorithm = params.algorithm ?? 'SHA1';
  const digits: 6 | 8 = params.digits === 8 ? 8 : 6;
  const period =
    typeof params.period === 'number' && Number.isFinite(params.period) && params.period > 0
      ? Math.floor(params.period)
      : 30;
  const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();

  const epochSec = Math.floor(nowMs / 1000);
  const counter = BigInt(Math.floor(epochSec / period));
  const counterBytes = new Uint8Array(8);
  const counterView = new DataView(counterBytes.buffer);
  counterView.setBigUint64(0, counter < 0n ? 0n : counter, false);

  const keyBytes = decodeBase32(params.secret);
  const digest = computeHmac(algorithm, keyBytes, counterBytes);

  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  const code = String((binary >>> 0) % mod).padStart(digits, '0');
  const elapsedInWindow = ((epochSec % period) + period) % period;
  const remainingSec = period - elapsedInWindow;

  return {
    code,
    remainingSec,
    period,
  };
}

/**
 * Checks whether a user-supplied string is a valid `otpauth://totp/...` URI or raw Base32 secret.
 */
export function isValidTotpInput(input: string): boolean {
  return parseOtpAuthUri(input) !== null;
}
