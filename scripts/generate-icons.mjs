import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT_DIR = process.cwd();
const BUILD_DIR = path.resolve(ROOT_DIR, 'build');
const RENDERER_ASSETS_DIR = path.resolve(ROOT_DIR, 'src', 'renderer', 'assets');
const EXT_ICONS_DIR = path.resolve(ROOT_DIR, 'extension', 'icons');
const DOCS_ASSETS_DIR = path.resolve(ROOT_DIR, 'docs', 'assets');

const BRAND_MASTER_PATH = path.join(BUILD_DIR, 'brand-master.png');
const FORCE_REGEN = process.argv.includes('--force');

export function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

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

export function encodePng(width, height, rgba) {
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

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-Node 8-bit PNG decoder supporting Grayscale (0), RGB (2), Gray+Alpha (4), and RGBA (6).
 */
export function decodePng(pngBuf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (pngBuf[i] !== sig[i]) {
      throw new Error('Invalid PNG signature');
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    const chunk = pngBuf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      const interlace = chunk[12];
      if (bitDepth !== 8 || interlace !== 0) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  const channelsMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = channelsMap[colorType];
  if (!bpp || width <= 0 || height <= 0) {
    throw new Error(`Unsupported PNG colorType=${colorType} (${width}x${height})`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * bpp;
  const unfiltered = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const srcRow = y * (rowBytes + 1);
    const filter = inflated[srcRow];
    const dstRow = y * rowBytes;
    const prevRow = (y - 1) * rowBytes;

    for (let i = 0; i < rowBytes; i++) {
      const rawByte = inflated[srcRow + 1 + i];
      const left = i >= bpp ? unfiltered[dstRow + i - bpp] : 0;
      const up = y > 0 ? unfiltered[prevRow + i] : 0;
      const upLeft = y > 0 && i >= bpp ? unfiltered[prevRow + i - bpp] : 0;

      let val = rawByte;
      if (filter === 1) val = (rawByte + left) & 0xff;
      else if (filter === 2) val = (rawByte + up) & 0xff;
      else if (filter === 3) val = (rawByte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}`);

      unfiltered[dstRow + i] = val;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const di = i * 4;
    if (colorType === 6) {
      const si = i * 4;
      rgba[di] = unfiltered[si];
      rgba[di + 1] = unfiltered[si + 1];
      rgba[di + 2] = unfiltered[si + 2];
      rgba[di + 3] = unfiltered[si + 3];
    } else if (colorType === 2) {
      const si = i * 3;
      rgba[di] = unfiltered[si];
      rgba[di + 1] = unfiltered[si + 1];
      rgba[di + 2] = unfiltered[si + 2];
      rgba[di + 3] = 255;
    } else if (colorType === 4) {
      const si = i * 2;
      rgba[di] = unfiltered[si];
      rgba[di + 1] = unfiltered[si];
      rgba[di + 2] = unfiltered[si];
      rgba[di + 3] = unfiltered[si + 1];
    } else {
      rgba[di] = unfiltered[i];
      rgba[di + 1] = unfiltered[i];
      rgba[di + 2] = unfiltered[i];
      rgba[di + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Non-ringing exact area-coverage resampler in premultiplied RGBA space.
 * Produces clean anti-aliased edges without Lanczos negative-lobe ringing halos.
 */
export function resizeRgbaArea(src, sw, sh, dw, dh, cropX = 0, cropY = 0, cropW = sw, cropH = sh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const scaleX = cropW / dw;
  const scaleY = cropH / dh;

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = cropY + dy * scaleY;
    const sy1 = cropY + (dy + 1) * scaleY;
    const iy0 = Math.max(0, Math.floor(sy0));
    const iy1 = Math.min(sh - 1, Math.floor(sy1));

    for (let dx = 0; dx < dw; dx++) {
      const sx0 = cropX + dx * scaleX;
      const sx1 = cropX + (dx + 1) * scaleX;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(sw - 1, Math.floor(sx1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;

      for (let sy = iy0; sy <= iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (sy * sw + sx) * 4;
          const sa = src[si + 3] / 255;
          r += src[si] * sa * w;
          g += src[si + 1] * sa * w;
          b += src[si + 2] * sa * w;
          a += sa * w;
          wsum += w;
        }
      }

      const di = (dy * dw + dx) * 4;
      const outA = wsum > 0 ? Math.max(0, Math.min(1, a / wsum)) : 0;
      if (outA > 0.002) {
        dst[di] = clampByte(r / wsum / outA);
        dst[di + 1] = clampByte(g / wsum / outA);
        dst[di + 2] = clampByte(b / wsum / outA);
        dst[di + 3] = clampByte(outA * 255);
      }
    }
  }
  return dst;
}

/**
 * Signed distance to a rounded squircle box centered at (0, 0).
 */
function squircleSdf(dx, dy, boxHalf, corner) {
  const qx = Math.abs(dx) - (boxHalf - corner);
  const qy = Math.abs(dy) - (boxHalf - corner);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    corner
  );
}

/**
 * Composites/masks a square master RGBA onto target size `s`:
 * - 'brand': full-bleed squircle (~95% fill), preserving existing alpha if master already has transparency
 * - 'brand-mac': Apple HIG 824x824 squircle inside 1024x1024 canvas + soft Dock drop shadow
 */
function renderMasterBrandVariant(masterRgba, mw, mh, s, mode) {
  const isMacBrand = mode === 'brand-mac';

  // Detect whether master already carries border transparency
  let borderAlphaSum = 0;
  let borderCount = 0;
  const step = Math.max(1, Math.floor(mw / 64));
  for (let x = 0; x < mw; x += step) {
    borderAlphaSum += masterRgba[(2 * mw + x) * 4 + 3];
    borderAlphaSum += masterRgba[((mh - 3) * mw + x) * 4 + 3];
    borderCount += 2;
  }
  const hasTransparentBorder = borderCount > 0 && borderAlphaSum / borderCount < 245;

  const out = Buffer.alloc(s * s * 4);
  if (isMacBrand) {
    const inset = Math.round(s * (100 / 1024));
    const inner = Math.max(1, s - inset * 2);
    const scaled = resizeRgbaArea(masterRgba, mw, mh, inner, inner);
    const half = s / 2;
    const pad = inset;
    const boxHalf = half - pad;
    const corner = boxHalf * 0.45;
    const shadowOffsetY = Math.max(0.5, s * (14 / 1024));
    const shadowBlur = Math.max(1.0, s * (26 / 1024));
    const edgeWidth = s <= 32 ? 0.9 : 1.3;

    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4;
        const dx = x + 0.5 - half;
        const dy = y + 0.5 - half;
        const dist = squircleSdf(dx, dy, boxHalf, corner);

        let r = 0;
        let g = 0;
        let b = 0;
        let srcA = 0;
        const ix = x - inset;
        const iy = y - inset;
        if (ix >= 0 && ix < inner && iy >= 0 && iy < inner) {
          const si = (iy * inner + ix) * 4;
          r = scaled[si];
          g = scaled[si + 1];
          b = scaled[si + 2];
          srcA = scaled[si + 3] / 255;
        }

        let maskAlpha = 1;
        if (dist > edgeWidth) maskAlpha = 0;
        else if (dist > -0.5) {
          maskAlpha = Math.max(0, Math.min(1, (edgeWidth - dist) / (edgeWidth + 0.5)));
        }
        if (hasTransparentBorder) {
          maskAlpha = Math.min(maskAlpha, srcA);
        } else {
          maskAlpha *= srcA;
        }

        if (maskAlpha < 1) {
          const sdist = squircleSdf(dx, dy - shadowOffsetY, boxHalf, corner);
          let shadowAlpha = 0;
          if (sdist < shadowBlur * 1.5) {
            const t = Math.max(0, 1 - Math.max(0, sdist) / (shadowBlur * 1.5));
            shadowAlpha = t * t * 0.26;
          }
          const outA = maskAlpha + shadowAlpha * (1 - maskAlpha);
          if (outA > 0.002) {
            out[i] = clampByte((r * maskAlpha) / outA);
            out[i + 1] = clampByte((g * maskAlpha) / outA);
            out[i + 2] = clampByte((b * maskAlpha) / outA);
            out[i + 3] = clampByte(outA * 255);
          }
        } else {
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = 255;
        }
      }
    }
    return out;
  }

  // Standard full-bleed squircle variant ('brand')
  const scaled = resizeRgbaArea(masterRgba, mw, mh, s, s);
  if (hasTransparentBorder) {
    return scaled;
  }

  const half = s / 2;
  const pad = s * 0.025;
  const boxHalf = half - pad;
  const corner = boxHalf * 0.45;
  const edgeWidth = s <= 32 ? 0.85 : 1.25;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const dist = squircleSdf(x + 0.5 - half, y + 0.5 - half, boxHalf, corner);
      let maskAlpha = 1;
      if (dist > edgeWidth) maskAlpha = 0;
      else if (dist > -0.5) {
        maskAlpha = Math.max(0, Math.min(1, (edgeWidth - dist) / (edgeWidth + 0.5)));
      }
      const outA = (scaled[i + 3] / 255) * maskAlpha;
      out[i] = scaled[i];
      out[i + 1] = scaled[i + 1];
      out[i + 2] = scaled[i + 2];
      out[i + 3] = clampByte(outA * 255);
    }
  }
  return out;
}

/**
 * Extracts the crisp foreground silhouette from `brand-master.png` onto a transparent canvas,
 * un-premultiplying edge pixels against the sampled dark background so light themes get zero dark fringe.
 */
export function extractBrandForeground(masterRgba, width, height) {
  // Sample outer 12px frame to measure background color & alpha
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgA = 0;
  let bgCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < 12 || x >= width - 12 || y < 12 || y >= height - 12) {
        const i = (y * width + x) * 4;
        bgR += masterRgba[i];
        bgG += masterRgba[i + 1];
        bgB += masterRgba[i + 2];
        bgA += masterRgba[i + 3];
        bgCount++;
      }
    }
  }
  bgR /= Math.max(1, bgCount);
  bgG /= Math.max(1, bgCount);
  bgB /= Math.max(1, bgCount);
  bgA /= Math.max(1, bgCount);

  const fgRgba = Buffer.alloc(width * height * 4);
  const alreadyTransparent = bgA < 180;

  // Measure typical neutral & warm interior distances (exclude edge highlights so solid core hits 255 alpha)
  let warmSum = 0;
  let warmCount = 0;
  let neutralSum = 0;
  let neutralCount = 0;
  if (!alreadyTransparent) {
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const r = masterRgba[p];
      const g = masterRgba[p + 1];
      const b = masterRgba[p + 2];
      const d = Math.hypot(r - bgR, g - bgG, b - bgB);
      if (d < 80) continue;
      if (r - b > 100 && g < 150) {
        warmSum += d;
        warmCount++;
      } else if (Math.abs(r - b) < 35 && d > 200) {
        neutralSum += d;
        neutralCount++;
      }
    }
  }
  const warmAvgDist = warmCount > 0 ? warmSum / warmCount : 197;
  const neutralAvgDist = neutralCount > 0 ? neutralSum / neutralCount : 382;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = masterRgba[p];
      const g = masterRgba[p + 1];
      const b = masterRgba[p + 2];
      const srcA = masterRgba[p + 3] / 255;

      let a = 0;
      if (alreadyTransparent) {
        a = srcA;
        fgRgba[p] = r;
        fgRgba[p + 1] = g;
        fgRgba[p + 2] = b;
        fgRgba[p + 3] = masterRgba[p + 3];
      } else {
        const dr = r - bgR;
        const dg = g - bgG;
        const db = b - bgB;
        const dist = Math.hypot(dr, dg, db);
        const chroma = r > b ? (r - b) / Math.max(1, r - bgR) : 0;
        const warmth = Math.min(1, Math.max(0, (chroma - 0.12) / 0.65));
        const targetDist = neutralAvgDist * (1 - warmth) + warmAvgDist * warmth;
        const noiseFloor = 14;
        const fullOpacityDist = targetDist * 0.68;
        if (dist > noiseFloor) {
          a = Math.min(1, Math.max(0, (dist - noiseFloor) / Math.max(1, fullOpacityDist - noiseFloor)));
        }
        a *= srcA;
        if (a > 0.004) {
          const inv = 1 / Math.max(0.18, a);
          fgRgba[p] = clampByte(bgR + dr * inv);
          fgRgba[p + 1] = clampByte(bgG + dg * inv);
          fgRgba[p + 2] = clampByte(bgB + db * inv);
          fgRgba[p + 3] = clampByte(a * 255);
        }
      }

      if (a > 0.08) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }

  return { fgRgba, bbox: { minX, minY, maxX, maxY } };
}

/**
 * Dilates a subtle dark obsidian backing around the extracted silhouette so the porcelain outer ring
 * remains crisp and high-contrast on light Windows taskbars without adding an opaque square tile.
 */
function buildTrayColorSilhouette(fgRgba, width, height, bbox) {
  const side = Math.max(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1);
  const rad = Math.max(12, Math.round(side * 0.048));
  const backed = Buffer.from(fgRgba);
  const haloMask = new Float32Array(width * height);

  for (let y = Math.max(0, bbox.minY - 2); y <= Math.min(height - 1, bbox.maxY + 2); y++) {
    for (let x = Math.max(0, bbox.minX - 2); x <= Math.min(width - 1, bbox.maxX + 2); x++) {
      const a = fgRgba[(y * width + x) * 4 + 3] / 255;
      if (a <= 0.05) continue;

      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const up = fgRgba[((y - 1) * width + x) * 4 + 3];
        const dn = fgRgba[((y + 1) * width + x) * 4 + 3];
        const lf = fgRgba[(y * width + x - 1) * 4 + 3];
        const rt = fgRgba[(y * width + x + 1) * 4 + 3];
        if (up > 240 && dn > 240 && lf > 240 && rt > 240) {
          if (a > haloMask[y * width + x]) haloMask[y * width + x] = a;
          continue;
        }
      }

      const y0 = Math.max(0, y - rad);
      const y1 = Math.min(height - 1, y + rad);
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(width - 1, x + rad);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy - y;
        for (let xx = x0; xx <= x1; xx++) {
          const d = Math.hypot(xx - x, dy);
          if (d <= rad) {
            const cov = Math.min(1, (rad - d) / 2.5) * a;
            if (cov > haloMask[yy * width + xx]) haloMask[yy * width + xx] = cov;
          }
        }
      }
    }
  }

  for (let i = 0; i < width * height; i++) {
    const ha = haloMask[i];
    if (ha <= 0) continue;
    const p = i * 4;
    const fa = fgRgba[p + 3] / 255;
    const outA = fa + ha * (1 - fa);
    if (outA > 0.002) {
      backed[p] = clampByte((fgRgba[p] * fa + 20 * ha * (1 - fa)) / outA);
      backed[p + 1] = clampByte((fgRgba[p + 1] * fa + 20 * ha * (1 - fa)) / outA);
      backed[p + 2] = clampByte((fgRgba[p + 2] * fa + 24 * ha * (1 - fa)) / outA);
      backed[p + 3] = clampByte(outA * 255);
    }
  }

  const pad = Math.round(side * 0.065) + rad;
  const cropSide = side + pad * 2;
  const cx = Math.round((bbox.minX + bbox.maxX) / 2);
  const cy = Math.round((bbox.minY + bbox.maxY) / 2);
  const cropX = Math.max(0, cx - Math.round(cropSide / 2));
  const cropY = Math.max(0, cy - Math.round(cropSide / 2));
  const cropW = Math.min(width - cropX, cropSide);
  const cropH = Math.min(height - cropY, cropSide);

  return resizeRgbaArea(backed, width, height, 32, 32, cropX, cropY, cropW, cropH);
}

function erodeAlphaForSmallTemplate(rgba, width, height, radiusPx) {
  const out = Buffer.from(rgba);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4 + 3;
      const a = rgba[idx];
      if (a === 0) continue;
      let minNeighbor = a;
      const y0 = Math.max(0, y - radiusPx);
      const y1 = Math.min(height - 1, y + radiusPx);
      const x0 = Math.max(0, x - radiusPx);
      const x1 = Math.min(width - 1, x + radiusPx);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy - y;
        for (let xx = x0; xx <= x1; xx++) {
          if (Math.hypot(xx - x, dy) <= radiusPx) {
            const na = rgba[(yy * width + xx) * 4 + 3];
            if (na < minNeighbor) minNeighbor = na;
            if (minNeighbor === 0) break;
          }
        }
        if (minNeighbor === 0) break;
      }
      out[idx] = Math.round(a * 0.25 + minNeighbor * 0.75);
    }
  }
  return out;
}

function buildTrayTemplatePng(fgRgba, width, height, bbox, size) {
  const side = Math.max(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1);
  const pad = Math.round(side * 0.05);
  const cropSide = side + pad * 2;
  const cx = Math.round((bbox.minX + bbox.maxX) / 2);
  const cy = Math.round((bbox.minY + bbox.maxY) / 2);
  const cropX = Math.max(0, cx - Math.round(cropSide / 2));
  const cropY = Math.max(0, cy - Math.round(cropSide / 2));
  const cropW = Math.min(width - cropX, cropSide);
  const cropH = Math.min(height - cropY, cropSide);

  // Slightly open the inner gap/trench at 18px 1x so non-Retina macOS menu bar never muddies
  const srcBuf = size <= 18 ? erodeAlphaForSmallTemplate(fgRgba, width, height, Math.max(4, Math.round(side * 0.01))) : fgRgba;
  const resized = resizeRgbaArea(srcBuf, width, height, size, size, cropX, cropY, cropW, cropH);
  for (let i = 0; i < size * size; i++) {
    const p = i * 4;
    resized[p] = 0;
    resized[p + 1] = 0;
    resized[p + 2] = 0;
    if (size <= 18) {
      const a = resized[p + 3] / 255;
      const crisp = a <= 0.14 ? 0 : a >= 0.85 ? 1 : (a - 0.14) / 0.71;
      resized[p + 3] = clampByte(crisp * 255);
    }
  }
  return resized;
}

/**
 * Analytic 4x4 supersampled fallback renderer matching the new open-capsule-shell + core mark.
 */
export function renderProceduralMarkRgba(size, opts = {}) {
  const { bgShape = 'squircle', glyphScale = 0.66, monochrome = false, macInset = false } = opts;
  const out = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const angle = Math.PI / 4; // tilted bottom-left to top-right
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const scale = macInset ? glyphScale * 0.805 : glyphScale;
  const segHalf = size * scale * 0.19;
  const ringMidR = size * scale * 0.295;
  const ringHalfThick = size * scale * 0.072;
  const coreR = size * scale * 0.165;
  const gapHalf = size * scale * 0.036;

  const pad = macInset ? size * (100 / 1024) : size * 0.025;
  const boxHalf = half - pad;
  const corner = boxHalf * 0.45;
  const circleR = half - 0.5;
  const samples = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples - half;
          const py = y + (sy + 0.5) / samples - half;

          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;

          if (bgShape !== 'none') {
            let inside = false;
            if (bgShape === 'circle') {
              inside = Math.hypot(px, py) <= circleR;
            } else {
              inside = squircleSdf(px, py, boxHalf, corner) <= 0;
            }
            if (inside) {
              const t = Math.max(0, Math.min(1, (px + py + size) / (2 * size)));
              r = 21 - t * 5;
              g = 21 - t * 5;
              b = 25 - t * 6;
              a = 1;
            }
          }

          // Rotated local frame: rx along main capsule axis, ry perpendicular (+ry is lower-right)
          const rx = px * cosA - py * sinA;
          const ry = px * sinA + py * cosA;
          const clampedX = Math.max(-segHalf, Math.min(segHalf, rx));
          const capDist = Math.hypot(rx - clampedX, ry);

          const inCore = capDist <= coreR;
          const inRing = Math.abs(capDist - ringMidR) <= ringHalfThick && !(ry > 0 && Math.abs(rx) < gapHalf);

          if (inCore || inRing) {
            if (monochrome) {
              r = 255;
              g = 255;
              b = 255;
              a = 1;
            } else if (inCore) {
              r = 203;
              g = 82;
              b = 35;
              a = 1;
            } else {
              r = 240;
              g = 241;
              b = 235;
              a = 1;
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
      const di = (y * size + x) * 4;
      if (finalA > 0.0001) {
        out[di] = clampByte(accR / accA);
        out[di + 1] = clampByte(accG / accA);
        out[di + 2] = clampByte(accB / accA);
        out[di + 3] = clampByte(finalA * 255);
      }
    }
  }
  return out;
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

function wrapIcns(pngMap) {
  const slots = [
    ['icp4', 16],
    ['ic11', 32],
    ['icp5', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024],
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
    path.join(DOCS_ASSETS_DIR, 'kapsula-icon.png'),
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

function runMain() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(RENDERER_ASSETS_DIR, { recursive: true });
  fs.mkdirSync(EXT_ICONS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_ASSETS_DIR, { recursive: true });

  const hasMaster = fs.existsSync(BRAND_MASTER_PATH);
  if (!hasMaster && !FORCE_REGEN && allCommittedAssetsPresent()) {
    console.log('Preserving committed brand icons (build/brand-master.png absent).');
    return;
  }

  const brandSizes = [1024, 512, 256, 128, 64, 48, 32, 24, 16];
  const brandPngs = new Map();
  const macBrandPngs = new Map();
  let trayPng32;
  let trayTemplate18;
  let trayTemplate36;

  if (hasMaster) {
    const master = decodePng(fs.readFileSync(BRAND_MASTER_PATH));
    for (const s of brandSizes) {
      brandPngs.set(s, encodePng(s, s, renderMasterBrandVariant(master.rgba, master.width, master.height, s, 'brand')));
      macBrandPngs.set(s, encodePng(s, s, renderMasterBrandVariant(master.rgba, master.width, master.height, s, 'brand-mac')));
    }
    const { fgRgba, bbox } = extractBrandForeground(master.rgba, master.width, master.height);
    trayPng32 = encodePng(32, 32, buildTrayColorSilhouette(fgRgba, master.width, master.height, bbox));
    trayTemplate18 = encodePng(18, 18, buildTrayTemplatePng(fgRgba, master.width, master.height, bbox, 18));
    trayTemplate36 = encodePng(36, 36, buildTrayTemplatePng(fgRgba, master.width, master.height, bbox, 36));
  } else {
    for (const s of brandSizes) {
      brandPngs.set(s, encodePng(s, s, renderProceduralMarkRgba(s, { bgShape: 'squircle', macInset: false })));
      macBrandPngs.set(s, encodePng(s, s, renderProceduralMarkRgba(s, { bgShape: 'squircle', macInset: true })));
    }
    const tpl18 = renderProceduralMarkRgba(18, { bgShape: 'none', glyphScale: 0.84, monochrome: true });
    const tpl36 = renderProceduralMarkRgba(36, { bgShape: 'none', glyphScale: 0.84, monochrome: true });
    for (let i = 0; i < 18 * 18; i++) {
      tpl18[i * 4] = 0;
      tpl18[i * 4 + 1] = 0;
      tpl18[i * 4 + 2] = 0;
    }
    for (let i = 0; i < 36 * 36; i++) {
      tpl36[i * 4] = 0;
      tpl36[i * 4 + 1] = 0;
      tpl36[i * 4 + 2] = 0;
    }
    trayTemplate18 = encodePng(18, 18, tpl18);
    trayTemplate36 = encodePng(36, 36, tpl36);
    trayPng32 = encodePng(32, 32, renderProceduralMarkRgba(32, { bgShape: 'squircle' }));
  }

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), brandPngs.get(1024));
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
  fs.writeFileSync(path.join(DOCS_ASSETS_DIR, 'kapsula-icon.png'), brandPngs.get(512));
  fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon16.png'), brandPngs.get(16));
  fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon48.png'), brandPngs.get(48));
  fs.writeFileSync(path.join(EXT_ICONS_DIR, 'icon128.png'), brandPngs.get(128));

  console.log(
    'Generated build/icon.png (1024), build/icon.icns (Apple HIG 824/1024 squircle), build/icon.ico (256..16), build/tray.png (32), build/trayTemplate*.png (18/36 silhouette), src/renderer/assets/kapsula-icon.png (128), docs/assets/kapsula-icon.png (512), and extension/icons/*',
  );
}

const isEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  runMain();
}
