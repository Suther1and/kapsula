import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLocale, ExtractedAction } from '@shared/types';

const execFileAsync = promisify(execFile);

export interface OcrResult {
  text: string;
  lines: string[];
}

export function extractActionsFromText(text: string, locale: AppLocale = 'ru'): ExtractedAction[] {
  if (!text) return [];
  const actions: ExtractedAction[] = [];
  const seen = new Set<string>();
  const codeLabelPrefix = locale === 'en' ? 'Code' : 'Код';

  const pushUnique = (item: ExtractedAction) => {
    const key = `${item.type}:${item.value}`;
    if (!seen.has(key) && actions.length < 6) {
      seen.add(key);
      actions.push(item);
    }
  };

  // URLs (explicit protocol + bare domains like magicui.design, 21st.dev, github.com/owner/repo)
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;!?]+$/, '');
    pushUnique({ type: 'url', label: url.replace(/^https?:\/\//, '').slice(0, 32), value: url });
  }
  const textWithoutProtoUrls = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ');
  for (const m of textWithoutProtoUrls.matchAll(
    /(?:^|[\s(])((?:[a-z0-9-]+\.)+(?:com|io|dev|design|ai|app|org|net|co|me|ru|xyz)(?:\/[^\s<>"')\]]*)?)/gi
  )) {
    const rawHost = m[1]!.replace(/[.,;!?]+$/, '');
    if (/\.(?:png|jpe?g|webp|gif|svg|pdf|mp4|wav|mp3|json|txt)$/i.test(rawHost)) continue;
    const url = `https://${rawHost}`;
    pushUnique({ type: 'url', label: rawHost.slice(0, 32), value: url });
  }

  // Emails
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    pushUnique({ type: 'email', label: m[0], value: m[0] });
  }

  // Strip URLs before scanning promo codes so URL slugs (/demo-kapsula/) never become fake promo chips
  const textWithoutUrls = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ');

  for (const m of textWithoutUrls.matchAll(
    /(?:промокод|promo|coupon|купон|код(?:\s+скидки|\s+доступа)?)\s*(?:[:=—]|\s+)\s*([A-Za-z0-9][A-Za-z0-9_-]{3,24})/gi
  )) {
    const code = (m[1] || '').trim().toUpperCase();
    if (
      code &&
      code.length >= 4 &&
      !/^\d{4}-\d{2}$/.test(code) &&
      !/^(?:ERR|ERROR|WARN|BUG|HTTP|HTTPS|UTF|SHA|AES)-/i.test(code) &&
      !/^(?:ОШИБКИ|ДОСТУПА|ОТВЕТА|СТАТУСА|ERROR|HTTP|NULL|NONE)$/i.test(code)
    ) {
      pushUnique({ type: 'code', label: `${codeLabelPrefix} ${code}`, value: code });
    }
  }

  const TECHNICAL_PREFIXES = new Set([
    'SHA', 'AES', 'RSA', 'MD5', 'TLS', 'SSL', 'UTF', 'ISO',
    'HTTP', 'HTTPS', 'API', 'SDK', 'CPU', 'GPU', 'RAM', 'SSD',
    'HDD', 'USB', 'HDMI', 'UUID', 'JSON', 'BIP', 'WIN', 'CVE', 'RFC',
    'ERR', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FAIL', 'FATAL', 'BUG', 'FIX',
    'SYS', 'NET', 'SQL', 'AUTH', 'DEV', 'PROD', 'STAGE', 'TEST', 'REF',
    'ID', 'SKU', 'MSG', 'LOG', 'VER', 'REV', 'REL', 'APP', 'OS', 'MAC',
    'X64', 'X86', 'ARM', 'ENV', 'PORT', 'PID', 'TID', 'TCP', 'UDP', 'DNS',
    'SSH', 'FTP', 'PNG', 'JPG', 'PDF', 'DOC', 'ZIP', 'MP3', 'MP4', 'CODE',
  ]);
  const PROMO_PREFIXES = new Set(['PROMO', 'SALE', 'SAVE', 'GIFT', 'VIP', 'WELCOME', 'CLUB', 'KAPSULA']);

  for (const m of textWithoutUrls.matchAll(/\b([A-Za-z]{2,10})-([A-Za-z0-9]{3,10})(?:-[A-Za-z0-9]{2,8})?\b/g)) {
    const raw = (m[0] || '').trim();
    const prefix = (m[1] || '').trim().toUpperCase();
    const suffix = (m[2] || '').trim();
    const code = raw.toUpperCase();
    const matchIndex = m.index ?? 0;
    if (TECHNICAL_PREFIXES.has(prefix)) continue;
    // Ignore ordinary lowercase prose compounds; keep alphanumeric/uppercase codes
    if (!/\d/.test(raw) && !/[A-Z]{3}/.test(raw)) continue;
    if (suffix.length < 4 && !/[A-Z0-9]/.test(suffix)) continue;
    // Avoid catching generic 2-part issue/ticket tags like TS-230 or APP-404 unless near promo context
    const hasThirdSegment = (raw.match(/-/g)?.length ?? 0) >= 2;
    const around = textWithoutUrls.slice(Math.max(0, matchIndex - 36), matchIndex + raw.length + 36);
    const hasPromoContext = /(?:промо|promo|coupon|купон|скидк|voucher|bonus|бонус)/i.test(around);
    if (!hasThirdSegment && !hasPromoContext && !PROMO_PREFIXES.has(prefix) && /^\d{3,4}$/.test(suffix)) {
      continue;
    }
    if (code.length >= 5 && !/^\d{4}-\d{2}$/.test(code)) {
      pushUnique({ type: 'code', label: `${codeLabelPrefix} ${code}`, value: code });
    }
  }

  // Phone numbers (+7 / 8 / international) without matching substrings of longer numbers
  for (const m of text.matchAll(/(?<!\d)(?:\+7|8|\+1|\+44|\+49)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g)) {
    pushUnique({ type: 'phone', label: m[0].trim(), value: m[0].trim() });
  }

  // CLI commands
  for (const m of text.matchAll(/(?:^|\n)\s*((?:npm|pnpm|uv|git|curl|pip|npx)\s+[^\n\r]{4,70})/gim)) {
    const cmd = m[1]!.trim();
    pushUnique({ type: 'command', label: cmd.slice(0, 32), value: cmd });
  }

  return actions;
}

export function samplePaletteFromBgra(bitmap: Buffer, width: number, height: number): string[] {
  if (!bitmap || width <= 0 || height <= 0 || bitmap.length < width * height * 4) {
    return [];
  }
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const stepX = Math.max(1, Math.floor(width / 16));
  const stepY = Math.max(1, Math.floor(height / 16));

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      const b = bitmap[idx]!;
      const g = bitmap[idx + 1]!;
      const r = bitmap[idx + 2]!;
      const a = bitmap[idx + 3]!;
      if (a < 128) continue;

      const brightness = (r + g + b) / 3;
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      // Weight colorful midtones higher than flat background white/black
      if (brightness < 14 || brightness > 246) continue;

      const qr = Math.floor(r / 32) * 32;
      const qg = Math.floor(g / 32) * 32;
      const qb = Math.floor(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;
      const prev = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      const weight = 1 + Math.floor(sat / 40);
      prev.count += weight;
      prev.r += r * weight;
      prev.g += g * weight;
      prev.b += b * weight;
      buckets.set(key, prev);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((c) => {
      const r = Math.min(255, Math.round(c.r / c.count));
      const g = Math.min(255, Math.round(c.g / c.count));
      const b = Math.min(255, Math.round(c.b / c.count));
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    });
}

export function parseOcrJsonOutput(stdout: string): OcrResult {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return { text: '', lines: [] };
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown; lines?: unknown };
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      : typeof parsed.lines === 'string' && parsed.lines.trim()
        ? [parsed.lines.trim()]
        : [];
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : lines.join('\n').trim();
    return { text, lines };
  } catch {
    return { text: '', lines: [] };
  }
}

export function resolveWinRtScript(dataDir: string): string {
  const candidates = [
    path.join(__dirname, 'winrt-ocr.ps1'),
    path.resolve(process.cwd(), 'dist/main/winrt-ocr.ps1'),
    path.resolve(process.cwd(), 'src/main/ocr/winrt-ocr.ps1'),
  ];

  // PowerShell cannot read scripts inside Electron app.asar, so materialize a physical copy in dataDir
  const targetDir = path.join(dataDir, 'scripts');
  const targetPath = path.join(targetDir, 'winrt-ocr.ps1');

  for (const c of candidates) {
    if (c.includes('app.asar')) {
      const unpacked = c.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) {
        return unpacked;
      }
    }
    if (fs.existsSync(c)) {
      if (!c.includes('.asar')) return c;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(c, targetPath);
      return targetPath;
    }
  }
  throw new Error('winrt-ocr.ps1 script not found');
}

export function resolveMacOsVisionBinary(): string | null {
  const candidates = [
    path.join(__dirname, 'macos-vision-ocr'),
    path.resolve(process.cwd(), 'dist/main/macos-vision-ocr'),
  ];
  for (const c of candidates) {
    if (c.includes('app.asar')) {
      const unpacked = c.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
    }
    if (fs.existsSync(c) && !c.includes('.asar')) {
      return c;
    }
  }
  return null;
}

export async function runWinRtOcr(imagePath: string, dataDir: string): Promise<OcrResult> {
  if (process.platform !== 'win32' || !fs.existsSync(imagePath)) {
    return { text: '', lines: [] };
  }

  try {
    const scriptPath = resolveWinRtScript(dataDir);
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', imagePath],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    return parseOcrJsonOutput(stdout);
  } catch {
    return { text: '', lines: [] };
  }
}

export async function runMacOsVisionOcr(imagePath: string): Promise<OcrResult> {
  if (process.platform !== 'darwin' || !fs.existsSync(imagePath)) {
    return { text: '', lines: [] };
  }

  const binPath = resolveMacOsVisionBinary();
  if (!binPath) {
    return { text: '', lines: [] };
  }

  try {
    const { stdout } = await execFileAsync(binPath, [imagePath], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseOcrJsonOutput(stdout);
  } catch {
    return { text: '', lines: [] };
  }
}
