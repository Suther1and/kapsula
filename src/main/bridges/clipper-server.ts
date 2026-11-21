import crypto from 'node:crypto';
import http from 'node:http';
import type { CaptureMode } from '@shared/types';
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
    private readonly getOrbits?: () => Array<{ id: string; name: string; color: string }>
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
    throw new Error('Не удалось запустить локальный клиппер-сервер');
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
    return (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin.startsWith('safari-extension://')
    );
  }

  private setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (this.isAllowedExtensionOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kapsula-Token, X-Kapsula-Client');
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

    // Extension handshake endpoint strictly POST-only for verified extension origins
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
        res.end(JSON.stringify({ error: 'Forbidden origin' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: this.getToken() }));
      return;
    }

    // Universal CSP-safe Bookmarklet pixel endpoint
    if (req.method === 'GET' && reqUrl.pathname === '/clip-pixel') {
      const token = reqUrl.searchParams.get('token');
      const expected = this.getToken();
      if (!this.tokensEqual(token, expected)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const pageUrl = reqUrl.searchParams.get('url') || undefined;
      const rawTitle = reqUrl.searchParams.get('title') || undefined;
      const rawText = reqUrl.searchParams.get('text') || reqUrl.searchParams.get('sel') || pageUrl || '';
      const modeParam = (reqUrl.searchParams.get('mode') || 'autopilot') as CaptureMode;

      if (rawText) {
        try {
          const cleaned = this.cleanClipPayload({ url: pageUrl, title: rawTitle, text: rawText });
          const item = await this.pipeline.capture({
            text: cleaned.text,
            url: pageUrl,
            title: cleaned.title,
            mode: ['autopilot', 'buffer', 'ghost', 'focus'].includes(modeParam) ? modeParam : 'autopilot',
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
      const queryToken = reqUrl.searchParams.get('token');
      if (!this.isAuthorized(req, queryToken)) {
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

        const mode =
          typeof body.mode === 'string' && ['autopilot', 'buffer', 'ghost', 'focus'].includes(body.mode)
            ? (body.mode as CaptureMode)
            : undefined;
        const orbitId =
          typeof body.orbitId === 'string' && body.orbitId.trim()
            ? body.orbitId.trim()
            : undefined;
        const url = typeof body.url === 'string' ? body.url : undefined;
        const rawTitle = typeof body.title === 'string' ? body.title : undefined;
        const rawText = typeof body.text === 'string' ? body.text : url || '';
        const rawHtml = typeof body.html === 'string' ? body.html : undefined;
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined;
        const platform = typeof body.platform === 'string' ? body.platform : undefined;
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === 'string')
          : undefined;

        const cleaned =
          mode === 'ghost'
            ? { title: rawTitle, text: rawText }
            : this.cleanClipPayload({ url, title: rawTitle, text: rawText, html: rawHtml });

        const item = await this.pipeline.capture({
          text: cleaned.text,
          url,
          title: cleaned.title,
          imageBase64,
          mode,
          orbitOverride: orbitId,
          platform,
          tags,
          source: 'browser_ext',
          externalId: this.buildClipExternalId(url, rawText || rawHtml || ''),
        });
        this.onClipFeedback?.({ title: item.title, orbit: item.orbit, isSecret: item.dna === 'secret' });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: item.id, title: item.title, orbit: item.orbit }));
      } catch (err) {
        const status = (err as Error & { statusCode?: number }).statusCode === 413 ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
