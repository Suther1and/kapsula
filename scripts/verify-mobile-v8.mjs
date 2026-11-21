import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DIST_DIR = path.resolve(ROOT, 'dist', 'mobile');
const OUT_DIR = path.resolve(ROOT, '.tmp', 'v8-mobile-audit');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const FORBIDDEN_UI_PATTERNS = [
  { label: 'Supabase', re: /\bsupabase\b/i },
  { label: 'Telegram', re: /\btelegram\b/i },
  { label: '(RU / EN)', re: /\(\s*ru\s*\/\s*en\s*\)/i },
  { label: 'Тинькофф', re: /тинькофф/i },
];

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
      if (
        !filePath.startsWith(DIST_DIR) ||
        !fs.existsSync(filePath) ||
        fs.statSync(filePath).isDirectory()
      ) {
        filePath = path.join(DIST_DIR, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function buildMinimalWavBytes(durationSec = 1, sampleRate = 8000) {
  const numSamples = durationSec * sampleRate;
  const buf = new Uint8Array(44 + numSamples);
  const view = new DataView(buf.buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  buf.fill(128, 44);
  return Array.from(buf);
}

function parseRgb(str) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(str || '');
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  const srgb = /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(str || '');
  if (srgb) {
    return {
      r: Math.round(Number(srgb[1]) * 255),
      g: Math.round(Number(srgb[2]) * 255),
      b: Math.round(Number(srgb[3]) * 255),
    };
  }
  return null;
}

function parseHexToRgb(hex) {
  const clean = (hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function contrastRatioRgb(a, b) {
  const lum = (c) => {
    const ch = [c.r, c.g, c.b].map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function launchBrowser() {
  for (const ch of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ headless: true, ...(ch ? { channel: ch } : {}) });
    } catch {
      // try next browser channel
    }
  }
  throw new Error('Could not launch Chromium/Chrome/Edge for Mobile V8 verification');
}

async function checkScreenHealth(page, screenLabel) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const bodyText = document.body?.innerText || '';
    const placeholders = Array.from(document.querySelectorAll('input, textarea'))
      .map((el) => el.getAttribute('placeholder') || '')
      .filter(Boolean)
      .join(' | ');
    const selects = document.querySelectorAll('select').length;
    const brokenImgs = Array.from(document.querySelectorAll('img'))
      .filter(
        (img) =>
          !img.classList.contains('ProseMirror-separator') &&
          img.offsetParent !== null &&
          (!img.complete || img.naturalWidth === 0)
      )
      .map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 120),
        alt: img.getAttribute('alt') || '',
        cls: img.className || '',
        inKapsulaNode: Boolean(img.closest('[data-testid="mobile-inline-image-node"]')),
      }));
    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      innerW: window.innerWidth,
      selects,
      brokenImgs,
      textCombined: `${bodyText}\n${placeholders}`,
    };
  });

  const issues = [];
  if (metrics.scrollW > metrics.clientW + 1) {
    issues.push(`Horizontal overflow on ${screenLabel}: scrollWidth=${metrics.scrollW} > clientWidth=${metrics.clientW}`);
  }
  if (metrics.selects > 0) {
    issues.push(`Found ${metrics.selects} raw native <select> element(s) on ${screenLabel}`);
  }
  if (metrics.brokenImgs.length > 0) {
    issues.push(`Found ${metrics.brokenImgs.length} broken visible <img> element(s) on ${screenLabel}: ${JSON.stringify(metrics.brokenImgs)}`);
  }
  for (const pat of FORBIDDEN_UI_PATTERNS) {
    if (pat.re.test(metrics.textCombined)) {
      issues.push(`Forbidden UI text leak '${pat.label}' found on ${screenLabel}`);
    }
  }
  return issues;
}

async function setRangeValue(page, locator, val) {
  await locator.evaluate((el, v) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, val);
}

async function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('dist/mobile/index.html missing — run npm run build:mobile first');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const { server, port } = await startStaticServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const browser = await launchBrowser();

  const results = [];
  const allConsoleErrors = [];
  const allPageErrors = [];
  const capturedScreenshots = [];

  function record(id, pass, detail) {
    results.push({ id, pass, detail });
    console.log(`${pass ? '[PASS]' : '[FAIL]'} ${id}: ${detail}`);
  }

  function attachErrorListeners(page, tag) {
    const localErrors = [];
    page.on('pageerror', (err) => {
      const msg = `[${tag}] PAGEERROR: ${err.message}`;
      localErrors.push(msg);
      allPageErrors.push(msg);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = `[${tag}] CONSOLE_ERROR: ${msg.text()}`;
        localErrors.push(text);
        allConsoleErrors.push(text);
      }
    });
    page.on('requestfailed', (req) => {
      const text = `[${tag}] REQUEST_FAILED: ${req.url()} (${req.failure()?.errorText || 'failed'})`;
      localErrors.push(text);
      allConsoleErrors.push(text);
    });
    return localErrors;
  }

  async function snap(page, filename) {
    const full = path.join(OUT_DIR, filename);
    await page.screenshot({ path: full });
    capturedScreenshots.push(full);
    return full;
  }

  try {
    // =========================================================================
    // SCENARIO 1: Fresh empty IndexedDB -> MobileWelcomeSheet (360x800)
    // =========================================================================
    const ctx1 = await browser.newContext({
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 2,
      locale: 'ru-RU',
    });
    const page = await ctx1.newPage();
    const errsMain = attachErrorListeners(page, 'main');

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="kapsula-mobile-root"]');

    try {
      await page.waitForSelector('[data-testid="mobile-welcome-sheet"]', { timeout: 5000 });
      await page.waitForTimeout(260);

      const welcomeFit = await page.evaluate(() => {
        const popup = document.querySelector('[data-testid="mobile-welcome-sheet"]')?.closest('.k-drawer-popup');
        const startBtn = document.querySelector('[data-testid="mobile-welcome-start-btn"]');
        const skipBtn = document.querySelector('[data-testid="mobile-welcome-skip-btn"]');
        const pr = popup?.getBoundingClientRect();
        const sr = startBtn?.getBoundingClientRect();
        const skr = skipBtn?.getBoundingClientRect();
        return {
          popupOk: Boolean(pr && pr.left >= -1 && pr.right <= 361 && pr.top >= 0 && pr.bottom <= 801),
          startVisible: Boolean(sr && sr.height >= 40 && sr.bottom <= 801 && sr.right <= 361),
          skipVisible: Boolean(skr && skr.height >= 40 && skr.bottom <= 801 && skr.left >= 0),
          popupRect: pr ? { l: Math.round(pr.left), r: Math.round(pr.right), t: Math.round(pr.top), b: Math.round(pr.bottom) } : null,
        };
      });
      const issues1 = await checkScreenHealth(page, 'm01-welcome-compact');
      await snap(page, 'm01-welcome-compact.png');

      // Pick 2 universal presets ("Работа", "Идеи") & click Start
      await page.locator('[data-testid="mobile-welcome-sheet"] button', { hasText: 'Работа' }).click();
      await page.locator('[data-testid="mobile-welcome-sheet"] button', { hasText: 'Идеи' }).click();
      await page.click('[data-testid="mobile-welcome-start-btn"]');
      await page.waitForSelector('[data-testid="mobile-welcome-sheet"]', { state: 'detached', timeout: 5000 });
      await page.waitForTimeout(250);

      const afterWelcome = await page.evaluate(() => {
        const store = window.__kapsulaMobile.store;
        return {
          orbits: store.listOrbits().map((o) => o.name),
          items: store.listItems({ includeSecrets: false }).map((i) => i.title),
          tasksCount: store.listVaultTasks().length,
          onboarded: store.getSyncState('pref_onboarded'),
        };
      });

      // Verify reload does not reopen welcome sheet
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="kapsula-mobile-root"]');
      await page.waitForTimeout(280);
      const welcomeReopened = await page.isVisible('[data-testid="mobile-welcome-sheet"]');

      const ok1 =
        welcomeFit.popupOk &&
        welcomeFit.startVisible &&
        welcomeFit.skipVisible &&
        issues1.length === 0 &&
        afterWelcome.orbits.includes('Работа') &&
        afterWelcome.orbits.includes('Идеи') &&
        afterWelcome.tasksCount >= 4 &&
        afterWelcome.onboarded === '1' &&
        !welcomeReopened;

      record(
        'M01_Welcome_Compact',
        ok1,
        ok1
          ? `WelcomeSheet rendered cleanly within 360x800, created ${afterWelcome.orbits.length} orbits + ${afterWelcome.tasksCount} starter tasks, stayed dismissed on reload`
          : `fit=${JSON.stringify(welcomeFit)} after=${JSON.stringify(afterWelcome)} reopened=${welcomeReopened} issues=${JSON.stringify(issues1)}`
      );
    } catch (e) {
      record('M01_Welcome_Compact', false, e.message);
    }

    // =========================================================================
    // SCENARIO 2: Kanban Board (Compact 360x800 + Reload Persistence + Fold 840x900)
    // =========================================================================
    try {
      await page.click('[data-testid="nav-tab-tasks"]');
      await page.waitForSelector('[data-testid="mobile-tasks-view"]');
      await page.waitForTimeout(200);
      const listIssues = await checkScreenHealth(page, 'compact-tasks-list');

      // Switch List -> Board
      await page.click('[data-testid="tasks-view-board"]');
      await page.waitForSelector('[data-testid="mobile-kanban-board"]');
      await page.waitForTimeout(240);

      // Verify horizontal snap carousel & peeking next column on 360x800
      const compactBoardGeom = await page.evaluate(() => {
        const board = document.querySelector('[data-testid="mobile-kanban-board"]');
        const col1 = document.querySelector('[data-testid="kanban-column-inbox"]');
        const col2 = document.querySelector('[data-testid="kanban-column-in_progress"]');
        const chips = Array.from(document.querySelectorAll('[data-testid^="kanban-col-chip-"]'));
        const r1 = col1?.getBoundingClientRect();
        const r2 = col2?.getBoundingClientRect();
        return {
          hasSnap: Boolean(board?.className.includes('snap-x') && board?.className.includes('snap-mandatory')),
          boardScrollable: Boolean(board && board.scrollWidth > board.clientWidth + 40),
          chipCount: chips.length,
          col1Width: r1 ? Math.round(r1.width) : 0,
          col2Left: r2 ? Math.round(r2.left) : 9999,
          col2Peeking: Boolean(r1 && r2 && r2.left > r1.right && r2.left < 360),
        };
      });

      // Get first two inbox task ids
      const inboxTaskIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="kanban-column-inbox"] [data-testid^="kanban-card-"]')).map((el) =>
          el.getAttribute('data-testid').replace('kanban-card-', '')
        )
      );
      if (inboxTaskIds.length < 2) {
        throw new Error(`Expected >= 2 starter tasks in inbox, got ${inboxTaskIds.length}`);
      }
      const moveTaskId = inboxTaskIds[0];
      const doneTaskId = inboxTaskIds[1];

      // Move card 1 to "В работе" (in_progress) via 1-tap Column chip
      await page.click(`[data-testid="kanban-move-chip-${moveTaskId}"]`);
      await page.waitForSelector('[data-testid="picker-opt-in_progress"]');
      await page.click('[data-testid="picker-opt-in_progress"]');
      await page.waitForTimeout(250);

      const movedToInProgress = await page.evaluate(
        (tid) => Boolean(document.querySelector(`[data-testid="kanban-column-in_progress"] [data-testid="kanban-card-${tid}"]`)),
        moveTaskId
      );

      // Add custom column "Проверка"
      await page.click('[data-testid="kanban-add-column-btn"]');
      await page.waitForSelector('[data-testid="kanban-column-title-input"]');
      await page.fill('[data-testid="kanban-column-title-input"]', 'Проверка');
      await page.locator('button[type="submit"]', { hasText: 'Создать колонку' }).click();
      await page.waitForTimeout(260);

      const customColId = await page.evaluate(() => {
        const cols = window.__kapsulaMobile.store.listTaskBoardColumns();
        return cols.find((c) => c.title === 'Проверка')?.id ?? null;
      });

      // Toggle checkbox on card 2 -> must move to "Готово" (done)
      await page.click('[data-testid="kanban-col-chip-inbox"]');
      await page.waitForTimeout(260);
      await page.click(`[data-testid="kanban-column-inbox"] [data-testid="task-check-${doneTaskId}"]`);
      await page.waitForTimeout(300);

      const movedToDone = await page.evaluate(
        (tid) => Boolean(document.querySelector(`[data-testid="kanban-column-done"] [data-testid="kanban-card-${tid}"]`)),
        doneTaskId
      );

      // Reset carousel scroll to start so inbox + peeking in_progress are cleanly framed
      await page.evaluate(() => {
        const board = document.querySelector('[data-testid="mobile-kanban-board"]');
        if (board) board.scrollLeft = 0;
      });
      await page.waitForTimeout(220);
      const boardCompactIssues = await checkScreenHealth(page, 'm02-kanban-compact');
      await snap(page, 'm02-kanban-compact.png');

      // Reload & verify persistence!
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="kapsula-mobile-root"]');
      await page.click('[data-testid="nav-tab-tasks"]');
      await page.waitForSelector('[data-testid="mobile-kanban-board"]');
      await page.waitForTimeout(260);

      const persistCheck = await page.evaluate(
        ({ moveId, doneId, customId }) => ({
          inProgressPersisted: Boolean(
            document.querySelector(`[data-testid="kanban-column-in_progress"] [data-testid="kanban-card-${moveId}"]`)
          ),
          donePersisted: Boolean(
            document.querySelector(`[data-testid="kanban-column-done"] [data-testid="kanban-card-${doneId}"]`)
          ),
          customColPersisted: Boolean(
            customId && document.querySelector(`[data-testid="kanban-column-${customId}"]`)
          ),
        }),
        { moveId: moveTaskId, doneId: doneTaskId, customId: customColId }
      );

      const okCompact =
        compactBoardGeom.hasSnap &&
        compactBoardGeom.boardScrollable &&
        compactBoardGeom.col2Peeking &&
        movedToInProgress &&
        Boolean(customColId) &&
        movedToDone &&
        persistCheck.inProgressPersisted &&
        persistCheck.donePersisted &&
        persistCheck.customColPersisted &&
        listIssues.length === 0 &&
        boardCompactIssues.length === 0;

      record(
        'M02_Kanban_Compact_And_Persistence',
        okCompact,
        okCompact
          ? `Snap carousel OK (col1=${compactBoardGeom.col1Width}px, col2 peeks at x=${compactBoardGeom.col2Left}px), move/add-col/done-toggle persisted across reload`
          : `geom=${JSON.stringify(compactBoardGeom)} moved=${movedToInProgress} customCol=${customColId} done=${movedToDone} persist=${JSON.stringify(persistCheck)} issues=${JSON.stringify([...listIssues, ...boardCompactIssues])}`
      );

      // Expand to Galaxy Z Fold (840x900) -> multi-column side-by-side board
      await page.setViewportSize({ width: 840, height: 900 });
      await page.waitForTimeout(320);

      const foldBoardGeom = await page.evaluate(() => {
        const rootMode = document.querySelector('[data-testid="kapsula-mobile-root"]')?.getAttribute('data-fold-mode');
        const railVisible = Boolean(document.querySelector('[data-testid="fold-nav-rail"]'));
        const cols = Array.from(document.querySelectorAll('[data-testid^="kanban-column-"]')).map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.getAttribute('data-testid'), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
        });
        const visibleFullCols = cols.filter((c) => c.left >= 70 && c.right <= 845).length;
        const sideBySide = cols.length >= 2 && cols[1].left >= cols[0].right && cols[1].left < 840;
        return { rootMode, railVisible, visibleFullCols, sideBySide, cols: cols.slice(0, 4) };
      });
      const foldIssues = await checkScreenHealth(page, 'm02b-kanban-fold');
      await snap(page, 'm02b-kanban-fold.png');

      const okFold =
        foldBoardGeom.rootMode === 'expanded' &&
        foldBoardGeom.railVisible &&
        foldBoardGeom.sideBySide &&
        foldBoardGeom.visibleFullCols >= 2 &&
        foldIssues.length === 0;

      record(
        'M02b_Kanban_Fold_Expanded',
        okFold,
        okFold
          ? `Fold 840x900 side-by-side board OK (${foldBoardGeom.visibleFullCols} full columns visible, rail visible, 0 overflow)`
          : `geom=${JSON.stringify(foldBoardGeom)} issues=${JSON.stringify(foldIssues)}`
      );

      // Return to Compact 360x800
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(260);
    } catch (e) {
      record('M02_Kanban_Suite', false, e.message);
      await page.setViewportSize({ width: 360, height: 800 });
    }

    // =========================================================================
    // SCENARIO 3: MobileNoteEditor (Templates, Inline Photo, `/` & `[[` Docked Tray, Revisions)
    // =========================================================================
    try {
      await page.click('[data-testid="nav-tab-notes"]');
      await page.waitForSelector('[data-testid="mobile-notes-view"]');
      await page.waitForTimeout(200);
      const notesListIssues = await checkScreenHealth(page, 'compact-notes-list');

      // Create new virtual draft -> test template chips
      await page.click('[data-testid="notes-create-btn"]');
      await page.waitForSelector('[data-testid="mobile-notes-fullscreen-editor"]');
      await page.waitForSelector('[data-testid="mobile-note-templates"]');
      await page.waitForTimeout(180);

      const templatesCount = await page.locator('[data-testid^="note-template-"]').count();
      await page.click('[data-testid="note-template-idea"]');
      await page.waitForTimeout(700); // materialize draft into real note

      const afterTpl = await page.evaluate(() => ({
        title: document.querySelector('[data-testid="mobile-note-editor-title"]')?.value || '',
        bodyText: document.querySelector('[data-testid="mobile-note-editor-body"]')?.innerText || '',
        templatesHidden: !document.querySelector('[data-testid="mobile-note-templates"]'),
        historyBtnVisible: Boolean(document.querySelector('[data-testid="note-editor-history-btn"]')),
      }));

      // Edit content cleanly so we have a concise top section + inline photo + slash command
      await page.fill('[data-testid="mobile-note-editor-title"]', 'Концепт мобильного редактора');
      await page.click('[data-testid="mobile-note-editor-body"]');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Первая версия заметки с планом проверки встроенных фото, вики-ссылок и истории версий.');
      await page.waitForTimeout(750); // triggers auto-revision checkpoint of template version

      // Now edit again + insert inline photo via real filechooser -> KapsulaImage -> ensureMediaUrl!
      await page.keyboard.press('Enter');
      await page.keyboard.type('Добавляю референс прямо внутрь текста заметки:');
      await page.keyboard.press('Enter');

      await page.click('[data-testid="note-toolbar-image"]');
      await page.waitForTimeout(200);
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('button', { hasText: 'Галерея' }).click(),
      ]);
      await fileChooser.setFiles(path.resolve(ROOT, 'build', 'icon.png'));
      await page.waitForSelector('[data-testid="mobile-inline-image-node"] img', { timeout: 6000 });
      await page.waitForTimeout(680); // safely past 450ms editor autosave debounce

      const inlineImgCheck = await page.evaluate(() => {
        const img = document.querySelector('[data-testid="mobile-inline-image-node"] img');
        const store = window.__kapsulaMobile.store;
        const note = store.listItems({ includeSecrets: false }).find((i) => i.title === 'Концепт мобильного редактора');
        return {
          imgRendered: Boolean(img && img.complete && img.naturalWidth > 0),
          naturalWidth: img?.naturalWidth ?? 0,
          srcIsBlob: Boolean(img?.src?.startsWith('blob:')),
          bodyHasKapsulaMedia: Boolean(note?.body?.includes('kapsula-media://local/')),
        };
      });

      // Test `/` docked suggestion tray above formatting toolbar!
      // Focus the editor prose explicitly (avoid clicking center of `.ProseMirror` which hits the inline <img> lightbox!)
      await page.evaluate(() => {
        const pm = document.querySelector('[data-testid="mobile-note-editor-body"]');
        if (pm) pm.focus();
      });
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      await page.waitForSelector('[data-testid="note-docked-suggestion-tray"]', { timeout: 4000 });
      await page.waitForTimeout(220);

      const slashTrayGeom = await page.evaluate(() => {
        const tray = document.querySelector('[data-testid="note-docked-suggestion-tray"]');
        const toolbar = document.querySelector('[data-testid="note-editor-toolbar"]');
        const toastEl = document.querySelector('[data-sonner-toast]');
        const statusSpan = document.querySelector('[data-testid="note-editor-topbar"] span.truncate');
        const tr = tray?.getBoundingClientRect();
        const tbr = toolbar?.getBoundingClientRect();
        const toastr = toastEl?.getBoundingClientRect();
        const toastOverlapsTrayOrToolbar = Boolean(
          toastr &&
            ((tr && toastr.top < tr.bottom && toastr.bottom > tr.top) ||
              (tbr && toastr.top < tbr.bottom && toastr.bottom > tbr.top))
        );
        return {
          text: tray?.innerText?.trim() || '',
          aboveToolbar: Boolean(tr && tbr && tr.bottom <= tbr.top + 3 && Math.abs(tr.bottom - tbr.top) <= 6),
          withinWidth: Boolean(tr && tr.left >= -1 && tr.right <= 361),
          toastOverlapsTrayOrToolbar,
          toastText: toastEl?.textContent?.trim() || null,
          topbarStatusClipped: Boolean(statusSpan && statusSpan.scrollWidth > statusSpan.clientWidth + 1),
          topbarStatusText: statusSpan?.textContent?.trim() || '',
        };
      });

      const editorIssues = await checkScreenHealth(page, 'm03-editor-photo-slash-compact');
      await snap(page, 'm03-editor-photo-slash-compact.png');

      record(
        'M03c_Editor_Toast_And_Topbar_360px',
        !slashTrayGeom.toastOverlapsTrayOrToolbar && !slashTrayGeom.topbarStatusClipped,
        !slashTrayGeom.toastOverlapsTrayOrToolbar && !slashTrayGeom.topbarStatusClipped
          ? 'No toast overlap on docked tray/toolbar and topbar status unclipped'
          : `toastOverlapsTrayOrToolbar=${slashTrayGeom.toastOverlapsTrayOrToolbar} (toast="${slashTrayGeom.toastText}"), topbarStatusClipped=${slashTrayGeom.topbarStatusClipped} (status="${slashTrayGeom.topbarStatusText}")`
      );

      // Wait for Sonner toast auto-dismiss (move mouse away so Sonner doesn't pause timer)
      await page.mouse.move(10, 10);
      await page.waitForSelector('[data-sonner-toast]', { state: 'detached', timeout: 5000 }).catch(() => {});

      // Now test `[[` wiki-link docked suggestion tray & pill insertion!
      await page.keyboard.press('Backspace');
      await page.keyboard.type('[[');
      await page.waitForTimeout(240);

      const wikiTrayCheck = await page.evaluate(() => {
        const tray = document.querySelector('[data-testid="note-docked-suggestion-tray"]');
        const btns = tray ? Array.from(tray.querySelectorAll('button')).map((b) => b.textContent?.trim()) : [];
        return {
          visible: Boolean(tray),
          isLinkMode: Boolean(tray?.innerText?.includes('Ссылка:')),
          suggestions: btns,
        };
      });

      let wikiPillRendered = false;
      if (wikiTrayCheck.suggestions.length > 0) {
        await page.locator('[data-testid="note-docked-suggestion-tray"] button').first().click();
        await page.waitForTimeout(220);
        wikiPillRendered = (await page.locator('[data-testid^="wiki-link-pill-"]').count()) > 0;
      }

      // Check IME-safe docked tray with simulated Android keyboard open
      await page.keyboard.type(' /');
      await page.setViewportSize({ width: 360, height: 440 });
      await page.evaluate(() => window.__kapsulaMobile.setKeyboardState({ visible: true, heightDp: 360 }));
      await page.waitForTimeout(240);
      const imeTrayCheck = await page.evaluate(() => {
        const topbar = document.querySelector('[data-testid="note-editor-topbar"]')?.getBoundingClientRect();
        const tray = document.querySelector('[data-testid="note-docked-suggestion-tray"]')?.getBoundingClientRect();
        const toolbar = document.querySelector('[data-testid="note-editor-toolbar"]')?.getBoundingClientRect();
        return {
          topbarPinned: Boolean(topbar && topbar.top >= -1 && topbar.top <= 2),
          trayVisible: Boolean(tray && tray.height >= 30 && tray.bottom <= 442),
          toolbarVisible: Boolean(toolbar && toolbar.bottom <= 442),
        };
      });
      await page.evaluate(() => window.__kapsulaMobile.setKeyboardState({ visible: false, heightDp: 0 }));
      await page.setViewportSize({ width: 360, height: 800 });
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(750);

      const okEditor =
        templatesCount === 4 &&
        afterTpl.templatesHidden &&
        afterTpl.historyBtnVisible &&
        inlineImgCheck.imgRendered &&
        inlineImgCheck.srcIsBlob &&
        inlineImgCheck.bodyHasKapsulaMedia &&
        slashTrayGeom.aboveToolbar &&
        slashTrayGeom.withinWidth &&
        slashTrayGeom.text.includes('Команда:') &&
        wikiTrayCheck.isLinkMode &&
        wikiPillRendered &&
        imeTrayCheck.topbarPinned &&
        imeTrayCheck.trayVisible &&
        imeTrayCheck.toolbarVisible &&
        notesListIssues.length === 0 &&
        editorIssues.length === 0;

      record(
        'M03_Editor_Photo_Slash_Wiki_Templates',
        okEditor,
        okEditor
          ? `4 templates, inline kapsula-media:// photo rendered (w=${inlineImgCheck.naturalWidth}px), IME-safe / and [[ trays + wiki pill OK`
          : `tpl=${templatesCount} afterTpl=${JSON.stringify(afterTpl)} img=${JSON.stringify(inlineImgCheck)} slash=${JSON.stringify(slashTrayGeom)} wiki=${JSON.stringify(wikiTrayCheck)} pill=${wikiPillRendered} ime=${JSON.stringify(imeTrayCheck)} issues=${JSON.stringify([...notesListIssues, ...editorIssues])}`
      );

      // Open «История версий» sheet and verify diff preview!
      await page.click('[data-testid="note-editor-history-btn"]');
      await page.waitForSelector('[data-testid="mobile-revision-history-sheet"]', { timeout: 5000 });
      await page.waitForTimeout(260);

      const revCheck = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="mobile-revision-history-sheet"]');
        const restoreBtn = document.querySelector('[data-testid="revision-restore-btn"]');
        const text = sheet?.innerText || '';
        return {
          hasDiffHeader: text.toLowerCase().includes('отличия от текущей версии'),
          hasDiffMarkers: text.includes('+ ') || text.includes('− '),
          hasRestoreBtn: Boolean(restoreBtn),
        };
      });
      const revIssues = await checkScreenHealth(page, 'm03b-editor-revisions-compact');
      await snap(page, 'm03b-editor-revisions-compact.png');

      const okRev = revCheck.hasDiffHeader && revCheck.hasDiffMarkers && revCheck.hasRestoreBtn && revIssues.length === 0;
      record(
        'M03b_Editor_Revisions_Diff',
        okRev,
        okRev
          ? 'Revision History sheet opened with timeline pills, +/- diff preview, and Restore button'
          : `rev=${JSON.stringify(revCheck)} issues=${JSON.stringify(revIssues)}`
      );

      // Close Revision sheet & exit editor
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.click('[data-testid="note-editor-back"]');
      await page.waitForTimeout(220);
    } catch (e) {
      record('M03_Editor_Suite', false, e.message);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(150);
      if (await page.isVisible('[data-testid="note-editor-back"]').catch(() => false)) {
        await page.click('[data-testid="note-editor-back"]').catch(() => {});
        await page.waitForTimeout(200);
      }
    }

    // =========================================================================
    // SCENARIO 4: Untranscribed Voice Note -> «Расшифровать через ИИ» visible & «Причесать текст» hidden!
    // =========================================================================
    try {
      const wavBytes = buildMinimalWavBytes(1, 8000);
      const voiceId = await page.evaluate(async (bytesArr) => {
        const store = window.__kapsulaMobile.store;
        await store.saveMediaFile('voice-audit-sample.wav', 'audio/wav', new Uint8Array(bytesArr));
        const item = await store.createItem({
          dna: 'voice',
          title: 'Голосовая заметка (00:18)',
          body: '',
          mediaPath: 'voice-audit-sample.wav',
          mediaType: 'audio/wav',
          mediaDurationSec: 18,
          mediaMeta: {
            waveformPeaks: [0.22, 0.48, 0.78, 0.42, 0.85, 0.61, 0.36, 0.74, 0.88, 0.55, 0.4, 0.69, 0.52, 0.3],
          },
        });
        window.__kapsulaMobile.refresh();
        return item.id;
      }, wavBytes);

      await page.click('[data-testid="nav-tab-feed"]');
      await page.waitForSelector(`[data-testid="feed-card-${voiceId}"]`);
      await page.waitForTimeout(260);

      const feedVoiceCheck = await page.evaluate((vid) => {
        const card = document.querySelector(`[data-testid="feed-card-${vid}"]`);
        const btn = card?.querySelector('[data-testid="mobile-voice-transcribe-btn"]');
        const txt = btn?.textContent?.trim() || '';
        return {
          hasTranscribeOnCard: Boolean(btn && (txt.includes('Расшифровать через ИИ') || txt.includes('Расшифровать ИИ'))),
          cardBtnText: txt,
          hasPolishLeak: Boolean(card?.innerText?.includes('Причесать')),
        };
      }, voiceId);

      // Open voice note in editor (click title h3 so we don't hit MobileAudioPlayer's stopPropagation wrapper)
      await page.click(`[data-testid="feed-card-${voiceId}"] h3`);
      await page.waitForTimeout(240);
      await page.locator('button', { hasText: 'Открыть в редакторе' }).click();
      await page.waitForSelector('[data-testid="mobile-note-editor"]');
      await page.waitForTimeout(260);

      const editorVoiceCheck = await page.evaluate(() => {
        const transcribeBtn = document.querySelector('[data-testid="mobile-voice-transcribe-btn"]');
        const polishBtn = document.querySelector('[data-testid="note-editor-polish-btn"]');
        const extractBtn = document.querySelector('[data-testid="mobile-voice-extract-tasks-btn"]');
        return {
          transcribeVisible: Boolean(transcribeBtn && transcribeBtn.textContent?.includes('Расшифровать через ИИ')),
          polishHidden: !polishBtn,
          extractHiddenWhenEmpty: !extractBtn,
        };
      });
      const voiceIssues = await checkScreenHealth(page, 'm04-voice-ai-compact');
      await snap(page, 'm04-voice-ai-compact.png');

      await page.click('[data-testid="note-editor-back"]');
      await page.waitForTimeout(200);

      const okVoice =
        feedVoiceCheck.hasTranscribeOnCard &&
        !feedVoiceCheck.hasPolishLeak &&
        editorVoiceCheck.transcribeVisible &&
        editorVoiceCheck.polishHidden &&
        editorVoiceCheck.extractHiddenWhenEmpty &&
        voiceIssues.length === 0;

      record(
        'M04_Voice_AI_Untranscribed',
        okVoice,
        okVoice
          ? 'Untranscribed voice note shows «Расшифровать через ИИ» in Feed & Editor, hides «Причесать текст» & «Выделить задачи» when empty'
          : `feed=${JSON.stringify(feedVoiceCheck)} editor=${JSON.stringify(editorVoiceCheck)} issues=${JSON.stringify(voiceIssues)}`
      );
    } catch (e) {
      record('M04_Voice_AI_Untranscribed', false, e.message);
    }

    // =========================================================================
    // SCENARIO 5: Vault (Biometric unlock transition, TOTP 2FA + Ring, Universal Placeholder, Master PIN)
    // =========================================================================
    // 5A: Test REAL locked -> unlocked biometric transition in clean context
    let vaultUnlockTransitionPassed = false;
    {
      const ctxVaultTest = await browser.newContext({
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2,
        locale: 'ru-RU',
      });
      const vPage = await ctxVaultTest.newPage();
      const vErrs = attachErrorListeners(vPage, 'vault-unlock-transition');
      try {
        await vPage.goto(baseUrl, { waitUntil: 'networkidle' });
        await vPage.waitForSelector('[data-testid="kapsula-mobile-root"]');
        await vPage.evaluate(async () => {
          await window.__kapsulaMobile.store.setSyncState('pref_onboarded', '1');
          window.__kapsulaMobile.refresh();
        });
        await vPage.reload({ waitUntil: 'networkidle' });
        await vPage.waitForSelector('[data-testid="kapsula-mobile-root"]');
        await vPage.click('[data-testid="nav-tab-vault"]');
        await vPage.waitForSelector('[data-testid="mobile-vault-locked"]');
        const lockedIssues = await checkScreenHealth(vPage, 'compact-vault-locked');
        await vPage.click('[data-testid="vault-biometric-unlock-btn"]');
        await vPage.waitForTimeout(450);
        const unlocked = await vPage.isVisible('[data-testid="mobile-vault-view"]');
        // Also test unlocked -> locked transition (verifies zero React #300 crash!)
        let relocked = false;
        if (unlocked) {
          await vPage.click('[data-testid="vault-lock-btn"]');
          await vPage.waitForTimeout(350);
          relocked = await vPage.isVisible('[data-testid="mobile-vault-locked"]');
        }
        vaultUnlockTransitionPassed = unlocked && relocked && vErrs.length === 0 && lockedIssues.length === 0;
        record(
          'M05a_Vault_Biometric_Unlock_Transition',
          vaultUnlockTransitionPassed,
          vaultUnlockTransitionPassed
            ? 'Vault transitioned cleanly locked -> unlocked -> locked with 0 errors'
            : `Vault lock/unlock failed! unlocked=${unlocked} relocked=${relocked} errors=${JSON.stringify(vErrs)} issues=${JSON.stringify(lockedIssues)}`
        );
      } catch (e) {
        record('M05a_Vault_Biometric_Unlock_Transition', false, `${e.message} errors=${JSON.stringify(vErrs)}`);
      } finally {
        await ctxVaultTest.close();
      }
    }

    // 5B: Unlocked Vault TOTP 2FA + Countdown Ring + Universal Placeholder (NO «Тинькофф»)
    // Use clean context (if 5A failed due to hook-order crash on transition, start unlocked via pref_biometric_vault=0 so we still audit unlocked Vault thoroughly!)
    {
      const ctxVaultUi = await browser.newContext({
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2,
        locale: 'ru-RU',
      });
      const uPage = await ctxVaultUi.newPage();
      const uErrs = attachErrorListeners(uPage, 'vault-totp-ui');
      try {
        await uPage.goto(baseUrl, { waitUntil: 'networkidle' });
        await uPage.waitForSelector('[data-testid="kapsula-mobile-root"]');
        await uPage.evaluate(async (needDirectUnlock) => {
          await window.__kapsulaMobile.store.setSyncState('pref_onboarded', '1');
          if (needDirectUnlock) {
            await window.__kapsulaMobile.store.setSyncState('pref_biometric_vault', '0');
          }
          window.__kapsulaMobile.refresh();
        }, !vaultUnlockTransitionPassed);
        await uPage.reload({ waitUntil: 'networkidle' });
        await uPage.waitForSelector('[data-testid="kapsula-mobile-root"]');
        await uPage.click('[data-testid="nav-tab-vault"]');
        if (vaultUnlockTransitionPassed) {
          await uPage.waitForSelector('[data-testid="mobile-vault-locked"]');
          await uPage.click('[data-testid="vault-biometric-unlock-btn"]');
        }
        await uPage.waitForSelector('[data-testid="mobile-vault-view"]', { timeout: 5000 });
        await uPage.waitForTimeout(200);

        // Open create form & inspect universal bank card placeholder (NO «Тинькофф»!)
        await uPage.click('[data-testid="vault-add-btn"]');
        await uPage.waitForSelector('[data-testid="vault-secret-title-input"]');
        const cardPlaceholder = await uPage.getAttribute('[data-testid="vault-secret-title-input"]', 'placeholder');
        const placeholderUniversal = Boolean(
          cardPlaceholder &&
            cardPlaceholder.includes('Банковская карта') &&
            !/тинькофф/i.test(cardPlaceholder)
        );

        // Switch to Пароль and add secret with otpauth:// TOTP URI
        await uPage.locator('form button', { hasText: 'Пароль' }).click();
        await uPage.fill('[data-testid="vault-secret-title-input"]', 'Рабочий аккаунт Kapsula');
        await uPage.locator('input[placeholder*="Логин"]').fill('user@example.com');
        await uPage.locator('textarea[placeholder="Пароль"]').fill('SuperStrong#2026');
        await uPage.fill(
          '[data-testid="vault-secret-totp-input"]',
          'otpauth://totp/Kapsula:user@example.com?secret=JBSWY3DPEHPK3PXP'
        );
        await uPage.waitForTimeout(200);

        const formTotpPreview = await uPage.evaluate(() => {
          const text = document.body.innerText;
          const m = /(?:Код 2FA|2FA-код) сейчас:\s*(\d{3}\s\d{3})\s*·\s*(\d+)\s*с/.exec(text);
          return { matched: Boolean(m), code: m?.[1] || null, sec: m?.[2] ? Number(m[2]) : null };
        });

        await uPage.locator('button[type="submit"]', { hasText: 'Сохранить в Сейф' }).click();
        await uPage.waitForTimeout(300);
        // Saving a secret selects it (opening Detail BottomSheet on compact); dismiss detail sheet to inspect card + TOTP row + wipe banner
        await uPage.keyboard.press('Escape');
        await uPage.waitForSelector('[data-testid^="mobile-totp-row-"]', { timeout: 5000 });
        await uPage.waitForTimeout(250);

        const totpCardCheck = await uPage.evaluate(() => {
          const row = document.querySelector('[data-testid^="mobile-totp-row-"]');
          const svg = row?.querySelector('svg');
          const circles = svg?.querySelectorAll('circle')?.length ?? 0;
          const secText = svg?.querySelector('text')?.textContent?.trim() || '';
          const codeMatch = /\b(\d{3}\s\d{3})\b/.exec(row?.innerText || '');
          return {
            hasRow: Boolean(row),
            code: codeMatch?.[1] || null,
            hasSvgRing: circles >= 2,
            countdownSec: Number(secText) || 0,
          };
        });

        // Click copy 2FA to verify live clipboard wipe banner
        await uPage.locator('[data-testid^="mobile-copy-totp-"]').first().click();
        await uPage.waitForTimeout(250);
        const wipeBarVisible = await uPage.evaluate(() => document.body.innerText.includes('в буфере обмена'));

        const vaultIssues = await checkScreenHealth(uPage, 'm05-vault-totp-pin-compact');
        await snap(uPage, 'm05-vault-totp-pin-compact.png');

        // Also inspect Light Theme contrast of TotpRing inside Detail Pane!
        await uPage.locator('[data-testid^="mobile-secret-card-"] .font-semibold').first().click();
        await uPage.waitForTimeout(300);
        await uPage.evaluate(() => {
          document.documentElement.setAttribute('data-theme', 'light');
          document.documentElement.style.setProperty('--k-bg-surface-2', '#f2f2f6');
          document.documentElement.style.setProperty('--k-ink-primary', '#151519');
        });
        const lightRingContrast = await uPage.evaluate(() => {
          const svgs = Array.from(document.querySelectorAll('svg'));
          const detailRing = svgs.find((s) => s.getAttribute('width') === '32');
          const txt = detailRing?.querySelector('text');
          const computedFill = txt ? getComputedStyle(txt).fill : '';
          const attrFill = txt?.getAttribute('fill') || '';
          return { attrFill, computedFill, hasDetailRing: Boolean(detailRing) };
        });

        const parsedRingRgb = parseRgb(lightRingContrast.computedFill) || parseHexToRgb(lightRingContrast.attrFill);
        const ringCr = parsedRingRgb ? contrastRatioRgb(parsedRingRgb, { r: 242, g: 242, b: 246 }) : 0;
        const ringContrastOk = !lightRingContrast.hasDetailRing || ringCr >= 4.5;

        const okTotp =
          placeholderUniversal &&
          formTotpPreview.matched &&
          totpCardCheck.hasRow &&
          Boolean(totpCardCheck.code) &&
          totpCardCheck.hasSvgRing &&
          totpCardCheck.countdownSec >= 1 &&
          totpCardCheck.countdownSec <= 30 &&
          wipeBarVisible &&
          vaultIssues.length === 0 &&
          uErrs.length === 0;

        record(
          'M05b_Vault_TOTP_And_Placeholder',
          okTotp,
          okTotp
            ? `Universal placeholder OK («${cardPlaceholder}»), live 6-digit TOTP (${totpCardCheck.code}, ${totpCardCheck.countdownSec}s) + SVG ring + wipe bar OK${!vaultUnlockTransitionPassed ? ' (audited via direct-unlocked fallback due to M05a P0 crash)' : ''}`
            : `placeholder=${cardPlaceholder} preview=${JSON.stringify(formTotpPreview)} card=${JSON.stringify(totpCardCheck)} wipe=${wipeBarVisible} issues=${JSON.stringify(vaultIssues)} errs=${JSON.stringify(uErrs)}`
        );

        record(
          'M05d_Vault_Detail_TotpRing_LightTheme_Contrast',
          ringContrastOk,
          ringContrastOk
            ? `Detail TotpRing light-theme contrast OK (${ringCr.toFixed(2)}:1 >= 4.5, fill=${lightRingContrast.computedFill})`
            : `Detail TotpRing text fill='${lightRingContrast.computedFill || lightRingContrast.attrFill}' low contrast on light-theme surface #f2f2f6 (${ringCr.toFixed(2)}:1 < 4.5)`
        );
      } catch (e) {
        record('M05b_Vault_TOTP_And_Placeholder', false, `${e.message} errs=${JSON.stringify(uErrs)}`);
      } finally {
        await ctxVaultUi.close();
      }
    }

    // 5C: Master PIN Setup in Settings + Wrong PIN Rejection + Correct PIN Unlock
    {
      const ctxPin = await browser.newContext({
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2,
        locale: 'ru-RU',
      });
      const pPage = await ctxPin.newPage();
      const pErrs = attachErrorListeners(pPage, 'vault-master-pin');
      try {
        await pPage.goto(baseUrl, { waitUntil: 'networkidle' });
        await pPage.waitForSelector('[data-testid="kapsula-mobile-root"]');
        await pPage.evaluate(async () => {
          await window.__kapsulaMobile.store.setSyncState('pref_onboarded', '1');
          window.__kapsulaMobile.refresh();
        });
        await pPage.reload({ waitUntil: 'networkidle' });
        await pPage.waitForSelector('[data-testid="kapsula-mobile-root"]');

        // Open Settings -> Вид и Сейф -> Set Master PIN
        await pPage.click('[data-testid="header-cloud-btn"]');
        await pPage.waitForSelector('[data-testid="settings-cloud-sheet"]');
        await pPage.click('[data-testid="settings-tab-appearance"]');
        await pPage.waitForTimeout(200);
        await pPage.click('[data-testid="settings-master-pin-toggle"]');
        await pPage.locator('input[placeholder*="Новый мастер-ПИН"]').fill('2580');
        await pPage.locator('input[placeholder="Повтори мастер-ПИН"]').fill('2580');
        await pPage.locator('button[type="submit"]', { hasText: 'Сохранить ПИН' }).click();
        await pPage.waitForTimeout(300);

        const pinSetActive = await pPage.evaluate(() => ({
          hasPinInStore: window.__kapsulaMobile.store.hasMasterPin(),
          uiShowsActive: document.body.innerText.includes('Активен · резервный вход без биометрии'),
        }));

        await pPage.keyboard.press('Escape');
        await pPage.waitForTimeout(200);

        // Open Vault -> Switch to Master PIN -> test wrong PIN -> test right PIN
        await pPage.click('[data-testid="nav-tab-vault"]');
        await pPage.waitForSelector('[data-testid="mobile-vault-locked"]');
        await pPage.waitForSelector('[data-testid="vault-switch-to-pin-btn"]');
        await pPage.click('[data-testid="vault-switch-to-pin-btn"]');
        await pPage.waitForSelector('[data-testid="vault-pin-input"]');
        const pinUiIssues = await checkScreenHealth(pPage, 'compact-vault-pin-screen');

        // Wrong PIN
        await pPage.fill('[data-testid="vault-pin-input"]', '9999');
        await pPage.click('[data-testid="vault-pin-unlock-btn"]');
        await pPage.waitForTimeout(450);
        const wrongPinRejected = await pPage.evaluate(() => ({
          stillLocked: Boolean(document.querySelector('[data-testid="mobile-vault-locked"]')),
          hasErrMsg: document.body.innerText.includes('Неверный'),
        }));

        // Right PIN
        await pPage.fill('[data-testid="vault-pin-input"]', '2580');
        await pPage.click('[data-testid="vault-pin-unlock-btn"]');
        await pPage.waitForTimeout(600);
        const rightPinUnlocked = await pPage.isVisible('[data-testid="mobile-vault-view"]');

        const okPin =
          pinSetActive.hasPinInStore &&
          pinSetActive.uiShowsActive &&
          wrongPinRejected.stillLocked &&
          wrongPinRejected.hasErrMsg &&
          rightPinUnlocked &&
          pinUiIssues.length === 0 &&
          pErrs.length === 0;

        record(
          'M05c_Vault_Master_PIN_Flow',
          okPin,
          okPin
            ? 'Master PIN setup, wrong-PIN rejection, and right-PIN unlock all passed cleanly'
            : `setup=${JSON.stringify(pinSetActive)} wrongPin=${JSON.stringify(wrongPinRejected)} rightUnlocked=${rightPinUnlocked} issues=${JSON.stringify(pinUiIssues)} errs=${JSON.stringify(pErrs)}`
        );
      } catch (e) {
        record('M05c_Vault_Master_PIN_Flow', false, `${e.message} errs=${JSON.stringify(pErrs)}`);
      } finally {
        await ctxPin.close();
      }
    }

    // =========================================================================
    // SCENARIO 6: Settings Colors/Custom BG, Dock & Scrim Blend, theme-color, Trash Restore/Purge, AI Key, Reconcile, Fold Expanded
    // =========================================================================
    try {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.click('[data-testid="nav-tab-feed"]');
      await page.waitForTimeout(220);

      // Seed 2 items & soft-delete them so Trash has 2 items (1 to restore, 1 to purge permanently!)
      const trashSeed = await page.evaluate(async () => {
        const store = window.__kapsulaMobile.store;
        const a = await store.createItem({ dna: 'note', title: 'Запись для восстановления', body: 'Проверка восстановления из корзины' });
        const b = await store.createItem({ dna: 'note', title: 'Запись для полного удаления', body: 'Будет удалена навсегда' });
        await store.deleteItem(a.id);
        await store.deleteItem(b.id);
        window.__kapsulaMobile.refresh();
        return { restoreId: a.id, purgeId: b.id };
      });

      // Capture baseline dock / scrim / theme-color before customization
      const beforeColors = await page.evaluate(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        const nav = document.querySelector('[data-testid="fold-bottom-nav"]');
        const scrim = nav?.parentElement?.previousElementSibling;
        return {
          themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
          canvas: cs.getPropertyValue('--k-bg-canvas').trim(),
          accent: cs.getPropertyValue('--k-accent').trim(),
          dockBg: nav ? getComputedStyle(nav).backgroundColor : null,
          scrimBg: scrim ? getComputedStyle(scrim).backgroundImage : null,
        };
      });

      // Open Settings -> Вид и Сейф
      await page.click('[data-testid="header-cloud-btn"]');
      await page.waitForSelector('[data-testid="settings-cloud-sheet"]');
      await page.click('[data-testid="settings-tab-appearance"]');
      await page.waitForTimeout(240);

      // Adjust Accent Hue slider (e.g., 195 deg cyan-teal)
      const accentHueSlider = page.locator('input[aria-label="Оттенок акцента"]');
      await setRangeValue(page, accentHueSlider, 195);
      await page.waitForTimeout(180);

      // Pick Pine bg preset AND open fine-tuning sliders to customize BG hue/tint/lightness
      await page.click('[data-testid="bg-preset-pine"]');
      await page.waitForTimeout(160);
      await page.locator('button', { hasText: 'Тонкая настройка' }).click();
      await page.waitForTimeout(180);

      const bgSliders = page.locator('[data-testid="settings-cloud-sheet"] input[type="range"]');
      // Slider index 0 = Accent Hue, 1 = Bg Hue, 2 = Bg Tint, 3 = Bg Lightness
      await setRangeValue(page, bgSliders.nth(1), 152);
      await setRangeValue(page, bgSliders.nth(2), 92);
      await setRangeValue(page, bgSliders.nth(3), 75);
      await page.waitForTimeout(220);

      // Measure visual geometry of sliders & preset pills on 360px (catch tiny/truncated controls!)
      const appearanceLayoutAudit = await page.evaluate(() => {
        const sliders = Array.from(document.querySelectorAll('[data-testid="settings-cloud-sheet"] input[type="range"]')).map((el, idx) => {
          const r = el.getBoundingClientRect();
          const pr = el.parentElement?.getBoundingClientRect();
          return {
            idx,
            cls: el.className,
            width: Math.round(r.width),
            parentWidth: pr ? Math.round(pr.width) : 0,
            fillRatio: pr && pr.width > 0 ? Number((r.width / pr.width).toFixed(2)) : 0,
          };
        });
        const bgClips = Array.from(document.querySelectorAll('[data-testid^="bg-preset-"]')).map((btn) => {
          const sp = btn.querySelector('span:last-child');
          return {
            id: btn.getAttribute('data-testid'),
            text: sp?.textContent?.trim(),
            clipped: Boolean(sp && sp.scrollWidth > sp.clientWidth + 1),
          };
        });
        const accentClips = Array.from(document.querySelectorAll('[data-testid^="accent-preset-"]')).map((btn) => {
          const sp = btn.querySelector('span:last-child');
          return {
            id: btn.getAttribute('data-testid'),
            text: sp?.textContent?.trim(),
            clipped: Boolean(sp && sp.scrollWidth > sp.clientWidth + 1),
          };
        });
        return { sliders, bgClips: bgClips.filter((x) => x.clipped), accentClips: accentClips.filter((x) => x.clipped) };
      });

      // Scroll slightly inside settings sheet to frame Accent Hue + Background Presets + Sliders
      await page.evaluate(() => {
        const scrollEl = document.querySelector('[data-testid="settings-cloud-sheet"]')?.closest('.k-scroll');
        if (scrollEl) scrollEl.scrollTop = 140;
      });
      await page.waitForTimeout(180);
      const settingsAppIssues = await checkScreenHealth(page, 'm06-settings-colors-custom-compact');
      await snap(page, 'm06-settings-colors-custom-compact.png');

      // Test AI key settings (scroll down to AI form)
      await page.locator('[data-testid="settings-cloud-sheet"] button', { hasText: 'Gemini' }).click();
      await page.waitForSelector('[data-testid="settings-ai-key-input"]');
      await page.fill('[data-testid="settings-ai-key-input"]', 'AIzaSyMockMobileVerifyKey00001');
      await page.locator('button[type="submit"]', { hasText: 'Сохранить настройки ИИ' }).click();
      await page.waitForTimeout(260);
      const aiKeySaved = await page.evaluate(() => {
        const cfg = window.__kapsulaMobile.store.getMobileAiConfig();
        return { provider: cfg.provider, hasGoogleKey: cfg.hasGoogleKey, badgeVisible: document.body.innerText.includes('Ключ сохранён') };
      });

      // Switch to Разделы tab -> test Trash (Restore & Purge Permanently!)
      await page.click('[data-testid="settings-tab-structure"]');
      await page.waitForSelector('[data-testid="settings-trash-section"]');
      await page.waitForTimeout(200);
      const structIssues = await checkScreenHealth(page, 'compact-settings-structure-trash');

      const trashBeforeVisible = await page.evaluate(
        ({ rId, pId }) => ({
          hasRestoreRow: Boolean(document.querySelector(`[data-testid="trash-item-${rId}"]`)),
          hasPurgeRow: Boolean(document.querySelector(`[data-testid="trash-item-${pId}"]`)),
        }),
        { rId: trashSeed.restoreId, pId: trashSeed.purgeId }
      );

      // Restore item 1
      await page.locator(`[data-testid="trash-item-${trashSeed.restoreId}"] button[aria-label="Восстановить"]`).click();
      await page.waitForTimeout(240);
      // Purge item 2 permanently
      await page.locator(`[data-testid="trash-item-${trashSeed.purgeId}"] button[aria-label="Удалить навсегда"]`).click();
      await page.waitForTimeout(240);

      const trashAfter = await page.evaluate(
        ({ rId, pId }) => {
          const store = window.__kapsulaMobile.store;
          const rawPurged = store.getRawItem(pId);
          return {
            restoredActive: Boolean(store.getItemById(rId)),
            purgedGoneFromActive: store.getItemById(pId) === null,
            purgedGoneFromTrash: !store.listTrashedItems().some((i) => i.id === pId),
            purgedFlaggedAndScrubbed: Boolean(rawPurged?.purgedAt && rawPurged.title === '' && rawPurged.body === ''),
          };
        },
        { rId: trashSeed.restoreId, pId: trashSeed.purgeId }
      );

      // Check Cloud tab: no 'Supabase' leak + verify «Полная сверка синхронизации» UI & method
      await page.click('[data-testid="settings-tab-cloud"]');
      await page.waitForTimeout(200);
      await page.locator('button', { hasText: 'Свой сервер облака' }).click();
      await page.waitForTimeout(180);
      const cloudSignedOutIssues = await checkScreenHealth(page, 'compact-settings-cloud-signedout');

      // Temporarily inspect connected Cloud Sync view to verify «Полная сверка синхронизации» renders cleanly without leaks
      const reconcileUiCheck = await page.evaluate(() => {
        const eng = window.__kapsulaMobile.syncEngine;
        const hasMethod = typeof eng.reconcileFull === 'function';
        const prevState = eng.state;
        const prevEmail = eng.email;
        eng.state = 'synced';
        eng.email = 'demo@kapsula.app';
        eng.emitStatus();
        return { hasMethod, prevState, prevEmail };
      });
      await page.waitForTimeout(200);
      const reconcileBtnVisible = await page.isVisible('[data-testid="cloud-reconcile-full-btn"]');
      const reconcileBtnText = reconcileBtnVisible
        ? (await page.textContent('[data-testid="cloud-reconcile-full-btn"]'))?.trim()
        : '';
      const cloudConnectedIssues = await checkScreenHealth(page, 'compact-settings-cloud-connected');
      await page.evaluate(({ prevState, prevEmail }) => {
        const eng = window.__kapsulaMobile.syncEngine;
        eng.state = prevState;
        eng.email = prevEmail;
        eng.emitStatus();
      }, reconcileUiCheck);
      await page.waitForTimeout(160);

      // Close Settings and verify Dock (`--k-dock-bg`), Scrim (`--k-scrim-bottom`), & `<meta name="theme-color">` blend cleanly on Compact Feed!
      await page.keyboard.press('Escape');
      await page.waitForTimeout(260);

      const afterColors = await page.evaluate(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        const nav = document.querySelector('[data-testid="fold-bottom-nav"]');
        const scrim = nav?.parentElement?.previousElementSibling;
        return {
          dataAccent: root.getAttribute('data-accent'),
          themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
          canvas: cs.getPropertyValue('--k-bg-canvas').trim(),
          surface1: cs.getPropertyValue('--k-bg-surface-1').trim(),
          accent: cs.getPropertyValue('--k-accent').trim(),
          dockBg: nav ? getComputedStyle(nav).backgroundColor : null,
          scrimBg: scrim ? getComputedStyle(scrim).backgroundImage : null,
        };
      });

      const canvasRgb = parseHexToRgb(afterColors.canvas);
      const dockRgb = parseRgb(afterColors.dockBg);
      const dockBlendsWithCustomBg = Boolean(
        canvasRgb &&
          dockRgb &&
          afterColors.dockBg !== beforeColors.dockBg &&
          dockRgb.g > dockRgb.r // green-tinted pine custom background reflected in dock!
      );
      const scrimBlendsWithCustomBg = Boolean(
        afterColors.scrimBg &&
          afterColors.scrimBg !== beforeColors.scrimBg &&
          !afterColors.scrimBg.includes('rgb(14, 14, 17)')
      );
      const themeColorMatches =
        Boolean(afterColors.themeColor) &&
        afterColors.themeColor !== beforeColors.themeColor &&
        afterColors.themeColor.toLowerCase() === afterColors.canvas.toLowerCase();

      const customCompactFeedIssues = await checkScreenHealth(page, 'compact-feed-custom-theme');

      // Switch to Fold Expanded (840x900) and check custom theme + all main tabs for overflow & leaks!
      await page.setViewportSize({ width: 840, height: 900 });
      await page.waitForTimeout(300);
      await page.locator('[data-testid^="feed-card-"]').first().click();
      await page.waitForTimeout(280);
      const customFoldIssues = await checkScreenHealth(page, 'm06b-custom-theme-fold');
      // Check Voice Transcribe button vertical text clipping in 2-col Fold masonry!
      const voiceBtnClipFold = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="mobile-voice-transcribe-btn"]');
        if (!btn) return null;
        return {
          text: btn.textContent?.trim(),
          scrollH: btn.scrollHeight,
          clientH: btn.clientHeight,
          overflowY: btn.scrollHeight > btn.clientHeight + 2,
        };
      });
      await snap(page, 'm06b-custom-theme-fold.png');
      record(
        'M06d_Fold_Voice_Transcribe_Button_No_Vertical_Clip',
        !voiceBtnClipFold || !voiceBtnClipFold.overflowY,
        !voiceBtnClipFold || !voiceBtnClipFold.overflowY
          ? 'Voice transcribe button fits cleanly inside its height on Fold 2-col card'
          : `Voice transcribe button text wraps & overflows fixed height on Fold 2-col card! ${JSON.stringify(voiceBtnClipFold)}`
      );

      // Also check Calendar & Notes & Search at 840x900 and 360x800 for overflow & leaks
      const sweepIssues = [];
      for (const tab of ['notes', 'tasks', 'calendar']) {
        await page.click(`[data-testid="nav-tab-${tab}"]`);
        await page.waitForTimeout(200);
        sweepIssues.push(...(await checkScreenHealth(page, `fold-840-${tab}`)));
      }
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(240);
      await page.click('[data-testid="nav-tab-calendar"]');
      await page.waitForTimeout(200);
      sweepIssues.push(...(await checkScreenHealth(page, 'compact-360-calendar')));
      await page.click('[data-testid="mobile-search-toggle"]');
      await page.waitForSelector('[data-testid="mobile-search-overlay"]');
      await page.waitForTimeout(180);
      sweepIssues.push(...(await checkScreenHealth(page, 'compact-360-search-overlay')));
      await page.click('[data-testid="mobile-search-close"]');
      await page.waitForTimeout(180);

      const slidersFullWidth = appearanceLayoutAudit.sliders.every((s) => s.fillRatio >= 0.85);
      const noPresetClips =
        appearanceLayoutAudit.bgClips.length === 0 && appearanceLayoutAudit.accentClips.length === 0;

      const okColorsAndSettings =
        afterColors.dataAccent === 'custom' &&
        afterColors.accent !== beforeColors.accent &&
        themeColorMatches &&
        dockBlendsWithCustomBg &&
        scrimBlendsWithCustomBg &&
        aiKeySaved.provider === 'google_ai_studio' &&
        aiKeySaved.hasGoogleKey &&
        aiKeySaved.badgeVisible &&
        trashBeforeVisible.hasRestoreRow &&
        trashBeforeVisible.hasPurgeRow &&
        trashAfter.restoredActive &&
        trashAfter.purgedGoneFromActive &&
        trashAfter.purgedGoneFromTrash &&
        trashAfter.purgedFlaggedAndScrubbed &&
        reconcileUiCheck.hasMethod &&
        reconcileBtnVisible &&
        reconcileBtnText.includes('Сверка синхронизации') &&
        settingsAppIssues.length === 0 &&
        structIssues.length === 0 &&
        cloudSignedOutIssues.length === 0 &&
        cloudConnectedIssues.length === 0 &&
        customCompactFeedIssues.length === 0 &&
        customFoldIssues.length === 0 &&
        sweepIssues.length === 0;

      record(
        'M06_Settings_Colors_DockScrim_Trash_AI_Reconcile_Leaks',
        okColorsAndSettings,
        okColorsAndSettings
          ? `Custom accent (${afterColors.accent}) + custom bg (${afterColors.canvas}), <meta theme-color> updated, dock (${afterColors.dockBg}) & scrim blend seamlessly, AI key saved, Trash restore+purge OK, Reconcile button OK, 0 leaks & 0 overflows across 360x800 & 840x900`
          : `before=${JSON.stringify(beforeColors)} after=${JSON.stringify(afterColors)} dockBlend=${dockBlendsWithCustomBg} scrimBlend=${scrimBlendsWithCustomBg} themeMeta=${themeColorMatches} ai=${JSON.stringify(aiKeySaved)} trashBefore=${JSON.stringify(trashBeforeVisible)} trashAfter=${JSON.stringify(trashAfter)} reconcile=${reconcileBtnVisible}/${reconcileBtnText} issues=${JSON.stringify([...settingsAppIssues, ...structIssues, ...cloudSignedOutIssues, ...cloudConnectedIssues, ...customCompactFeedIssues, ...customFoldIssues, ...sweepIssues])}`
      );

      record(
        'M06c_Settings_Sliders_And_Presets_Layout_360px',
        slidersFullWidth && noPresetClips,
        slidersFullWidth && noPresetClips
          ? `All ${appearanceLayoutAudit.sliders.length} range sliders fill full width & 0 preset label clips`
          : `sliders=${JSON.stringify(appearanceLayoutAudit.sliders)} bgClips=${JSON.stringify(appearanceLayoutAudit.bgClips)} accentClips=${JSON.stringify(appearanceLayoutAudit.accentClips)}`
      );
    } catch (e) {
      record('M06_Settings_Colors_Suite', false, e.message);
    }

    await ctx1.close();

    // Summary & Exit Code
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log('\n==================== MOBILE V8 AUDIT SUMMARY ====================');
    console.log(`Passed: ${passed}/${results.length}, Failed: ${failed}`);
    console.log(`Page Errors: ${allPageErrors.length}, Console Errors: ${allConsoleErrors.length}`);
    if (allPageErrors.length > 0) console.log('PAGE ERRORS:\n' + allPageErrors.join('\n'));
    if (allConsoleErrors.length > 0) console.log('CONSOLE ERRORS:\n' + allConsoleErrors.join('\n'));
    console.log('SCREENSHOTS:\n' + capturedScreenshots.map((p) => ' - ' + p).join('\n'));

    if (failed > 0 || allPageErrors.length > 0 || allConsoleErrors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
