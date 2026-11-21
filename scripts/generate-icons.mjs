import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT_DIR = process.cwd();
const BUILD_DIR = path.resolve(ROOT_DIR, 'build');
const RENDERER_ASSETS_DIR = path.resolve(ROOT_DIR, 'src', 'renderer', 'assets');
const EXT_ICONS_DIR = path.resolve(ROOT_DIR, 'extension', 'icons');

const BRAND_MASTER_PATH = path.join(BUILD_DIR, 'brand-master.jpg');
const TRAY_MASTER_PATH = path.join(BUILD_DIR, 'tray-master.jpg');
const FORCE_REGEN = process.argv.includes('--force');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Renders a razor-sharp analytic anti-aliased macOS Menu Bar Template capsule icon
 * (pure black RGB + smooth 4x4 supersampled alpha silhouette) for 18x18 & 36x36 Retina.
 */
function renderMacTemplateCapsuleRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const angle = -Math.PI / 4; // 45-degree iconic Kapsula tilt
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const seg = size * 0.165;
  const rad = size * 0.185;
  const seamHalf = Math.max(0.55, size * 0.036);
  const samples = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples - half;
          const py = y + (sy + 0.5) / samples - half;
          const rx = px * cosA - py * sinA;
          const ry = px * sinA + py * cosA;
          const cy = Math.max(-seg, Math.min(seg, ry));
          const capDist = Math.hypot(rx, ry - cy) - rad;
          if (capDist <= 0) {
            // Subtle crisp diagonal split line across the capsule waist
            const inSeam = Math.abs(ry) < seamHalf && Math.abs(rx) < rad * 0.72;
            if (!inSeam) coverage += 1;
          }
        }
      }
      const alpha = coverage / (samples * samples);
      const idx = (y * size + x) * 4;
      buf[idx] = 0;
      buf[idx + 1] = 0;
      buf[idx + 2] = 0;
      buf[idx + 3] = clampByte(alpha * 255);
    }
  }
  return buf;
}

function proceduralIconRgba(size, macInset = false) {
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const pad = macInset ? size * (100 / 1024) : size * 0.04;
  const boxHalf = half - pad;
  const corner = boxHalf * 0.45;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const qx = Math.abs(dx) - (boxHalf - corner);
      const qy = Math.abs(dy) - (boxHalf - corner);
      const dist =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
        Math.min(Math.max(qx, qy), 0) -
        corner;
      const idx = (y * size + x) * 4;
      if (dist > 1.2) continue;
      const alpha = Math.max(0, Math.min(1, 0.85 - dist));
      const normY = (y - pad) / Math.max(1, size - pad * 2);
      let r = 24 + (1 - normY) * 18;
      let g = 24 + (1 - normY) * 17;
      let b = 22 + (1 - normY) * 16;

      const angle = -0.68;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const rx = dx * cosA - dy * sinA;
      const ry = dx * sinA + dy * cosA;
      const scale = macInset ? 0.805 : 1.0;
      const seg = size * 0.11 * scale;
      const rad = size * 0.14 * scale;
      const cy = Math.max(-seg, Math.min(seg, ry));
      const capDist = Math.hypot(rx, ry - cy) - rad;
      if (capDist < 1.5) {
        const ca = Math.max(0, Math.min(1, 1 - capDist * 0.55));
        r = r * (1 - ca) + 232 * ca;
        g = g * (1 - ca) + 106 * ca;
        b = b * (1 - ca) + 51 * ca;
      }
      buf[idx] = clampByte(r);
      buf[idx + 1] = clampByte(g);
      buf[idx + 2] = clampByte(b);
      buf[idx + 3] = clampByte(alpha * 255);
    }
  }
  return buf;
}

/**
 * Crops the tight non-black content box from a master JPG on Windows using .NET System.Drawing
 * and resamples into exact RGBA buffers cleanly using HighQualityBicubic.
 *
 * Modes:
 *  - 'brand': Full-bleed Windows/app squircle (~95% fill)
 *  - 'brand-mac': Apple HIG macOS squircle (824x824 centered inside 1024x1024 = 80.5% fill + subtle drop shadow)
 *  - 'tray': Windows color taskbar icon
 */
function loadAndResizeMasterWindows(srcJpgPath, sizes, mode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-icon-gen-'));
  const psPath = path.join(tmpDir, 'render.ps1');
  const outPrefix = path.join(tmpDir, 'out_');
  const isBrandMode = mode === 'brand' || mode === 'brand-mac';
  const isMacBrand = mode === 'brand-mac';

  const sizeList = sizes.join(',');
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$srcBmp = New-Object System.Drawing.Bitmap('${srcJpgPath.replace(/'/g, "''")}')
try {
  $w = $srcBmp.Width
  $h = $srcBmp.Height
  $minX = $w; $minY = $h; $maxX = 0; $maxY = 0
  $step = [Math]::Max(1, [int]($w / 256))
  for ($y = 0; $y -lt $h; $y += $step) {
    for ($x = 0; $x -lt $w; $x += $step) {
      $p = $srcBmp.GetPixel($x, $y)
      if ($('${isBrandMode ? 'brand' : 'tray'}') -eq 'brand') {
        if ($p.R -gt 14 -or $p.G -gt 14 -or $p.B -gt 14) {
          if ($x -lt $minX) { $minX = $x }
          if ($y -lt $minY) { $minY = $y }
          if ($x -gt $maxX) { $maxX = $x }
          if ($y -gt $maxY) { $maxY = $y }
        }
      } else {
        # tray: find orange capsule foreground
        if ($p.R -gt 110 -and ($p.R - $p.B) -gt 40) {
          if ($x -lt $minX) { $minX = $x }
          if ($y -lt $minY) { $minY = $y }
          if ($x -gt $maxX) { $maxX = $x }
          if ($y -gt $maxY) { $maxY = $y }
        }
      }
    }
  }
  if ($maxX -le $minX) {
    $minX = 0; $minY = 0; $maxX = $w - 1; $maxY = $h - 1
  }
  $cw = $maxX - $minX + 1
  $ch = $maxY - $minY + 1
  $side = [Math]::Max($cw, $ch)
  if ($('${isBrandMode ? 'brand' : 'tray'}') -eq 'brand') {
    # Trim 2.2% outer edge to remove any faint light-grey fringe from master JPG border
    $cropSide = [int]($side * 0.956)
  } else {
    $pad = [int]($side * 0.16)
    $cropSide = $side + $pad * 2
  }
  $cx = [int](($minX + $maxX) / 2)
  $cy = [int](($minY + $maxY) / 2)
  $cropX = [Math]::Max(0, $cx - [int]($cropSide / 2))
  $cropY = [Math]::Max(0, $cy - [int]($cropSide / 2))
  $cropW = [Math]::Min($w - $cropX, $cropSide)
  $cropH = [Math]::Min($h - $cropY, $cropSide)

  foreach ($s in @(${sizeList})) {
    $dst = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    try {
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      if ($('${isMacBrand ? 'mac' : 'win'}') -eq 'mac') {
        # Apple macOS HIG: 824x824 icon centered inside 1024x1024 canvas (100px margin)
        $inset = [int][Math]::Round($s * (100.0 / 1024.0))
        $inner = [Math]::Max(1, $s - $inset * 2)
        $destRect = New-Object System.Drawing.Rectangle($inset, $inset, $inner, $inner)
      } else {
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
      }
      $g.DrawImage($srcBmp, $destRect, $cropX, $cropY, $cropW, $cropH, [System.Drawing.GraphicsUnit]::Pixel)
    } finally {
      $g.Dispose()
    }
    $rawPath = '${outPrefix.replace(/'/g, "''")}' + $s + '.bgra'
    $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $bd = $dst.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $bytes = New-Object byte[] ($s * $s * 4)
      [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
      [System.IO.File]::WriteAllBytes($rawPath, $bytes)
    } finally {
      $dst.UnlockBits($bd)
      $dst.Dispose()
    }
  }
} finally {
  $srcBmp.Dispose()
}
`;
  fs.writeFileSync(psPath, psScript, 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
      stdio: 'pipe',
    });
    const out = new Map();
    for (const s of sizes) {
      const bgra = fs.readFileSync(`${outPrefix}${s}.bgra`);
      const rgba = Buffer.alloc(bgra.length);
      const half = s / 2;
      const pad = isMacBrand ? s * (100 / 1024) : mode === 'brand' ? s * 0.025 : 0;
      const boxHalf = half - pad;
      const corner = isMacBrand ? boxHalf * 0.45 : s * 0.236;
      const shadowOffsetY = isMacBrand ? Math.max(0.5, s * (14 / 1024)) : 0;
      const shadowBlur = isMacBrand ? Math.max(1.0, s * (26 / 1024)) : 0;

      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const i = (y * s + x) * 4;
          const b = bgra[i];
          const g = bgra[i + 1];
          const r = bgra[i + 2];

          if (isBrandMode) {
            const dx = x + 0.5 - half;
            const dy = y + 0.5 - half;
            const qx = Math.abs(dx) - (boxHalf - corner);
            const qy = Math.abs(dy) - (boxHalf - corner);
            const dist =
              Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
              Math.min(Math.max(qx, qy), 0) -
              corner;
            const edgeWidth = s <= 32 ? 0.9 : 1.35;
            let maskAlpha = 1;
            if (dist > edgeWidth) maskAlpha = 0;
            else if (dist > -0.5) {
              maskAlpha = Math.max(0, Math.min(1, (edgeWidth - dist) / (edgeWidth + 0.5)));
            }

            if (isMacBrand && maskAlpha < 1) {
              // Subtle macOS Dock drop shadow inside the transparent HIG margin
              const sqx = Math.abs(dx) - (boxHalf - corner);
              const sqy = Math.abs(dy - shadowOffsetY) - (boxHalf - corner);
              const sdist =
                Math.hypot(Math.max(sqx, 0), Math.max(sqy, 0)) +
                Math.min(Math.max(sqx, sqy), 0) -
                corner;
              let shadowAlpha = 0;
              if (sdist < shadowBlur * 1.5) {
                const t = Math.max(0, 1 - Math.max(0, sdist) / (shadowBlur * 1.5));
                shadowAlpha = t * t * 0.26;
              }
              const outA = maskAlpha + shadowAlpha * (1 - maskAlpha);
              if (outA > 0.002) {
                rgba[i] = clampByte((r * maskAlpha) / outA);
                rgba[i + 1] = clampByte((g * maskAlpha) / outA);
                rgba[i + 2] = clampByte((b * maskAlpha) / outA);
                rgba[i + 3] = clampByte(outA * 255);
              }
            } else {
              rgba[i] = r;
              rgba[i + 1] = g;
              rgba[i + 2] = b;
              rgba[i + 3] = clampByte(maskAlpha * 255);
            }
          } else {
            // Tray icon: un-premultiply dark background edge so light taskbar shows zero dark fringe
            const warmth = r - b;
            let a = 0;
            if (warmth > 42 && r > 80) {
              a = Math.max(0, Math.min(1, (warmth - 38) / 68));
            }
            if (a > 0 && a < 0.95) {
              rgba[i] = clampByte(24 + (r - 24) / Math.max(0.25, a));
              rgba[i + 1] = clampByte(23 + (g - 23) / Math.max(0.25, a));
              rgba[i + 2] = clampByte(21 + (b - 21) / Math.max(0.25, a));
            } else {
              rgba[i] = r;
              rgba[i + 1] = g;
              rgba[i + 2] = b;
            }
            rgba[i + 3] = clampByte(a * 255);
          }
        }
      }
      out.set(s, encodePng(s, s, rgba));
    }
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Resizes an existing high-res PNG master on macOS using built-in `sips`.
 */
function resizePngSetMacOS(srcPngPath, sizes) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-sips-'));
  try {
    const out = new Map();
    for (const s of sizes) {
      const dst = path.join(tmpDir, `icon_${s}.png`);
      execFileSync('sips', ['-z', String(s), String(s), srcPngPath, '--out', dst], {
        stdio: 'pipe',
      });
      out.set(s, fs.readFileSync(dst));
    }
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function wrapIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const s = sizes[i] >= 256 ? 0 : sizes[i];
    const p = pngBuffers[i];
    const base = i * 16;
    dir[base] = s;
    dir[base + 1] = s;
    dir[base + 2] = 0;
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(p.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += p.length;
  }
  return Buffer.concat([header, dir, ...pngBuffers]);
}

/**
 * Pure-Node Apple ICNS container encoder using modern PNG icon chunks (16..1024px, standard + @2x Retina).
 */
function wrapIcns(pngMap) {
  const slots = [
    ['icp4', 16],
    ['ic11', 32], // 16@2x
    ['icp5', 32],
    ['ic12', 64], // 32@2x
    ['ic07', 128],
    ['ic13', 256], // 128@2x
    ['ic08', 256],
    ['ic14', 512], // 256@2x
    ['ic09', 512],
    ['ic10', 1024], // 512@2x
  ];
  const chunks = [];
  let totalSize = 8;
  for (const [osType, size] of slots) {
    const png = pngMap.get(size);
    if (!png) continue;
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(osType, 0, 4, 'ascii');
    chunkHeader.writeUInt32BE(8 + png.length, 4);
    chunks.push(chunkHeader, png);
    totalSize += 8 + png.length;
  }
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalSize, 4);
  return Buffer.concat([fileHeader, ...chunks]);
}

function allCommittedAssetsPresent() {
  const required = [
    path.join(BUILD_DIR, 'icon.png'),
    path.join(BUILD_DIR, 'icon.icns'),
    path.join(BUILD_DIR, 'icon.ico'),
    path.join(BUILD_DIR, 'tray.png'),
    path.join(BUILD_DIR, 'trayTemplate.png'),
    path.join(BUILD_DIR, 'trayTemplate@2x.png'),
    path.join(RENDERER_ASSETS_DIR, 'kapsula-icon.png'),
    path.join(EXT_ICONS_DIR, 'icon16.png'),
    path.join(EXT_ICONS_DIR, 'icon48.png'),
    path.join(EXT_ICONS_DIR, 'icon128.png'),
  ];
  return required.every((p) => {
    try {
      return fs.statSync(p).size > 100;
    } catch {
      return false;
    }
  });
}

fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(RENDERER_ASSETS_DIR, { recursive: true });
fs.mkdirSync(EXT_ICONS_DIR, { recursive: true });

const brandSizes = [1024, 512, 256, 128, 64, 48, 32, 24, 16];

// Never overwrite committed GPT-Image brand icons with procedural fallback on macOS/Linux CI
if (process.platform !== 'win32' && !FORCE_REGEN && allCommittedAssetsPresent()) {
  console.log(
    'Preserving committed brand icons (build/icon.icns, build/icon.png, build/icon.ico, build/trayTemplate*.png).',
  );
  process.exit(0);
}

let brandPngs;
let macBrandPngs;
let trayPng32;
const trayTemplate18 = encodePng(18, 18, renderMacTemplateCapsuleRgba(18));
const trayTemplate36 = encodePng(36, 36, renderMacTemplateCapsuleRgba(36));

if (process.platform === 'win32' && fs.existsSync(BRAND_MASTER_PATH)) {
  brandPngs = loadAndResizeMasterWindows(BRAND_MASTER_PATH, brandSizes, 'brand');
  macBrandPngs = loadAndResizeMasterWindows(BRAND_MASTER_PATH, brandSizes, 'brand-mac');
  if (fs.existsSync(TRAY_MASTER_PATH)) {
    const trayMap = loadAndResizeMasterWindows(TRAY_MASTER_PATH, [32], 'tray');
    trayPng32 = trayMap.get(32);
  } else {
    trayPng32 = brandPngs.get(32);
  }
} else if (process.platform === 'darwin' && fs.existsSync(path.join(BUILD_DIR, 'icon.png'))) {
  brandPngs = resizePngSetMacOS(path.join(BUILD_DIR, 'icon.png'), brandSizes);
  macBrandPngs = brandPngs;
  trayPng32 = fs.existsSync(path.join(BUILD_DIR, 'tray.png'))
    ? fs.readFileSync(path.join(BUILD_DIR, 'tray.png'))
    : brandPngs.get(32);
} else {
  brandPngs = new Map();
  macBrandPngs = new Map();
  for (const s of brandSizes) {
    brandPngs.set(s, encodePng(s, s, proceduralIconRgba(s, false)));
    macBrandPngs.set(s, encodePng(s, s, proceduralIconRgba(s, true)));
  }
  trayPng32 = brandPngs.get(32);
}

fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), brandPngs.get(1024) ?? brandPngs.get(512));
fs.writeFileSync(path.join(BUILD_DIR, 'tray.png'), trayPng32);
fs.writeFileSync(path.join(BUILD_DIR, 'trayTemplate.png'), trayTemplate18);
fs.writeFileSync(path.join(BUILD_DIR, 'trayTemplate@2x.png'), trayTemplate36);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.icns'), wrapIcns(macBrandPngs));

const icoSizes = [256, 128, 64, 48, 32, 24, 16];
fs.writeFileSync(
  path.join(BUILD_DIR, 'icon.ico'),
  wrapIco(
    icoSizes.map((s) => brandPngs.get(s)),
    icoSizes,
  ),
);

fs.writeFileSync(path.join(RENDERER_ASSETS_DIR, 'kapsula-icon.png'), brandPngs.get(128));
fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon16.png'), brandPngs.get(16));
fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon48.png'), brandPngs.get(48));
fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon128.png'), brandPngs.get(128));

console.log(
  'Generated build/icon.png (1024), build/icon.icns (Apple HIG 824/1024 squircle), build/icon.ico (256..16), build/tray.png (32), build/trayTemplate*.png (18/36 analytic SDF), src/renderer/assets/kapsula-icon.png, and extension/icons/*',
);
