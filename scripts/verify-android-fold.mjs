import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DIST_DIR = path.resolve(ROOT, 'dist', 'mobile');
const OUT_DIR = path.resolve(ROOT, '.tmp', 'fold-verify');

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

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const res = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    selectCount: document.querySelectorAll('select').length,
  }));
  assert(
    res.scrollW <= res.clientW + 1,
    `Horizontal overflow on ${label}: scrollWidth=${res.scrollW} > clientWidth=${res.clientW}`
  );
  assert(
    res.selectCount === 0,
    `Found ${res.selectCount} raw native <select> element(s) on ${label}! Must use MobilePickerSheet.`
  );
}

async function simulateAndroidKeyboard(page, open, width = 360) {
  if (open) {
    await page.setViewportSize({ width, height: 440 });
    await page.evaluate(() => {
      window.__kapsulaMobile.setKeyboardState({ visible: true, heightDp: 360 });
    });
  } else {
    await page.evaluate(() => {
      window.__kapsulaMobile.setKeyboardState({ visible: false, heightDp: 0 });
    });
    await page.setViewportSize({ width, height: 800 });
  }
  await page.waitForTimeout(220);
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
  const errors = [];

  let browser;
  for (const ch of ['chrome', 'msedge', undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(ch ? { channel: ch } : {}) });
      break;
    } catch {
      // try next browser channel
    }
  }
  if (!browser) {
    throw new Error('Could not launch Chromium/Chrome/Edge for Fold visual verification');
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 }, // Narrow Samsung Galaxy Z Fold cover screen
      deviceScaleFactor: 2,
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`);
    });

    await page.goto(`${baseUrl}?lang=ru`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="kapsula-mobile-root"]');

    const sampleImgBytes = Array.from(fs.readFileSync(path.resolve(ROOT, 'build', 'icon.png')));

    // Seed rich realistic Russian vault data through store bridge
    const seededIds = await page.evaluate(async (pngArray) => {
      const api = window.__kapsulaMobile;
      const store = api.store;

      const orbGame = await store.createOrbit({ name: 'Геймдев', color: '#E86A33', icon: 'GameController' });
      const orbFin = await store.createOrbit({ name: 'Финансы', color: '#2EA06B', icon: 'Receipt' });
      const orbIdea = await store.createOrbit({ name: 'Идеи', color: '#3B82F6', icon: 'Lightbulb' });
      const board = await store.createBoard({ name: 'Релиз Fold', color: '#E86A33', icon: 'Sparkle' });

      await store.saveMediaFile('ui-ref.png', 'image/png', new Uint8Array(pngArray));

      const noteMain = await store.createItem({
        dna: 'note',
        title: 'Сценарии для Samsung Galaxy Z Fold',
        body: '## План проверки\n\n- [ ] Проверить узкий внешний экран одной рукой\n- [ ] Проверить раскрытие в 2 панели без потери текста\n- [x] Подключить сквозное шифрование Kapsula\n\nВажно, чтобы при открытии клавиатуры шапка редактора никогда не уезжала вверх.',
        orbit: orbGame.id,
        focusBoardId: board.id,
        tags: ['fold', 'android'],
        isPinned: true,
        remindAt: Date.now() + 3_600_000,
      });

      const linkItem = await store.createItem({
        dna: 'link',
        title: 'Шейдеры воды и частиц для мобильного билда',
        body: 'Подборка лёгких шейдеров с разбором производительности под Adreno и Mali.',
        url: 'https://t.me/gamedev_notes/412',
        orbit: orbGame.id,
        tags: ['шейдеры', 'telegram'],
      });

      await store.createItem({
        dna: 'shot',
        title: 'Референс тёмного UI и карточек',
        body: 'Хороший контраст карточек и мягкие отступы на узком экране.',
        imagePath: 'ui-ref.png',
        thumbPath: 'ui-ref.png',
        orbit: orbIdea.id,
        focusBoardId: board.id,
        tags: ['дизайн'],
      });

      await store.createItem({
        dna: 'voice',
        title: 'Голосовая идея по боёвке',
        body: 'Сделать быстрый рывок с отменой анимации и отдачей на контроллере.',
        mediaDurationSec: 47,
        mediaMeta: {
          waveformPeaks: [0.25, 0.55, 0.85, 0.45, 0.72, 0.9, 0.6, 0.35, 0.78, 0.64, 0.4, 0.82, 0.5, 0.3],
          actionItems: ['Проверить тайминг рывка на 60 FPS'],
          checkedActionIndices: [],
        },
        orbit: orbGame.id,
      });

      const card1 = await store.upsertSecret({
        kind: 'bank_card',
        title: 'Тинькофф Black',
        service: 'Тинькофф Black',
        secretValue: '5536913844229911',
        expiry: '08/29',
        cvv: '742',
        cardHolder: 'ALEXEY SMIRNOV',
        notes: 'Основная карта: кэшбэк 5% на рестораны и подписки, лимит 150к/мес',
        orbit: orbFin.id,
      });

      await store.upsertSecret({
        kind: 'bank_card',
        title: 'Альфа Travel',
        service: 'Альфа Travel',
        secretValue: '4276380012344821',
        expiry: '11/28',
        cvv: '905',
        cardHolder: 'ALEXEY SMIRNOV',
        notes: 'Для авиабилетов, отелей и поездок за границу',
        orbit: orbFin.id,
      });

      await store.upsertSecret({
        kind: 'password',
        title: 'GitHub Studio',
        service: 'github.com',
        login: 'alexey@kapsula.app',
        secretValue: 'Kapsula-Dev-Pass!2026',
        notes: 'Рабочий аккаунт с 2FA',
      });

      const todayStart = new Date();
      todayStart.setHours(14, 0, 0, 0);
      await store.upsertCalendarEvent({
        title: 'Созвон по релизу Android',
        notes: 'Проверить сборку APK на Fold',
        location: 'Telegram Call',
        startAt: todayStart.getTime(),
        endAt: todayStart.getTime() + 3_600_000,
        color: '#E86A33',
        kind: 'event',
      });

      const eve = new Date();
      eve.setHours(18, 30, 0, 0);
      await store.upsertCalendarEvent({
        title: 'Тренировка',
        notes: 'Силовая 60 мин',
        startAt: eve.getTime(),
        endAt: eve.getTime() + 3_600_000,
        color: '#2EA06B',
        recurrence: 'weekdays',
        kind: 'event',
      });

      const late = new Date();
      late.setHours(21, 0, 0, 0);
      await store.upsertCalendarEvent({
        title: 'Вечерний разбор задач',
        notes: 'Синхронизация планов на завтра',
        startAt: late.getTime(),
        endAt: late.getTime() + 1_800_000,
        color: '#3B82F6',
        kind: 'event',
      });

      api.refresh();
      return { noteMainId: noteMain.id, linkItemId: linkItem.id, card1Id: card1.id };
    }, sampleImgBytes);

    await page.waitForTimeout(300);

    // ==================== 1. NARROW COMPACT FOLD (360x800) ====================
    assert(
      (await page.getAttribute('[data-testid="kapsula-mobile-root"]', 'data-fold-mode')) === 'compact',
      'Expected compact fold mode at 360px'
    );
    assert(await page.isVisible('[data-testid="fold-bottom-nav"]'), 'Floating bottom dock must be visible');
    assert(await page.isVisible('[data-testid="compact-quick-capture-fab"]'), 'Paired + orb must be visible');
    assert(await page.isVisible('[data-testid="mobile-audio-player"]'), 'Voice card must show inline audio player');

    // Verify paired + orb aligns cleanly horizontally with floating dock (NOT floating above it over content!)
    const dockAlign = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="fold-bottom-nav"]')?.getBoundingClientRect();
      const orb = document.querySelector('[data-testid="compact-quick-capture-fab"]')?.getBoundingClientRect();
      if (!nav || !orb) return null;
      return { navTop: nav.top, orbTop: orb.top, diff: Math.abs(nav.top - orb.top), orbRight: orb.right };
    });
    assert(dockAlign && dockAlign.diff <= 8, `Paired + orb must align with floating dock! Got diff=${dockAlign?.diff}`);
    assert(dockAlign.orbRight <= 360, `Dock/Orb overflows 360px screen! right=${dockAlign.orbRight}`);

    const brokenImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).filter((img) => !img.complete || img.naturalWidth === 0).length
    );
    assert(brokenImgs === 0, `Detected ${brokenImgs} broken <img> elements on Feed!`);

    // Verify ALL 5 tabs fit inside the 360px floating bottom dock with ZERO text truncation!
    for (const tabId of ['feed', 'notes', 'tasks', 'calendar', 'vault']) {
      await page.click(`[data-testid="nav-tab-${tabId}"]`);
      await page.waitForTimeout(160);
      const labelCheck = await page.evaluate(() => {
        const lbl = document.querySelector('[data-testid="dock-active-label"]');
        const nav = document.querySelector('[data-testid="fold-bottom-nav"]');
        if (!lbl || !nav) return null;
        const lb = lbl.getBoundingClientRect();
        const nb = nav.getBoundingClientRect();
        return {
          text: lbl.textContent?.trim(),
          clipped: lbl.scrollWidth > lbl.clientWidth + 1,
          outsideNav: lb.right > nb.right + 1 || lb.left < nb.left - 1,
        };
      });
      assert(
        labelCheck && !labelCheck.clipped && !labelCheck.outsideNav,
        `Floating dock label clipped on tab ${tabId}: ${JSON.stringify(labelCheck)}`
      );
    }
    await page.click('[data-testid="nav-tab-feed"]');
    await page.waitForTimeout(180);

    await assertNoHorizontalOverflow(page, 'compact-feed');
    await page.screenshot({ path: path.join(OUT_DIR, '01-compact-feed-dark.png') });

    // Test Photo Lightbox on Feed
    await page.locator('[data-testid="feed-grid"] img').first().click();
    await page.waitForSelector('[data-testid="mobile-image-lightbox"]');
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(OUT_DIR, '02-compact-photo-lightbox.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);

    // Test Action Sheet & Delete + Bottom Undo Toast!
    await page.click(`[data-testid="feed-card-more-${seededIds.linkItemId}"]`);
    await page.waitForSelector('[data-testid="item-action-sheet"]');
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(OUT_DIR, '03-compact-action-sheet.png') });
    await page.click('[data-testid="action-sheet-delete"]');
    await page.waitForTimeout(350);

    const toastPos = await page.evaluate(() => {
      const header = document.querySelector('header')?.getBoundingClientRect();
      const toastEl = document.querySelector('[data-sonner-toast]')?.getBoundingClientRect();
      if (!toastEl) return null;
      return {
        toastTop: toastEl.top,
        toastBottom: toastEl.bottom,
        headerBottom: header?.bottom ?? 0,
        vh: window.innerHeight,
      };
    });
    assert(toastPos && toastPos.toastTop > toastPos.vh * 0.55, `Undo toast must be at BOTTOM of screen! Got top=${toastPos?.toastTop}`);

    // Click Undo ("Отменить") and verify link item is restored!
    await page.locator('[data-sonner-toast] button', { hasText: 'Отменить' }).click();
    await page.waitForTimeout(250);
    assert(
      await page.isVisible(`[data-testid="feed-card-${seededIds.linkItemId}"]`),
      'Undo toast button must restore deleted item!'
    );

    // ==================== 2. KEYBOARD TORTURE TESTS (360x440 + keyboardOpen=true) ====================
    // 2a. Quick Capture Sheet with Android keyboard open (must NOT collapse into 15% strip!)
    await page.click('[data-testid="compact-quick-capture-fab"]');
    await page.waitForSelector('[data-testid="quick-capture-sheet"]');
    await page.waitForTimeout(240);
    // Assert ALL 5 QuickCapture mode tabs fit cleanly on 360px with zero clipping!
    const captureModesFit = await page.evaluate(() => {
      const ids = ['text', 'voice', 'photo', 'file', 'secret'];
      return ids.map((id) => {
        const el = document.querySelector(`[data-testid="capture-tab-${id}"]`);
        const r = el?.getBoundingClientRect();
        return { id, ok: Boolean(r && r.left >= 0 && r.right <= 360 && r.width >= 48) };
      });
    });
    assert(
      captureModesFit.every((m) => m.ok),
      `QuickCapture 5-mode bar clipped on 360px: ${JSON.stringify(captureModesFit)}`
    );
    await page.screenshot({ path: path.join(OUT_DIR, '04-compact-capture-open.png') });

    // Test stacked MobilePickerSheet inside QuickCapture: Escape must ONLY close picker, NOT parent sheet!
    await page.click('[data-testid="capture-orbit-picker"]');
    await page.waitForSelector('[data-testid="picker-opt-none"]');
    await page.waitForTimeout(180);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    assert(
      await page.isVisible('[data-testid="quick-capture-sheet"]'),
      'Escape on nested MobilePickerSheet accidentally dismissed parent QuickCaptureSheet!'
    );

    await simulateAndroidKeyboard(page, true, 360);
    const captureKbCheck = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="quick-capture-sheet"]')?.closest('.k-drawer-popup');
      const textarea = document.querySelector('[data-testid="capture-text-input"]');
      const submitBtn = document.querySelector('[data-testid="capture-text-submit"]');
      const dock = document.querySelector('[data-testid="fold-bottom-nav"]');
      if (!sheet || !textarea || !submitBtn) return null;
      const sb = sheet.getBoundingClientRect();
      const tb = textarea.getBoundingClientRect();
      const btnb = submitBtn.getBoundingClientRect();
      return {
        sheetHeight: sb.height,
        sheetBottom: sb.bottom,
        textareaHeight: tb.height,
        submitBottom: btnb.bottom,
        dockVisible: Boolean(dock),
      };
    });
    assert(captureKbCheck && captureKbCheck.sheetHeight >= 260, `QuickCapture collapsed under keyboard! height=${captureKbCheck?.sheetHeight}`);
    assert(captureKbCheck.textareaHeight >= 60, `QuickCapture textarea clipped under keyboard! h=${captureKbCheck.textareaHeight}`);
    assert(captureKbCheck.submitBottom <= 442, `QuickCapture Submit button pushed below keyboard viewport! bottom=${captureKbCheck.submitBottom}`);
    assert(!captureKbCheck.dockVisible, 'Bottom dock must hide when keyboard is open!');
    await page.screenshot({ path: path.join(OUT_DIR, '05-compact-capture-keyboard.png') });
    await page.keyboard.press('Escape');
    await simulateAndroidKeyboard(page, false, 360);

    // 2b. Global Search Overlay with Android keyboard open (full height results, ZERO dock/FAB!)
    await page.click('[data-testid="mobile-search-toggle"]');
    await page.waitForSelector('[data-testid="mobile-search-overlay"]');
    await page.fill('[data-testid="mobile-search-input"]', 'шейдеры');
    await simulateAndroidKeyboard(page, true, 360);

    const searchKbCheck = await page.evaluate(() => {
      const results = document.querySelector('[data-testid="mobile-search-results"]')?.getBoundingClientRect();
      const dock = document.querySelector('[data-testid="fold-bottom-nav"]');
      const fab = document.querySelector('[data-testid="compact-quick-capture-fab"]');
      const hit = document.querySelector('[data-testid^="search-result-item-"]');
      return {
        resultsHeight: results?.height ?? 0,
        dockVisible: Boolean(dock),
        fabVisible: Boolean(fab),
        hasHit: Boolean(hit),
      };
    });
    assert(searchKbCheck.resultsHeight >= 250, `Search results area too small under keyboard! h=${searchKbCheck.resultsHeight}`);
    assert(!searchKbCheck.dockVisible && !searchKbCheck.fabVisible, 'Dock and FAB must be hidden during Search + Keyboard!');
    assert(searchKbCheck.hasHit, 'Search must display matching result above keyboard!');
    await page.screenshot({ path: path.join(OUT_DIR, '06-compact-search-keyboard.png') });
    await page.click('[data-testid="mobile-search-close"]');
    await simulateAndroidKeyboard(page, false, 360);

    // 2c. Notes: Deferred empty draft (New -> Back creates ZERO notes!) + Keyboard TopBar pin!
    await page.click('[data-testid="nav-tab-notes"]');
    await page.waitForSelector('[data-testid="mobile-notes-view"]');
    await page.waitForTimeout(200);
    await assertNoHorizontalOverflow(page, 'compact-notes-list');
    await page.screenshot({ path: path.join(OUT_DIR, '07-compact-notes-list.png') });

    const countBeforeEmptyNew = await page.evaluate(
      () => window.__kapsulaMobile.store.listItems({ includeSecrets: false }).length
    );
    await page.click('[data-testid="notes-create-btn"]');
    await page.waitForSelector('[data-testid="mobile-notes-fullscreen-editor"]');
    await page.waitForTimeout(160);
    await page.click('[data-testid="note-editor-back"]');
    await page.waitForTimeout(200);
    const countAfterEmptyBack = await page.evaluate(
      () => window.__kapsulaMobile.store.listItems({ includeSecrets: false }).length
    );
    assert(
      countAfterEmptyBack === countBeforeEmptyNew,
      `Empty New -> Back created a ghost note! before=${countBeforeEmptyNew}, after=${countAfterEmptyBack}`
    );

    // Open New Note again, type real content under open keyboard -> verify TopBar stays at y=0 and Undo/Redo toolbar visible!
    await page.click('[data-testid="notes-create-btn"]');
    await page.waitForSelector('[data-testid="mobile-notes-fullscreen-editor"]');
    await simulateAndroidKeyboard(page, true, 360);
    await page.fill('[data-testid="mobile-note-editor-title"]', 'Проверка редактора на Fold');
    await page.click('[data-testid="mobile-note-editor-body"]');
    await page.keyboard.type('Ввод русского текста с открытой клавиатурой без уезжания шапки.');
    await page.waitForTimeout(600);

    const editorKbCheck = await page.evaluate(() => {
      const topbar = document.querySelector('[data-testid="note-editor-topbar"]')?.getBoundingClientRect();
      const toolbar = document.querySelector('[data-testid="note-editor-toolbar"]')?.getBoundingClientRect();
      const undoBtn = document.querySelector('[data-testid="note-toolbar-undo"]');
      return {
        topbarTop: topbar?.top ?? -999,
        topbarBottom: topbar?.bottom ?? 0,
        toolbarBottom: toolbar?.bottom ?? 9999,
        hasUndo: Boolean(undoBtn),
        scrollY: window.scrollY,
      };
    });
    assert(editorKbCheck.topbarTop >= -1 && editorKbCheck.topbarTop <= 2, `Note editor topbar drifted off-screen! top=${editorKbCheck.topbarTop}`);
    assert(editorKbCheck.toolbarBottom <= 442, `Note editor formatting toolbar clipped below keyboard! bottom=${editorKbCheck.toolbarBottom}`);
    assert(editorKbCheck.hasUndo, 'Note editor must include Undo/Redo buttons!');
    assert(editorKbCheck.scrollY === 0, `Root window scrolled! scrollY=${editorKbCheck.scrollY}`);
    await page.screenshot({ path: path.join(OUT_DIR, '08-compact-note-editor-keyboard.png') });
    await page.click('[data-testid="note-editor-back"]');
    await simulateAndroidKeyboard(page, false, 360);

    const countAfterRealNote = await page.evaluate(
      () => window.__kapsulaMobile.store.listItems({ includeSecrets: false }).length
    );
    assert(
      countAfterRealNote === countBeforeEmptyNew + 1,
      `Real note should persist after typing! expected=${countBeforeEmptyNew + 1}, got=${countAfterRealNote}`
    );

    // ==================== 3. TASKS & COLLAPSIBLE CALENDAR ON COMPACT FOLD ====================
    await page.click('[data-testid="nav-tab-tasks"]');
    await page.waitForSelector('[data-testid="mobile-tasks-view"]');
    await page.waitForTimeout(200);
    await assertNoHorizontalOverflow(page, 'compact-tasks');
    await page.screenshot({ path: path.join(OUT_DIR, '09-compact-tasks.png') });

    await page.click('[data-testid="nav-tab-calendar"]');
    await page.waitForSelector('[data-testid="mobile-calendar-view"]');
    await page.waitForTimeout(220);
    await assertNoHorizontalOverflow(page, 'compact-calendar-week');

    const calWeekCheck = await page.evaluate(() => {
      const mode = document.querySelector('[data-testid="calendar-grid-pane"]')?.getAttribute('data-calendar-mode');
      const agenda = document.querySelector('[data-testid="calendar-agenda-scroll"]')?.getBoundingClientRect();
      return { mode, agendaHeight: agenda?.height ?? 0 };
    });
    assert(calWeekCheck.mode === 'week', `Compact calendar should start in week strip mode! got=${calWeekCheck.mode}`);
    assert(calWeekCheck.agendaHeight >= 340, `Compact calendar agenda too cramped! height=${calWeekCheck.agendaHeight}px`);
    await page.screenshot({ path: path.join(OUT_DIR, '10-compact-calendar-week.png') });

    // Expand Month Grid
    await page.click('[data-testid="calendar-mode-toggle"]');
    await page.waitForSelector('[data-testid="calendar-month-grid"]');
    await page.waitForTimeout(220);
    await assertNoHorizontalOverflow(page, 'compact-calendar-month');
    await page.screenshot({ path: path.join(OUT_DIR, '11-compact-calendar-month.png') });
    await page.click('[data-testid="calendar-mode-toggle"]');
    await page.waitForTimeout(200);

    // ==================== 4. VAULT (LOCKED -> UNLOCKED -> CARD COMMENT -> LIVE WIPE BAR) ====================
    await page.click('[data-testid="nav-tab-vault"]');
    await page.waitForSelector('[data-testid="mobile-vault-locked"]');
    await page.waitForTimeout(200);
    assert(!(await page.isVisible('[data-testid="compact-quick-capture-fab"]')), 'Paired + orb must hide on locked Vault');
    await page.screenshot({ path: path.join(OUT_DIR, '12-compact-vault-locked.png') });

    await page.click('[data-testid="vault-biometric-unlock-btn"]');
    await page.waitForSelector('[data-testid="mobile-vault-view"]');
    await page.waitForTimeout(220);
    const notesText = await page.textContent(`[data-testid="mobile-card-notes-${seededIds.card1Id}"]`);
    assert(notesText && notesText.includes('кэшбэк 5%'), 'Bank card encrypted comment must be visible on unlocked card');
    await page.click(`[data-testid="mobile-copy-pan-${seededIds.card1Id}"]`);
    await page.waitForTimeout(320);
    await assertNoHorizontalOverflow(page, 'compact-vault-unlocked');
    await page.screenshot({ path: path.join(OUT_DIR, '13-compact-vault-unlocked.png') });

    // ==================== 5. CLOUD AUTH KEYBOARD TEST & 6 ACCENT PRESETS ====================
    await page.click('[data-testid="header-cloud-btn"]');
    await page.waitForSelector('[data-testid="settings-cloud-sheet"]');
    await page.waitForTimeout(240);
    await simulateAndroidKeyboard(page, true, 360);
    const cloudKbCheck = await page.evaluate(() => {
      const emailEl = document.querySelector('[data-testid="cloud-email-input"]')?.getBoundingClientRect();
      const passEl = document.querySelector('[data-testid="cloud-password-input"]')?.getBoundingClientRect();
      const submitEl = document.querySelector('[data-testid="cloud-auth-submit"]')?.getBoundingClientRect();
      return {
        emailVisible: Boolean(emailEl && emailEl.height >= 36 && emailEl.bottom <= 440),
        passVisible: Boolean(passEl && passEl.height >= 36 && passEl.bottom <= 440),
        submitVisible: Boolean(submitEl && submitEl.height >= 40 && submitEl.bottom <= 442),
        passBottom: passEl?.bottom ?? 999,
        submitBottom: submitEl?.bottom ?? 999,
      };
    });
    assert(
      cloudKbCheck.emailVisible && cloudKbCheck.passVisible && cloudKbCheck.submitVisible,
      `Cloud auth email/password/submit must ALL fit inside 440px keyboard viewport! got=${JSON.stringify(cloudKbCheck)}`
    );
    await page.screenshot({ path: path.join(OUT_DIR, '14-compact-cloud-auth-keyboard.png') });
    await simulateAndroidKeyboard(page, false, 360);

    // Switch accent to Cobalt and verify CSS variable changed from terracotta!
    await page.click('[data-testid="settings-tab-appearance"]');
    await page.waitForTimeout(180);
    await page.click('[data-testid="accent-preset-cobalt"]');
    await page.waitForTimeout(180);
    const cobaltAccent = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-accent'),
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--k-accent').trim(),
    }));
    assert(cobaltAccent.attr === 'cobalt' && cobaltAccent.cssVar === '#4f86f7', `Cobalt accent did not apply! got=${JSON.stringify(cobaltAccent)}`);
    // Assert ZERO truncation on all 6 accent preset pills at 360px
    const accentClips = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('[data-testid^="accent-preset-"]'));
      return buttons
        .map((btn) => {
          const span = btn.querySelector('span:last-child');
          return span && span.scrollWidth > span.clientWidth + 1 ? span.textContent : null;
        })
        .filter(Boolean);
    });
    assert(accentClips.length === 0, `Accent preset labels truncated at 360px: ${accentClips.join(', ')}`);
    await page.screenshot({ path: path.join(OUT_DIR, '15-compact-settings-appearance-cobalt.png') });

    // Check Structure tab (Sections & Boards)
    await page.click('[data-testid="settings-tab-structure"]');
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(OUT_DIR, '16-compact-settings-structure.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);

    // Feed screenshot in Cobalt Dark
    await page.click('[data-testid="nav-tab-feed"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT_DIR, '17-compact-feed-cobalt-dark.png') });

    // ==================== 6. LIVE FOLD CONTINUITY (360x800 -> 820x920 + HINGE -> 360x800) ====================
    await page.click('[data-testid="nav-tab-notes"]');
    await page.waitForSelector(`[data-testid="note-row-${seededIds.noteMainId}"]`);
    await page.click(`[data-testid="note-row-${seededIds.noteMainId}"]`);
    await page.waitForSelector('[data-testid="mobile-notes-fullscreen-editor"]');
    const suffix = ' · непрерывность Fold!';
    const titleInput = page.locator('[data-testid="mobile-note-editor-title"]');
    const beforeTitle = await titleInput.inputValue();
    await titleInput.fill(beforeTitle + suffix);

    // Unfold live + simulate Book Mode vertical hinge!
    await page.setViewportSize({ width: 820, height: 920 });
    await page.evaluate(() => {
      window.__kapsulaMobile.setFoldState({
        posture: 'half-opened',
        isSeparating: true,
        hingeOrientation: 'vertical',
        hingeBounds: { left: 398, top: 0, right: 422, bottom: 920 },
      });
    });
    await page.waitForTimeout(260);

    assert(
      (await page.getAttribute('[data-testid="kapsula-mobile-root"]', 'data-fold-mode')) === 'expanded',
      'Expected expanded fold mode at 820px'
    );
    assert(await page.isVisible('[data-testid="fold-nav-rail"]'), 'Nav rail must appear when unfolded');
    assert(!(await page.isVisible('[data-testid="fold-bottom-nav"]')), 'Bottom dock must hide when unfolded');
    const titleAfterUnfold = await page.locator('[data-testid="mobile-note-editor-title"]').inputValue();
    assert(titleAfterUnfold.endsWith(suffix), `Draft title lost during unfold! got="${titleAfterUnfold}"`);
    await assertNoHorizontalOverflow(page, 'expanded-notes-hinge');
    await page.screenshot({ path: path.join(OUT_DIR, '18-expanded-notes-hinge-dark.png') });

    // Reset to flat unfolded for all 5 expanded tabs
    await page.evaluate(() => {
      window.__kapsulaMobile.setFoldState({
        posture: 'flat',
        isSeparating: false,
        hingeOrientation: 'none',
        hingeBounds: null,
      });
    });
    await page.waitForTimeout(180);

    // Expanded Feed
    await page.click('[data-testid="nav-tab-feed"]');
    await page.waitForSelector('[data-testid="feed-grid"]');
    await page.locator('[data-testid^="feed-card-"]').first().click();
    await page.waitForSelector('[data-testid="feed-detail-pane"]');
    await page.waitForTimeout(380); // let MobileNavRail spring pill settle
    // Assert MobileAudioPlayer NEVER overflows its narrow 2-column card!
    const audioOverflow = await page.evaluate(() => {
      const players = Array.from(document.querySelectorAll('[data-testid="mobile-audio-player"]'));
      return players.map((p) => {
        const card = p.closest('article');
        const pr = p.getBoundingClientRect();
        const cr = card?.getBoundingClientRect();
        return {
          selfOverflow: p.scrollWidth > p.clientWidth + 1,
          outsideCard: Boolean(cr && pr.right > cr.right + 1),
        };
      });
    });
    assert(
      audioOverflow.length > 0 && audioOverflow.every((a) => !a.selfOverflow && !a.outsideCard),
      `MobileAudioPlayer overflowed card on Expanded Fold! got=${JSON.stringify(audioOverflow)}`
    );
    await assertNoHorizontalOverflow(page, 'expanded-feed');
    await page.screenshot({ path: path.join(OUT_DIR, '19-expanded-feed-cobalt-dark.png') });

    // Expanded Calendar
    await page.click('[data-testid="nav-tab-calendar"]');
    await page.waitForSelector('[data-testid="calendar-grid-pane"]');
    await page.waitForSelector('[data-testid="calendar-day-pane"]');
    await page.waitForTimeout(380);
    await assertNoHorizontalOverflow(page, 'expanded-calendar');
    await page.screenshot({ path: path.join(OUT_DIR, '20-expanded-calendar-dark.png') });

    // Expanded Vault
    await page.click('[data-testid="nav-tab-vault"]');
    await page.waitForSelector('[data-testid="vault-grid"]');
    await page.waitForTimeout(380);
    await assertNoHorizontalOverflow(page, 'expanded-vault');
    await page.screenshot({ path: path.join(OUT_DIR, '21-expanded-vault-dark.png') });

    // Switch to Light Theme + Emerald Accent and capture both Expanded & Compact Light!
    await page.click('[data-testid="cloud-settings-btn"]');
    await page.waitForSelector('[data-testid="settings-cloud-sheet"]');
    await page.click('[data-testid="settings-tab-appearance"]');
    await page.click('[data-testid="theme-light-btn"]');
    await page.click('[data-testid="accent-preset-emerald"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);

    await page.click('[data-testid="nav-tab-feed"]');
    await page.waitForTimeout(380);
    await assertNoHorizontalOverflow(page, 'expanded-feed-light');
    await page.screenshot({ path: path.join(OUT_DIR, '22-expanded-feed-emerald-light.png') });

    // Fold back to 360x800 in Light Emerald theme
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(260);
    await assertNoHorizontalOverflow(page, 'compact-feed-light');
    await page.screenshot({ path: path.join(OUT_DIR, '23-compact-feed-emerald-light.png') });

    // Bilingual EN smoke verification (close detail sheet if open after fold -> switch to English -> check nav chrome + zero overflow)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
    await page.click('[data-testid="header-cloud-btn"]');
    await page.waitForSelector('[data-testid="settings-cloud-sheet"]');
    await page.click('[data-testid="settings-tab-appearance"]');
    await page.click('[data-testid="settings-lang-en"]');
    await page.waitForTimeout(180);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
    const enNavText = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="mobile-bottom-nav"], nav');
      return nav ? nav.innerText : '';
    });
    assert(enNavText.length > 0 && !/[А-Яа-яЁё]/.test(enNavText), `EN nav chrome leaked Cyrillic: "${enNavText}"`);
    await assertNoHorizontalOverflow(page, 'compact-en-light');

    assert(errors.length === 0, `Runtime console/page errors detected:\n${errors.join('\n')}`);
    console.log('\n[fold-verify] ALL 26 ANDROID FOLD V2 SCENARIOS PASSED (0 errors)!');
    console.log(`[fold-verify] Screenshots saved to: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
