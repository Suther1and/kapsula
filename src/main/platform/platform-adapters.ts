import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OcrResult } from '../ocr/ocr-service';
import { runMacOsVisionOcr, runWinRtOcr } from '../ocr/ocr-service';

const execFileAsync = promisify(execFile);

export interface LocalOcrAdapter {
  extractText(imagePath: string, dataDir: string): Promise<OcrResult>;
}

export interface PlatformPasteAdapter {
  triggerPasteShortcut(): Promise<boolean>;
}

export const defaultLocalOcrAdapter: LocalOcrAdapter = {
  async extractText(imagePath: string, dataDir: string): Promise<OcrResult> {
    if (process.platform === 'win32') {
      return runWinRtOcr(imagePath, dataDir);
    }
    if (process.platform === 'darwin') {
      return runMacOsVisionOcr(imagePath);
    }
    return { text: '', lines: [] };
  },
};

export const defaultPlatformPasteAdapter: PlatformPasteAdapter = {
  async triggerPasteShortcut(): Promise<boolean> {
    if (process.platform === 'win32') {
      try {
        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^v')",
          ],
          { windowsHide: true, timeout: 2500 }
        );
        return true;
      } catch {
        return false;
      }
    }
    if (process.platform === 'darwin') {
      try {
        // Use virtual key code 9 (V) so Cmd+V works on both Russian and Latin keyboard layouts
        await execFileAsync(
          'osascript',
          ['-e', 'tell application "System Events" to key code 9 using command down'],
          { timeout: 2500 }
        );
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },
};
