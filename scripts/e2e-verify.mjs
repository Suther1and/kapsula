import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EXE_PATH = path.join(ROOT_DIR, 'release', 'win-unpacked', 'Kapsula.exe');
const AUDIT_DIR = process.env.KAPSULA_AUDIT_DIR
  ? path.resolve(process.env.KAPSULA_AUDIT_DIR)
  : path.join(ROOT_DIR, '.tmp', 'e2e-verify');

const BANNED_UI_TERMS = ['DPAPI', 'MTProto', 'FTS5', 'SQLite', 'SQLITE_', 'OCR', 'PKCE', 'ECONNREFUSED'];
const BANNED_ASSISTANT_TERMS = ['[#', 'openrouter', '$0.00'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killStrayProcesses() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process Kapsula,electron -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore' }
    );
  } catch {
    // ignore if none running
  }
}

async function waitForSurfaces(app, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wins = app.windows();
    const capsule = wins.find((w) => w.url().includes('surface=capsule'));
    assert.equal(capsule, undefined, 'Floating companion orb (surface=capsule) MUST NOT exist in v6');
    const vault = wins.find((w) => w.url().includes('surface=vault') || !w.url().includes('surface='));
    const hud = wins.find((w) => w.url().includes('surface=hud'));
    if (vault && hud) {
      await Promise.all([
        vault.waitForLoadState('domcontentloaded'),
        hud.waitForLoadState('domcontentloaded'),
      ]);
      assert.equal(wins.length, 2, `Expected exactly 2 windows (vault + hud), got ${wins.length}`);
      return { vault, hud };
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for Kapsula vault + hud surfaces. Found ${app.windows().length} windows.`);
}

async function saveShot(page, name) {
  const outPath = path.join(AUDIT_DIR, name);
  await page.screenshot({ path: outPath });
  console.log(`  [shot] ${name}`);
  return outPath;
}

async function assertCleanHumanCopy(page, contextLabel) {
  const bodyText = await page.locator('body').innerText();
  for (const term of BANNED_UI_TERMS) {
    const re = new RegExp(`(?<![A-Za-zА-Яа-яЁё0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-zА-Яа-яЁё0-9_])`, 'i');
    assert.ok(
      !re.test(bodyText),
      `[${contextLabel}] Technical jargon leaked into UI: "${term}"`
    );
  }
}

function assertNearZero(actual, expected, label, tolerance = 0.5) {
  const delta = Math.abs(actual - expected);
  assert.ok(
    delta <= tolerance,
    `Zero-jump invariant violated [${label}]: before=${expected.toFixed(2)}, after=${actual.toFixed(2)}, delta=${delta.toFixed(2)}px (max ${tolerance}px)`
  );
  return delta;
}

async function sampleFrames(page, selector, durationOffsets = [0, 45, 110, 240]) {
  const results = [];
  const start = Date.now();
  for (const targetMs of durationOffsets) {
    const wait = targetMs - (Date.now() - start);
    if (wait > 0) await sleep(wait);
    const snap = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        present: true,
        x: Number(r.x.toFixed(2)),
        y: Number(r.y.toFixed(2)),
        w: Number(r.width.toFixed(2)),
        h: Number(r.height.toFixed(2)),
        opacity: Number(parseFloat(cs.opacity || '1').toFixed(3)),
        transform: cs.transform,
      };
    }, selector);
    results.push({ tMs: Date.now() - start, ...snap });
  }
  return results;
}

async function main() {
  assert.ok(fs.existsSync(EXE_PATH), `Packaged binary missing at ${EXE_PATH}. Run npm run pack:win first.`);
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  for (const old of fs.readdirSync(AUDIT_DIR)) {
    if (old.endsWith('.png') || old.endsWith('.json')) {
      fs.rmSync(path.join(AUDIT_DIR, old), { force: true });
    }
  }

  const metrics = {
    zeroJump: {},
    motionFrames: {},
    invariants: {},
  };

  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-e2e-v6-'));
  console.log(`[e2e-v6] Launching packaged Kapsula.exe with isolated KAPSULA_DATA_DIR=${tmpDataDir}`);

  let app;
  try {
    app = await electron.launch({
      executablePath: EXE_PATH,
      env: {
        ...process.env,
        KAPSULA_DATA_DIR: tmpDataDir,
        KAPSULA_E2E_QUIT_ON_CLOSE: '1',
        KAPSULA_E2E_KEEP_HUD: '1',
        KAPSULA_SKIP_SENDKEYS: '1',
      },
    });

    const { vault, hud } = await waitForSurfaces(app);
    await vault.waitForSelector('[data-testid="studio-workspace"]', { timeout: 15000 });
    await vault.waitForTimeout(700);
    // Dismiss v8 universal onboarding modal if shown on cold empty vault (keeps 0 orbits)
    const onboardingSkipBtn = vault.getByTestId('onboarding-skip-btn');
    if (await onboardingSkipBtn.isVisible().catch(() => false)) {
      await onboardingSkipBtn.click();
      await vault.waitForTimeout(260);
    }

    // -------------------------------------------------------------------------
    // 01. Surface hygiene, cold-start, header cleanups, neutral obsidian RGB, Alt+Space
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 01 - Cold start, Neutral RGB & Surface hygiene');
    const initSettings = await vault.evaluate(() => window.kapsula.getSettings());
    assert.equal(initSettings.theme, 'dark', 'Default theme must be Neutral Obsidian Dark');
    assert.equal(initSettings.hudShortcut, 'Alt+Space', 'Default HUD shortcut must be Alt+Space');

    const darkBg = await vault.evaluate(() => {
      const ws = document.querySelector('[data-testid="studio-workspace"]');
      const raw = ws ? getComputedStyle(ws).backgroundColor : '';
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
      return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), raw } : null;
    });
    assert.ok(darkBg && darkBg.g <= darkBg.b && darkBg.b - darkBg.g <= 6, `Dark background must NOT be greenish/olive, got ${JSON.stringify(darkBg)}`);
    metrics.invariants.darkBgRgb = darkBg;

    const initOrbits = await vault.evaluate(() => window.kapsula.listOrbits());
    assert.equal(initOrbits.length, 0, 'Cold start must have 0 starter sections');

    const headerText = await vault.locator('header').innerText();
    assert.ok(!headerText.includes('Ctrl+K'), 'Header search must not show redundant Ctrl+K badge');
    assert.ok(!/telegram/i.test(headerText), 'Header must not contain Telegram button');

    const headerGeo = await vault.evaluate(() => {
      const l = document.querySelector('[data-testid="header-left-group"]')?.getBoundingClientRect();
      const c = document.querySelector('[data-testid="header-center-group"]')?.getBoundingClientRect();
      const r = document.querySelector('[data-testid="header-right-group"]')?.getBoundingClientRect();
      return l && c && r ? { lRight: l.right, cLeft: c.left, cRight: c.right, rLeft: r.left } : null;
    });
    assert.ok(
      headerGeo &&
        headerGeo.lRight <= headerGeo.cLeft - 8 &&
        headerGeo.rLeft >= headerGeo.cRight + 8,
      `Header groups overlap center search! ${JSON.stringify(headerGeo)}`
    );
    metrics.invariants.headerGapsPx = {
      leftGap: Number((headerGeo.cLeft - headerGeo.lRight).toFixed(1)),
      rightGap: Number((headerGeo.rLeft - headerGeo.cRight).toFixed(1)),
    };

    // Verify header stays overlap-free when shrunk to minWidth (960px) and 1080px
    const narrowChecks = [];
    for (const w of [960, 1080, 1360]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find((bw) => bw.webContents.getURL().includes('surface=vault'));
        if (win) win.setSize(width, 880);
      }, w);
      await vault.waitForTimeout(120);
      const geo = await vault.evaluate(() => {
        const l = document.querySelector('[data-testid="header-left-group"]')?.getBoundingClientRect();
        const c = document.querySelector('[data-testid="header-center-group"]')?.getBoundingClientRect();
        const r = document.querySelector('[data-testid="header-right-group"]')?.getBoundingClientRect();
        return l && c && r ? { lRight: l.right, cLeft: c.left, cRight: c.right, rLeft: r.left } : null;
      });
      assert.ok(
        geo && geo.lRight <= geo.cLeft - 8 && geo.rLeft >= geo.cRight + 8,
        `Header overlap at width=${w}: ${JSON.stringify(geo)}`
      );
      narrowChecks.push({
        width: w,
        leftGap: Number((geo.cLeft - geo.lRight).toFixed(1)),
        rightGap: Number((geo.rLeft - geo.cRight).toFixed(1)),
      });
    }
    metrics.invariants.headerResizeGaps = narrowChecks;

    const sidebarText = await vault.getByTestId('workspace-sidebar').innerText();
    assert.ok(!sidebarText.includes('Случайная запись'), 'Sidebar must not contain Случайная запись');

    await assertCleanHumanCopy(vault, '01-cold-start');
    await saveShot(vault, '01-cold-start-dark.png');

    // -------------------------------------------------------------------------
    // 02. Zero-jump OmniComposer focus + Sidebar Toggle Motion & Centered Search
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 02 - Zero-jump invariants (OmniComposer + Header Search on Sidebar Toggle)');
    const omniBox = vault.getByTestId('omni-composer');
    const omniInput = vault.getByTestId('omni-composer-input');
    const omniBefore = await omniBox.boundingBox();
    const inputBefore = await omniInput.boundingBox();
    await omniInput.click();
    await vault.waitForTimeout(250);
    const omniAfter = await omniBox.boundingBox();
    const inputAfter = await omniInput.boundingBox();
    assert.ok(omniBefore && omniAfter && inputBefore && inputAfter);
    metrics.zeroJump.omniFocus = {
      dx: assertNearZero(omniAfter.x, omniBefore.x, 'omni-x'),
      dy: assertNearZero(omniAfter.y, omniBefore.y, 'omni-y'),
      dw: assertNearZero(omniAfter.width, omniBefore.width, 'omni-w'),
      inputDy: assertNearZero(inputAfter.y, inputBefore.y, 'omni-input-y'),
      inputDh: assertNearZero(inputAfter.height, inputBefore.height, 'omni-input-h'),
      expandedTrayDeltaH: Number((omniAfter.height - omniBefore.height).toFixed(2)),
    };
    assert.ok(
      omniAfter.height - omniBefore.height >= 36 && omniAfter.height - omniBefore.height <= 80,
      `Expected smooth v7 OmniComposer tray expand (36..80px), got ${(omniAfter.height - omniBefore.height).toFixed(2)}px`
    );

    const getHeaderAndSearchCenters = () =>
      vault.evaluate(() => {
        const hdr = document.querySelector('header')?.getBoundingClientRect();
        const grp = document.querySelector('[data-testid="header-center-group"]')?.getBoundingClientRect();
        return hdr && grp
          ? { headerCenter: hdr.x + hdr.width / 2, searchCenter: grp.x + grp.width / 2 }
          : null;
      });

    const searchInput = vault.getByTestId('global-search-input');
    const openCenters = await getHeaderAndSearchCenters();
    assert.ok(openCenters);
    assertNearZero(openCenters.searchCenter, openCenters.headerCenter, 'global-search-center-open', 1.5);

    const sidebarCloseFramesPromise = sampleFrames(vault, '[data-testid="workspace-sidebar"]', [0, 45, 110, 240]);
    await vault.locator('[data-testid="workspace-sidebar"] [data-testid="toggle-sidebar-btn"]').click();
    const sidebarCloseFrames = await sidebarCloseFramesPromise;
    await vault.waitForTimeout(120);

    const closedCenters = await getHeaderAndSearchCenters();
    assert.ok(closedCenters);
    metrics.zeroJump.searchCenterOnSidebarToggle = assertNearZero(
      closedCenters.searchCenter,
      closedCenters.headerCenter,
      'global-search-center-closed',
      1.5
    );
    metrics.motionFrames.sidebarClose = sidebarCloseFrames;
    const midClosed = sidebarCloseFrames[1];
    assert.ok(
      sidebarCloseFrames.some((f) => f.present && f.w > 8 && f.w < 236) ||
        (midClosed && midClosed.opacity > 0.05 && midClosed.opacity < 0.99),
      `Expected smooth intermediate sidebar width/opacity frames, got: ${JSON.stringify(sidebarCloseFrames)}`
    );

    const sidebarOpenFramesPromise = sampleFrames(vault, '[data-testid="workspace-sidebar"]', [0, 45, 110, 240]);
    await vault.locator('header [data-testid="toggle-sidebar-btn"]').click();
    metrics.motionFrames.sidebarOpen = await sidebarOpenFramesPromise;
    await vault.waitForTimeout(150);

    // -------------------------------------------------------------------------
    // 03. Unlimited Sections (12+), Icons/Colors, Counter Alignment, Hover & Context Menu
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 03 - 12 Custom Sections, Aligned Right Counters & Right-Click Context Menu');
    await vault.getByTestId('add-orbit-btn').click();
    await vault.waitForSelector('[data-testid="section-name-input"]', { timeout: 5000 });
    await vault.getByTestId('section-name-input').fill('Игры');
    await vault.waitForTimeout(200);
    await saveShot(vault, '02-section-editor-modal.png');
    await vault.getByTestId('section-save-btn').click();
    await vault.waitForTimeout(250);

    // Create 11 more sections (total 12 > old v5 cap of 9!)
    await vault.evaluate(async () => {
      const names = [
        'Идеи', 'Референсы', 'Шейдеры', 'Работа', 'Финансы',
        'Книги', 'Музыка', 'Видео', 'Код', 'Путешествия', 'Удаляемый',
      ];
      const colors = [
        '#3B82F6', '#8B5CF6', '#EC4899', '#10B981', '#F59E0B',
        '#06B6D4', '#EF4444', '#6366F1', '#14B8A6', '#F97316', '#84CC16',
      ];
      const icons = [
        'Sparkle', 'Palette', 'Cube', 'Briefcase', 'Receipt',
        'BookOpen', 'MusicNotes', 'FilmStrip', 'Code', 'Compass', 'Trash',
      ];
      for (let i = 0; i < names.length; i++) {
        await window.kapsula.createOrbit({
          name: names[i],
          description: `Описание раздела ${names[i]}`,
          color: colors[i],
          icon: icons[i],
        });
      }
    });
    await vault.getByTestId('nav-notes').click();
    await vault.waitForTimeout(200);
    await vault.getByTestId('nav-flow').click();
    await vault.waitForTimeout(350);

    const orbitsList = await vault.evaluate(() => window.kapsula.listOrbits());
    assert.equal(orbitsList.length, 12, `Expected 12 custom sections without arbitrary cap, got ${orbitsList.length}`);
    metrics.invariants.orbitCount = orbitsList.length;

    // Check right-aligned counters form a straight line ACROSS both top nav AND user sections
    const countRights = await vault.evaluate(() => {
      const topNavCounts = Array.from(
        document.querySelectorAll('[data-testid^="nav-"] span:last-child')
      );
      const orbitCounts = Array.from(document.querySelectorAll('[data-testid^="orbit-count-"]'));
      return [...topNavCounts, ...orbitCounts].map((el) => {
        const r = el.getBoundingClientRect();
        return Number((r.x + r.width).toFixed(2));
      });
    });
    const minRight = Math.min(...countRights);
    const maxRight = Math.max(...countRights);
    assert.ok(
      maxRight - minRight <= 1.2,
      `Sidebar top-nav + section counters not aligned on straight vertical axis: rights=${JSON.stringify(countRights)}`
    );
    metrics.zeroJump.sidebarCountersSpread = Number((maxRight - minRight).toFixed(2));

    // Hover a section and check its counter stays fixed, then test Right-Click Context Menu
    const firstOrbitRow = vault.locator('[data-testid^="sidebar-orbit-"]').first();
    const firstCountEl = vault.locator('[data-testid^="orbit-count-"]').first();
    const countBeforeHover = await firstCountEl.boundingBox();
    await firstOrbitRow.hover();
    await vault.waitForTimeout(150);
    const countAfterHover = await firstCountEl.boundingBox();
    assertNearZero(countAfterHover.x + countAfterHover.width, countBeforeHover.x + countBeforeHover.width, 'orbit-count-hover');

    // Right-click last section ("Удаляемый") and delete via Context Menu
    const lastOrbit = orbitsList[orbitsList.length - 1];
    const lastOrbitRow = vault.getByTestId(`sidebar-orbit-${lastOrbit.id}`);
    const ctxFramesPromise = sampleFrames(vault, '[data-testid="context-menu-popup"]', [0, 40, 110, 220]);
    await lastOrbitRow.click({ button: 'right' });
    metrics.motionFrames.contextMenu = await ctxFramesPromise;
    await vault.waitForSelector('[data-testid="context-menu-popup"]', { timeout: 4000 });
    await saveShot(vault, '03-sidebar-context-menu.png');
    await vault.getByRole('menuitem', { name: 'Удалить раздел' }).click();
    await vault.waitForTimeout(300);

    const orbitsAfterDelete = await vault.evaluate(() => window.kapsula.listOrbits());
    assert.equal(orbitsAfterDelete.length, 11, 'Deleting section via context menu should leave 11 sections');

    // -------------------------------------------------------------------------
    // 04. Right Side-Sheet Ephemeral Draft, Rich Task Alignment & Floating Slash Portal
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 04 - Ephemeral Empty Draft + Side-Sheet + Task Alignment + Slash Menu');
    const countBeforeEmptyDraft = (await vault.evaluate(() => window.kapsula.queryVault({ limit: 500 }))).length;

    const sheetFramesPromise = sampleFrames(vault, '[data-testid="studio-document-canvas"]', [0, 45, 110, 240]);
    await vault.locator('[data-testid="new-blank-note-btn"]:not([inert] *)').first().click();
    metrics.motionFrames.sideSheetOpen = await sheetFramesPromise;
    await vault.waitForSelector('[data-testid="note-studio-title"]', { timeout: 5000 });
    // Close immediately without typing
    await vault.getByTestId('note-studio-close').click();
    await vault.waitForTimeout(250);

    const countAfterEmptyDraft = (await vault.evaluate(() => window.kapsula.queryVault({ limit: 500 }))).length;
    assert.equal(countAfterEmptyDraft, countBeforeEmptyDraft, 'Closing empty draft MUST leave 0 junk notes in DB');

    // Open blank draft and write real content + checklist + /slash menu
    await vault.locator('[data-testid="new-blank-note-btn"]:not([inert] *)').first().click();
    await vault.waitForSelector('[data-testid="note-studio-title"]', { timeout: 5000 });
    await vault.getByTestId('note-studio-title').fill('Шейдер воды для Unity');
    const editor = vault.getByTestId('note-studio-editor');
    await editor.click();
    await vault.keyboard.type('Нужно добавить каустики и мягкую кромку берега.', { delay: 10 });
    await vault.keyboard.press('Enter');
    await vault.keyboard.type('- [ ] Настроить карту нормалей и глубины', { delay: 10 });
    await vault.keyboard.press('Enter');
    await vault.keyboard.press('Enter');
    await vault.keyboard.type('/блок');
    await vault.waitForSelector('[data-testid="slash-command-menu"]', { timeout: 5000 });
    const slashBox = await vault.getByTestId('slash-command-menu').boundingBox();
    assert.ok(slashBox && slashBox.x > 100 && slashBox.y > 60, `Slash menu coordinates must track caret inside sheet: ${JSON.stringify(slashBox)}`);
    await saveShot(vault, '04-note-studio-side-sheet-slash.png');
    await vault.keyboard.press('Enter');
    await vault.keyboard.type('float depth = LinearEyeDepth(rawDepth);', { delay: 8 });
    await vault.waitForTimeout(550);

    // Check checkbox-to-text vertical alignment inside TipTap taskList
    const taskAlignDelta = await vault.evaluate(() => {
      const li = document.querySelector('.k-prose ul[data-type="taskList"] li');
      if (!li) return null;
      const box = li.querySelector('label input[type="checkbox"]');
      const p = li.querySelector('div p');
      if (!box || !p) return null;
      const br = box.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      return Math.abs(br.top + br.height / 2 - (pr.top + pr.height / 2));
    });
    assert.ok(taskAlignDelta !== null && taskAlignDelta <= 3.0, `Checklist checkbox misaligned with text: ${taskAlignDelta}px`);
    metrics.zeroJump.taskCheckboxAlignDelta = Number(taskAlignDelta.toFixed(2));

    await vault.getByTestId('note-studio-close').click();
    await vault.waitForTimeout(300);

    // -------------------------------------------------------------------------
    // 05. Pin -> Unpin Chronology Preservation & Flush-Right Card Timestamps
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 05 - Pin -> Unpin Chronology & Card Hover Timestamp Stability');
    const nowMs = Date.now();
    const chronItems = await vault.evaluate(async (ts) => {
      const a = await window.kapsula.capture({ title: 'Хроно A (раньше всех)', text: 'Запись A', createdAt: ts + 1000, source: 'vault_ui' });
      const b = await window.kapsula.capture({ title: 'Хроно B (середина)', text: 'Запись B', createdAt: ts + 2000, source: 'vault_ui' });
      const c = await window.kapsula.capture({ title: 'Хроно C (самая свежая)', text: 'Запись C', createdAt: ts + 3000, source: 'vault_ui' });
      return [a.id, b.id, c.id];
    }, nowMs);
    await vault.waitForTimeout(400);

    const getOrderTopIds = () =>
      vault.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="memory-card-"]')).map((el) =>
          el.getAttribute('data-testid').replace('memory-card-', '')
        )
      );

    let order = await getOrderTopIds();
    assert.equal(order[0], chronItems[2], 'Newest item C should appear first initially');
    assert.equal(order[1], chronItems[1], 'Middle item B should appear second initially');
    assert.equal(order[2], chronItems[0], 'Oldest item A should appear third initially');

    // Pin middle item B -> moves to position 0
    await vault.evaluate((id) => window.kapsula.updateItem(id, { isPinned: true }), chronItems[1]);
    await vault.waitForTimeout(350);
    order = await getOrderTopIds();
    assert.equal(order[0], chronItems[1], 'Pinned item B must move to the very top');

    // Unpin item B -> MUST return to exact chronological position between C and A!
    await vault.evaluate((id) => window.kapsula.updateItem(id, { isPinned: false }), chronItems[1]);
    await vault.waitForTimeout(350);
    order = await getOrderTopIds();
    assert.equal(order[0], chronItems[2], 'After unpinning B, newest C must return to 1st place');
    assert.equal(order[1], chronItems[1], 'After unpinning B, B must return to exact 2nd place');
    assert.equal(order[2], chronItems[0], 'After unpinning B, A must stay in 3rd place');
    metrics.invariants.pinUnpinChronologyRestored = true;

    // Check zero-reflow + flush-right timestamp on card hover (card height + title width/y delta === 0)
    const firstCard = vault.getByTestId(`memory-card-${chronItems[2]}`);
    const tsLoc = vault.getByTestId(`card-timestamp-${chronItems[2]}`);
    const hoverBefore = await firstCard.evaluate((cardEl) => {
      const cardRect = cardEl.getBoundingClientRect();
      const titleEl = cardEl.querySelector('h3');
      const titleRect = titleEl?.getBoundingClientRect();
      return {
        cardH: Number(cardRect.height.toFixed(2)),
        titleW: titleRect ? Number(titleRect.width.toFixed(2)) : 0,
        titleOffsetY: titleRect ? Number((titleRect.y - cardRect.y).toFixed(2)) : 0,
      };
    });
    const tsBefore = await tsLoc.boundingBox();
    await firstCard.hover();
    await vault.waitForTimeout(200);
    const hoverAfter = await firstCard.evaluate((cardEl) => {
      const cardRect = cardEl.getBoundingClientRect();
      const titleEl = cardEl.querySelector('h3');
      const titleRect = titleEl?.getBoundingClientRect();
      return {
        cardH: Number(cardRect.height.toFixed(2)),
        titleW: titleRect ? Number(titleRect.width.toFixed(2)) : 0,
        titleOffsetY: titleRect ? Number((titleRect.y - cardRect.y).toFixed(2)) : 0,
      };
    });
    const tsAfter = await tsLoc.boundingBox();
    metrics.zeroJump.cardTimestampHover = assertNearZero(
      tsAfter.x + tsAfter.width,
      tsBefore.x + tsBefore.width,
      'card-timestamp-right'
    );
    metrics.invariants.cardHoverReflowDeltaPx = Math.max(
      assertNearZero(hoverAfter.cardH, hoverBefore.cardH, 'card-hover-height', 0.1),
      assertNearZero(hoverAfter.titleW, hoverBefore.titleW, 'card-hover-title-w', 0.1),
      assertNearZero(hoverAfter.titleOffsetY, hoverBefore.titleOffsetY, 'card-hover-title-offset-y', 0.1)
    );
    await saveShot(vault, '05a-card-hover-clean.png');

    // Capture 69-char Russian game-dev note -> assert NO mid-word cut / NO orphan "ы" line / NO Финансы misrouting
    await omniInput.fill('из интерфейса выбора карты селать просмотр всех текущих карт и колоды');
    await vault.getByTestId('omni-save-btn').click();
    await vault.waitForTimeout(350);
    const gameCardCheck = await vault.evaluate(async () => {
      const all = await window.kapsula.queryVault({ limit: 50 });
      const gm = all.find((x) => (x.body || '').includes('всех текущих карт и колоды'));
      if (!gm) return null;
      const domCard = document.querySelector(`[data-testid="memory-card-${gm.id}"]`);
      const lines = (domCard?.innerText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return {
        title: gm.title,
        tags: gm.tags,
        orbit: gm.orbit,
        hasOrphanLine: lines.includes('ы'),
        hasColonFull: (domCard?.innerText || '').includes('колоды'),
      };
    });
    assert.ok(gameCardCheck, 'Game note must exist in vault');
    assert.equal(gameCardCheck.hasOrphanLine, false, `Must NEVER show orphan "ы" line: ${JSON.stringify(gameCardCheck)}`);
    assert.equal(gameCardCheck.hasColonFull, true, `Card must show full word "колоды": ${JSON.stringify(gameCardCheck)}`);
    assert.ok(!gameCardCheck.tags.includes('финансы'), `Game card note must NOT be tagged Финансы: ${JSON.stringify(gameCardCheck)}`);
    metrics.invariants.wordBoundaryTitleOk = true;

    // Verify right-click context menu on a feed card is NOT swallowed by feed background menu
    await firstCard.click({ button: 'right' });
    await vault.waitForSelector('[data-testid="context-menu-popup"]', { timeout: 4000 });
    await vault.getByRole('menuitem', { name: 'Открыть' }).waitFor({ state: 'visible', timeout: 2500 });
    await vault.keyboard.press('Escape');
    await vault.waitForTimeout(180);

    // -------------------------------------------------------------------------
    // 06. Live t.me Link Ingestion + Instagram + Bilingual RU<->EN Search
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 06 - Deep t.me Unfurl + Bilingual Search');
    await omniInput.fill('https://t.me/durov/342');
    await vault.getByTestId('omni-save-btn').click();
    await vault.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="omni-composer-input"]');
        const cards = Array.from(document.querySelectorAll('[data-testid^="memory-card-"]'));
        return (
          input?.value === '' &&
          cards.some((c) => c.innerText.includes('Telegram') || c.innerText.includes('t.me'))
        );
      },
      { timeout: 12000 }
    );
    // Verify synchronous t.me link unfurl resolved immediately on capture without empty "t.me" flash
    await vault.waitForTimeout(150);
    const tgCardInfo = await vault.evaluate(async () => {
      const all = await window.kapsula.queryVault({ limit: 50 });
      const tg = all.find((x) => (x.url || '').includes('t.me/durov/342'));
      return tg ? { dna: tg.dna, title: tg.title, body: tg.body, domain: tg.domain, orbit: tg.orbit } : null;
    });
    assert.ok(tgCardInfo, 't.me/durov/342 item must exist in vault');
    assert.equal(tgCardInfo.dna, 'link', 'Long unfurled Telegram post must preserve link card DNA');
    assert.ok(!tgCardInfo.body.includes('&quot;'), 'Telegram unfurl must decode HTML entities cleanly');
    assert.ok(
      tgCardInfo.body.length > 40 &&
        tgCardInfo.title.trim().toLowerCase() !== 'telegram' &&
        tgCardInfo.title.trim().toLowerCase() !== 't.me',
      `Expected immediate rich post content & meaningful title for t.me/durov/342, got ${JSON.stringify(tgCardInfo)}`
    );
    assert.ok(tgCardInfo.orbit !== 'docs', 'Telegram social post must not be misrouted into Документы');
    metrics.invariants.tmePostLength = tgCardInfo.body.length;

    await vault.evaluate(async () => {
      await window.kapsula.capture({
        url: 'https://www.instagram.com/p/demoShaders/',
        title: 'Instagram Shader Breakdown',
        text: 'Разбор стилизованных текстур в Instagram',
        source: 'vault_ui',
      });
    });
    await vault.waitForTimeout(300);

    await searchInput.fill('инстаграм');
    await vault.waitForTimeout(300);
    const igFound = await vault.locator('[data-testid^="memory-card-"]').count();
    assert.ok(igFound >= 1, 'Bilingual search "инстаграм" must match Instagram item');
    await searchInput.fill('');
    await vault.waitForTimeout(250);

    // -------------------------------------------------------------------------
    // 07. SegmentedControl Thumb Glide + Unified List View (~52px) & Board View
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 07 - SegmentedControl Glide, Unified List (~52px) & Reference Board');
    const thumbFramesPromise = sampleFrames(vault, '[data-testid="segmented-thumb"]', [0, 45, 95, 220]);
    await vault.getByRole('tab', { name: 'Список' }).click();
    const thumbFrames = await thumbFramesPromise;
    metrics.motionFrames.segmentedThumbGlide = thumbFrames;
    const xVals = thumbFrames.map((f) => f.x).filter((x) => typeof x === 'number');
    assert.ok(
      xVals.length >= 3 && (xVals[1] > xVals[0] + 1 || xVals[2] < xVals[xVals.length - 1] - 1),
      `Expected smooth horizontal SegmentedControl thumb glide frames, got ${JSON.stringify(thumbFrames)}`
    );
    await vault.waitForSelector('[data-testid="feed-list-container"]', { timeout: 5000 });
    await vault.waitForTimeout(250);

    const listHeights = await vault.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="compact-row-"]')).map((el) =>
        Number(el.getBoundingClientRect().height.toFixed(1))
      )
    );
    assert.ok(listHeights.length >= 4, 'Expected at least 4 rows in List view');
    for (const h of listHeights) {
      assert.ok(h >= 40 && h <= 64, `Compact list row height must stay ~52px single-row, got ${h}px`);
    }
    metrics.invariants.listRowHeights = listHeights;
    await saveShot(vault, '05-list-view.png');

    await vault.getByRole('tab', { name: 'Холст' }).click();
    await vault.waitForSelector('[data-testid="reference-board-canvas"]', { timeout: 5000 });
    await vault.waitForTimeout(250);
    await saveShot(vault, '06-reference-board.png');

    await vault.getByRole('tab', { name: 'Плитка' }).click();
    await vault.waitForSelector('[data-testid="feed-grid-container"]', { timeout: 5000 });
    await vault.waitForTimeout(250);

    // -------------------------------------------------------------------------
    // 08. Card Checkbox Clean Hover/Uncheck + Multi-Select Bulk Dock + Synthesize
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 08 - Checkbox Uncheck Hide + Multi-Select + Synthesize Notes');
    const firstCheckCard = vault.getByTestId(`memory-card-${chronItems[2]}`);
    const secondCheckCard = vault.getByTestId(`memory-card-${chronItems[1]}`);

    // First verify checking then unchecking and moving mouse away leaves opacity === 0 (never stuck!)
    await firstCheckCard.hover();
    await firstCheckCard.getByRole('checkbox').click();
    await firstCheckCard.getByRole('checkbox').click();
    await vault.mouse.move(4, 4);
    await vault.waitForTimeout(240);
    const badgeOpacityAfterUncheck = await vault.getByTestId(`card-select-badge-${chronItems[2]}`).evaluate((el) =>
      parseFloat(getComputedStyle(el).opacity || '1')
    );
    assert.equal(badgeOpacityAfterUncheck, 0, `Card checkbox stayed stuck visible after uncheck (opacity=${badgeOpacityAfterUncheck})`);
    metrics.invariants.cardCheckboxHiddenAfterUncheck = badgeOpacityAfterUncheck === 0;

    await firstCheckCard.hover();
    await firstCheckCard.getByRole('checkbox').click();

    const dockFramesPromise = sampleFrames(vault, '[data-testid="bulk-action-dock"]', [0, 45, 110, 240]);
    await secondCheckCard.hover();
    await secondCheckCard.getByRole('checkbox').click();
    metrics.motionFrames.bulkDock = await dockFramesPromise;
    await vault.waitForSelector('[data-testid="bulk-synthesize-btn"]', { timeout: 5000 });
    const bulkCountBox = await vault.getByTestId('bulk-selected-count').boundingBox();
    const bulkSynthBox = await vault.getByTestId('bulk-synthesize-btn').boundingBox();
    assert.ok(
      bulkCountBox && bulkSynthBox && bulkCountBox.x + bulkCountBox.width <= bulkSynthBox.x - 4,
      `Bulk selected counter overlaps Synthesize button: count=${JSON.stringify(bulkCountBox)}, synth=${JSON.stringify(bulkSynthBox)}`
    );

    const badgeOverlap = await vault.evaluate(() => {
      const author = document.querySelector('[data-testid="smart-link-author"]');
      const card = author?.closest('[data-testid^="memory-card-"]');
      const badge = card?.querySelector('[data-testid^="card-select-badge-"]');
      if (!author || !badge) return null;
      const a = author.getBoundingClientRect();
      const b = badge.getBoundingClientRect();
      const intersects2d = !(
        b.right <= a.left - 2 ||
        b.left >= a.right + 2 ||
        b.bottom <= a.top - 2 ||
        b.top >= a.bottom + 2
      );
      return {
        intersects2d,
        authorBox: { top: Math.round(a.top), bottom: Math.round(a.bottom) },
        badgeBox: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
      };
    });
    assert.ok(
      badgeOverlap && !badgeOverlap.intersects2d,
      `Selection badge intersects SmartLinkCard author label! ${JSON.stringify(badgeOverlap)}`
    );
    metrics.invariants.cardCheckboxNoOverlap = true;

    await saveShot(vault, '07-multi-select-bulk-dock.png');

    await vault.getByTestId('bulk-synthesize-btn').click();
    await vault.waitForSelector('[data-testid="synthesize-save-btn"]', { timeout: 8000 });
    await vault.waitForTimeout(500);
    await saveShot(vault, '08-synthesize-modal.png');
    await vault.getByTestId('synthesize-save-btn').click();
    await vault.waitForTimeout(450);
    if (await vault.getByTestId('note-studio-close').isVisible().catch(() => false)) {
      await vault.getByTestId('note-studio-close').click();
      await vault.waitForTimeout(250);
    }

    // -------------------------------------------------------------------------
    // 09. Encrypted Vault Secrets: Zero-Jump Tabs, CVV Chip Width, SecretStudioSheet
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 09 - Secrets Vault + SecretStudioSheet + Zero-Jump Tabs');
    await vault.getByTestId('nav-secrets').click();
    await vault.waitForTimeout(250);
    await vault.getByTestId('new-secret-btn').click();
    await vault.getByTestId('new-secret-bank_card-btn').click();
    await vault.waitForSelector('[data-testid="new-secret-form"]', { timeout: 5000 });
    await vault.waitForTimeout(260); // wait for 180ms opening scale animation to finish

    const secretDialog = vault.locator('[role="dialog"]');
    const secStartBox = await secretDialog.boundingBox();
    metrics.zeroJump.newSecretModalTabs = [];
    for (const tabName of ['Пароль', 'Ключ', 'Заметка', 'Карта']) {
      await secretDialog.getByRole('tab', { name: tabName }).click();
      await vault.waitForTimeout(180);
      const b = await secretDialog.boundingBox();
      metrics.zeroJump.newSecretModalTabs.push({
        tab: tabName,
        dy: assertNearZero(b.y, secStartBox.y, `new-secret-y-${tabName}`),
        dh: assertNearZero(b.height, secStartBox.height, `new-secret-h-${tabName}`),
      });
    }

    await vault.getByTestId('secret-title-input').fill('Т-Банк Black');
    await vault.getByTestId('secret-pan-input').fill('2200700488194310');
    await vault.getByTestId('secret-expiry-input').fill('0929');
    const formattedExp = await vault.getByTestId('secret-expiry-input').inputValue();
    assert.equal(formattedExp, '09/29', `Card expiry must auto-format 0929 -> 09/29, got "${formattedExp}"`);
    await vault.getByTestId('secret-cvv-input').fill('742');
    await vault.getByTestId('secret-submit-btn').click();

    const secretCardLoc = vault.locator('[data-testid^="secret-card-"]').first();
    await secretCardLoc.waitFor({ state: 'visible', timeout: 8000 });
    await vault.waitForTimeout(300);

    // Note: clicking submit opens SecretStudioSheet; inspect & edit title inside SecretStudioSheet first!
    if (await vault.getByTestId('secret-studio-sheet').isVisible().catch(() => false)) {
      await saveShot(vault, '09-secret-studio-sheet.png');
      await vault.getByTestId('studio-side-sheet').getByRole('button', { name: /Закрыть/i }).first().click().catch(async () => {
        await vault.keyboard.press('Escape');
      });
      await vault.waitForTimeout(250);
    }

    const cvvPill = vault.locator('[data-testid^="secret-copy-cvv-"]').first();
    const cvvBox = await cvvPill.boundingBox();
    assert.ok(cvvBox && cvvBox.width >= 36, `CVV chip must not be crushed, width=${cvvBox?.width}`);

    const expiryPill = vault.locator('[data-testid^="secret-copy-expiry-"]').first();
    await expiryPill.waitFor({ state: 'visible', timeout: 3000 });
    const expiryPillText = await expiryPill.innerText();
    assert.ok(expiryPillText.includes('09/29'), `Card expiry pill must show 09/29, got "${expiryPillText}"`);
    const expiryClipped = await expiryPill.evaluate((btn) => {
      const span = btn.querySelector('span:last-child');
      return span ? span.scrollWidth > span.clientWidth + 1 : false;
    });
    assert.equal(expiryClipped, false, 'Card expiry pill text must not truncate with ellipsis');
    await expiryPill.click();
    await vault.waitForTimeout(160);

    const panPill = vault.locator('[data-testid^="secret-copy-pan-"]').first();
    const panBefore = await panPill.boundingBox();
    await panPill.click();
    await vault.waitForTimeout(180);
    const panAfter = await panPill.boundingBox();
    metrics.zeroJump.secretCopyPanWidth = assertNearZero(panAfter.width, panBefore.width, 'secret-pan-copy-w');
    const cardScrollLeft = await secretCardLoc.evaluate((el) => el.scrollLeft);
    assert.equal(cardScrollLeft, 0, `Secret card must not horizontally scroll/clip after button click, got scrollLeft=${cardScrollLeft}`);
    await saveShot(vault, '10-vault-secrets-card.png');

    // Reveal card, then lock Vault with PIN and verify plaintext PAN & CVV immediately clear
    await vault.locator('[data-testid^="secret-reveal-"]').first().click();
    await vault.waitForFunction(
      () => document.querySelector('[data-testid^="secret-card-"]')?.textContent?.includes('2200'),
      undefined,
      { timeout: 4000 }
    );
    await vault.evaluate(async () => {
      await window.kapsula.setMasterPin('1234');
      await window.kapsula.lockVaultPin();
    });
    await vault.waitForTimeout(220);
    const lockedCardText = await secretCardLoc.innerText();
    assert.ok(!lockedCardText.includes('2200'), `Locked secret card MUST NOT expose plaintext PAN, got: ${lockedCardText}`);
    assert.ok(!lockedCardText.includes('742'), `Locked secret card MUST NOT expose plaintext CVV, got: ${lockedCardText}`);
    await vault.evaluate(async () => {
      await window.kapsula.unlockVaultPin('1234');
      await window.kapsula.setMasterPin(null);
    });
    await vault.waitForTimeout(160);

    // -------------------------------------------------------------------------
    // 10. Zero-Delay Instant Auto-Calendar + Non-Zero Badge + CalendarEventSheet
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 10 - Auto-Calendar Capture (0ms delay), Badge Count & Rich CalendarEventSheet');
    await vault.getByTestId('nav-flow').click();
    await vault.waitForSelector('[data-testid="omni-composer-input"]', { timeout: 5000 });
    await vault.getByTestId('omni-composer-input').fill('21.11 в 17:15 Чистка зубов на Ленина 14');
    // Immediate click without waiting for any IPC debounce
    await vault.getByTestId('omni-save-btn').click();
    await vault.waitForFunction(
      () => {
        const badge = document.querySelector('[data-testid="nav-calendar"] span[data-count]');
        return badge && Number(badge.getAttribute('data-count') || '0') >= 1;
      },
      undefined,
      { timeout: 6000 }
    );

    await vault.getByTestId('nav-calendar').click();
    await vault.waitForSelector('[data-testid="calendar-hub-view"]', { timeout: 5000 });
    await vault.waitForTimeout(250);
    const calAutoText = await vault.getByTestId('calendar-hub-view').innerText();
    assert.ok(calAutoText.includes('Чистка зубов'), 'Pasted Russian event must appear immediately in Calendar view');
    assert.ok(!calAutoText.includes('17:15-17:30') && !calAutoText.includes('17:15–17:30'), 'Event without duration must not invent 17:15-17:30');

    await vault.getByTestId('calendar-add-event-btn').click();
    await vault.waitForSelector('[data-testid="calendar-event-sheet"]', { timeout: 5000 });
    await vault.getByTestId('calendar-event-title-input').fill('Созвон по игре v6');
    await vault.getByTestId('duration-pill-30').click();
    await vault.getByTestId('calendar-checklist-input').fill('Проверить билд');
    await vault.getByTestId('calendar-checklist-add-btn').click();
    await vault.getByTestId('calendar-event-save-btn').click();
    await vault.waitForTimeout(320);
    const calText = await vault.getByTestId('calendar-hub-view').innerText();
    assert.ok(calText.includes('Созвон по игре v6'), 'Created event must appear in Calendar view');
    await saveShot(vault, '11-calendar-hub.png');

    // -------------------------------------------------------------------------
    // 10b. Distinct Purpose-Built Workspaces: 2-Pane Заметки + Visual Медиа + Задачи
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 10b - Distinct 2-Pane Notes Studio & Visual Media Gallery');
    // Seed a short Telegram Saved Message and a visual screenshot item to verify filtering & gallery
    await vault.evaluate(async () => {
      await window.kapsula.capture({
        text: '3 ступени графики 100%, 85, 75',
        source: 'telegram_saved',
      });
      const tinyPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAH0lEQVQI12P4z8BQz0AEYBxVSF+FJAaGJgYGhgYGBgANwQQJ2t1t6AAAAABJRU5ErkJggg==';
      await window.kapsula.capture({
        imageBase64: tinyPngBase64,
        title: 'Скриншот интерфейса боя',
        source: 'vault_ui',
      });
    });
    await vault.waitForTimeout(350);

    // Switch to Заметки -> must be 2-pane split studio (NOT OmniComposer feed clone!)
    await vault.getByTestId('nav-notes').click();
    await vault.waitForSelector('[data-testid="notes-hub-view"]', { timeout: 5000 });
    await vault.waitForSelector('[data-testid="notes-list-pane"]', { timeout: 5000 });
    await vault.waitForSelector('[data-testid="note-studio"]', { timeout: 5000 });
    assert.equal(
      await vault.locator('[data-testid="omni-composer"]').count(),
      0,
      'Заметки must NOT render generic OmniComposer feed clone'
    );
    const notesListDefaultText = await vault.getByTestId('notes-list-pane').innerText();
    assert.ok(
      !notesListDefaultText.includes('3 ступени графики'),
      'Short 1-line Telegram message must not clutter Мои заметки by default'
    );
    // Create a brand-new inline note right inside 2-pane Заметки
    await vault.getByTestId('notes-new-btn').click();
    await vault.waitForSelector('[data-testid="notes-draft-row"]', { timeout: 4000 });
    await vault.getByTestId('note-studio-title').fill('Дизайн-документ боёвки');
    await vault.getByTestId('note-studio-editor').click();
    await vault.keyboard.type('Рывок по направлению взгляда и плавная камера.');
    await vault.waitForTimeout(700);
    const notesListAfterCreate = await vault.getByTestId('notes-list-pane').innerText();
    assert.ok(
      notesListAfterCreate.includes('Дизайн-документ боёвки'),
      'New inline note must appear immediately in left Notes list pane'
    );
    await saveShot(vault, '20-notes-studio-2pane.png');
    await assertCleanHumanCopy(vault, '10b-notes');

    // Verify Ctrl+N inside Заметки opens inline draft (no overlapping Side-Sheet)
    // AND fast-switching away within 100ms still saves the draft cleanly (zero data loss!)
    await vault.keyboard.press('Control+n');
    await vault.waitForSelector('[data-testid="notes-draft-row"]', { timeout: 4000 });
    assert.equal(
      await vault.locator('[data-testid="studio-side-sheet"]').count(),
      0,
      'Header + inside Заметки must NOT open an overlapping Side-Sheet'
    );
    await vault.getByTestId('note-studio-title').fill('Быстрый черновик без потерь');
    // Immediately switch to another note BEFORE the 420ms debounce timer fires!
    await vault.locator('[data-testid^="notes-list-item-"]').first().click();
    await vault.waitForFunction(
      () => {
        const pane = document.querySelector('[data-testid="notes-list-pane"]');
        return pane && pane.innerText.includes('Быстрый черновик без потерь');
      },
      undefined,
      { timeout: 5000 }
    );
    const fastDraftMeta = await vault.evaluate(async () => {
      const all = await window.kapsula.queryVault({ limit: 50 });
      const found = all.find((x) => x.title === 'Быстрый черновик без потерь');
      return found ? { orbit: found.orbit, remindAt: found.remindAt, focusBoardId: found.focusBoardId } : null;
    });
    assert.ok(fastDraftMeta, 'Fast-switched draft must be persisted in SQLite');
    assert.equal(fastDraftMeta.orbit, '', `Fast-switched draft must NOT steal target note's orbit: ${JSON.stringify(fastDraftMeta)}`);
    assert.equal(fastDraftMeta.remindAt, null, `Fast-switched draft must NOT steal target note's reminder: ${JSON.stringify(fastDraftMeta)}`);

    // Switch to Медиа -> must be dedicated Visual Gallery Hub (NOT OmniComposer feed clone!)
    await vault.getByTestId('nav-media').click();
    await vault.waitForSelector('[data-testid="media-hub-view"]', { timeout: 5000 });
    await vault.waitForSelector('[data-testid="media-category-tabs"]', { timeout: 5000 });
    assert.equal(
      await vault.locator('[data-testid="omni-composer"]').count(),
      0,
      'Медиа must NOT render generic text OmniComposer feed clone'
    );
    const mediaVisualGridCount = await vault.locator('[data-testid^="media-tile-"]').count();
    assert.ok(mediaVisualGridCount >= 1, 'Медиа gallery must display visual tiles');
    await vault.waitForTimeout(250);
    await saveShot(vault, '21-media-gallery-hub.png');
    await assertCleanHumanCopy(vault, '10b-media');

    // Switch to Задачи -> dedicated Tasks Hub
    await vault.getByTestId('nav-tasks').click();
    await vault.waitForSelector('[data-testid="tasks-hub-view"]', { timeout: 5000 });
    assert.equal(
      await vault.locator('[data-testid="omni-composer"]').count(),
      0,
      'Задачи must NOT render OmniComposer'
    );
    await vault.waitForTimeout(220);
    await saveShot(vault, '22-tasks-hub.png');
    metrics.invariants.distinctWorkspacesVerified = true;

    // -------------------------------------------------------------------------
    // 11. Settings Modal (7 Tabs Zero-Jump + No Native Select)
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 11 - Settings Modal Zero-Jump 7 Tabs');
    await vault.getByTestId('open-settings-btn').click();
    const settingsDialog = vault.locator('[role="dialog"]');
    await settingsDialog.waitFor({ state: 'visible', timeout: 5000 });
    await vault.waitForTimeout(260); // wait for 180ms opening scale animation to finish
    assert.equal(await vault.locator('select').count(), 0, 'Native <select> forbidden in UI');

    const stStartBox = await settingsDialog.boundingBox();
    metrics.zeroJump.settingsModalTabs = [];
    for (const tabName of ['ИИ', 'Интеграции', 'Безопасность', 'Данные', 'Синхронизация', 'Клавиши', 'Внешний вид']) {
      await settingsDialog.getByRole('tab', { name: tabName, exact: true }).click();
      await vault.waitForTimeout(180);
      const b = await settingsDialog.boundingBox();
      metrics.zeroJump.settingsModalTabs.push({
        tab: tabName,
        dy: assertNearZero(b.y, stStartBox.y, `settings-y-${tabName}`),
        dh: assertNearZero(b.height, stStartBox.height, `settings-h-${tabName}`),
      });
      if (tabName === 'Интеграции') {
        await saveShot(vault, '12-settings-integrations.png');
      }
    }
    await assertCleanHumanCopy(vault, '11-settings');
    await vault.keyboard.press('Escape');
    await vault.waitForTimeout(220);

    // -------------------------------------------------------------------------
    // 12. Voice Recording (.wav Saved) + Assistant + Porcelain Light Theme
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 12 - Voice WAV Persistence, Assistant & Light Theme');
    await vault.getByTestId('nav-flow').click();
    await vault.waitForTimeout(250);
    await vault.evaluate(() => {
      window.__KAPSULA_SYNTH_MIC__ = true;
    });
    await vault.locator('[data-testid="omni-dictate-btn"]:not([inert] *)').first().click();
    await vault.waitForSelector('[data-testid="voice-recorder-studio"]', { timeout: 5000 });
    await vault.waitForTimeout(1150);
    await vault.getByTestId('voice-finish-btn').click();
    await vault.waitForSelector('[data-testid="waveform-audio-player"]', { timeout: 15000 });
    const playerText = await vault.getByTestId('waveform-audio-player').first().innerText();
    assert.ok(!playerText.includes('NaN') && !playerText.includes('Infinity'), `Bad audio clock: ${playerText}`);

    // Collapse OmniComposer cleanly after voice recording before checking Assistant zero-shift invariant
    await vault.locator('[data-testid="studio-workspace"] header').click({ position: { x: 80, y: 20 } });
    await vault.waitForTimeout(260);

    // Verify Floating Docked Assistant opens/closes with 0.00px layout jerk on composer & feed cards!
    const captureTrackedFeedRects = () =>
      vault.evaluate(() => {
        const composer = document.querySelector('[data-testid="omni-composer"]');
        const cards = Array.from(document.querySelectorAll('[data-testid^="memory-card-"]')).slice(0, 3);
        return [composer, ...cards]
          .filter(Boolean)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              id: el.getAttribute('data-testid'),
              x: Number(r.x.toFixed(2)),
              y: Number(r.y.toFixed(2)),
              w: Number(r.width.toFixed(2)),
              h: Number(r.height.toFixed(2)),
            };
          });
      });
    const rectsBeforeAsst = await captureTrackedFeedRects();

    const asstFramesPromise = sampleFrames(vault, '[data-testid="assistant-drawer"]', [0, 45, 110, 240]);
    await vault.getByTestId('assistant-open-btn').click();
    const asstFrames = await asstFramesPromise;
    metrics.motionFrames.assistantSlide = asstFrames;
    await vault.waitForSelector('[data-testid="assistant-drawer"]', { timeout: 5000 });
    await vault.waitForTimeout(100);

    const rectsDuringAsstOpen = await captureTrackedFeedRects();
    let maxAsstShift = 0;
    for (let i = 0; i < rectsBeforeAsst.length; i++) {
      const a = rectsBeforeAsst[i];
      const b = rectsDuringAsstOpen[i];
      assert.ok(a && b);
      maxAsstShift = Math.max(
        maxAsstShift,
        assertNearZero(b.x, a.x, `asst-open-x-${a.id}`, 0.25),
        assertNearZero(b.y, a.y, `asst-open-y-${a.id}`, 0.25),
        assertNearZero(b.w, a.w, `asst-open-w-${a.id}`, 0.25),
        assertNearZero(b.h, a.h, `asst-open-h-${a.id}`, 0.25)
      );
    }
    metrics.invariants.assistantOpenFeedShiftPx = maxAsstShift;

    const asstInitialText = await vault.getByTestId('assistant-drawer').innerText();
    assert.ok(!asstInitialText.includes('Понимает запросы RU'), 'Assistant header must not show technical RU/EN subtitle');

    // Verify docked overlay does NOT block left navigation clicks while open
    const asstBox = await vault.getByTestId('assistant-drawer').boundingBox();
    assert.ok(
      asstBox && asstBox.x > 380 && asstBox.width >= 330 && asstBox.width <= 480,
      `Assistant must dock on right without covering full viewport: ${JSON.stringify(asstBox)}`
    );
    await vault.getByTestId('nav-tasks').click();
    await vault.waitForSelector('[data-testid="tasks-hub-view"]', { timeout: 3000 });
    await vault.getByTestId('nav-flow').click();
    await vault.waitForSelector('[data-testid="feed-grid-container"]', { timeout: 3000 });
    metrics.invariants.assistantDockedNonBlocking = true;

    await vault.getByTestId('assistant-input').fill('какие у меня есть сохраненки из инстаграма?');
    await vault.getByTestId('assistant-send-btn').click();
    await vault.waitForFunction(
      () => {
        const d = document.querySelector('[data-testid="assistant-drawer"]');
        return d && d.innerText.includes('Shader Breakdown') && !d.innerText.includes('Ищу по хранилищу');
      },
      { timeout: 12000 }
    );
    const asstText = await vault.getByTestId('assistant-drawer').innerText();
    assert.ok(!asstText.includes('Хроно'), 'Instagram-scoped Assistant query must not pull unrelated notes');
    for (const banned of BANNED_ASSISTANT_TERMS) {
      assert.ok(!asstText.toLowerCase().includes(banned), `Assistant leaked banned string "${banned}"`);
    }
    await saveShot(vault, '13-assistant-drawer.png');
    await vault.getByRole('button', { name: 'Закрыть ассистента' }).click();
    await vault.waitForTimeout(240);
    const rectsAfterAsstClose = await captureTrackedFeedRects();
    for (let i = 0; i < rectsBeforeAsst.length; i++) {
      const a = rectsBeforeAsst[i];
      const b = rectsAfterAsstClose[i];
      assertNearZero(b.x, a.x, `asst-close-x-${a.id}`, 0.25);
      assertNearZero(b.w, a.w, `asst-close-w-${a.id}`, 0.25);
    }

    // Light Theme Screenshot
    await vault.getByTestId('theme-toggle-btn').click();
    await vault.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 5000 });
    await vault.waitForTimeout(350);
    await saveShot(vault, '14-light-theme-grid.png');

    await vault.getByTestId('theme-toggle-btn').click();
    await vault.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 5000 });
    await vault.waitForTimeout(300);
    await saveShot(vault, '15-dark-theme-grid.png');

    // Verify Медиа displays BOTH visual tiles AND dedicated Audio/Voice waveform shelf together
    await vault.getByTestId('nav-media').click();
    await vault.waitForSelector('[data-testid="media-visual-grid"]', { timeout: 5000 });
    await vault.waitForSelector('[data-testid="media-audio-section"]', { timeout: 5000 });
    await vault.waitForTimeout(250);
    await saveShot(vault, '23-media-with-audio.png');
    await vault.getByTestId('nav-flow').click();
    await vault.waitForTimeout(180);

    // -------------------------------------------------------------------------
    // 13. Alt+Пробел 5-Tab Command HUD Verification + Slide Without Height Squash
    // -------------------------------------------------------------------------
    console.log('[e2e-v6] 13 - Alt+Пробел 5-Tab Command HUD');
    await vault.evaluate(() => window.kapsula.windowAction('open-hud'));
    await hud.waitForSelector('[data-testid="command-hud"]', { timeout: 5000 });
    await hud.waitForTimeout(280);

    const hudOpacityBg = await hud.evaluate(() => {
      const panel = document.querySelector('[data-testid="command-hud"] > div');
      return panel ? getComputedStyle(panel).backgroundColor : '';
    });
    metrics.invariants.hudBackground = hudOpacityBg;
    await saveShot(hud, '16-hud-search.png');

    for (const [tabLabel, shotFile] of [
      ['Записать', '17-hud-capture.png'],
      ['Сейф', '18-hud-vault.png'],
      ['Сегодня', '19-hud-today.png'],
      ['Важное', null],
    ]) {
      const hudThumbFramesPromise = sampleFrames(hud, '[data-testid="segmented-thumb"]', [0, 45, 95, 220]);
      await hud.getByRole('tab', { name: tabLabel }).click();
      const hudThumbFrames = await hudThumbFramesPromise;
      if (tabLabel === 'Записать') {
        metrics.motionFrames.hudSegmentedThumbGlide = hudThumbFrames;
        const hx = hudThumbFrames.map((f) => f.x).filter((v) => typeof v === 'number');
        assert.ok(
          hx.length >= 3 && (hx[1] > hx[0] + 1 || hx[2] < hx[hx.length - 1] - 1),
          `Expected HUD SegmentedControl horizontal glide, got ${JSON.stringify(hudThumbFrames)}`
        );
      }
      await hud.waitForTimeout(80);
      if (tabLabel === 'Сейф') {
        const hudVaultText = await hud.getByTestId('command-hud').innerText();
        assert.ok(hudVaultText.includes('09/29'), `HUD Сейф must display bank card expiry 09/29, got "${hudVaultText}"`);
      }
      if (shotFile) await saveShot(hud, shotFile);
    }

    fs.writeFileSync(path.join(AUDIT_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    console.log('[e2e-v6] ALL E2E & MOTION INVARIANTS PASSED!');
    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    if (app) {
      await Promise.race([app.close(), sleep(4000)]).catch(() => {});
    }
    killStrayProcesses();
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      await sleep(300);
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[e2e-v6] FAILED:', err);
  killStrayProcesses();
  process.exitCode = 1;
});
