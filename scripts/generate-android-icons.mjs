import fs from 'node:fs';
import path from 'node:path';
import {
  clampByte,
  decodePng,
  encodePng,
  extractBrandForeground,
  renderProceduralMarkRgba,
  resizeRgbaArea,
} from './generate-icons.mjs';

const ROOT_DIR = process.cwd();
const ANDROID_RES = path.resolve(ROOT_DIR, 'android', 'app', 'src', 'main', 'res');
const BRAND_MASTER_PATH = path.resolve(ROOT_DIR, 'build', 'brand-master.png');

/**
 * Renders an anti-aliased obsidian plate ('rounded' or 'circle') for legacy Android mipmap icons.
 */
function renderLegacyPlate(size, shape) {
  const out = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const cornerR = size * 0.24;
  const circleR = half - 0.5;
  const samples = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accA = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples - half;
          const py = y + (sy + 0.5) / samples - half;
          let inside = false;
          if (shape === 'circle') {
            inside = Math.hypot(px, py) <= circleR;
          } else {
            const qx = Math.abs(px) - (half - cornerR);
            const qy = Math.abs(py) - (half - cornerR);
            const d =
              Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
              Math.min(Math.max(qx, qy), 0) -
              cornerR;
            inside = d <= 0;
          }
          if (inside) accA += 1;
        }
      }
      const alpha = accA / (samples * samples);
      if (alpha > 0.001) {
        const t = Math.max(0, Math.min(1, (x + y) / (2 * size)));
        const i = (y * size + x) * 4;
        out[i] = clampByte(21 - t * 6);
        out[i + 1] = clampByte(21 - t * 6);
        out[i + 2] = clampByte(26 - t * 7);
        out[i + 3] = clampByte(alpha * 255);
      }
    }
  }
  return out;
}

/**
 * Composites a resized foreground glyph centered inside a target square RGBA canvas.
 */
function compositeCenteredGlyph(baseRgba, canvasSize, glyphRgba, glyphSize, monochrome = false) {
  const out = Buffer.from(baseRgba);
  const offset = Math.round((canvasSize - glyphSize) / 2);
  for (let gy = 0; gy < glyphSize; gy++) {
    const dy = offset + gy;
    if (dy < 0 || dy >= canvasSize) continue;
    for (let gx = 0; gx < glyphSize; gx++) {
      const dx = offset + gx;
      if (dx < 0 || dx >= canvasSize) continue;
      const gi = (gy * glyphSize + gx) * 4;
      const fa = glyphRgba[gi + 3] / 255;
      if (fa <= 0.002) continue;

      const di = (dy * canvasSize + dx) * 4;
      const ba = out[di + 3] / 255;
      const outA = fa + ba * (1 - fa);
      if (outA <= 0.002) continue;

      const fr = monochrome ? 255 : glyphRgba[gi];
      const fg = monochrome ? 255 : glyphRgba[gi + 1];
      const fb = monochrome ? 255 : glyphRgba[gi + 2];

      out[di] = clampByte((fr * fa + out[di] * ba * (1 - fa)) / outA);
      out[di + 1] = clampByte((fg * fa + out[di + 1] * ba * (1 - fa)) / outA);
      out[di + 2] = clampByte((fb * fa + out[di + 2] * ba * (1 - fa)) / outA);
      out[di + 3] = clampByte(outA * 255);
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

  const hasMaster = fs.existsSync(BRAND_MASTER_PATH);
  let master = null;
  let extracted = null;
  let cropX = 0;
  let cropY = 0;
  let cropSide = 0;

  if (hasMaster) {
    master = decodePng(fs.readFileSync(BRAND_MASTER_PATH));
    extracted = extractBrandForeground(master.rgba, master.width, master.height);
    const { bbox } = extracted;
    cropSide = Math.max(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1);
    const cx = Math.round((bbox.minX + bbox.maxX) / 2);
    const cy = Math.round((bbox.minY + bbox.maxY) / 2);
    cropX = Math.max(0, Math.min(master.width - cropSide, cx - Math.floor(cropSide / 2)));
    cropY = Math.max(0, Math.min(master.height - cropSide, cy - Math.floor(cropSide / 2)));
  }

  for (const d of densities) {
    const outDir = path.join(ANDROID_RES, d.dir);
    fs.mkdirSync(outDir, { recursive: true });

    if (hasMaster && master && extracted) {
      // Legacy rounded square (glyph bbox = 68% of canvas)
      const legacyGlyphSize = Math.round(d.legacy * 0.68);
      const legacyGlyph = resizeRgbaArea(
        extracted.fgRgba,
        master.width,
        master.height,
        legacyGlyphSize,
        legacyGlyphSize,
        cropX,
        cropY,
        cropSide,
        cropSide,
      );
      const legacyRgba = compositeCenteredGlyph(
        renderLegacyPlate(d.legacy, 'rounded'),
        d.legacy,
        legacyGlyph,
        legacyGlyphSize,
      );
      fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), encodePng(d.legacy, d.legacy, legacyRgba));

      // Legacy circle (glyph bbox = 64% of canvas so tilted ends stay comfortably inset)
      const roundGlyphSize = Math.round(d.legacy * 0.64);
      const roundGlyph = resizeRgbaArea(
        extracted.fgRgba,
        master.width,
        master.height,
        roundGlyphSize,
        roundGlyphSize,
        cropX,
        cropY,
        cropSide,
        cropSide,
      );
      const roundRgba = compositeCenteredGlyph(
        renderLegacyPlate(d.legacy, 'circle'),
        d.legacy,
        roundGlyph,
        roundGlyphSize,
      );
      fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), encodePng(d.legacy, d.legacy, roundRgba));

      // Adaptive foreground (bbox = 52% -> diagonal corner radius ~57.5% of half-canvas, strictly inside 66% Android safe zone)
      const fgGlyphSize = Math.round(d.fg * 0.52);
      const fgGlyph = resizeRgbaArea(
        extracted.fgRgba,
        master.width,
        master.height,
        fgGlyphSize,
        fgGlyphSize,
        cropX,
        cropY,
        cropSide,
        cropSide,
      );
      const emptyCanvas = Buffer.alloc(d.fg * d.fg * 4);
      const fgRgba = compositeCenteredGlyph(emptyCanvas, d.fg, fgGlyph, fgGlyphSize, false);
      fs.writeFileSync(path.join(outDir, 'ic_launcher_foreground.png'), encodePng(d.fg, d.fg, fgRgba));

      // Android 13+ Material You / One UI monochrome layer (pure white silhouette inside 66% safe zone)
      const monoRgba = compositeCenteredGlyph(emptyCanvas, d.fg, fgGlyph, fgGlyphSize, true);
      fs.writeFileSync(path.join(outDir, 'ic_launcher_monochrome.png'), encodePng(d.fg, d.fg, monoRgba));
    } else {
      const legacyRgba = renderProceduralMarkRgba(d.legacy, { bgShape: 'squircle', glyphScale: 0.72 });
      fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), encodePng(d.legacy, d.legacy, legacyRgba));

      const roundRgba = renderProceduralMarkRgba(d.legacy, { bgShape: 'circle', glyphScale: 0.68 });
      fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), encodePng(d.legacy, d.legacy, roundRgba));

      const fgRgba = renderProceduralMarkRgba(d.fg, { bgShape: 'none', glyphScale: 0.54 });
      fs.writeFileSync(path.join(outDir, 'ic_launcher_foreground.png'), encodePng(d.fg, d.fg, fgRgba));

      const monoRgba = renderProceduralMarkRgba(d.fg, {
        bgShape: 'none',
        glyphScale: 0.54,
        monochrome: true,
      });
      fs.writeFileSync(path.join(outDir, 'ic_launcher_monochrome.png'), encodePng(d.fg, d.fg, monoRgba));
    }
  }

  console.log('[android-icons] Generated adaptive (66% safe zone), legacy, round, and monochrome Android icons from brand-master.png');
}

main();
