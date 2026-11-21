import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clipboard, NativeImage } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { extractActionsFromText, runWinRtOcr } from '@main/ocr/ocr-service';
import { readClipboardSnapshot } from '@main/pipeline/clipboard-helper';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-ocr-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Offline Windows 11 WinRT OCR & Smart Action Chips', () => {
  it('recognizes crisp Russian & English text + extracts PROMO code and URL chips', async () => {
    if (process.platform !== 'win32') return;

    const imgPath = path.join(tmpDir, 'ocr-sample.png');
    const psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(900, 260)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Arial', 24, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Black
$g.DrawString('Заказ оплачен Промокод: PROMO-7788', $font, $brush, 24, 38)
$g.DrawString('Ссылка https://example.com/pay', $font, $brush, 24, 120)
$g.Dispose()
$bmp.Save('${imgPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true,
    });

    const ocr = await runWinRtOcr(imgPath, tmpDir);
    expect(ocr.text.length).toBeGreaterThan(10);
    expect(ocr.text).toMatch(/PROMO[- ]?7788/i);
    expect(ocr.text).toMatch(/Заказ|оплачен/i);

    const actions = extractActionsFromText(ocr.text);
    expect(actions.some((a) => a.type === 'code' && /PROMO-7788/i.test(a.value))).toBe(true);
    expect(actions.some((a) => a.type === 'url' && a.value.includes('example.com/pay'))).toBe(true);
  });

  it('filters technical tokens and embedded digit substrings while extracting real promo codes and phones', () => {
    const sample =
      'Алгоритм SHA-256 и AES-256 с UTF-8, ID 123456789012345, промокод SALE-2026 и телефон +7 (999) 123-45-67';
    const actions = extractActionsFromText(sample);
    const values = actions.map((a) => a.value);

    expect(values).toContain('SALE-2026');
    expect(values).toContain('+7 (999) 123-45-67');
    expect(values).not.toContain('SHA-256');
    expect(values).not.toContain('AES-256');
    expect(values).not.toContain('UTF-8');
    expect(values.some((v) => v.includes('2345678901'))).toBe(false);
  });

  it('returns empty OCR result cleanly without throwing when image path is missing', async () => {
    const missing = await runWinRtOcr(path.join(tmpDir, 'does-not-exist.png'), tmpDir);
    expect(missing).toEqual({ text: '', lines: [] });
  });

  it('reads PNG/JPEG images and falls back to readText cleanly in readClipboardSnapshot', async () => {
    const pngBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    const clipPng = {
      read: async () => [
        {
          types: ['image/png'],
          getType: async () => new Blob([pngBytes], { type: 'image/png' }),
        },
      ],
      readText: async () => 'fallback-text',
    } as unknown as Clipboard;
    const snapPng = await readClipboardSnapshot(clipPng);
    expect(snapPng.imageBase64).toBe(Buffer.from(pngBytes).toString('base64'));
    expect(snapPng.text).toBe('');

    const jpegBytes = Uint8Array.from([255, 216, 255]);
    const convertedPngBytes = Buffer.from('converted-png');
    const clipJpeg = {
      read: async () => [
        {
          types: ['image/jpeg'],
          getType: async () => new Blob([jpegBytes], { type: 'image/jpeg' }),
        },
      ],
      readText: async () => '',
    } as unknown as Clipboard;
    const mockNativeImage = {
      createFromBuffer: () =>
        ({
          isEmpty: () => false,
          toPNG: () => convertedPngBytes,
        }) as unknown as NativeImage,
    };
    const snapJpeg = await readClipboardSnapshot(clipJpeg, mockNativeImage);
    expect(snapJpeg.imageBase64).toBe(convertedPngBytes.toString('base64'));

    const clipEmptyBlob = {
      read: async () => [
        {
          types: ['image/png'],
          getType: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
        },
      ],
      readText: async () => '  plain text fallback  ',
    } as unknown as Clipboard;
    const snapEmpty = await readClipboardSnapshot(clipEmptyBlob);
    expect(snapEmpty).toEqual({ imageBase64: null, text: 'plain text fallback' });

    const clipThrowingRead = {
      read: async () => {
        throw new Error('W3C read unavailable');
      },
      readText: async () => 'text-after-error',
    } as unknown as Clipboard;
    const snapErr = await readClipboardSnapshot(clipThrowingRead);
    expect(snapErr).toEqual({ imageBase64: null, text: 'text-after-error' });
  });

  it('rejects error/status codes like ERR-404 and HTTP-500 while keeping PROMO-KAPSULA-7788', () => {
    const sample = 'Ошибка ERR-404, статус HTTP-500, промокод на скидку: PROMO-KAPSULA-7788';
    const values = extractActionsFromText(sample).map((a) => a.value);

    expect(values).toContain('PROMO-KAPSULA-7788');
    expect(values).not.toContain('ERR-404');
    expect(values).not.toContain('HTTP-500');
  });
});
