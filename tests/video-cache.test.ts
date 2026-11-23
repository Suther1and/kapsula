import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VIDEO_FILE_BYTES, VideoCacheManager, parseHttpByteRange } from '@main/pipeline/video-cache';
import { extractYouTubeVideoId, parseRedditVideoFromJson } from '@main/pipeline/video-extractor';
import { sanitizeMediaMetaForSync } from '@shared/sync-contract';

const tempDirs: string[] = [];

function makeTempCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-vid-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('Wave 6: VideoCacheManager, HTTP Byte Ranges, Social Video Extraction & Sync Exclusion', () => {
  it('enforces 60 MB per-file cap, touches recency, evicts LRU over limitMb, rejects traversal, and clears cleanly', () => {
    const dir = makeTempCacheDir();
    const mgr = new VideoCacheManager(dir, 250);

    // Reject oversized single file (> 60 MB)
    const oversized = Buffer.alloc(MAX_VIDEO_FILE_BYTES + 1024, 1);
    expect(mgr.putBuffer(oversized, 'too-big', '.mp4')).toBeNull();

    // Put 4 files of 55 MB = 220 MB (within 250 MB budget) and backdate mtimes
    const chunk55Mb = Buffer.alloc(55 * 1024 * 1024, 0);
    const savedNames: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      chunk55Mb[0] = i + 1;
      const putRes = mgr.putBuffer(chunk55Mb, `clip${i}`, '.mp4');
      expect(putRes).toBeTruthy();
      savedNames.push(putRes!.filename);
      const fp = path.join(dir, putRes!.filename);
      const ts = new Date(Date.now() - (10 - i) * 60_000);
      fs.utimesSync(fp, ts, ts);
    }

    // Touch oldest file (#0) so #1 becomes the true LRU, then add a 5th 55 MB clip -> auto-evicts #1
    mgr.touch(savedNames[0]!);
    chunk55Mb[0] = 99;
    const fifth = mgr.putBuffer(chunk55Mb, 'clip4', '.mp4');
    expect(fifth).toBeTruthy();
    savedNames.push(fifth!.filename);

    const stats = mgr.getStats();
    expect(stats.limitMb).toBe(250);
    expect(stats.bytesUsed).toBeLessThanOrEqual(250 * 1024 * 1024);
    expect(mgr.resolveSafePath(savedNames[0]!).ok).toBe(true);
    expect(mgr.resolveSafePath(savedNames[1]!).ok).toBe(false);

    // Traversal & invalid paths rejected
    expect(mgr.resolveSafePath('../secret.mp4')).toEqual({ ok: false, status: 400 });
    expect(mgr.resolveSafePath('nested/file.mp4')).toEqual({ ok: false, status: 400 });
    expect(mgr.resolveSafePath('CON.mp4')).toEqual({ ok: false, status: 400 });

    const afterClear = mgr.clear();
    expect(afterClear.fileCount).toBe(0);
    expect(afterClear.bytesUsed).toBe(0);
  });

  it('parses RFC 9110 HTTP byte ranges accurately', () => {
    expect(parseHttpByteRange(null, 1000)).toEqual({ status: 200 });
    expect(parseHttpByteRange('bytes=0-99', 1000)).toEqual({ status: 206, start: 0, end: 99 });
    expect(parseHttpByteRange('bytes=100-', 1000)).toEqual({ status: 206, start: 100, end: 999 });
    expect(parseHttpByteRange('bytes=-50', 1000)).toEqual({ status: 206, start: 950, end: 999 });
    expect(parseHttpByteRange('bytes=1200-1300', 1000)).toEqual({ status: 416 });
    expect(parseHttpByteRange('bytes=200-100', 1000)).toEqual({ status: 416 });
    expect(parseHttpByteRange('items=0-10', 1000)).toEqual({ status: 416 });
  });

  it('extracts YouTube IDs and Reddit fallback_url video metadata cleanly', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=12')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://youtube.com/shorts/AbCdEf12345')).toBe('AbCdEf12345');
    expect(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();

    const reddit = parseRedditVideoFromJson([
      {
        data: {
          children: [
            {
              data: {
                secure_media: {
                  reddit_video: {
                    fallback_url: 'https://v.redd.it/xyz123/DASH_720.mp4?source=fallback',
                    duration: 19,
                  },
                },
                preview: {
                  images: [{ source: { url: 'https://preview.redd.it/thumb.jpg?s=1&amp;v=2' } }],
                },
              },
            },
          ],
        },
      },
    ]);
    expect(reddit.videoUrl).toBe('https://v.redd.it/xyz123/DASH_720.mp4?source=fallback');
    expect(reddit.durationSec).toBe(19);
    expect(reddit.posterUrl).toBe('https://preview.redd.it/thumb.jpg?s=1&v=2');
  });

  it('strips local-only cachedVideoFile and videoExtractStatus in sanitizeMediaMetaForSync', () => {
    const cleaned = sanitizeMediaMetaForSync({
      fileName: 'reel.mp4',
      fileSize: 4096,
      youtubeVideoId: 'dQw4w9WgXcQ',
      cachedVideoFile: 'vc_ig_123456.mp4',
      videoExtractStatus: 'ready',
      videoUrl: 'https://v.redd.it/example/720.mp4',
    });
    expect(cleaned).toBeTruthy();
    expect(cleaned!.cachedVideoFile).toBeUndefined();
    expect(cleaned!.videoExtractStatus).toBeUndefined();
    expect(cleaned!.youtubeVideoId).toBe('dQw4w9WgXcQ');
    expect(cleaned!.fileName).toBe('reel.mp4');
  });
});
