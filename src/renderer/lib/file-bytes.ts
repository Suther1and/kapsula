import { translate } from '@shared/i18n';
import type { AppLocale } from '@shared/types';

export const MAX_UPLOAD_IMAGE_OR_DOC_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_VIDEO_BYTES = 48 * 1024 * 1024;

function getDomLocale(): AppLocale {
  return typeof document !== 'undefined' && document.documentElement?.lang === 'en' ? 'en' : 'ru';
}

export async function readFileAsBytes(
  file: File,
  maxBytes = MAX_UPLOAD_IMAGE_OR_DOC_BYTES,
  readErrorMsg?: string,
  locale: AppLocale = getDomLocale()
): Promise<Uint8Array> {
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(translate(locale, 'error.fileTooLarge', { mb }));
  }
  const fallbackErr = readErrorMsg || translate(locale, 'error.readFileFailed');
  try {
    if (typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        const mb = Math.round(maxBytes / (1024 * 1024));
        throw new Error(translate(locale, 'error.fileTooLarge', { mb }));
      }
      if (buf.byteLength > 0) {
        return new Uint8Array(buf);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes(String(Math.round(maxBytes / (1024 * 1024))))) {
      throw err;
    }
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        if (reader.result.byteLength > maxBytes) {
          const mb = Math.round(maxBytes / (1024 * 1024));
          reject(new Error(translate(locale, 'error.fileTooLarge', { mb })));
          return;
        }
        resolve(new Uint8Array(reader.result));
        return;
      }
      reject(new Error(fallbackErr));
    };
    reader.onerror = () => reject(new Error(fallbackErr));
    reader.readAsArrayBuffer(file);
  });
}
