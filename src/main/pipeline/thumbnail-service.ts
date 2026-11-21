import fs from 'node:fs';
import path from 'node:path';
import { samplePaletteFromBgra } from '../ocr/ocr-service';

export interface ThumbnailAnalysisResult {
  thumbPath: string | null;
  isLightBanner: boolean;
  palette: string[];
  width: number;
  height: number;
}

function getNativeImage(): typeof import('electron').nativeImage | null {
  // Never require('electron') inside plain Node/Vitest (Electron 45 triggers lazy binary download)
  if (!process.versions?.electron) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    if (electron && electron.nativeImage && typeof electron.nativeImage.createFromBuffer === 'function') {
      return electron.nativeImage;
    }
  } catch {
    // Running inside non-Electron Vitest / CLI environment
  }
  return null;
}

function analyzeBitmapBgra(
  bitmap: Buffer,
  width: number,
  height: number
): { isLightBanner: boolean; hasAlphaEdges: boolean } {
  if (!bitmap || width <= 0 || height <= 0 || bitmap.length < width * height * 4) {
    return { isLightBanner: false, hasAlphaEdges: false };
  }

  let brightCount = 0;
  let borderBright = 0;
  let borderTotal = 0;
  let totalVisible = 0;
  let alphaEdgeCount = 0;
  let lumSum = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const b = bitmap[idx]!;
      const g = bitmap[idx + 1]!;
      const r = bitmap[idx + 2]!;
      const a = bitmap[idx + 3]!;
      const isBorder = x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2;

      if (a < 235) {
        if (isBorder) alphaEdgeCount++;
        continue;
      }

      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumSum += lum;
      totalVisible++;

      const isBrightWhite = r > 224 && g > 224 && b > 224;
      if (isBrightWhite) brightCount++;
      if (isBorder) {
        borderTotal++;
        if (isBrightWhite) borderBright++;
      }
    }
  }

  if (totalVisible === 0) {
    return { isLightBanner: false, hasAlphaEdges: alphaEdgeCount > 0 };
  }

  const avgLum = lumSum / totalVisible;
  const brightRatio = brightCount / totalVisible;
  const borderBrightRatio = borderTotal > 0 ? borderBright / borderTotal : 0;

  // White/cream OG banners (e.g. SVG Artista, Notion docs, minimalist product shots)
  const isLightBanner =
    (avgLum >= 0.74 && brightRatio >= 0.45) ||
    (borderBrightRatio >= 0.78 && avgLum >= 0.65);

  return {
    isLightBanner,
    hasAlphaEdges: alphaEdgeCount > Math.max(4, Math.floor((width + height) * 0.25)),
  };
}

/**
 * Downscales screenshots / OG images to <=640px cached thumbnails and inspects
 * luminance so light banners receive calm matte framing instead of harsh dark cutouts.
 */
export function generateThumbnailAndAnalyze(
  buffer: Buffer,
  mediaDir: string,
  fileStem: string
): ThumbnailAnalysisResult {
  const nativeImage = getNativeImage();
  if (!nativeImage || !buffer || buffer.length === 0) {
    return { thumbPath: null, isLightBanner: false, palette: [], width: 0, height: 0 };
  }

  try {
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) {
      return { thumbPath: null, isLightBanner: false, palette: [], width: 0, height: 0 };
    }

    const size = img.getSize();
    const probe = img.resize({ width: 32, height: 32, quality: 'good' });
    const probeSize = probe.getSize();
    const bitmap = probe.toBitmap();

    const { isLightBanner, hasAlphaEdges } = analyzeBitmapBgra(
      bitmap,
      probeSize.width,
      probeSize.height
    );
    const palette = samplePaletteFromBgra(bitmap, probeSize.width, probeSize.height);

    const maxW = 640;
    const maxH = 1280;
    let thumbImg = img;
    if (size.width > maxW || size.height > maxH) {
      const scale = Math.min(maxW / Math.max(1, size.width), maxH / Math.max(1, size.height));
      thumbImg = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good',
      });
    }

    fs.mkdirSync(mediaDir, { recursive: true });
    const ext = hasAlphaEdges ? 'png' : 'jpg';
    const thumbFilename = `thumb_${fileStem}.${ext}`;
    const outBuf = hasAlphaEdges ? thumbImg.toPNG() : thumbImg.toJPEG(84);

    if (outBuf.length > 0) {
      fs.writeFileSync(path.join(mediaDir, thumbFilename), outBuf);
      return {
        thumbPath: thumbFilename,
        isLightBanner,
        palette,
        width: size.width,
        height: size.height,
      };
    }

    return { thumbPath: null, isLightBanner, palette, width: size.width, height: size.height };
  } catch {
    return { thumbPath: null, isLightBanner: false, palette: [], width: 0, height: 0 };
  }
}
