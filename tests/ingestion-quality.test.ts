import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importArchiveJson } from '@main/bridges/archive-importer';
import { ClipperServer } from '@main/bridges/clipper-server';
import { importNotionZip } from '@main/bridges/markdown-importer';
import { VaultRepository } from '@main/db/repository';
import { runAiPipeline } from '@main/ai/enricher';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { processDocumentIntelligence } from '@main/pipeline/document-pipeline';
import { emailHtmlToMarkdown, parseEmlBuffer } from '@main/pipeline/email-parser';
import {
  extractReadablePage,
  looksLikeRawHtmlContent,
  sanitizeIngestedText,
} from '@main/pipeline/html-cleaner';
import { parseGenericHtmlPage, parseTelegramPostHtml } from '@main/pipeline/unfurler';
import { VaultCrypto } from '@main/security/vault-crypto';
import { createZipBuffer } from '@main/utils/zip';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeEnv(enableUrlUnfurl = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-ingestion-test-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  const cryptoVault = new VaultCrypto(dir, null);
  const pipeline = new CapturePipeline({
    repo,
    cryptoVault,
    dataDir: dir,
    getConfig: () => ({
      activeMode: 'autopilot',
      activeFocusBoardId: null,
      aiProvider: 'local',
      apiKey: null,
      monthlyCapUsd: 1.5,
      enableAutoOcr: false,
      enableUrlUnfurl,
    }),
  });
  cleanups.push(() => repo.close());
  return { dir, repo, cryptoVault, pipeline };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Ingestion Quality — Zero Raw HTML Leakage & Smart Content Extraction', () => {
  it('classifies Awwwards Sites of the Month with Stimulus attributes as clean showcase card with zero nav/promo/attribute leakage', () => {
    const awwwardsHtml = `<!doctype html>
<html lang="en">
  <head>
    <title>Sites Of The Month - Awwwards</title>
    <meta name="description" content="Sites Of The Month on Awwwards, the awards that recognize the talent and effort of the best web designers, developers and agencies in the world." />
    <link rel="canonical" href="https://www.awwwards.com/websites/sites_of_the_month/" />
  </head>
  <body>
    <div class="alert-bar promo-banner">
      <a href="/academy-plan?utm_source=alert">The Creative Pass — Watch all courses for just $12/month</a>
    </div>
    <header class="site-header">
      <nav>
        <ul>
          <li><a href="/websites/">Awards</a></li>
          <li><a href="/websites/honorable-mentions/">Honor Mentions</a></li>
          <li><a href="/websites/nominees/">Nominees</a></li>
          <li><a href="/websites/sites_of_the_day/">Sites of the Day</a></li>
          <li><a href="/free-fonts/">Free fonts</a></li>
          <li><a href="/websites/architecture/">Architecture</a></li>
          <li><a href="/websites/fashion/">Fashion</a></li>
        </ul>
      </nav>
      <div class="search-box" data-controller="search">
        <button data-action="click->search#doToogleTab">Websites</button>
        <input type="text" data-action="focus->search#show keyup->search#search" data-search-target="input" />
      </div>
    </header>
    <main>
      <div class="filters searchable-filter" data-controller="grid">
        <button data-action="click->grid#toggleFilter" data-grid-target="filterItem">By Category</button>
        <input data-action="keyup->searchable-filter#searchEvent" />
      </div>
      <h1>Sites Of The Month</h1>
      <p>Sites Of The Month on Awwwards, the awards that recognize the talent and effort of the best web designers, developers and agencies in the world.</p>
      <section class="grid-sites">
        <figure>
          <img
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAQAAADB7vUKAAAAEUlEQVR42mNkIAAYRxXQSwEAC5oADbo22BYAAAAASUVORK5CYII="
            data-srcset="https://assets.awwwards.com/awards/media/cache/thumb_440_330/submissions/2026/08/shot1.png 1x, https://assets.awwwards.com/awards/media/cache/thumb_880_660/submissions/2026/08/shot1.png 2x"
            alt="Santioni Spirits"
            class="lazy figure-rollover__file"
          />
          <img src="https://assets.awwwards.com/awards/media/cache/thumb_user_70/avatar/1.jpg" width="20" height="20" class="avatar-name__img" alt="Active Theory" />
        </figure>
        <figure>
          <img
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAQAAADB7vUKAAAAEUlEQVR42mNkIAAYRxXQSwEAC5oADbo22BYAAAAASUVORK5CYII="
            data-srcset="https://assets.awwwards.com/awards/media/cache/thumb_440_330/submissions/2026/07/shot2.jpg 1x, https://assets.awwwards.com/awards/media/cache/thumb_880_660/submissions/2026/07/shot2.jpg 2x"
            alt="Why Zero"
            class="lazy figure-rollover__file"
          />
        </figure>
        <figure>
          <img
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAQAAADB7vUKAAAAEUlEQVR42mNkIAAYRxXQSwEAC5oADbo22BYAAAAASUVORK5CYII="
            data-srcset="https://assets.awwwards.com/awards/media/cache/thumb_880_660/submissions/2026/07/shot3.png 2x"
            alt="ERA Residence"
            class="lazy figure-rollover__file"
          />
        </figure>
      </section>
    </main>
    <footer>
      <div class="social-links">
        <a href="https://www.facebook.com/awwwards">Facebook</a>
        <a href="https://www.tiktok.com/@awwwards.com">TikTok</a>
        <a href="https://www.instagram.com/awwwards/">Instagram</a>
      </div>
    </footer>
  </body>
</html>`;

    const res = parseGenericHtmlPage(
      awwwardsHtml,
      new URL('https://www.awwwards.com/websites/sites_of_the_month/')
    );

    expect(res.pageKind).toBe('showcase');
    expect(res.title).toBe('Sites Of The Month - Awwwards');
    expect(res.description).toContain('best web designers, developers and agencies');
    expect(res.ogImageUrl).toBe(
      'https://assets.awwwards.com/awards/media/cache/thumb_880_660/submissions/2026/08/shot1.png'
    );
    expect(res.galleryUrls).not.toContain(
      'https://assets.awwwards.com/awards/media/cache/thumb_user_70/avatar/1.jpg'
    );

    const body = res.bodyMarkdown || '';
    expect(body).toContain('Sites Of The Month on Awwwards');
    expect(body).toContain('Santioni Spirits');
    expect(body).toContain('Why Zero');
    expect(body).toContain('ERA Residence');

    // ZERO broken HTML attributes, nav menus, filter drawers, promo banners, or social footer links
    for (const forbidden of [
      '">',
      'data-search-target',
      'data-grid-target',
      'keyup->',
      'click->',
      'doToogleTab',
      'toggleFilter',
      'searchEvent',
      '/academy-plan',
      'The Creative Pass',
      'Watch all courses',
      'Honor Mentions',
      'Free fonts',
      'By Category',
      'facebook.com/awwwards',
      'tiktok.com',
    ]) {
      expect(body, `Body must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('extracts genuine articles & technical docs via Readability with syntax-fenced code blocks and strips sidebar/cookie chrome', () => {
    const docsHtml = `<!doctype html>
<html>
  <head>
    <title>Closures - JavaScript | MDN</title>
    <meta property="og:title" content="Closures - JavaScript | MDN" />
    <meta property="og:description" content="A closure is the combination of a function bundled together with references to its surrounding state." />
    <meta name="og:image" content="https://developer.mozilla.org/mdn-social-image.png" />
  </head>
  <body>
    <header>
      <nav>
        <a href="/docs">References</a>
        <a href="/guides">Guides</a>
        <a href="/plus">MDN Plus</a>
        <a href="/blog">Blog</a>
        <a href="/play">Play</a>
      </nav>
    </header>
    <aside class="sidebar">
      <ul>
        <li><a href="/a">Grammar and types</a></li>
        <li><a href="/b">Control flow</a></li>
        <li><a href="/c">Loops</a></li>
        <li><a href="/d">Functions</a></li>
        <li><a href="/e">Expressions</a></li>
      </ul>
    </aside>
    <div class="cookie-banner">We use cookies to improve your experience. <button>Accept all cookies</button></div>
    <main>
      <article>
        <h1>Closures</h1>
        <h2>Lexical scoping</h2>
        <p>A closure is the combination of a function bundled together (enclosed) with references to its surrounding state (the lexical environment). In other words, a closure gives a function access to its outer scope from an inner function.</p>
        <div class="code-example">
          <div class="example-header"><span class="language-name">js</span><button class="copy-code-button">Copy</button></div>
          <pre class="brush: js notranslate"><code>function init() {
  const name = "Mozilla";
  function displayName() {
    console.log(name);
  }
  displayName();
}</code></pre>
        </div>
        <p>Running this code has the exact same effect as calling the inner function directly inside the outer scope, except that lexical scoping preserves the outer variable binding even after the parent function finishes returning to the caller.</p>
        <blockquote>Closures are created every time a function is created, at function creation time.</blockquote>
      </article>
    </main>
    <footer>All rights reserved © 2026 Mozilla</footer>
  </body>
</html>`;

    const res = extractReadablePage(
      docsHtml,
      new URL('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures')
    );

    expect(res.pageKind).toBe('article');
    expect(res.title).toBe('Closures - JavaScript | MDN');
    expect(res.ogImageUrl).toBe('https://developer.mozilla.org/mdn-social-image.png');
    expect(res.bodyMarkdown).toContain('## Lexical scoping');
    expect(res.bodyMarkdown).toContain('```js\nfunction init() {');
    expect(res.bodyMarkdown).toContain('> Closures are created every time a function is created');
    expect(res.bodyMarkdown).not.toContain('jsfunction init');
    expect(res.bodyMarkdown).not.toContain('We use cookies');
    expect(res.bodyMarkdown).not.toContain('MDN Plus');
    expect(res.bodyMarkdown).not.toContain('All rights reserved');
  });

  it('classifies SaaS landing homepages cleanly as showcase cards instead of dumping marketing nav/CTA soup', () => {
    const landingHtml = `<!doctype html>
<html>
  <head>
    <meta property="og:title" content="Linear – The system for product development" />
    <meta property="og:description" content="Purpose-built for planning and building products with AI agents." />
    <meta property="og:image" content="https://linear.app/api/og/main?title=Linear" />
  </head>
  <body>
    <header><nav><a href="/features">Features</a><a href="/method">Method</a><a href="/pricing">Pricing</a><a href="/login">Log in</a></nav></header>
    <main>
      <h1>The product development system for teams and agents</h1>
      <p>Fast issue tracking.</p>
      <a href="/signup">Start building</a>
    </main>
    <footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
  </body>
</html>`;

    const res = parseGenericHtmlPage(landingHtml, new URL('https://linear.app/'));
    expect(res.pageKind).toBe('showcase');
    expect(res.title).toBe('Linear – The system for product development');
    expect(res.description).toBe('Purpose-built for planning and building products with AI agents.');
    expect(res.ogImageUrl).toBe('https://linear.app/api/og/main?title=Linear');
    expect(res.bodyMarkdown).toBe('Purpose-built for planning and building products with AI agents.');
    expect(res.bodyMarkdown).not.toContain('Start building');
    expect(res.bodyMarkdown).not.toContain('Pricing');
  });

  it('extracts clean GitHub repo metadata and README on HTML fallback without GitHub navigation soup', () => {
    const ghHtml = `<!doctype html>
<html>
  <head>
    <meta property="og:title" content="GitHub - facebook/react: The library for web and native user interfaces." />
    <meta property="og:description" content="The library for web and native user interfaces. Contribute to facebook/react development by creating an account on GitHub." />
    <meta property="og:image" content="https://opengraph.githubassets.com/1/facebook/react" />
  </head>
  <body>
    <header><nav><a href="/features">Product</a><a href="/solutions">Solutions</a><a href="/pricing">Pricing</a><a href="/login">Sign in</a></nav></header>
    <main>
      <article class="markdown-body">
        <h1>React</h1>
        <p>React is a JavaScript library for building user interfaces with declarative components and predictable state updates across web and native targets.</p>
      </article>
    </main>
  </body>
</html>`;

    const res = parseGenericHtmlPage(ghHtml, new URL('https://github.com/facebook/react'));
    expect(res.platform).toBe('github');
    expect(res.title).toBe('facebook/react: The library for web and native user interfaces.');
    expect(res.description).toBe('The library for web and native user interfaces.');
    expect(res.ogImageUrl).toBe('https://opengraph.githubassets.com/1/facebook/react');
    expect(res.bodyMarkdown).toContain('React is a JavaScript library for building user interfaces');
    expect(res.bodyMarkdown).not.toContain('Sign in');
    expect(res.bodyMarkdown).not.toContain('Contribute to facebook/react');
  });

  it('converts complex HTML emails with -> attributes, MSO conditionals, hidden preheaders, and tracking pixels without leakage', () => {
    const dirtyEmailHtml = `<!doctype html>
<html>
  <head><style>.hidden { display: none; } body { color: #111; }</style></head>
  <body>
    <div style="display:none;max-height:0;opacity:0;mso-hide:all;">Hidden preheader spam text &zwnj;&nbsp;&zwnj;</div>
    <!--[if mso]><table><tr><td>Outlook only junk</td></tr></table><![endif]-->
    <table role="presentation" data-action="click->mail#track" data-mail-target="wrapper">
      <tr>
        <td>
          <h2>Дайджест недели</h2>
          <p data-action="mouseenter->card#hover keyup->search#go">Привет! Посмотри <a href="https://example.com/digest" data-cond="a > b">свежий выпуск</a> с разбором UI.</p>
          <ul>
            <li data-action="click->item#select">Новый движок верстки</li>
            <li>Поддержка <code>&amp;lt;section&amp;gt;</code></li>
          </ul>
          <img src="https://track.example.com/open.track?id=123" width="1" height="1" alt="" />
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const md = emailHtmlToMarkdown(dirtyEmailHtml);
    expect(md).toContain('## Дайджест недели');
    expect(md).toContain('[свежий выпуск](https://example.com/digest)');
    expect(md).toContain('- Новый движок верстки');
    expect(md).toContain('`&lt;section&gt;`');

    for (const bad of [
      'Hidden preheader spam',
      'Outlook only junk',
      'mail#track',
      'card#hover',
      'search#go',
      'item#select',
      'data-mail-target',
      'data-cond',
      '">',
      'open.track',
      'display: none',
    ]) {
      expect(md, `Email markdown must not contain "${bad}"`).not.toContain(bad);
    }

    // Verify full .eml parsing uses the DOM-based converter cleanly
    const eml = [
      'From: Newsletter <news@example.com>',
      'Subject: Weekly Digest',
      'Content-Type: text/html; charset="utf-8"',
      '',
      dirtyEmailHtml,
    ].join('\r\n');
    const parsed = parseEmlBuffer(Buffer.from(eml, 'utf8'));
    expect(parsed.bodyMarkdown).toContain('## Дайджест недели');
    expect(parsed.bodyMarkdown).not.toContain('mail#track');
    expect(parsed.bodyMarkdown).not.toContain('">');
  });

  it('sanitizes pasted raw HTML without breaking intentional JSX/TypeScript code snippets', async () => {
    const pastedDirtyHtml = `
      <div class="nav" role="navigation"><a href="/a">Home</a><a href="/b">Pricing</a><a href="/c">About</a><a href="/d">Login</a></div>
      <div data-action="focus->search#show keyup->search#search" data-search-target="input">
        <p>Полезная заметка про &laquo;Капсулу&raquo; &amp; чистый парсер.</p>
      </div>
    `;
    expect(looksLikeRawHtmlContent(pastedDirtyHtml)).toBe(true);
    const sanitized = sanitizeIngestedText(pastedDirtyHtml, { stripCookieNoise: true });
    expect(sanitized).toBe('Полезная заметка про «Капсулу» & чистый парсер.');
    expect(sanitized).not.toContain('search#show');
    expect(sanitized).not.toContain('data-search-target');
    expect(sanitized).not.toContain('">');

    // Intentional TypeScript / JSX code snippet MUST remain completely intact!
    const tsxSnippet = `import React from 'react';
export function SearchInput() {
  return <input data-action="focus->search#show" className="field" />;
}`;
    expect(looksLikeRawHtmlContent(tsxSnippet)).toBe(false);
    expect(sanitizeIngestedText(tsxSnippet)).toBe(tsxSnippet);

    // End-to-end CapturePipeline cleans pasted HTML while keeping code snippets untouched
    const { pipeline } = makeEnv(false);
    const cleanedItem = await pipeline.capture({ text: pastedDirtyHtml, source: 'vault_ui' });
    expect(cleanedItem.body).toBe('Полезная заметка про «Капсулу» & чистый парсер.');
    expect(cleanedItem.body).not.toContain('search#show');

    const codeItem = await pipeline.capture({ text: tsxSnippet, source: 'vault_ui' });
    expect(codeItem.dna).toBe('snippet');
    expect(codeItem.body).toContain('data-action="focus->search#show"');
  });

  it('cleans ClipperServer HTML/cookie payloads and avoids duplicating tab title into body', async () => {
    const { pipeline, repo } = makeEnv(false);
    const server = new ClipperServer(pipeline, () => 'clip-quality-tok');
    const port = await server.start();
    cleanups.push(() => server.stop());

    // 1. Browser extension default page clip sends `${tab.title}\n${tab.url}` -> stripped to clean URL so unfurl works
    const pageClip = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'clip-quality-tok',
      },
      body: JSON.stringify({
        url: 'https://www.awwwards.com/websites/sites_of_the_month/',
        title: 'Sites Of The Month &amp; Awards',
        text: 'Sites Of The Month &amp; Awards\nhttps://www.awwwards.com/websites/sites_of_the_month/',
      }),
    });
    expect(pageClip.status).toBe(200);
    const pageJson = (await pageClip.json()) as { id: string };
    const savedPage = repo.getItemById(pageJson.id);
    expect(savedPage?.title).toBe('Sites Of The Month & Awards');
    expect(savedPage?.body).toBe('https://www.awwwards.com/websites/sites_of_the_month/');

    // 2. Clipping dirty HTML selection strips nav, cookie banners, and Stimulus attributes
    const htmlClip = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kapsula-Token': 'clip-quality-tok',
      },
      body: JSON.stringify({
        url: 'https://example.com/guide',
        title: 'Design Guide',
        html: '<div class="cookie-banner">We use cookies</div><p data-action="click->tip#open">Ключевой принцип композиции.</p>',
      }),
    });
    expect(htmlClip.status).toBe(200);
    const htmlJson = (await htmlClip.json()) as { id: string };
    const savedHtmlClip = repo.getItemById(htmlJson.id);
    expect(savedHtmlClip?.body).toBe('Ключевой принцип композиции.');
    expect(savedHtmlClip?.body).not.toContain('tip#open');
    expect(savedHtmlClip?.body).not.toContain('We use cookies');
  });

  it('handles -> attributes cleanly in Telegram post parser, Telegram HTML archive import, .html documents, and Notion ZIP callouts', async () => {
    // 1. Telegram embed post with `->` inside attribute
    const tgHtml = `
      <div class="tgme_widget_message">
        <div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name">Design Lab</a></div>
        <div class="tgme_widget_message_text" data-action="click->tg#expand">
          <b>Подборка 2026</b><br><br>
          Отличный <a href="https://example.com/ref" data-track="a->b">референс интерфейса</a>.
        </div>
      </div>
    `;
    const parsedTg = parseTelegramPostHtml(tgHtml, 'https://t.me/designlab/77');
    expect(parsedTg.title).toBe('Подборка 2026');
    expect(parsedTg.bodyMarkdown).toContain('[референс интерфейса](https://example.com/ref)');
    expect(parsedTg.bodyMarkdown).not.toContain('tg#expand');
    expect(parsedTg.bodyMarkdown).not.toContain('a->b');
    expect(parsedTg.bodyMarkdown).not.toContain('">');

    // 2. Telegram Desktop messages.html archive with `->` attribute
    const { dir, repo, pipeline } = makeEnv(false);
    const archiveHtml = `<!doctype html><html><body>
      <div class="message default" id="message777">
        <div class="body">
          <div class="date" title="20.11.2026 12:00:00 UTC+03:00">12:00</div>
          <div class="text" data-action="click->msg#open">Чистая архивная заметка &laquo;без мусора&raquo;.</div>
        </div>
      </div>
    </body></html>`;
    const imp = await importArchiveJson(archiveHtml, pipeline, repo);
    expect(imp.imported).toBe(1);
    const impItem = repo.queryItems({ limit: 5 })[0];
    expect(impItem?.body).toBe('Чистая архивная заметка «без мусора».');
    expect(impItem?.body).not.toContain('msg#open');

    // 3. Dropped .html document extracts clean prose instead of raw tags
    const htmlDocBuf = Buffer.from(
      `<!doctype html><html><head><title>Спецификация</title></head><body><nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav><main><article><h1>Спецификация</h1><p data-action="x->y#z">Первый важный абзац технической спецификации проекта для удобного чтения и поиска в Капсуле.</p><p>Второй подробный абзац с описанием требований, архитектуры хранилища и форматов экспорта данных.</p></article></main></body></html>`,
      'utf8'
    );
    const docRes = await processDocumentIntelligence({
      buffer: htmlDocBuf,
      fileName: 'spec.html',
      aiProvider: 'local',
    });
    expect(docRes.ext).toBe('html');
    expect(docRes.extractedText).toContain('Первый важный абзац');
    expect(docRes.extractedText).not.toContain('x->y#z');
    expect(docRes.extractedText).not.toContain('<article>');

    // 4. Notion ZIP with <aside> / <details> HTML callouts cleans tags while preserving code fences
    const notionZipPath = path.join(dir, 'notion-html-callout.zip');
    fs.writeFileSync(
      notionZipPath,
      createZipBuffer([
        {
          name: 'Гайд aabbccddeeff00112233445566778899.md',
          data: Buffer.from(
            '<aside>💡 Важное примечание &amp; совет.</aside>\n\n<details><summary>Детали</summary>Скрытый текст.</details>\n\n```html\n<aside>Keep code fence literal</aside>\n```',
            'utf8'
          ),
        },
      ])
    );
    const notionRes = await importNotionZip(notionZipPath, { repo, pipeline });
    expect(notionRes.importedCount).toBe(1);
    const notionNote = repo.queryItems({ limit: 10 }).find((i) => i.title === 'Гайд');
    expect(notionNote?.body).toContain('Важное примечание & совет.');
    expect(notionNote?.body).toContain('**Детали**');
    expect(notionNote?.body).toContain('```html\n<aside>Keep code fence literal</aside>\n```');
  });

  it('pre-cleans dirty HTML/cookie noise before sending prompt to cloud AI enricher', async () => {
    const { repo } = makeEnv(false);
    const capturedPrompts: string[] = [];

    const mockFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? '');
      capturedPrompts.push(bodyStr);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'Awwwards — Сайты месяца',
                      summary: 'Подборка лучших сайтов месяца по версии Awwwards для дизайн-вдохновения.',
                      orbit: 'unsorted',
                      suggestedNewSection: 'Дизайн',
                      dna: 'link',
                      tags: ['дизайн', 'референсы'],
                      calendarEvent: null,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const outcome = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
      contentHash: 'ai-clean-test-1',
      rawText:
        '<div data-action="keyup->search#search">Sites Of The Month on Awwwards</div>\nWe use cookies to improve your experience.',
      domain: 'awwwards.com',
      hasImage: false,
      orbits: [],
      localBaseline: {
        orbit: '',
        dna: 'link',
        title: 'Sites Of The Month - Awwwards',
        summary: '',
        tags: ['дизайн'],
      },
      fetchFn: mockFetch,
    });

    expect(outcome.usedCloud).toBe(true);
    expect(outcome.summary).toContain('Подборка лучших сайтов месяца');
    const allSent = capturedPrompts.join('\n');
    expect(allSent).toContain('Sites Of The Month on Awwwards');
    expect(allSent).not.toContain('keyup->search#search');
    expect(allSent).not.toContain('We use cookies');
  });
});
