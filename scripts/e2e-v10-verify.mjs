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
const ARTIFACT_DIR = process.env.KAPSULA_V10_AUDIT_DIR
  ? path.resolve(process.env.KAPSULA_V10_AUDIT_DIR)
  : path.join(ROOT_DIR, '.tmp', 'v10-desktop-audit');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWorkspaceExePids() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Process Kapsula -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*\\Notes+\\release\\win-unpacked\\Kapsula.exe\' } | Select-Object -ExpandProperty Id"',
      { encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function killWorkspaceExeProcesses() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process Kapsula -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*\\Notes+\\release\\win-unpacked\\Kapsula.exe\' } | Stop-Process -Force"',
      { stdio: 'ignore' }
    );
  } catch {
    // ignore
  }
}

function parseCssColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const rgbM =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(
      raw.trim()
    );
  if (!rgbM) return null;
  return {
    r: Number(rgbM[1]),
    g: Number(rgbM[2]),
    b: Number(rgbM[3]),
    a: rgbM[4] !== undefined ? Number(rgbM[4]) : 1,
  };
}

async function waitForSurfaces(app, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wins = app.windows();
    const vault = wins.find((w) => w.url().includes('surface=vault') || !w.url().includes('surface='));
    const hud = wins.find((w) => w.url().includes('surface=hud'));
    if (vault && hud) {
      await Promise.all([
        vault.waitForLoadState('domcontentloaded'),
        hud.waitForLoadState('domcontentloaded'),
      ]);
      return { vault, hud };
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for Vault + HUD windows (found ${app.windows().length})`);
}

async function saveShot(page, name, shots) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const outPath = path.join(ARTIFACT_DIR, name);
  await page.screenshot({ path: outPath });
  shots.push(outPath);
  console.log(`  [shot] ${name}`);
  return outPath;
}

async function main() {
  assert.ok(fs.existsSync(EXE_PATH), `Missing packaged exe: ${EXE_PATH}. Run npm run pack:win first.`);
  killWorkspaceExeProcesses();

  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-e2e-v10-'));
  const report = {
    startedAt: new Date().toISOString(),
    exePath: EXE_PATH,
    artifactDir: ARTIFACT_DIR,
    checks: {},
    shots: [],
    pageErrors: [],
    consoleErrors: [],
    metrics: {},
  };

  async function runCheck(key, label, fn) {
    console.log(`\n[v10-e2e] ${key}: ${label}`);
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.checks[key] = { status: 'PASS', ms: Date.now() - t0, detail: detail ?? null };
      console.log(`  [PASS] ${key} (${Date.now() - t0}ms)`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.checks[key] = { status: 'FAIL', ms: Date.now() - t0, error: message };
      console.error(`  [FAIL] ${key}: ${message}`);
      return false;
    }
  }

  let app;
  let vault;
  let hud;

  try {
    app = await electron.launch({
      executablePath: EXE_PATH,
      env: {
        ...process.env,
        KAPSULA_DATA_DIR: tmpDataDir,
        KAPSULA_LOCALE: 'ru',
        KAPSULA_E2E_QUIT_ON_CLOSE: '1',
        KAPSULA_E2E_KEEP_HUD: '1',
        KAPSULA_SKIP_SENDKEYS: '1',
      },
    });

    ({ vault, hud } = await waitForSurfaces(app));

    const attachErrorCollectors = (win, name) => {
      win.on('pageerror', (err) => {
        report.pageErrors.push({ window: name, at: Date.now(), message: err?.stack || String(err) });
      });
      win.on('console', (msg) => {
        if (msg.type() === 'error') {
          report.consoleErrors.push({ window: name, at: Date.now(), text: msg.text() });
        }
      });
    };
    attachErrorCollectors(vault, 'vault');
    attachErrorCollectors(hud, 'hud');

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((bw) => bw.webContents.getURL().includes('surface=vault'));
      if (win) win.setSize(1380, 900);
    });

    await vault.waitForSelector('[data-testid="studio-workspace"]', { timeout: 15000 });
    await vault.waitForTimeout(450);

    // Dismiss initial onboarding modal cleanly
    const onboarding = vault.getByTestId('onboarding-modal');
    if (await onboarding.isVisible().catch(() => false)) {
      await vault.getByTestId('onboarding-next-btn').click();
      await vault.waitForTimeout(200);
      await vault.getByTestId('onboarding-next-btn').click();
      await vault.waitForTimeout(200);
      await vault.getByTestId('onboarding-start-local-btn').click();
      await onboarding.waitFor({ state: 'detached', timeout: 6000 });
      await vault.waitForTimeout(250);
    }

    // 1. Instant right-click context menu & zero card jump
    await runCheck('01_context_menu_speed', 'Right-click context menu opens immediately without layout shift', async () => {
      await vault.evaluate(async () => {
        await window.kapsula.capture({
          title: 'Проверка меню V10',
          text: 'Тестовая карточка для правого клика и выравнивания.',
          source: 'vault_ui',
        });
      });
      await vault.waitForTimeout(300);

      const firstCard = vault.locator('[data-testid="feed-grid-container"] > *').first();
      await firstCard.waitFor({ state: 'visible', timeout: 6000 });
      const beforeBox = await firstCard.boundingBox();
      assert.ok(beforeBox, 'Missing card bounding box');

      const tOpen0 = performance.now();
      await firstCard.click({ button: 'right' });
      const popup = vault.getByTestId('context-menu-popup');
      await popup.waitFor({ state: 'visible', timeout: 2500 });
      const openMs = Math.round(performance.now() - tOpen0);
      const afterBox = await firstCard.boundingBox();
      assert.ok(afterBox && Math.abs(afterBox.y - beforeBox.y) <= 1, 'Card jumped vertically on right-click');

      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(160);
      report.metrics.contextMenuOpenMs = openMs;
      assert.ok(openMs < 250, `Context menu took too long: ${openMs}ms`);
      return { openMs, yShiftPx: Math.abs(afterBox.y - beforeBox.y) };
    });

    // 2. Standalone task creation, TaskDetailSheet edit & inline section Tasks tab
    await runCheck('02_tasks_studio_and_sheet', 'Standalone task CRUD, TaskDetailSheet notes/due edit & inline section tasks', async () => {
      await vault.getByTestId('nav-tasks').click();
      await vault.waitForSelector('[data-testid="tasks-hub-view"]', { timeout: 6000 });
      await vault.waitForTimeout(220);

      const quickInput = vault.getByTestId('quick-task-input');
      await quickInput.fill('Подготовить сборку релиза V10');
      await quickInput.press('Enter');
      await vault.waitForTimeout(350);

      const createdTasks = await vault.evaluate(() => window.kapsula.listTasks());
      const task = createdTasks.find((t) => t.text.includes('Подготовить сборку релиза V10'));
      assert.ok(task, 'Standalone task was not created in SQLite');

      const detailsBtn = vault.getByTestId(`task-details-btn-${task.id}`);
      if (await detailsBtn.isVisible().catch(() => false)) {
        await detailsBtn.click();
      } else {
        await vault.getByText('Подготовить сборку релиза V10').first().click();
      }

      const sheet = vault.getByTestId('task-detail-sheet');
      await sheet.waitFor({ state: 'visible', timeout: 5000 });
      const notesBox = vault.getByTestId('task-sheet-notes');
      await notesBox.fill('Проверить иконку и оба скрипта проверки.');
      await notesBox.blur();
      await vault.getByTestId('task-sheet-date-input').fill('2026-12-05');
      await vault.waitForTimeout(250);
      await saveShot(vault, 'v10-audit-tasks.png', report.shots);

      await vault.getByTestId('task-sheet-close-btn').click();
      await sheet.waitFor({ state: 'detached', timeout: 4000 });

      const updatedTasks = await vault.evaluate(() => window.kapsula.listTasks());
      const reloaded = updatedTasks.find((t) => t.id === task.id);
      assert.ok(reloaded && reloaded.notes?.includes('Проверить иконку'), 'TaskDetailSheet notes did not persist');
      assert.ok(reloaded.dueAt != null, 'TaskDetailSheet due date did not persist');

      // Inline Tasks tab inside first starter section
      const firstOrbitBtn = vault.locator('[data-testid^="sidebar-orbit-"]').first();
      await firstOrbitBtn.click();
      await vault.waitForTimeout(200);
      const inlineTasksChip = vault.getByTestId('feed-quick-filters').getByRole('button', { name: /Задачи/i });
      await inlineTasksChip.click();
      await vault.waitForSelector('[data-testid="tasks-hub-view"]', { timeout: 5000 });

      return { taskId: task.id, dueAt: reloaded.dueAt };
    });

    // 3. Calendar 24h grid, Week/Day/Month/Agenda, side-by-side overlaps, auto-scroll to 07:00 & +N popover
    await runCheck('03_calendar_overlaps_and_views', 'Calendar 24h auto-scroll, side-by-side overlaps, Day view, Month +N popover & Agenda groups', async () => {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const d = now.getDate();
      const todayKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const overflowDayKey = `${y}-${String(m + 1).padStart(2, '0')}-15`;

      const seededIds = await vault.evaluate(
        async ({ year, month, day }) => {
          const ts = (dy, h, min) => new Date(year, month, dy, h, min, 0, 0).getTime();
          const a = await window.kapsula.upsertCalendarEvent({
            title: 'Архитектурный разбор',
            startAt: ts(day, 10, 0),
            endAt: ts(day, 11, 30),
            hasEndTime: true,
            color: '#E86A33',
          });
          const b = await window.kapsula.upsertCalendarEvent({
            title: 'Дизайн ревью',
            startAt: ts(day, 10, 30),
            endAt: ts(day, 12, 0),
            hasEndTime: true,
            color: '#3B82F6',
          });
          const c = await window.kapsula.upsertCalendarEvent({
            title: 'Синк по бэкенду',
            startAt: ts(day, 11, 0),
            endAt: ts(day, 12, 30),
            hasEndTime: true,
            color: '#10B981',
          });
          await window.kapsula.upsertCalendarEvent({
            title: 'Релизная заморозка',
            startAt: ts(day, 0, 0),
            endAt: ts(day, 23, 59),
            allDay: true,
            color: '#8B5CF6',
          });
          for (let i = 1; i <= 5; i += 1) {
            await window.kapsula.upsertCalendarEvent({
              title: `Пункт переполнения ${i}`,
              startAt: ts(15, 8 + i, 0),
              endAt: ts(15, 9 + i, 0),
              hasEndTime: true,
            });
          }
          return { aId: a.id, bId: b.id, cId: c.id };
        },
        { year: y, month: m, day: d }
      );

      await vault.getByTestId('nav-calendar').click();
      await vault.waitForSelector('[data-testid="calendar-hub-view"]', { timeout: 6000 });
      await vault.waitForTimeout(300);

      // Month +N overflow popover
      const overflowBtn = vault.getByTestId(`calendar-overflow-${overflowDayKey}`);
      await overflowBtn.waitFor({ state: 'visible', timeout: 5000 });
      await overflowBtn.click();
      await vault.waitForTimeout(180);
      await vault.getByRole('button', { name: /Пункт переполнения 5/ }).waitFor({ state: 'visible', timeout: 3000 });
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(180);

      // Jump back to Today (after selecting Day 15 overflow) before switching to Week view
      await vault.getByRole('button', { name: 'Сегодня', exact: true }).click();
      await vault.waitForTimeout(140);

      // Switch to Week view -> check 07:00 auto-scroll, all-day strip & side-by-side non-overlapping boxes
      await vault.getByRole('tab', { name: 'Неделя' }).click();
      await vault.waitForSelector('[data-testid="calendar-time-grid-scroll"]', { timeout: 5000 });
      await vault.waitForTimeout(240);

      const scrollTop = await vault
        .getByTestId('calendar-time-grid-scroll')
        .evaluate((el) => el.scrollTop);
      assert.ok(scrollTop >= 240, `Expected week grid to auto-scroll near 07:00 (~322px), got ${scrollTop}`);
      await vault.getByTestId('calendar-allday-strip').waitFor({ state: 'visible', timeout: 4000 });

      const evA = vault.getByTestId(`calendar-timed-event-${seededIds.aId}`);
      const evB = vault.getByTestId(`calendar-timed-event-${seededIds.bId}`);
      const evC = vault.getByTestId(`calendar-timed-event-${seededIds.cId}`);
      const boxes = await Promise.all([evA.boundingBox(), evB.boundingBox(), evC.boundingBox()]);
      assert.ok(boxes[0] && boxes[1] && boxes[2], 'Missing bounding boxes for overlapping week events');
      boxes.sort((x, yBox) => x.x - yBox.x);
      assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x + 2, 'Week overlapping events A/B collide horizontally');
      assert.ok(boxes[1].x + boxes[1].width <= boxes[2].x + 2, 'Week overlapping events B/C collide horizontally');

      await saveShot(vault, 'v10-audit-calendar-week.png', report.shots);

      // Switch to Day view (today already selected)
      await vault.getByRole('tab', { name: 'День' }).click();
      await vault.waitForTimeout(200);
      await vault.waitForSelector(`[data-testid="calendar-time-col-${todayKey}"]`, { timeout: 5000 });
      const dayBoxes = await Promise.all([evA.boundingBox(), evB.boundingBox()]);
      assert.ok(dayBoxes[0] && dayBoxes[1], 'Missing bounding boxes in Day view');
      dayBoxes.sort((x, yBox) => x.x - yBox.x);
      assert.ok(dayBoxes[0].x + dayBoxes[0].width <= dayBoxes[1].x + 2, 'Day view overlapping events collide');
      await saveShot(vault, 'v10-audit-calendar-day.png', report.shots);

      // Switch to Agenda view
      await vault.getByRole('tab', { name: 'Список' }).click();
      await vault.waitForSelector('[data-testid="calendar-agenda-list"]', { timeout: 5000 });
      const agendaText = await vault.getByTestId('calendar-agenda-list').innerText();
      assert.ok(agendaText.includes('Архитектурный разбор'), 'Expected seeded event inside grouped agenda');

      return { scrollTop, weekColumns: boxes.map((b) => Math.round(b.width)) };
    });

    // 4. Sidebar drag-resize to Icon-Rail (~60px) -> restore + double-click reset & counter alignment
    await runCheck('04_sidebar_resize_and_rail', 'Sidebar drag-resizes to 60px Icon-Rail, restores, dblclick resets, counters stay aligned', async () => {
      await vault.getByTestId('nav-flow').click();
      await vault.waitForTimeout(220);

      const counterPositions = await vault.evaluate(() => {
        const els = [...document.querySelectorAll('[data-testid^="orbit-count-"]')];
        return els.map((el) => Math.round(el.getBoundingClientRect().right * 10) / 10);
      });
      if (counterPositions.length >= 2) {
        const spread = Math.max(...counterPositions) - Math.min(...counterPositions);
        report.metrics.sidebarCountersSpread = spread;
        assert.ok(spread <= 1.2, `Sidebar counters misaligned: spread=${spread}px`);
      }

      const sidebar = vault.getByTestId('workspace-sidebar');
      const handle = vault.getByTestId('sidebar-resize-handle');
      const hBox = await handle.boundingBox();
      assert.ok(hBox, 'Missing sidebar resize handle');

      // Drag left past 164px snap threshold -> Icon-Rail (~60px)
      await vault.mouse.move(hBox.x + hBox.width / 2, hBox.y + 180);
      await vault.mouse.down();
      await vault.mouse.move(40, hBox.y + 180, { steps: 10 });
      await vault.mouse.up();
      await vault.waitForTimeout(240);

      const railBox = await sidebar.boundingBox();
      assert.ok(railBox && railBox.width >= 52 && railBox.width <= 72, `Expected ~60px icon-rail, got ${railBox?.width}`);
      const railText = await sidebar.innerText();
      assert.ok(!railText.includes('Нет холст'), `Clipped placeholder leaked in Icon-Rail: ${railText}`);
      await vault.locator('header [data-testid="toggle-sidebar-btn"]').waitFor({ state: 'visible', timeout: 3000 });
      await saveShot(vault, 'v10-audit-sidebar-rail.png', report.shots);

      // Drag right from rail -> expands cleanly
      const hRailBox = await handle.boundingBox();
      assert.ok(hRailBox, 'Missing resize handle in rail mode');
      await vault.mouse.move(hRailBox.x + hRailBox.width / 2, hRailBox.y + 180);
      await vault.mouse.down();
      await vault.mouse.move(290, hRailBox.y + 180, { steps: 10 });
      await vault.mouse.up();
      await vault.waitForTimeout(220);

      const expandedBox = await sidebar.boundingBox();
      assert.ok(expandedBox && expandedBox.width >= 240, `Expected expanded sidebar >= 240px, got ${expandedBox?.width}`);

      // Double-click handle -> resets to 244px default
      await handle.dblclick();
      await vault.waitForTimeout(220);
      const resetBox = await sidebar.boundingBox();
      assert.ok(resetBox && Math.abs(resetBox.width - 244) <= 8, `Expected ~244px reset width, got ${resetBox?.width}`);

      return { railWidth: railBox.width, expandedWidth: expandedBox.width, resetWidth: resetBox.width };
    });

    // 5. Glassmorphism toggle + opaque HUD invariant + Data tab Video Cache controls
    await runCheck('05_glass_and_video_cache_ui', 'Glassmorphism works on Vault, HUD stays 100% opaque, Video Cache controls present', async () => {
      await vault.getByTestId('open-settings-btn').click();
      const dialog = vault.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(220);

      const glassCard = vault.getByTestId('appearance-glass-card');
      await glassCard.getByRole('tab', { name: 'Матовое' }).click();
      await vault.waitForTimeout(220);

      const attr = await vault.evaluate(() => document.documentElement.getAttribute('data-glass'));
      assert.equal(attr, 'frosted', `Expected data-glass="frosted", got ${attr}`);

      // Close settings briefly so v10-audit-glass-frosted.png captures the live frosted workspace unobstructed
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(220);
      await vault.getByTestId('nav-flow').click();
      await vault.waitForTimeout(220);
      await saveShot(vault, 'v10-audit-glass-frosted.png', report.shots);

      // Verify Command HUD stays strictly opaque even with frosted Vault enabled
      await vault.evaluate(() => window.kapsula.windowAction('open-hud'));
      await hud.waitForSelector('[data-testid="command-hud"]', { timeout: 6000 });
      await hud.waitForTimeout(220);
      const hudBg = await hud.evaluate(() => {
        const outer = document.querySelector('[data-testid="command-hud"] > div');
        return outer ? getComputedStyle(outer).backgroundColor : '';
      });
      const parsedHudBg = parseCssColor(hudBg);
      assert.ok(parsedHudBg && parsedHudBg.a === 1, `Command HUD must stay opaque (alpha=1), got ${hudBg}`);
      await vault.evaluate(() => window.kapsula.windowAction('close-hud'));

      // Re-open Settings, restore glass to off & inspect Video Cache Data UI
      await vault.getByTestId('open-settings-btn').click();
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(180);
      await vault.getByTestId('appearance-glass-card').getByRole('tab', { name: 'Выкл' }).click();
      await vault.waitForTimeout(160);

      // Switch to Data tab -> inspect Video Cache controls & localized "0 Б" / "МБ"
      await dialog.getByRole('tab', { name: 'Данные' }).click();
      await vault.waitForSelector('[data-testid="video-cache-limit-select"]', { timeout: 5000 });
      await vault.getByTestId('clear-video-cache-btn').waitFor({ state: 'visible', timeout: 4000 });
      await vault.waitForTimeout(220);
      const dataText = await dialog.innerText();
      assert.ok(dataText.includes('0 Б'), `Expected localized "0 Б" in video cache summary, got:\n${dataText}`);
      assert.ok(
        dataText.includes('500 МБ') || dataText.includes('250 МБ'),
        `Expected localized МБ limit label in select`
      );
      await saveShot(vault, 'v10-audit-settings-data.png', report.shots);

      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(180);

      return { glassAttr: attr, hudBg };
    });
  } finally {
    if (app) {
      await Promise.race([app.close(), sleep(4000)]).catch(() => {});
    }
    killWorkspaceExeProcesses();
    await sleep(300);
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      await sleep(300);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {
        // ignore lock
      }
    }
  }

  const strayAfterExit = getWorkspaceExePids().length;
  report.checks['06_zero_stray_processes'] =
    strayAfterExit === 0
      ? { status: 'PASS', ms: 0, detail: { strayAfterExit } }
      : { status: 'FAIL', ms: 0, error: `Found ${strayAfterExit} stray workspace Kapsula.exe processes` };

  const checkEntries = Object.entries(report.checks);
  const failedChecks = checkEntries.filter(([, v]) => v.status !== 'PASS');

  console.log('\n================ V10 DESKTOP E2E SUMMARY ================');
  for (const [k, v] of checkEntries) {
    console.log(`  [${v.status}] ${k}${v.error ? ` — ${v.error}` : ''}`);
  }
  console.log(`  Page errors:    ${report.pageErrors.length}`);
  console.log(`  Console errors: ${report.consoleErrors.length}`);
  console.log(`  Screenshots:    ${report.shots.length} saved in ${ARTIFACT_DIR}`);

  if (report.pageErrors.length > 0) console.error('PAGE ERRORS:', report.pageErrors);
  if (report.consoleErrors.length > 0) console.error('CONSOLE ERRORS:', report.consoleErrors);

  if (failedChecks.length > 0 || report.pageErrors.length > 0 || report.consoleErrors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[v10-e2e] FATAL:', err);
  killWorkspaceExeProcesses();
  process.exitCode = 1;
});
