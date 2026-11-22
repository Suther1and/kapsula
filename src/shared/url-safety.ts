function isPrivateIpv4Tuple(a: number, b: number, c: number, d: number): boolean {
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv4Literal(raw: string): [number, number, number, number] | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function parseIpv6Hextets(raw: string): number[] | null {
  const clean = raw.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!clean.includes(':')) return null;

  let working = clean.toLowerCase();
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Literal(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dblIdx = working.indexOf('::');
  if (dblIdx !== -1) {
    if (working.indexOf('::', dblIdx + 2) !== -1) return null;
    const left = working.slice(0, dblIdx).split(':').filter(Boolean);
    const right = working.slice(dblIdx + 2).split(':').filter(Boolean);
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const all = [...left, ...new Array<string>(missing).fill('0'), ...right];
    const parsed = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return parsed.some((n) => !Number.isInteger(n)) ? null : parsed;
  }

  const groups = working.split(':');
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return parsed.some((n) => !Number.isInteger(n)) ? null : parsed;
}

function isPrivateIpLiteral(ip: string): boolean {
  const v4 = parseIpv4Literal(ip);
  if (v4) {
    return isPrivateIpv4Tuple(v4[0], v4[1], v4[2], v4[3]);
  }
  const h = parseIpv6Hextets(ip);
  if (h) {
    const allZeroExceptLast = h.slice(0, 7).every((x) => x === 0);
    if (allZeroExceptLast && (h[7] === 0 || h[7] === 1)) return true;
    // IPv4-mapped (::ffff:w.x.y.z) or IPv4-compatible (::w.x.y.z)
    if (
      h.slice(0, 5).every((x) => x === 0) &&
      (h[5] === 0xffff || h[5] === 0)
    ) {
      return isPrivateIpv4Tuple(h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff);
    }
    // NAT64 (64:ff9b::/96)
    if (h[0] === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
      return isPrivateIpv4Tuple(h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff);
    }
    if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return false;
}

/**
 * Pure JS check rejecting localhost, local domains, private/reserved IPv4 & IPv6 literals,
 * and integer/hex IP representations (safe for both Electron Node and Capacitor WebView).
 */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = (hostname.trim().replace(/^\[|\]$/g, '').toLowerCase().split('%')[0] ?? '').trim();
  if (
    !h ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  if (!h.includes('.') && !h.includes(':') && (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h))) {
    return true;
  }
  if (isPrivateIpLiteral(h)) return true;

  try {
    const parsedHost = new URL(h.includes(':') ? `http://[${h}]` : `http://${h}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    if (!parsedHost || parsedHost === 'localhost' || parsedHost.endsWith('.localhost')) {
      return true;
    }
    if (parsedHost !== h && isPrivateIpLiteral(parsedHost)) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}
