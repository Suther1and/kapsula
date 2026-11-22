import crypto from 'node:crypto';
import http from 'node:http';
import type { AppLocale, CaptureMode } from '@shared/types';
import { CLIPPER_PORT_BASE, CLIPPER_PORT_RANGE } from '@shared/constants';
import type { CapturePipeline } from '../pipeline/capture-pipeline';
import {
  htmlFragmentToCleanMarkdown,
  normalizeMetaText,
  sanitizeIngestedText,
} from '../pipeline/html-cleaner';
import { sanitizeSafeExternalUrl } from '../pipeline/unfurler';

export interface ClipFeedbackPayload {
  title: string;
  orbit: string;
  isSecret: boolean;
}

export interface ClipperServerOptions {
  allowedExtensionOrigins?: string[];
  getPairingCode?: () => string | null;
  isOriginPaired?: (origin: string) => boolean;
  onPairOrigin?: (origin: string) => void;
}

const CHROME_EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const MOZ_EXT_ORIGIN_RE = /^moz-extension:\/\/[0-9a-f-]{8,64}$/i;
const SAFARI_EXT_ORIGIN_RE = /^safari-extension:\/\/[A-Za-z0-9._-]+$/;

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export class ClipperServer {
  private server: http.Server | null = null;
  private boundPort = CLIPPER_PORT_BASE;

  constructor(
    private readonly pipeline: CapturePipeline,
    private readonly getToken: () => string,
    private readonly onClipFeedback?: (feedback: ClipFeedbackPayload) => void,
    private readonly getOrbits?: () => Array<{ id: string; name: string; color: string }>,
    private readonly getLocale?: () => AppLocale,
    private readonly options: ClipperServerOptions = {}
  ) {}

  public getPort(): number {
    return this.boundPort;
  }

  public async start(): Promise<number> {
    if (this.server) return this.boundPort;

    for (let offset = 0; offset < CLIPPER_PORT_RANGE; offset++) {
      const candidate = CLIPPER_PORT_BASE + offset;
      try {
        await this.bindPort(candidate);
        this.boundPort = candidate;
        return candidate;
      } catch {
        // Try next port in range
      }
    }
    const isEn = this.getLocale?.() === 'en';
    throw new Error(isEn ? 'Could not start local browser clipper server' : 'Не удалось запустить локальный клиппер-сервер');
  }

  private bindPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        this.server = srv;
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private isAllowedExtensionOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    const clean = origin.trim();
    return (
      CHROME_EXT_ORIGIN_RE.test(clean) ||
      MOZ_EXT_ORIGIN_RE.test(clean) ||
      SAFARI_EXT_ORIGIN_RE.test(clean)
    );
  }

  private isHandshakeAuthorized(origin: string, pairCodeHeader?: string): boolean {
    const clean = origin.trim();
    if (this.options.allowedExtensionOrigins?.includes(clean)) return true;
    if (this.options.isOriginPaired?.(clean)) return true;
    const expectedCode = (this.options.getPairingCode?.() || '').trim();
    const providedCode = (pairCodeHeader || '').trim();
    if (expectedCode && providedCode && this.tokensEqual(providedCode, expectedCode)) {
      this.options.onPairOrigin?.(clean);
      return true;
    }
    return false;
  }

  private setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (this.isAllowedExtensionOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Kapsula-Token, X-Kapsula-Client, X-Kapsula-Pair-Code'
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
  }

  private isWebOriginBlocked(req: http.IncomingMessage): boolean {
    const origin = String(req.headers.origin || '').toLowerCase();
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (origin === 'null') return true;
    if (origin.startsWith('http://') || origin.startsWith('https://')) return true;
    if (secFetchSite === 'cross-site') return true;
    return false;
  }

  private tokensEqual(provided: string | null | undefined, expected: string): boolean {
    if (!provided || !expected) return false;
    const bufA = Buffer.from(provided, 'utf8');
    const bufB = Buffer.from(expected, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private isAuthorized(req: http.IncomingMessage, queryToken?: string | null): boolean {
    if (this.isWebOriginBlocked(req)) return false;

    const expected = this.getToken();
    const headerToken = req.headers['x-kapsula-token'];
    if (typeof headerToken === 'string' && this.tokensEqual(headerToken, expected)) return true;
    if (this.tokensEqual(queryToken, expected)) return true;
    return false;
  }

  private readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let abortedTooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (abortedTooLarge) return;
        total += chunk.length;
        if (total > 8 * 1024 * 1024) {
          abortedTooLarge = true;
          const err = new Error('Payload too large');
          (err as Error & { statusCode?: number }).statusCode = 413;
          reject(err);
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (abortedTooLarge) return;
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private buildClipExternalId(url: string | undefined, text: string): string | null {
    if (!url) return null;
    const norm = `${url}|${text.trim().slice(0, 400)}`;
    const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
    return `clip:${hash}`;
  }

  private cleanClipPayload(params: {
    url?: string;
    title?: string;
    text?: string;
    html?: string;
  }): { title?: string; text: string } {
    const cleanTitle = params.title ? normalizeMetaText(params.title) : undefined;
    let baseUrl: URL | undefined;
    if (params.url) {
      try {
        baseUrl = new URL(params.url);
      } catch {
        baseUrl = undefined;
      }
    }

    let cleanedText = '';
    if (params.html && params.html.trim()) {
      cleanedText = htmlFragmentToCleanMarkdown(params.html, {
        baseUrl,
        sanitizeUrl: sanitizeSafeExternalUrl,
        mode: 'web',
        stripBoilerplate: true,
      }).markdown;
    }
    if (!cleanedText && params.text) {
      cleanedText = sanitizeIngestedText(params.text, {
        baseUrl,
        sanitizeUrl: sanitizeSafeExternalUrl,
        stripCookieNoise: true,
      });
    }

    // Prevent browser extension's default `${tab.title}\n${tab.url}` page clip from duplicating title into body
    // and blocking CapturePipeline's clean link unfurling!
    if (params.url && cleanedText) {
      const strippedUrl = cleanedText.replace(params.url, '').trim();
      if (!strippedUrl) {
        cleanedText = params.url;
      } else if (
        cleanTitle &&
        strippedUrl.toLowerCase() === cleanTitle.toLowerCase()
      ) {
        cleanedText = params.url;
      } else if (
        cleanTitle &&
        cleanedText.toLowerCase().startsWith(`${cleanTitle.toLowerCase()}\n`)
      ) {
        const rest = cleanedText.slice(cleanTitle.length).trim();
        if (rest) cleanedText = rest;
      }
    }

    return {
      title: cleanTitle || undefined,
      text: cleanedText || params.url || '',
    };
  }

  private formatClipError(err: unknown): { status: number; message: string } {
    const isTooLarge = (err as Error & { statusCode?: number }).statusCode === 413;
    const status = isTooLarge ? 413 : 400;
    const rawMsg = err instanceof Error ? err.message : '';
    const isEn = this.getLocale?.() === 'en';
    const isLockedErr = /заблок|locked/i.test(rawMsg);
    const message = isTooLarge
      ? isEn
        ? 'Payload too large'
        : 'Слишком большой объём данных'
      : isLockedErr
        ? isEn
          ? 'Vault is locked — unlock Kapsula with your master PIN first'
          : 'Сейф заблокирован — сначала разблокируй Kapsula мастер-кодом'
        : isEn
          ? 'Could not save clip'
          : 'Не удалось сохранить фрагмент';
    return { status, message };
  }

  private async ingestClipEntry(
    entry: Record<string, unknown>,
    opts: { allowGhost: boolean }
  ) {
    const rawMode = typeof entry.mode === 'string' ? entry.mode : undefined;
    if (rawMode === 'ghost' && !opts.allowGhost) {
      throw new Error('Ghost mode is not allowed in batch clip');
    }
    const mode =
      rawMode && ['autopilot', 'buffer', 'ghost', 'focus'].includes(rawMode)
        ? (rawMode as CaptureMode)
        : undefined;

    const orbitId =
      typeof entry.orbitId === 'string' && entry.orbitId.trim()
        ? entry.orbitId.trim()
        : undefined;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    const rawTitle = typeof entry.title === 'string' ? entry.title : undefined;
    const rawText = typeof entry.text === 'string' ? entry.text : url || '';
    const rawHtml = typeof entry.html === 'string' ? entry.html : undefined;
    const imageBase64 = typeof entry.imageBase64 === 'string' ? entry.imageBase64 : undefined;
    const platform = typeof entry.platform === 'string' ? entry.platform : undefined;
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((t): t is string => typeof t === 'string')
      : undefined;

    const sanitizedGhostTitle = rawTitle
      ? normalizeMetaText(rawTitle).replace(/[\x00-\x1f]/g, '').slice(0, 120)
      : undefined;
    const cleaned =
      mode === 'ghost'
        ? { title: sanitizedGhostTitle || undefined, text: rawText }
        : this.cleanClipPayload({ url, title: rawTitle, text: rawText, html: rawHtml });

    return this.pipeline.capture({
      text: cleaned.text,
      url: mode === 'ghost' ? undefined : url,
      title: cleaned.title,
      imageBase64,
      mode,
      orbitOverride: orbitId,
      platform,
      tags,
      source: 'browser_ext',
      externalId: this.buildClipExternalId(mode === 'ghost' ? undefined : url, rawText || rawHtml || ''),
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url || '/', `http://127.0.0.1:${this.boundPort}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request URL' }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, app: 'kapsula', port: this.boundPort }));
      return;
    }

    // Extension handshake endpoint strictly POST-only for verified + paired extension origins
    if (reqUrl.pathname === '/api/handshake') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      const origin = req.headers.origin;
      const isExtClient = req.headers['x-kapsula-client'] === 'ext-v1';
      if (this.isWebOriginBlocked(req) || !isExtClient || !this.isAllowedExtensionOrigin(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'forbidden_origin', error: 'Forbidden origin' }));
        return;
      }
      const pairCodeHeader =
        typeof req.headers['x-kapsula-pair-code'] === 'string'
          ? req.headers['x-kapsula-pair-code']
          : undefined;
      if (!this.isHandshakeAuthorized(origin!, pairCodeHeader)) {
        const isEn = this.getLocale?.() === 'en';
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            code: 'pairing_required',
            error: isEn
              ? 'Pairing code required (check Settings → Browser Extension)'
              : 'Требуется код подключения из Настроек → Расширение',
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: this.getToken() }));
      return;
    }

    // Universal CSP-safe Bookmarklet pixel endpoint (blocks cross-site web origins and secret mode over GET)
    if (req.method === 'GET' && reqUrl.pathname === '/clip-pixel') {
      const token = reqUrl.searchParams.get('token');
      const expected = this.getToken();
      const modeParam = (reqUrl.searchParams.get('mode') || 'autopilot') as CaptureMode;
      if (
        this.isWebOriginBlocked(req) ||
        modeParam === 'ghost' ||
        !this.tokensEqual(token, expected)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const pageUrl = reqUrl.searchParams.get('url') || undefined;
      const rawTitle = reqUrl.searchParams.get('title') || undefined;
      const rawText = reqUrl.searchParams.get('text') || reqUrl.searchParams.get('sel') || pageUrl || '';

      if (rawText) {
        try {
          const cleaned = this.cleanClipPayload({ url: pageUrl, title: rawTitle, text: rawText });
          const item = await this.pipeline.capture({
            text: cleaned.text,
            url: pageUrl,
            title: cleaned.title,
            mode: ['autopilot', 'buffer', 'focus'].includes(modeParam) ? modeParam : 'autopilot',
            source: 'browser_ext',
            externalId: this.buildClipExternalId(pageUrl, rawText),
          });
          this.onClipFeedback?.({ title: item.title, orbit: item.orbit, isSecret: item.dna === 'secret' });
        } catch {
          // Keep returning the transparent pixel even if capture fails
        }
      }

      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store',
      });
      res.end(TRANSPARENT_GIF);
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/orbits') {
      if (!this.isAuthorized(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized clipper request' }));
        return;
      }
      const orbits = this.getOrbits
        ? this.getOrbits()
        : this.pipeline.listOrbits().map((o) => ({
            id: o.id,
            name: o.name,
            color: o.color,
          }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, orbits }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/clip') {
      try {
        const body = await this.readJsonBody(req);
        const bodyToken = typeof body.token === 'string' ? body.token : null;
        if (!this.isAuthorized(req, bodyToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized clipper request' }));
          return;
        }

        const item = await this.ingestClipEntry(body, { allowGhost: true });
        this.onClipFeedback?.({ title: item.title, orbit: item.orbit, isSecret: item.dna === 'secret' });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: item.id, title: item.title, orbit: item.orbit }));
      } catch (err) {
        const { status, message } = this.formatClipError(err);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/clip-batch') {
      try {
        const body = await this.readJsonBody(req);
        const bodyToken = typeof body.token === 'string' ? body.token : null;
        if (!this.isAuthorized(req, bodyToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized clipper request' }));
          return;
        }

        const rawItems = Array.isArray(body.items) ? body.items : null;
        if (!rawItems || rawItems.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: this.getLocale?.() === 'en' ? 'No clips provided' : 'Нет элементов для сохранения' }));
          return;
        }

        const batch = rawItems.slice(0, 30);
        let saved = 0;
        let failed = 0;
        let firstItem: { title: string; orbit: string } | null = null;
        let lastErrorMessage: string | undefined;

        for (const rawEntry of batch) {
          if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
            failed += 1;
            continue;
          }
          try {
            const item = await this.ingestClipEntry(rawEntry as Record<string, unknown>, {
              allowGhost: false,
            });
            saved += 1;
            if (!firstItem) {
              firstItem = { title: item.title, orbit: item.orbit };
            }
          } catch (itemErr) {
            failed += 1;
            lastErrorMessage = this.formatClipError(itemErr).message;
          }
        }

        if (saved > 0 && firstItem) {
          const isEn = this.getLocale?.() === 'en';
          const feedbackTitle =
            saved === 1
              ? firstItem.title
              : isEn
                ? `Saved ${saved} clips`
                : `Сохранено записей: ${saved}`;
          this.onClipFeedback?.({ title: feedbackTitle, orbit: firstItem.orbit, isSecret: false });
        }

        const status = saved > 0 ? 200 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: saved > 0,
            saved,
            failed,
            total: batch.length,
            ...(saved === 0 ? { error: lastErrorMessage || (this.getLocale?.() === 'en' ? 'Could not save clips' : 'Не удалось сохранить подборку') } : {}),
          })
        );
      } catch (err) {
        const { status, message } = this.formatClipError(err);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
