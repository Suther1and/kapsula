import type { Clipboard, NativeImage } from 'electron';

export interface ClipboardSnapshot {
  imageBase64: string | null;
  text: string;
}

export async function readClipboardSnapshot(
  clipboardApi: Clipboard,
  nativeImageApi?: { createFromBuffer: (buf: Buffer) => NativeImage }
): Promise<ClipboardSnapshot> {
  try {
    const items = await clipboardApi.read();
    for (const item of items) {
      const imgMime = item.types.find((t) => t.startsWith('image/'));
      if (imgMime) {
        const blob = await item.getType(imgMime);
        if (!('arrayBuffer' in blob)) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        if (buf.length > 0) {
          if (nativeImageApi && imgMime !== 'image/png') {
            const converted = nativeImageApi.createFromBuffer(buf);
            if (!converted.isEmpty()) {
              return { imageBase64: converted.toPNG().toString('base64'), text: '' };
            }
          }
          return { imageBase64: buf.toString('base64'), text: '' };
        }
      }
    }
  } catch {
    // Fallback to plain text read when clipboard lacks read() items or holds empty data
  }

  try {
    const text = (await clipboardApi.readText()).trim();
    return { imageBase64: null, text };
  } catch {
    return { imageBase64: null, text: '' };
  }
}
