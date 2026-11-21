import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT_DIR = process.cwd();
const ANDROID_RES = path.resolve(ROOT_DIR, 'android', 'app', 'src', 'main', 'res');

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

/**
 * Renders the crisp signature Kapsula tilted dual-tone pill emblem analytically (4x4 supersampled)
 * with zero outer squircle frame — so Samsung One UI / Android Adaptive Icons never show a tile-in-tile border.
 */
function renderKapsulaGlyph(canvasSize, opts) {
  const { bgShape = 'none', monochrome = false, glyphScale = 0.56 } = opts;
  const out = Buffer.alloc(canvasSize * canvasSize * 4);
  const half = canvasSize / 2;
  const angle = -Math.PI / 4;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const radius = canvasSize * glyphScale * 0.255;
  const halfSeg = canvasSize * glyphScale * 0.235;
  const seamHalf = Math.max(0.7, canvasSize * glyphScale * 0.022);
  const dotOffset = halfSeg * 0.82;
  const dotRadius = radius * 0.24;
  const cornerR = canvasSize * 0.24;
  const circleR = half - 0.5;
  const samples = 4;

  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples - half;
          const py = y + (sy + 0.5) / samples - half;

          // Optional background plate for legacy icons (mdpi..xxxhdpi)
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;

          if (bgShape === 'circle' || bgShape === 'rounded') {
            let bgInside = false;
            if (bgShape === 'circle') {
              bgInside = Math.hypot(px, py) <= circleR;
            } else {
              const qx = Math.abs(px) - (half - cornerR);
              const qy = Math.abs(py) - (half - cornerR);
              const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cornerR;
              bgInside = d <= 0;
            }
            if (bgInside) {
              // Subtle warm obsidian gradient background (#1a1a21 top-left -> #0f0f13 bottom-right)
              const t = Math.max(0, Math.min(1, (px + py + canvasSize) / (2 * canvasSize)));
              r = 26 - t * 11;
              g = 26 - t * 11;
              b = 33 - t * 14;
              a = 1;
            }
          }

          // Capsule SDF in rotated coordinates
          const rx = px * cosA - py * sinA;
          const ry = px * sinA + py * cosA;
          const cy = Math.max(-halfSeg, Math.min(halfSeg, ry));
          const capDist = Math.hypot(rx, ry - cy) - radius;

          if (capDist <= 0) {
            if (monochrome) {
              // Monochrome Android 13+ themed icon: solid white with crisp waist cut and accent dot cutout
              const inSeam = Math.abs(ry) <= seamHalf * 1.15;
              const inDot = Math.hypot(rx, ry - dotOffset) <= dotRadius;
              if (!inSeam && !inDot) {
                r = 255;
                g = 255;
                b = 255;
                a = 1;
              }
            } else {
              const inSeam = Math.abs(ry) <= seamHalf;
              if (inSeam) {
                // Crisp dark waist separation line
                r = 18;
                g = 18;
                b = 22;
                a = 1;
              } else if (ry < 0) {
                // Upper terracotta orange half (#e86a33 with soft specular depth)
                const shade = Math.max(-1, Math.min(1, rx / radius));
                r = Math.min(255, 238 - shade * 24);
                g = Math.min(255, 114 - shade * 22);
                b = Math.min(255, 58 - shade * 14);
                a = 1;
              } else {
                // Lower brushed warm porcelain/titanium half with subtle center dot
                const shade = Math.max(-1, Math.min(1, rx / radius));
                const inDot = Math.hypot(rx, ry - dotOffset) <= dotRadius;
                if (inDot) {
                  r = 232;
                  g = 106;
                  b = 51;
                  a = 1;
                } else {
                  r = Math.min(255, 240 - shade * 22);
                  g = Math.min(255, 239 - shade * 22);
                  b = Math.min(255, 243 - shade * 20);
                  a = 1;
                }
              }
            }
          }

          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
        }
      }

      const denom = samples * samples;
      const finalA = accA / denom;
      const idx = (y * canvasSize + x) * 4;
      if (finalA > 0.0001) {
        out[idx] = Math.min(255, Math.round(accR / accA));
        out[idx + 1] = Math.min(255, Math.round(accG / accA));
        out[idx + 2] = Math.min(255, Math.round(accB / accA));
        out[idx + 3] = Math.min(255, Math.round(finalA * 255));
      }
    }
  }

  return out;
}

function main() {
  if (!fs.existsSync(ANDROID_RES)) {
    console.log('[android-icons] android/ folder not found, skipping.');
    return;
  }

  const densities = [
    { dir: 'mipmap-mdpi', legacy: 48, fg: 108 },
    { dir: 'mipmap-hdpi', legacy: 72, fg: 162 },
    { dir: 'mipmap-xhdpi', legacy: 96, fg: 216 },
    { dir: 'mipmap-xxhdpi', legacy: 144, fg: 324 },
    { dir: 'mipmap-xxxhdpi', legacy: 192, fg: 432 },
  ];

  for (const d of densities) {
    const outDir = path.join(ANDROID_RES, d.dir);
    fs.mkdirSync(outDir, { recursive: true });

    // Legacy rounded square icon
    const legacyRgba = renderKapsulaGlyph(d.legacy, { bgShape: 'rounded', glyphScale: 0.72 });
    fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), encodePng(d.legacy, d.legacy, legacyRgba));

    // Legacy circular icon
    const roundRgba = renderKapsulaGlyph(d.legacy, { bgShape: 'circle', glyphScale: 0.7 });
    fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), encodePng(d.legacy, d.legacy, roundRgba));

    // Adaptive icon foreground (clean glyph on transparent canvas inside 66% safe zone)
    const fgRgba = renderKapsulaGlyph(d.fg, { bgShape: 'none', glyphScale: 0.56 });
    fs.writeFileSync(path.join(outDir, 'ic_launcher_foreground.png'), encodePng(d.fg, d.fg, fgRgba));

    // Android 13+ Material You / One UI themed monochrome layer
    const monoRgba = renderKapsulaGlyph(d.fg, {
      bgShape: 'none',
      monochrome: true,
      glyphScale: 0.54,
    });
    fs.writeFileSync(path.join(outDir, 'ic_launcher_monochrome.png'), encodePng(d.fg, d.fg, monoRgba));
  }

  console.log('[android-icons] Generated clean adaptive, legacy, and monochrome Android icons');
}

main();
