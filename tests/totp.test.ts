import { describe, expect, it } from 'vitest';
import {
  computeHmac,
  decodeBase32,
  generateTotp,
  isValidTotpInput,
  parseOtpAuthUri,
} from '@shared/totp';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 0x1f]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f]!;
  }
  return out;
}

const enc = new TextEncoder();

describe('TOTP engine (RFC 2104 / RFC 4231 / RFC 4648 / RFC 6238)', () => {
  it('matches RFC 2202 HMAC-SHA1 and RFC 4231 HMAC-SHA256/SHA512 test vectors', () => {
    // Test Case 1: key = 0x0b * 20, data = "Hi There"
    const key1 = new Uint8Array(20).fill(0x0b);
    const data1 = enc.encode('Hi There');
    expect(toHex(computeHmac('SHA1', key1, data1))).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00'
    );
    expect(toHex(computeHmac('SHA256', key1, data1))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
    );
    expect(toHex(computeHmac('SHA512', key1, data1))).toBe(
      '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854'
    );

    // Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
    const key2 = enc.encode('Jefe');
    const data2 = enc.encode('what do ya want for nothing?');
    expect(toHex(computeHmac('SHA1', key2, data2))).toBe(
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79'
    );
    expect(toHex(computeHmac('SHA256', key2, data2))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
    expect(toHex(computeHmac('SHA512', key2, data2))).toBe(
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737'
    );

    // Test Case 6: key longer than block size (131 bytes of 0xaa)
    const key6 = new Uint8Array(131).fill(0xaa);
    const data6 = enc.encode('Test Using Larger Than Block-Size Key - Hash Key First');
    expect(toHex(computeHmac('SHA256', key6, data6))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'
    );
    expect(toHex(computeHmac('SHA512', key6, data6))).toBe(
      '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598'
    );

    // Extra check with hex helper
    expect(toHex(computeHmac('SHA1', fromHex('0b'.repeat(20)), data1))).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00'
    );
  });

  it('passes ALL 18 official RFC 6238 Appendix B test vectors (SHA1, SHA256, SHA512)', () => {
    const sha1Secret = encodeBase32(enc.encode('12345678901234567890'));
    const sha256Secret = encodeBase32(enc.encode('12345678901234567890123456789012'));
    const sha512Secret = encodeBase32(
      enc.encode('1234567890123456789012345678901234567890123456789012345678901234')
    );

    const vectors: Array<{
      timeSec: number;
      sha1: string;
      sha256: string;
      sha512: string;
    }> = [
      { timeSec: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936' },
      { timeSec: 1111111109, sha1: '07081804', sha256: '68084774', sha512: '25091201' },
      { timeSec: 1111111111, sha1: '14050471', sha256: '67062674', sha512: '99943326' },
      { timeSec: 1234567890, sha1: '89005924', sha256: '91819424', sha512: '93441116' },
      { timeSec: 2000000000, sha1: '69279037', sha256: '90698825', sha512: '38618901' },
      { timeSec: 20000000000, sha1: '65353130', sha256: '77737706', sha512: '47863826' },
    ];

    for (const v of vectors) {
      const nowMs = v.timeSec * 1000;
      expect(
        generateTotp({ secret: sha1Secret, algorithm: 'SHA1', digits: 8, period: 30, nowMs }).code
      ).toBe(v.sha1);
      expect(
        generateTotp({ secret: sha256Secret, algorithm: 'SHA256', digits: 8, period: 30, nowMs }).code
      ).toBe(v.sha256);
      expect(
        generateTotp({ secret: sha512Secret, algorithm: 'SHA512', digits: 8, period: 30, nowMs }).code
      ).toBe(v.sha512);
    }
  });

  it('computes 6-digit TOTP codes and accurate remainingSec across window boundaries', () => {
    const secret = encodeBase32(enc.encode('12345678901234567890'));

    const at59 = generateTotp({ secret, nowMs: 59_000 });
    expect(at59.code).toBe('287082');
    expect(at59.remainingSec).toBe(1);
    expect(at59.period).toBe(30);

    const at60 = generateTotp({ secret, nowMs: 60_000 });
    expect(at60.remainingSec).toBe(30);
    expect(at60.code).not.toBe(at59.code);

    const customPeriod = generateTotp({ secret, period: 60, nowMs: 45_000 });
    expect(customPeriod.period).toBe(60);
    expect(customPeriod.remainingSec).toBe(15);
  });

  it('decodes RFC 4648 Base32 edge cases (whitespace, hyphens, lowercase, padding) and rejects invalid input', () => {
    const dec = new TextDecoder();
    expect(dec.decode(decodeBase32('MZXW6==='))).toBe('foo');
    expect(dec.decode(decodeBase32('mzxw-6ytb oi======'))).toBe('foobar');
    expect(toHex(decodeBase32('JBSWY3DPEHPK3PXP'))).toBe('48656c6c6f21deadbeef');
    expect(decodeBase32('jbsw y3dp-ehpk 3pxp')).toEqual(decodeBase32('JBSWY3DPEHPK3PXP'));

    expect(() => decodeBase32('')).toThrow();
    expect(() => decodeBase32('   ---  ')).toThrow();
    expect(() => decodeBase32('JBSWY3DP0189')).toThrow();
    expect(() => decodeBase32('NOT!VALID')).toThrow();
  });

  it('parses otpauth://totp URIs and raw Base32 secrets cleanly while rejecting invalid inputs', () => {
    const full = parseOtpAuthUri(
      'otpauth://totp/GitHub:alice%40example.com?secret=jbsw-y3dp-ehpk-3pxp&issuer=GitHub%20Inc&algorithm=SHA256&digits=8&period=60'
    );
    expect(full).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'GitHub Inc',
      account: 'alice@example.com',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
    });

    const labelIssuerFallback = parseOtpAuthUri(
      'otpauth://totp/Cloudflare:ops@acme.io?secret=GEZDGNBVGY3TQOJQ'
    );
    expect(labelIssuerFallback).toEqual({
      secret: 'GEZDGNBVGY3TQOJQ',
      issuer: 'Cloudflare',
      account: 'ops@acme.io',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    const raw = parseOtpAuthUri('  jbsw y3dp ehpk 3pxp  ');
    expect(raw).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    expect(isValidTotpInput('JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isValidTotpInput('otpauth://totp/Test:a@b.c?secret=JBSWY3DPEHPK3PXP')).toBe(true);

    // Reject unsupported or invalid values
    expect(parseOtpAuthUri('otpauth://hotp/Test:a?secret=JBSWY3DPEHPK3PXP&counter=1')).toBeNull();
    expect(parseOtpAuthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=7')).toBeNull();
    expect(parseOtpAuthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&algorithm=MD5')).toBeNull();
    expect(parseOtpAuthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=0')).toBeNull();
    expect(parseOtpAuthUri('https://example.com/?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(parseOtpAuthUri('short')).toBeNull();
    expect(isValidTotpInput('invalid-0189-secret')).toBe(false);
  });
});
