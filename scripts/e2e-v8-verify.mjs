import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EXE_PATH = path.join(ROOT_DIR, 'release', 'win-unpacked', 'Kapsula.exe');
const ICON_PATH = path.join(ROOT_DIR, 'build', 'icon.ico');
const AUDIT_DIR = process.env.KAPSULA_V8_AUDIT_DIR
  ? path.resolve(process.env.KAPSULA_V8_AUDIT_DIR)
  : path.join(ROOT_DIR, '.tmp', 'v8-desktop-audit');

const BANNED_TECH_TERMS = ['DPAPI', 'MTProto', 'FTS5', 'SQLite', 'SQLITE_', 'PKCE', 'ECONNREFUSED'];
const BANNED_SETTINGS_TERMS = ['my.telegram.org', 'api_id', 'api_hash', 'Supabase'];

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

function countStrayProcesses() {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execSync(
      'powershell -NoProfile -Command "@(Get-Process Kapsula,electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }
    ).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

// ---------- Synthesize real crisp multi-color PNG (no external deps) ----------
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generateTestPng(width = 160, height = 100) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      const px = rowOff + 1 + x * 3;
      const band = Math.floor((x / width) * 4);
      const border = x < 4 || x >= width - 4 || y < 4 || y >= height - 4;
      if (border) {
        raw[px] = 232;
        raw[px + 1] = 106;
        raw[px + 2] = 51;
      } else if (band === 0) {
        raw[px] = 24;
        raw[px + 1] = 32;
        raw[px + 2] = 54;
      } else if (band === 1) {
        raw[px] = 0;
        raw[px + 1] = 184;
        raw[px + 2] = 217;
      } else if (band === 2) {
        raw[px] = 232;
        raw[px + 1] = 106;
        raw[px + 2] = 51;
      } else {
        raw[px] = 46;
        raw[px + 1] = 160;
        raw[px + 2] = 107;
      }
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Synthesize real 16kHz mono PCM WAV buffer ----------
function generateMinimalWavBase64(durationSec = 1.6, sampleRate = 16000) {
  const numSamples = Math.round(durationSec * sampleRate);
  const buf = Buffer.alloc(44 + numSamples * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 220 * t) * 0.25;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buf.toString('base64');
}

// ---------- WCAG Contrast Helpers ----------
function parseCssColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const hexM = /^#([0-9a-f]{6})$/i.exec(s);
  if (hexM) {
    const h = hexM[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgbM = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(s);
  if (rgbM) {
    return {
      r: Number(rgbM[1]),
      g: Number(rgbM[2]),
      b: Number(rgbM[3]),
      a: rgbM[4] !== undefined ? Number(rgbM[4]) : 1,
    };
  }
  return null;
}

function relativeLuminance(rgb) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function contrastRatio(colorA, colorB) {
  const a = typeof colorA === 'string' ? parseCssColor(colorA) : colorA;
  const b = typeof colorB === 'string' ? parseCssColor(colorB) : colorB;
  if (!a || !b) return 0;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------- PE Icon Resource Verification ----------
function verifyExeIconResource() {
  assert.ok(fs.existsSync(EXE_PATH), `Missing packaged exe: ${EXE_PATH}`);
  assert.ok(fs.existsSync(ICON_PATH), `Missing build icon: ${ICON_PATH}`);

  const icoBuf = fs.readFileSync(ICON_PATH);
  // Find the PNG frame (0x89 PNG) inside build/icon.ico and verify its bytes exist in Kapsula.exe PE resources
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngIdx = icoBuf.indexOf(pngSig);
  assert.ok(pngIdx >= 0, 'Expected a 256x256 PNG frame inside build/icon.ico');
  const iconSlice = icoBuf.subarray(pngIdx, Math.min(icoBuf.length, pngIdx + 96));

  const exeBuf = fs.readFileSync(EXE_PATH);
  const embeddedOffset = exeBuf.indexOf(iconSlice);
  assert.ok(
    embeddedOffset >= 0,
    'Custom build/icon.ico PNG payload NOT found in release/win-unpacked/Kapsula.exe PE resources (default Electron icon risk!)'
  );

  // Also verify via .NET FileVersionInfo & ExtractAssociatedIcon
  const psCmd = [
    'Add-Type -AssemblyName System.Drawing',
    `$p = '${EXE_PATH.replace(/'/g, "''")}'`,
    '$vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)',
    '$ic = [System.Drawing.Icon]::ExtractAssociatedIcon($p)',
    '$w = if ($ic) { $ic.Width } else { 0 }',
    '$h = if ($ic) { $ic.Height } else { 0 }',
    'if ($ic) { $ic.Dispose() }',
    '[PSCustomObject]@{ ProductName = $vi.ProductName; CompanyName = $vi.CompanyName; FileDescription = $vi.FileDescription; IconWidth = $w; IconHeight = $h } | ConvertTo-Json -Compress',
  ].join('; ');
  const rawJson = execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
  const info = JSON.parse(rawJson);
  assert.equal(info.ProductName, 'Kapsula', `Expected ProductName=Kapsula, got ${info.ProductName}`);
  assert.ok(info.IconWidth >= 32 && info.IconHeight >= 32, `Invalid extracted icon dimensions: ${rawJson}`);
  return { embeddedOffset, ...info };
}

async function waitForSurfaces(app, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wins = app.windows();
    const capsule = wins.find((w) => w.url().includes('surface=capsule'));
    assert.equal(capsule, undefined, 'Floating companion orb (surface=capsule) MUST NOT exist');
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
  const outPath = path.join(AUDIT_DIR, name);
  await page.screenshot({ path: outPath });
  shots.push(outPath);
  console.log(`  [shot] ${name}`);
  return outPath;
}

async function main() {
  assert.ok(fs.existsSync(EXE_PATH), `Packaged binary missing at ${EXE_PATH}. Run npm run pack:win first.`);
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  for (const old of fs.readdirSync(AUDIT_DIR)) {
    if (old.endsWith('.png') || old.endsWith('.json')) {
      fs.rmSync(path.join(AUDIT_DIR, old), { force: true });
    }
  }

  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-e2e-v8-'));
  const tmpPngPath = path.join(tmpDataDir, 'v8-inline-sample.png');
  const testPngBuf = generateTestPng(160, 100);
  fs.writeFileSync(tmpPngPath, testPngBuf);
  const testPngBase64 = testPngBuf.toString('base64');
  const minimalWavBase64 = generateMinimalWavBase64(1.8);

  const report = {
    startedAt: new Date().toISOString(),
    exePath: EXE_PATH,
    auditDir: AUDIT_DIR,
    checks: {},
    shots: [],
    pageErrors: [],
    consoleErrors: [],
    metrics: {},
  };

  async function runCheck(key, label, fn) {
    console.log(`\n[v8-e2e] ${key}: ${label}`);
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
    // Pre-check PE icon resource
    await runCheck('00_pe_icon', 'Kapsula.exe PE icon resource & metadata', async () => {
      return verifyExeIconResource();
    });

    console.log(`[v8-e2e] Launching packaged Kapsula.exe with isolated KAPSULA_DATA_DIR=${tmpDataDir}`);
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

    // Set comfortable desktop viewport so Kanban & 2-pane studio render spaciously
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((bw) => bw.webContents.getURL().includes('surface=vault'));
      if (win) win.setSize(1380, 900);
    });

    await vault.waitForSelector('[data-testid="studio-workspace"]', { timeout: 15000 });
    await vault.waitForTimeout(500);

    // =========================================================================
    // 01. Universal Onboarding Modal
    // =========================================================================
    await runCheck('01_onboarding', 'Empty vault universal OnboardingModal & starter setup', async () => {
      const modal = vault.getByTestId('onboarding-modal');
      await modal.waitFor({ state: 'visible', timeout: 8000 });
      await vault.waitForTimeout(260);

      const step1Text = await modal.innerText();
      for (const forbidden of ['Telegram', 'Телеграм', 'Supabase', 'Юнити', 'Тинькофф', 'Unity']) {
        assert.ok(
          !step1Text.toLowerCase().includes(forbidden.toLowerCase()),
          `Onboarding must not contain personal/legacy term "${forbidden}"`
        );
      }
      for (const expected of ['Работа', 'Личное', 'Учёба', 'Финансы', 'Идеи']) {
        assert.ok(step1Text.includes(expected), `Onboarding missing universal preset section "${expected}"`);
      }

      await saveShot(vault, '01-onboarding-dark.png', report.shots);

      // Step 2: Visual Style
      await vault.getByTestId('onboarding-next-btn').click();
      await vault.waitForTimeout(260);
      const step2Text = await modal.innerText();
      assert.ok(step2Text.includes('Выбери визуальный стиль'), 'Expected Onboarding Step 2 visual style view');
      await saveShot(vault, '01b-onboarding-step2.png', report.shots);

      // Step 3: Cloud Sync vs Start Locally
      await vault.getByTestId('onboarding-next-btn').click();
      await vault.waitForTimeout(260);
      const step3Text = await modal.innerText();
      assert.ok(!step3Text.toLowerCase().includes('supabase'), 'Onboarding Step 3 leaked Supabase');

      await vault.getByTestId('onboarding-start-local-btn').click();
      await modal.waitFor({ state: 'detached', timeout: 6000 });
      await vault.waitForTimeout(350);

      const orbits = await vault.evaluate(() => window.kapsula.listOrbits());
      assert.equal(orbits.length, 3, `Expected 3 selected starter orbits (Работа, Личное, Идеи), got ${orbits.length}`);
      const items = await vault.evaluate(() => window.kapsula.queryVault({ limit: 50 }));
      const welcome = items.find((i) => i.title.includes('Добро пожаловать'));
      assert.ok(welcome, 'Expected welcome checklist note to be created by onboarding');
      assert.ok(welcome.body.includes('- [ ]'), 'Welcome note must contain actionable checklist tasks');
      return { orbits: orbits.map((o) => o.name), welcomeNoteId: welcome.id };
    });

    // =========================================================================
    // 02. NoteStudio: Inline Photo + Lightbox + Slash Menu + Wiki-Link + Reload Round-Trip
    // =========================================================================
    let richNoteId = null;
    await runCheck('02_note_inline_photo_wiki_slash', 'NoteStudio inline photo, lightbox, slash menu, [[wiki-link]] & reload round-trip', async () => {
      await vault.getByTestId('nav-notes').click();
      await vault.waitForSelector('[data-testid="notes-hub-view"]', { timeout: 6000 });
      await vault.getByTestId('notes-new-btn').click();
      await vault.waitForSelector('[data-testid="note-studio-title"]', { timeout: 5000 });
      await vault.waitForTimeout(200);

      // Verify empty starter template chips are present
      const tplChipsVisible = await vault.getByTestId('studio-template-chips').isVisible().catch(() => false);
      assert.ok(tplChipsVisible, 'Empty NoteStudio draft must display starter template chips');

      await vault.getByTestId('note-studio-title').fill('Заметка с фото и связями v8');
      const editor = vault.getByTestId('note-studio-editor');
      await editor.click();

      await vault.keyboard.type('Вводный абзац для проверки v8 редактора.', { delay: 6 });
      await vault.keyboard.press('Enter');
      await vault.keyboard.type('- Первый маркированный пункт', { delay: 6 });
      await vault.keyboard.press('Enter');
      await vault.keyboard.type('Второй маркированный пункт', { delay: 6 });
      await vault.keyboard.press('Enter');
      await vault.keyboard.press('Enter');
      // Directly follow bulletList with `- [ ] ` (verifies P2 fix: preceding bullets MUST stay bullets, NOT turn into checkboxes!)
      await vault.keyboard.type('- [ ] Проверить сохранение фото и чекбокса', { delay: 6 });
      await vault.keyboard.press('Enter');
      await vault.keyboard.press('Enter');

      // Insert real PNG image via file picker input (exercises saveNoteImage + KapsulaImage node)
      await vault.getByTestId('studio-image-file-input').setInputFiles(tmpPngPath);

      const inlineImg = vault.locator('[data-testid="note-studio-editor"] [data-testid="kapsula-inline-image"] img').first();
      await inlineImg.waitFor({ state: 'visible', timeout: 8000 });
      await vault.waitForFunction(() => {
        const img = document.querySelector('[data-testid="note-studio-editor"] [data-testid="kapsula-inline-image"] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }, { timeout: 8000 });

      const imgMetrics = await inlineImg.evaluate((el) => ({
        src: el.getAttribute('src'),
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
      }));
      assert.ok(
        imgMetrics.naturalWidth === 160 && imgMetrics.naturalHeight === 100,
        `Inline image dimensions mismatch: ${JSON.stringify(imgMetrics)}`
      );
      assert.ok(
        imgMetrics.src && imgMetrics.src.startsWith('kapsula-media://local/'),
        `Inline image must load via kapsula-media://local/, got ${imgMetrics.src}`
      );

      // Move caret to end of document WITHOUT clicking the inline image (which opens Lightbox!)
      await editor.locator('> p').first().click();
      await vault.keyboard.press('Control+End');
      await vault.keyboard.press('Enter');
      await vault.keyboard.type('Связанная заметка: [[Добро', { delay: 12 });
      await vault.waitForSelector('[data-testid="wiki-link-menu"]', { timeout: 5000 });
      await vault.keyboard.press('Enter');
      await vault.waitForTimeout(200);

      const wikiPill = vault.locator('[data-testid="note-studio-editor"] [data-wiki-link]').first();
      await wikiPill.waitFor({ state: 'visible', timeout: 4000 });
      const wikiTitle = await wikiPill.getAttribute('data-wiki-title');
      assert.ok(wikiTitle && wikiTitle.includes('Добро пожаловать'), `Unexpected wiki-link title: ${wikiTitle}`);

      // Wait for debounced autosave (420ms) and verify saved Markdown BEFORE clicking image
      await vault.waitForTimeout(750);
      const bodyBeforeLightbox = await vault.evaluate(async () => {
        const all = await window.kapsula.queryVault({ limit: 50 });
        return all.find((x) => x.title === 'Заметка с фото и связями v8')?.body ?? null;
      });
      await saveShot(vault, '02-note-inline-photo.png', report.shots);

      // Click inline image -> verify Lightbox opens cleanly
      await inlineImg.click();
      const lightboxDialog = vault.locator('[role="dialog"]').filter({ has: vault.locator('img') }).last();
      await lightboxDialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll('[role="dialog"] img'));
          return imgs.some((im) => im.complete && im.naturalWidth >= 100);
        },
        undefined,
        { timeout: 5000 }
      );
      await vault.waitForTimeout(220);
      await saveShot(vault, '02b-note-lightbox.png', report.shots);
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(260);

      // Check whether clicking the image for Lightbox left ProseMirror NodeSelection trapped on the image!
      const imageSelectedAfterLightboxClose = await vault.evaluate(() => {
        const frame = document.querySelector('[data-testid="note-studio-editor"] .k-inline-image-frame');
        return frame?.getAttribute('data-selected') === 'true';
      });

      // Click plain text at the LEFT of the last paragraph ("Связанная заметка") so we don't click the wiki-link pill!
      await editor.locator('> p').last().click({ position: { x: 24, y: 12 } });
      await vault.keyboard.press('End');
      await vault.keyboard.press('Enter');
      await vault.keyboard.type('/');
      const slashMenu = vault.getByTestId('slash-command-menu');
      await slashMenu.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(180);
      const slashText = await slashMenu.innerText();
      for (const expected of ['Заголовок 1', 'Чек-лист', 'Вставить фото', 'Шаблон: Встреча', 'Шаблон: Проект']) {
        assert.ok(slashText.includes(expected), `Expanded slash menu missing "${expected}"`);
      }
      await saveShot(vault, '02c-note-slash-menu.png', report.shots);
      await vault.keyboard.press('Escape');
      await vault.keyboard.press('Backspace');
      await vault.waitForTimeout(700);

      // Lookup saved item ID
      const savedNote = await vault.evaluate(async () => {
        const all = await window.kapsula.queryVault({ limit: 50 });
        return all.find((x) => x.title === 'Заметка с фото и связями v8') || null;
      });
      assert.ok(savedNote, 'Rich note must be persisted in SQLite');
      richNoteId = savedNote.id;

      // Full window reload to test Markdown round-trip survival
      await vault.reload();
      await vault.waitForSelector('[data-testid="studio-workspace"]', { timeout: 15000 });
      await vault.waitForTimeout(450);
      await vault.getByTestId('nav-notes').click();
      await vault.waitForSelector('[data-testid="notes-list-pane"]', { timeout: 6000 });
      await vault.getByTestId(`notes-list-item-${richNoteId}`).click();
      await vault.waitForTimeout(350);

      await vault.waitForFunction(
        () => {
          const ed = document.querySelector('[data-testid="note-studio-editor"]');
          if (!ed) return false;
          const img = ed.querySelector('[data-testid="kapsula-inline-image"] img');
          return Boolean(img && img.complete && img.naturalWidth > 0);
        },
        undefined,
        { timeout: 8000 }
      );

      const roundTrip = await vault.evaluate(() => {
        const ed = document.querySelector('[data-testid="note-studio-editor"]');
        const img = ed?.querySelector('[data-testid="kapsula-inline-image"] img');
        const wiki = ed?.querySelector('[data-wiki-link]');
        const bullets = ed?.querySelectorAll('ul:not([data-type="taskList"]) li').length ?? 0;
        const tasks = ed?.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]').length ?? 0;
        return {
          imgNaturalWidth: img?.naturalWidth ?? 0,
          wikiTitle: wiki?.getAttribute('data-wiki-title') ?? null,
          bullets,
          tasks,
        };
      });
      assert.ok(roundTrip.imgNaturalWidth === 160, `Inline photo lost after reload: ${JSON.stringify(roundTrip)}`);
      assert.ok(roundTrip.wikiTitle?.includes('Добро пожаловать'), `Wiki-link lost after reload: ${JSON.stringify(roundTrip)}`);
      assert.ok(roundTrip.bullets >= 2, `Bullets lost after reload: ${JSON.stringify(roundTrip)}`);
      assert.ok(roundTrip.tasks >= 1, `Checkboxes lost after reload: ${JSON.stringify(roundTrip)}`);

      // Record Lightbox NodeSelection trap diagnostic separately as a dedicated check
      report.checks['02b_lightbox_no_image_selection_trap'] = imageSelectedAfterLightboxClose
        ? {
            status: 'FAIL',
            ms: 0,
            error:
              'Clicking inline photo to open ShotLightbox leaves ProseMirror NodeSelection active (data-selected="true") after closing Lightbox — pressing Enter/typing deletes the photo! (Add onMouseDown preventDefault/stopPropagation on KapsulaImageView <img>)',
          }
        : { status: 'PASS', ms: 0, detail: { imageSelectedAfterLightboxClose } };

      return {
        richNoteId,
        imgMetrics,
        bodyBeforeLightbox,
        bodyAfterSlash: savedNote.body,
        imageSelectedAfterLightboxClose,
        roundTrip,
      };
    });

    // =========================================================================
    // 03. Revision History & Colored Line-Diff Modal
    // =========================================================================
    await runCheck('03_note_revision_diff', 'Note revision snapshot + История версий timeline & colored line-diff', async () => {
      assert.ok(richNoteId, 'Depends on richNoteId from check 02');

      // Save an explicit snapshot of the pre-edit version, then edit the note so diff is vivid
      await vault.evaluate((id) => window.kapsula.saveRevision(id, 'manual'), richNoteId);
      await vault.waitForTimeout(200);

      const editor = vault.getByTestId('note-studio-editor');
      await editor.locator('> p').first().click();
      await vault.keyboard.press('Control+End');
      await vault.keyboard.press('Enter');
      await vault.keyboard.type('Новая строка для проверки цветного diff в истории версий.', { delay: 6 });
      await vault.waitForTimeout(750);

      await vault.getByTestId('studio-history-btn').click();
      const histModal = vault.getByTestId('revision-history-modal');
      await histModal.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(250);

      const rowCount = await histModal.locator('[data-testid^="revision-row-"]').count();
      assert.ok(rowCount >= 1, `Expected >= 1 revision timeline rows, got ${rowCount}`);

      const diffViewer = vault.getByTestId('revision-diff-viewer');
      await diffViewer.waitFor({ state: 'visible', timeout: 4000 });
      const diffText = await diffViewer.innerText();
      assert.ok(
        diffText.includes('Новая строка для проверки цветного diff'),
        `Diff viewer must highlight changed line, got: ${diffText.slice(0, 220)}`
      );

      await saveShot(vault, '03-note-revision-diff.png', report.shots);
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(220);
      return { rowCount };
    });

    // =========================================================================
    // 04. Voice Note Untranscribed AI CTA (VoiceMemoCard + NoteStudio)
    // =========================================================================
    await runCheck('04_voice_transcribe_cta', 'Untranscribed voice note shows «Расшифровать через ИИ» & hides «Украсить»', async () => {
      const voiceItem = await vault.evaluate(async (wavB64) => {
        return window.kapsula.capture({
          audioBase64: wavB64,
          audioMime: 'audio/wav',
          audioDurationSec: 1.8,
          mediaMeta: {
            waveformPeaks: [0.2, 0.5, 0.8, 0.4, 0.7, 0.9, 0.3, 0.6, 0.5, 0.8, 0.4, 0.3],
          },
          source: 'vault_ui',
        });
      }, minimalWavBase64);

      assert.equal(voiceItem.dna, 'voice', `Expected voice dna, got ${voiceItem.dna}`);
      assert.ok(voiceItem.mediaPath, 'Voice item must save real WAV mediaPath');
      assert.equal((voiceItem.body || '').trim(), '', 'Untranscribed voice item must start with empty body in local mode');

      await vault.getByTestId('nav-flow').click();
      await vault.waitForSelector(`[data-testid="memory-card-${voiceItem.id}"]`, { timeout: 6000 });
      await vault.waitForTimeout(250);

      const voiceCard = vault.getByTestId(`memory-card-${voiceItem.id}`);
      const cardTranscribeBtn = voiceCard.getByTestId('voice-card-transcribe-btn');
      await cardTranscribeBtn.waitFor({ state: 'visible', timeout: 4000 });
      const cardBtnText = await cardTranscribeBtn.innerText();
      assert.ok(cardBtnText.includes('Расшифровать через ИИ'), `VoiceMemoCard CTA mismatch: ${cardBtnText}`);

      // Open voice note in NoteStudio full-canvas view (click card title row, avoiding WaveformAudioPlayer stopPropagation)
      await voiceCard.click({ position: { x: 80, y: 20 } });
      await vault.waitForSelector('[data-testid="studio-document-canvas"]', { timeout: 5000 });
      await vault.waitForTimeout(260);

      // Single clean primary CTA lives inside the audio player card (zero duplicate orange CTA in header!)
      const headerTranscribeCount = await vault.locator('[data-testid="studio-transcribe-btn"]').count();
      assert.equal(headerTranscribeCount, 0, 'Duplicate studio-transcribe-btn must NOT appear in NoteStudio header');
      const audioTranscribe = vault.getByTestId('studio-audio-transcribe-btn');
      await audioTranscribe.waitFor({ state: 'visible', timeout: 4000 });
      assert.ok((await audioTranscribe.innerText()).includes('Расшифровать через ИИ'));

      // Verify «Украсить» / «Причесать текст» header split pill is HIDDEN when body/transcript is empty
      const beautifyCount = await vault.locator('[data-testid="studio-beautify-btn"]').count();
      assert.equal(beautifyCount, 0, 'Beautify/Причесать button MUST be hidden/replaced when voice transcript is empty');

      // Audit NoteStudio header sibling overlap on 560px Side-Sheet + duplicate sparkle icon
      const headerOverlapAudit = await vault.evaluate(() => {
        const hdr = document.querySelector('[data-testid="note-studio-header"]');
        if (!hdr) return null;
        const leftGroup = hdr.children[0];
        const rightGroup = hdr.children[1];
        const leftButtons = Array.from(leftGroup?.querySelectorAll('button') ?? []).map((b) => ({
          text: b.innerText.trim(),
          right: Number(b.getBoundingClientRect().right.toFixed(1)),
          left: Number(b.getBoundingClientRect().left.toFixed(1)),
        }));
        const audioBtn = document.querySelector('[data-testid="studio-audio-transcribe-btn"]');
        const maxLeftRight = Math.max(0, ...leftButtons.map((b) => b.right));
        const rightGroupLeft = rightGroup ? Number(rightGroup.getBoundingClientRect().left.toFixed(1)) : 0;
        const overlapPx = Number((maxLeftRight - rightGroupLeft).toFixed(1));
        const hasDoubleSparkle = Boolean(
          audioBtn && audioBtn.querySelector('svg') && audioBtn.innerText.includes('✨')
        );
        return {
          leftButtons,
          rightGroupLeft,
          overlapPx,
          hasDoubleSparkle,
        };
      });
      report.checks['04b_voice_studio_header_no_overlap'] =
        headerOverlapAudit && (headerOverlapAudit.overlapPx > 0 || headerOverlapAudit.hasDoubleSparkle)
          ? {
              status: 'FAIL',
              ms: 0,
              error: `NoteStudio Side-Sheet voice header defect: overlapPx=${headerOverlapAudit.overlapPx}px (Напомнить clipped/covered by studio-transcribe-btn), hasDoubleSparkle=${headerOverlapAudit.hasDoubleSparkle} (SVG <Sparkle> + literal "✨" emoji)`,
              detail: headerOverlapAudit,
            }
          : { status: 'PASS', ms: 0, detail: headerOverlapAudit };

      await saveShot(vault, '04-voice-transcribe-cta.png', report.shots);

      await vault.getByTestId('note-studio-close').click();
      await vault.waitForTimeout(250);
      return { voiceItemId: voiceItem.id, cardBtnText };
    });

    // =========================================================================
    // 05. Command HUD: Opaque Surface + Live Rich Editor + Edit/Checkbox Persist + Escape Focus
    // =========================================================================
    await runCheck('05_hud_live_editor', 'Command HUD opaque background, live TipTap bullets/checkboxes/links/photo, live edit persistence & Escape focus', async () => {
      const hudNote = await vault.evaluate(async (pngB64) => {
        const savedImg = await window.kapsula.saveNoteImage({
          base64: pngB64,
          mimeType: 'image/png',
          fileName: 'hud-inline.png',
        });
        const body = [
          'Заметка для проверки живого редактора HUD.',
          '',
          '- Первый пункт списка HUD',
          '- Второй пункт списка HUD',
          '',
          '- [ ] Задача для клика прямо в HUD',
          '- [x] Уже выполненный пункт',
          '',
          'Открыть сайт: [Kapsula](https://example.com)',
          '',
          `![Встроенное фото HUD](${savedImg.mediaUrl})`,
        ].join('\n');
        return window.kapsula.capture({
          title: 'HUD Тест Редактора v8',
          text: body,
          source: 'vault_ui',
        });
      }, testPngBase64);

      await vault.evaluate(() => window.kapsula.windowAction('open-hud'));
      await hud.waitForSelector('[data-testid="command-hud"]', { timeout: 6000 });
      await hud.waitForTimeout(300);

      // Search for our note so it is deterministically selected
      const hudSearch = hud.getByTestId('hud-search-input');
      await hudSearch.fill('HUD Тест Редактора v8');
      await hud.waitForTimeout(350);

      await hud.waitForSelector('[data-testid="hud-right-editor"]', { timeout: 6000 });
      await hud.waitForFunction(() => {
        const ed = document.querySelector('[data-testid="hud-right-editor"]');
        const img = ed?.querySelector('[data-testid="kapsula-inline-image"] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }, { timeout: 8000 });

      // 1. Verify 100% opaque HUD surface background (alpha === 1)
      const bgAudit = await hud.evaluate(() => {
        const outer = document.querySelector('[data-testid="command-hud"] > div');
        const rightPane = document.querySelector('[data-testid="hud-right-pane"]');
        return {
          outerBg: outer ? getComputedStyle(outer).backgroundColor : '',
          rightPaneBg: rightPane ? getComputedStyle(rightPane).backgroundColor : '',
        };
      });
      const outerColor = parseCssColor(bgAudit.outerBg);
      const rightColor = parseCssColor(bgAudit.rightPaneBg);
      assert.ok(outerColor && outerColor.a === 1, `HUD outer surface must be 100% opaque (alpha=1), got ${bgAudit.outerBg}`);
      assert.ok(rightColor && rightColor.a === 1, `HUD right pane must be 100% opaque (alpha=1), got ${bgAudit.rightPaneBg}`);

      // 2. Verify bullets, checkboxes, clickable link (no raw markdown), and inline image
      const hudDom = await hud.evaluate(() => {
        const ed = document.querySelector('[data-testid="hud-right-editor"]');
        if (!ed) return null;
        const bullets = ed.querySelectorAll('ul:not([data-type="taskList"]) > li').length;
        const checkboxes = ed.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]').length;
        const link = ed.querySelector('a[href="https://example.com"]');
        const img = ed.querySelector('[data-testid="kapsula-inline-image"] img');
        return {
          bullets,
          checkboxes,
          linkText: link?.textContent?.trim() || null,
          rawText: ed.innerText,
          imgNaturalWidth: img?.naturalWidth ?? 0,
        };
      });
      assert.ok(hudDom && hudDom.bullets >= 2, `HUD must render real <ul><li> bullets, got ${JSON.stringify(hudDom)}`);
      assert.ok(hudDom.checkboxes >= 2, `HUD must render interactive checkboxes, got ${JSON.stringify(hudDom)}`);
      assert.equal(hudDom.linkText, 'Kapsula', `HUD must render clickable link "Kapsula", got ${JSON.stringify(hudDom)}`);
      assert.ok(
        !hudDom.rawText.includes('[Kapsula](https://example.com)'),
        `HUD leaked raw Markdown link syntax: ${hudDom.rawText}`
      );
      assert.ok(hudDom.imgNaturalWidth === 160, `HUD inline image failed to render: ${JSON.stringify(hudDom)}`);

      await saveShot(hud, '05-hud-live-edit-bullets.png', report.shots);

      // 3. Toggle unchecked task checkbox & edit text directly in HUD right pane
      const uncheckedBox = hud.locator('[data-testid="hud-right-editor"] ul[data-type="taskList"] li[data-checked="false"] input[type="checkbox"]').first();
      await uncheckedBox.click();
      await hud.waitForTimeout(120);

      // Click first plain paragraph (safe from external link) and append edited text
      const firstPara = hud.locator('[data-testid="hud-right-editor"] > p').first();
      await firstPara.click();
      await hud.keyboard.press('End');
      await hud.keyboard.type(' Правка прямо в HUD!', { delay: 8 });

      // Wait > 600ms for 350ms debounced autosave
      await hud.waitForTimeout(750);
      const saveLabel = await hud.getByTestId('hud-editor-save-state').innerText();
      assert.equal(saveLabel.trim(), 'Сохранено', `Expected HUD save state "Сохранено", got "${saveLabel}"`);

      await saveShot(hud, '05b-hud-after-edit.png', report.shots);

      // Verify persistence via window.kapsula.queryVault
      const persisted = await vault.evaluate(async (id) => {
        const all = await window.kapsula.queryVault({ limit: 50 });
        return all.find((x) => x.id === id) || null;
      }, hudNote.id);
      assert.ok(persisted, 'HUD edited note not found in queryVault');
      assert.ok(
        persisted.body.includes('Правка прямо в HUD!'),
        `HUD text edit did not persist to DB: ${persisted.body}`
      );
      assert.ok(
        /\[x\]\s+Задача для клика прямо в HUD/i.test(persisted.body),
        `HUD checkbox toggle did not persist as [x] to DB: ${persisted.body}`
      );

      // 4. Test Escape inside right pane returns focus to search input cleanly
      await firstPara.click();
      await hud.waitForTimeout(80);
      const beforeEscInsideRight = await hud.evaluate(() => {
        const pane = document.querySelector('[data-testid="hud-right-pane"]');
        return Boolean(pane && document.activeElement && pane.contains(document.activeElement));
      });
      assert.equal(beforeEscInsideRight, true, 'Expected focus inside hud-right-pane before Escape');

      await hud.keyboard.press('Escape');
      await hud.waitForTimeout(120);
      const activeAfterEsc = await hud.evaluate(() => ({
        testId: document.activeElement?.getAttribute('data-testid') || null,
        tag: document.activeElement?.tagName || null,
      }));
      assert.equal(
        activeAfterEsc.testId,
        'hud-search-input',
        `Escape from HUD right pane must return focus to hud-search-input, got ${JSON.stringify(activeAfterEsc)}`
      );

      // Close HUD cleanly
      await hud.evaluate(() => window.kapsula.closeHud());
      await vault.waitForTimeout(220);

      return { bgAudit, hudDom, activeAfterEsc };
    });

    // =========================================================================
    // 06. Kanban Board: 4 Default Columns + Add Custom Column + Multi-Frame Pointer Drag + Done Auto-Move + Reload
    // =========================================================================
    await runCheck('06_kanban_board_drag', 'Tasks Kanban board, custom column, multi-frame pointer drag, 0px layout jump, done auto-move & reload persistence', async () => {
      await vault.getByTestId('nav-tasks').click();
      await vault.waitForSelector('[data-testid="tasks-hub-view"]', { timeout: 6000 });
      await vault.getByRole('tab', { name: 'Доска' }).click();
      await vault.waitForSelector('[data-testid="tasks-kanban-board"]', { timeout: 6000 });
      await vault.waitForTimeout(260);

      // Verify 4 default columns
      const defaultColMap = [
        ['inbox', 'Входящие'],
        ['in_progress', 'В работе'],
        ['waiting', 'Жду'],
        ['done', 'Готово'],
      ];
      for (const [colId, expectedTitle] of defaultColMap) {
        const col = vault.getByTestId(`kanban-col-${colId}`);
        await col.waitFor({ state: 'visible', timeout: 4000 });
        const txt = await col.innerText();
        assert.ok(txt.includes(expectedTitle), `Column ${colId} missing title "${expectedTitle}"`);
      }

      // Add a custom column
      await vault.getByTestId('kanban-add-col-btn').click();
      await vault.getByTestId('kanban-new-col-input').fill('На проверке');
      await vault.keyboard.press('Enter');
      await vault.waitForTimeout(300);

      const boardText = await vault.getByTestId('tasks-kanban-board').innerText();
      assert.ok(boardText.includes('На проверке'), 'Custom column "На проверке" must appear on Kanban board');

      // Reset horizontal scroll back to 0 so Входящие and В работе are fully in viewport before drag & shot
      await vault.evaluate(() => {
        const scroller = document.querySelector('[data-testid="tasks-kanban-board"]');
        if (scroller) scroller.scrollLeft = 0;
      });
      await vault.waitForTimeout(220);
      await saveShot(vault, '06-kanban-board.png', report.shots);

      // Pick first card in Входящие
      const inboxCol = vault.getByTestId('kanban-col-inbox');
      const inProgressCol = vault.getByTestId('kanban-col-in_progress');
      const sourceCard = inboxCol.locator('[data-testid^="kanban-card-"]').first();
      await sourceCard.waitFor({ state: 'visible', timeout: 4000 });
      const cardTestId = await sourceCard.getAttribute('data-testid');
      const taskId = cardTestId.replace('kanban-card-', '');

      const getChromeRects = () =>
        vault.evaluate(() => {
          const hdr = document.querySelector('header')?.getBoundingClientRect();
          const sb = document.querySelector('[data-testid="workspace-sidebar"]')?.getBoundingClientRect();
          return {
            hdrX: hdr ? Number(hdr.x.toFixed(2)) : 0,
            hdrY: hdr ? Number(hdr.y.toFixed(2)) : 0,
            hdrH: hdr ? Number(hdr.height.toFixed(2)) : 0,
            sbW: sb ? Number(sb.width.toFixed(2)) : 0,
          };
        });

      const chromeBefore = await getChromeRects();
      const srcBox = await sourceCard.boundingBox();
      const dstBox = await inProgressCol.boundingBox();
      assert.ok(srcBox && dstBox, 'Missing Kanban card or target column bounding box');

      // Start pointer drag away from left checkbox & bottom source-note chip
      const startX = srcBox.x + srcBox.width * 0.65;
      const startY = srcBox.y + 16;
      const endX = dstBox.x + dstBox.width * 0.5;
      const endY = dstBox.y + 110;

      const dragFrames = [];
      const sampleDragFrame = async (label) => {
        const snap = await vault.evaluate(() => {
          const ov = document.querySelector('[data-testid="kanban-drag-overlay"]');
          const ind = document.querySelector('[data-testid="kanban-drop-indicator"]');
          const hdr = document.querySelector('header')?.getBoundingClientRect();
          const sb = document.querySelector('[data-testid="workspace-sidebar"]')?.getBoundingClientRect();
          return {
            overlayPresent: Boolean(ov),
            overlayTransform: ov ? getComputedStyle(ov).transform : null,
            overlayBox: ov
              ? (() => {
                  const r = ov.getBoundingClientRect();
                  return { x: Number(r.x.toFixed(1)), y: Number(r.y.toFixed(1)) };
                })()
              : null,
            dropIndicatorPresent: Boolean(ind),
            hdrY: hdr ? Number(hdr.y.toFixed(2)) : 0,
            sbW: sb ? Number(sb.width.toFixed(2)) : 0,
          };
        });
        dragFrames.push({ label, ...snap });
      };

      await vault.mouse.move(startX, startY);
      await vault.mouse.down();
      await sampleDragFrame('t=0ms');

      // Smooth multi-frame drag across 220ms
      const steps = [
        { delay: 40, frac: 0.25, label: 't=40ms' },
        { delay: 60, frac: 0.65, label: 't=100ms' },
        { delay: 120, frac: 1.0, label: 't=220ms' },
      ];
      for (const st of steps) {
        const nx = startX + (endX - startX) * st.frac;
        const ny = startY + (endY - startY) * st.frac;
        await vault.mouse.move(nx, ny, { steps: 4 });
        await sleep(st.delay);
        await sampleDragFrame(st.label);
      }

      await vault.mouse.up();
      await vault.waitForTimeout(320);

      const chromeAfter = await getChromeRects();
      report.metrics.kanbanDragFrames = dragFrames;

      // Verify lifted floating overlay appeared during drag and moved smoothly across columns
      const overlayFrames = dragFrames.filter((f) => f.overlayPresent && f.overlayBox);
      assert.ok(
        overlayFrames.length >= 2,
        `Expected lifted drag overlay across multiple frames, got: ${JSON.stringify(dragFrames)}`
      );
      const movedRightPx =
        overlayFrames[overlayFrames.length - 1].overlayBox.x - overlayFrames[0].overlayBox.x;
      assert.ok(movedRightPx > 80, `Drag overlay did not glide horizontally across columns: ${JSON.stringify(overlayFrames)}`);
      assert.ok(
        dragFrames.some((f) => f.dropIndicatorPresent),
        `Expected drop indicator bar during drag, got: ${JSON.stringify(dragFrames)}`
      );

      // Verify 0px layout jump on header/sidebar across ALL frames and after drop
      for (const f of dragFrames) {
        assert.ok(Math.abs(f.hdrY - chromeBefore.hdrY) <= 0.5, `Header jumped vertically during drag: ${JSON.stringify(f)}`);
        assert.ok(Math.abs(f.sbW - chromeBefore.sbW) <= 0.5, `Sidebar jumped during drag: ${JSON.stringify(f)}`);
      }
      assert.ok(Math.abs(chromeAfter.hdrY - chromeBefore.hdrY) <= 0.5, 'Header Y shifted after Kanban drop');
      assert.ok(Math.abs(chromeAfter.sbW - chromeBefore.sbW) <= 0.5, 'Sidebar width shifted after Kanban drop');

      // Verify card landed inside `in_progress` column
      const movedCardInProgress = inProgressCol.getByTestId(`kanban-card-${taskId}`);
      await movedCardInProgress.waitFor({ state: 'visible', timeout: 4000 });
      await saveShot(vault, '06b-kanban-after-drag.png', report.shots);

      // Toggle checkbox -> MUST auto-move card to Готово (`done`)
      await vault.getByTestId(`task-toggle-${taskId}`).click();
      await vault.waitForTimeout(350);
      const doneCol = vault.getByTestId('kanban-col-done');
      await doneCol.getByTestId(`kanban-card-${taskId}`).waitFor({ state: 'visible', timeout: 5000 });

      // Reload & verify Kanban mode, custom column, and moved card persist!
      await vault.reload();
      await vault.waitForSelector('[data-testid="studio-workspace"]', { timeout: 15000 });
      await vault.waitForTimeout(450);
      await vault.getByTestId('nav-tasks').click();
      await vault.waitForSelector('[data-testid="tasks-kanban-board"]', { timeout: 6000 });
      await vault.waitForTimeout(250);

      const persistedBoardText = await vault.getByTestId('tasks-kanban-board').innerText();
      assert.ok(persistedBoardText.includes('На проверке'), 'Custom column did not persist after reload');
      await vault
        .getByTestId('kanban-col-done')
        .getByTestId(`kanban-card-${taskId}`)
        .waitFor({ state: 'visible', timeout: 5000 });

      return { taskId, movedRightPx: Number(movedRightPx.toFixed(1)), dragFrames };
    });

    // =========================================================================
    // 07. Settings -> Внешний вид: Custom Accent Hue + Custom Bg Sliders + WCAG Contrast + Light Theme
    // =========================================================================
    await runCheck('07_appearance_colors_wcag_light', 'Custom Accent Hue (#00B8D9), Bg preset & sliders, WCAG >= 4.5:1 contrast & Light theme', async () => {
      await vault.getByTestId('open-settings-btn').click();
      const dialog = vault.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(240);

      // Adjust Accent Hue slider -> then set exact #00B8D9
      await vault.getByTestId('accent-hue-slider').fill('189');
      await vault.waitForTimeout(120);
      await vault.getByTestId('accent-hex-input').fill('#00B8D9');
      await vault.waitForTimeout(160);

      // Pick non-default dark preset ("Полночь") and then move custom bg sliders
      await vault.getByTestId('bg-preset-midnight').click();
      await vault.waitForTimeout(140);
      await vault.getByTestId('bg-hue-slider').fill('212');
      await vault.getByTestId('bg-tint-slider').fill('68');
      await vault.getByTestId('bg-lightness-slider').fill('52');
      await vault.waitForTimeout(280);

      const darkVars = await vault.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          accent: cs.getPropertyValue('--k-accent').trim(),
          inkOnAccent: cs.getPropertyValue('--k-ink-on-accent').trim(),
          bgCanvas: cs.getPropertyValue('--k-bg-canvas').trim(),
          bgSurface1: cs.getPropertyValue('--k-bg-surface-1').trim(),
          inkPrimary: cs.getPropertyValue('--k-ink-primary').trim(),
          inkSecondary: cs.getPropertyValue('--k-ink-secondary').trim(),
          inkMuted: cs.getPropertyValue('--k-ink-muted').trim(),
        };
      });

      assert.notEqual(darkVars.accent.toLowerCase(), '#e86a33', 'Accent CSS var did not update from default terracotta');
      assert.notEqual(darkVars.bgCanvas.toLowerCase(), '#0e0e11', 'Canvas CSS var did not update from default obsidian');

      const darkContrasts = {
        inkPrimaryOnCanvas: Number(contrastRatio(darkVars.inkPrimary, darkVars.bgCanvas).toFixed(2)),
        inkSecondaryOnCanvas: Number(contrastRatio(darkVars.inkSecondary, darkVars.bgCanvas).toFixed(2)),
        inkMutedOnCanvas: Number(contrastRatio(darkVars.inkMuted, darkVars.bgCanvas).toFixed(2)),
        inkOnAccent: Number(contrastRatio(darkVars.inkOnAccent, darkVars.accent).toFixed(2)),
        accentOnCanvas: Number(contrastRatio(darkVars.accent, darkVars.bgCanvas).toFixed(2)),
      };
      for (const [metric, ratio] of Object.entries(darkContrasts)) {
        assert.ok(ratio >= 4.5, `Dark theme WCAG contrast failed [${metric}]: ${ratio}:1 (< 4.5:1), vars=${JSON.stringify(darkVars)}`);
      }

      await saveShot(vault, '07-settings-colors-custom.png', report.shots);

      // Close Settings and capture live custom-themed workspace
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(240);
      await vault.getByTestId('nav-flow').click();
      await vault.waitForTimeout(280);
      await saveShot(vault, '07b-custom-theme-workspace.png', report.shots);

      // Switch to Light Theme & verify WCAG contrast + clean render
      await vault.getByTestId('theme-toggle-btn').click();
      await vault.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 5000 });
      await vault.waitForTimeout(350);

      const lightVars = await vault.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          accent: cs.getPropertyValue('--k-accent').trim(),
          inkOnAccent: cs.getPropertyValue('--k-ink-on-accent').trim(),
          bgCanvas: cs.getPropertyValue('--k-bg-canvas').trim(),
          inkPrimary: cs.getPropertyValue('--k-ink-primary').trim(),
          inkSecondary: cs.getPropertyValue('--k-ink-secondary').trim(),
          inkMuted: cs.getPropertyValue('--k-ink-muted').trim(),
        };
      });
      const lightContrasts = {
        inkPrimaryOnCanvas: Number(contrastRatio(lightVars.inkPrimary, lightVars.bgCanvas).toFixed(2)),
        inkSecondaryOnCanvas: Number(contrastRatio(lightVars.inkSecondary, lightVars.bgCanvas).toFixed(2)),
        inkMutedOnCanvas: Number(contrastRatio(lightVars.inkMuted, lightVars.bgCanvas).toFixed(2)),
        inkOnAccent: Number(contrastRatio(lightVars.inkOnAccent, lightVars.accent).toFixed(2)),
        accentOnCanvas: Number(contrastRatio(lightVars.accent, lightVars.bgCanvas).toFixed(2)),
      };
      for (const [metric, ratio] of Object.entries(lightContrasts)) {
        assert.ok(ratio >= 4.5, `Light theme WCAG contrast failed [${metric}]: ${ratio}:1 (< 4.5:1), vars=${JSON.stringify(lightVars)}`);
      }
      await saveShot(vault, '07c-light-theme.png', report.shots);

      // Return to Dark theme and reset default appearance for clean subsequent screenshots
      await vault.getByTestId('theme-toggle-btn').click();
      await vault.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 5000 });
      await vault.waitForTimeout(250);

      return { darkVars, darkContrasts, lightVars, lightContrasts };
    });

    // =========================================================================
    // 08. Settings Tabs: Интеграции, Безопасность, Синхронизация, Данные
    // =========================================================================
    await runCheck('08_settings_integrations_security_sync_data', 'Settings Интеграции, Безопасность, Синхронизация & Данные — zero Telegram/Supabase leaks', async () => {
      await vault.getByTestId('open-settings-btn').click();
      const dialog = vault.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(220);

      // Reset appearance first so remaining screenshots look clean & standard
      if (await vault.getByTestId('appearance-reset-btn').isVisible().catch(() => false)) {
        await vault.getByTestId('appearance-reset-btn').click();
        await vault.waitForTimeout(180);
      }

      const assertNoBannedText = (tabLabel, text) => {
        for (const banned of [...BANNED_SETTINGS_TERMS, ...BANNED_TECH_TERMS]) {
          assert.ok(
            !text.toLowerCase().includes(banned.toLowerCase()),
            `Settings tab "${tabLabel}" leaked forbidden term "${banned}"`
          );
        }
      };

      // --- Интеграции ---
      await dialog.getByRole('tab', { name: 'Интеграции', exact: true }).click();
      await vault.waitForTimeout(220);
      const intText = await dialog.innerText();
      assertNoBannedText('Интеграции', intText);

      for (const required of [
        'Google Календарь',
        'Расширение для браузера',
        'Почта → Kapsula',
        'Obsidian / Markdown',
        'Notion (.zip)',
      ]) {
        assert.ok(intText.includes(required), `Интеграции missing "${required}"`);
      }

      // Local .eml import CTA is visible (unlaunched inbound email forwarding UI intentionally hidden)
      await vault.getByTestId('import-eml-btn').waitFor({ state: 'visible', timeout: 5000 });
      const { firstAddr, rotatedAddr } = await vault.evaluate(async () => {
        if (typeof window.kapsula.rotateEmailInboundToken !== 'function') {
          throw new Error('window.kapsula.rotateEmailInboundToken IPC missing');
        }
        const first = await window.kapsula.rotateEmailInboundToken();
        const rotated = await window.kapsula.rotateEmailInboundToken();
        return { firstAddr: first?.address ?? '', rotatedAddr: rotated?.address ?? '' };
      });
      assert.ok(firstAddr.includes('@') && firstAddr.startsWith('in+'), `Unexpected email forwarding address: ${firstAddr}`);
      assert.notEqual(rotatedAddr, firstAddr, 'Rotating email forwarding address must generate a new token');

      await saveShot(vault, '08-settings-integrations.png', report.shots);

      // --- Безопасность ---
      await dialog.getByRole('tab', { name: 'Безопасность', exact: true }).click();
      await vault.waitForTimeout(220);
      const secText = await dialog.innerText();
      assertNoBannedText('Безопасность', secText);
      for (const required of [
        'Автоблокировка Сейфа',
        'Защита Сейфа от записи экрана и скриншотов',
        'Блокировать Сейф при сворачивании окна',
        'Автоочистка буфера обмена',
      ]) {
        assert.ok(secText.includes(required), `Безопасность missing "${required}"`);
      }
      await saveShot(vault, '08b-settings-security-sync.png', report.shots);

      // --- Синхронизация ---
      await dialog.getByRole('tab', { name: 'Синхронизация', exact: true }).click();
      await vault.waitForTimeout(220);
      // Also expand custom sync server disclosure to confirm ZERO Supabase leaks even inside collapsed panel
      const customServerToggle = dialog.getByRole('button', { name: /Свой сервер синхронизации/i });
      if (await customServerToggle.isVisible().catch(() => false)) {
        await customServerToggle.click();
        await vault.waitForTimeout(160);
      }
      const syncText = await dialog.innerText();
      assertNoBannedText('Синхронизация', syncText);

      // Verify reconcileFullSync IPC is wired and callable safely (UI button renders when active/signed in)
      const reconcileResult = await vault.evaluate(async () => {
        if (typeof window.kapsula.reconcileFullSync !== 'function') return { exists: false };
        const st = await window.kapsula.reconcileFullSync();
        return { exists: true, state: st?.state ?? null };
      });
      assert.equal(reconcileResult.exists, true, 'window.kapsula.reconcileFullSync IPC must exist');

      // --- Данные ---
      await dialog.getByRole('tab', { name: 'Данные', exact: true }).click();
      await vault.waitForTimeout(220);
      const dataText = await dialog.innerText();
      assertNoBannedText('Данные', dataText);
      await vault.getByTestId('export-markdown-zip-btn').waitFor({ state: 'visible', timeout: 4000 });
      await vault.getByTestId('restore-json-backup-btn').waitFor({ state: 'visible', timeout: 4000 });
      assert.ok(dataText.includes('Экспорт в Markdown + медиа (.zip)'), 'Данные missing Markdown ZIP export');

      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(220);
      return { firstAddr, rotatedAddr, reconcileResult };
    });

    // =========================================================================
    // 09. Vault 2FA TOTP Live Code + Countdown Ring + Copy
    // =========================================================================
    await runCheck('09_vault_totp_2fa', 'Vault 2FA TOTP creation, live 6-digit code + SVG countdown ring & copy', async () => {
      await vault.getByTestId('nav-secrets').click();
      await vault.waitForTimeout(250);
      await vault.getByTestId('new-secret-btn').click();
      await vault.getByTestId('new-secret-bank_card-btn').click();
      const form = vault.getByTestId('new-secret-form');
      await form.waitFor({ state: 'visible', timeout: 5000 });
      await vault.waitForTimeout(220);

      // Verify universal placeholders (no personal bank name hardcoded)
      const cardPlaceholder = await vault.getByTestId('secret-title-input').getAttribute('placeholder');
      assert.ok(
        cardPlaceholder && !cardPlaceholder.toLowerCase().includes('тинькофф'),
        `Secret placeholder leaked personal brand: ${cardPlaceholder}`
      );

      await form.getByRole('tab', { name: 'Пароль' }).click();
      await vault.waitForTimeout(160);
      await vault.getByTestId('secret-title-input').fill('Kapsula 2FA Аккаунт');
      await vault.getByTestId('secret-login-input').fill('user@example.com');
      await vault.getByTestId('secret-value-input').fill('StrongSecretPass!2026');

      await vault.getByTestId('secret-totp-toggle').click();
      await vault
        .getByTestId('secret-totp-input')
        .fill('otpauth://totp/Kapsula:user@example.com?secret=JBSWY3DPEHPK3PXP');
      await vault.waitForTimeout(150);

      const preview = vault.getByTestId('secret-totp-preview');
      await preview.waitFor({ state: 'visible', timeout: 4000 });
      const previewText = await preview.innerText();
      assert.ok(/\d{3}\s\d{3}/.test(previewText), `Expected 6-digit TOTP preview in modal, got: ${previewText}`);

      await vault.getByTestId('secret-submit-btn').click();
      await vault.waitForTimeout(350);

      // Close SecretStudioSheet if auto-opened so VaultSecretCard is clearly visible
      if (await vault.getByTestId('secret-studio-sheet').isVisible().catch(() => false)) {
        await vault.keyboard.press('Escape');
        await vault.waitForTimeout(240);
      }

      const totpRow = vault.locator('[data-testid^="secret-totp-row-"]').first();
      await totpRow.waitFor({ state: 'visible', timeout: 5000 });
      const codeEl = vault.locator('[data-testid^="secret-totp-code-"]').first();
      const codeText = (await codeEl.innerText()).trim();
      assert.ok(/^\d{3}\s\d{3}$/.test(codeText), `Expected live formatted 6-digit TOTP code, got "${codeText}"`);

      const ringCircles = await totpRow.locator('svg circle').count();
      assert.equal(ringCircles, 2, `Expected 2 SVG circles in TOTP countdown ring, got ${ringCircles}`);

      const rowText = await totpRow.innerText();
      assert.ok(/\d+\s*с/.test(rowText), `Expected live remaining seconds indicator in TOTP row, got "${rowText}"`);

      await saveShot(vault, '09-vault-totp-2fa.png', report.shots);

      // Click TOTP row to copy code & verify toast confirmation
      await totpRow.click();
      await vault.waitForTimeout(250);
      const toastVisible = await vault.getByText('2FA-код скопирован').isVisible().catch(() => false);
      assert.ok(toastVisible, 'Expected "2FA-код скопирован" toast after clicking TOTP row');

      return { codeText, ringCircles };
    });

    // =========================================================================
    // 10. Trash vs Archive Separation + Permanent Purge
    // =========================================================================
    await runCheck('10_trash_vs_archive', 'Delete note -> appears in Корзина (NOT Архив) -> «Удалить навсегда» purges completely', async () => {
      await vault.getByTestId('nav-flow').click();
      await vault.waitForTimeout(250);

      const disposable = await vault.evaluate(() =>
        window.kapsula.capture({
          title: 'Заметка на проверку корзины v8',
          text: 'Эта запись должна попасть строго в Корзину, а не в Архив.',
          source: 'vault_ui',
        })
      );
      await vault.waitForSelector(`[data-testid="memory-card-${disposable.id}"]`, { timeout: 6000 });

      // Delete via real UI right-click ContextMenu
      await vault.getByTestId(`memory-card-${disposable.id}`).click({ button: 'right' });
      await vault.waitForSelector('[data-testid="context-menu-popup"]', { timeout: 4000 });
      await vault.getByRole('menuitem', { name: 'Удалить' }).click();
      await vault.waitForTimeout(400);

      // Assert DB separation: absent from active & archive, present in trash
      const afterSoftDelete = await vault.evaluate(async (id) => {
        const active = await window.kapsula.queryVault({ includeArchived: false, limit: 200 });
        const archived = await window.kapsula.queryVault({ archivedOnly: true, limit: 200 });
        const trashed = await window.kapsula.queryVault({ onlyDeleted: true, limit: 200 });
        return {
          inActive: active.some((x) => x.id === id),
          inArchive: archived.some((x) => x.id === id),
          inTrash: trashed.some((x) => x.id === id),
        };
      }, disposable.id);
      assert.equal(afterSoftDelete.inActive, false, 'Deleted note must disappear from active feed');
      assert.equal(afterSoftDelete.inArchive, false, 'Deleted note MUST NOT be stuck in Архив');
      assert.equal(afterSoftDelete.inTrash, true, 'Deleted note MUST appear in Корзина');

      // Open Корзина view in sidebar
      await vault.getByTestId('nav-trash').click();
      const trashRow = vault.getByTestId(`trash-row-${disposable.id}`);
      await trashRow.waitFor({ state: 'visible', timeout: 5000 });
      await vault.getByTestId(`trash-restore-${disposable.id}`).waitFor({ state: 'visible', timeout: 3000 });
      await vault.getByTestId(`trash-purge-${disposable.id}`).waitFor({ state: 'visible', timeout: 3000 });
      await vault.waitForTimeout(200);
      await saveShot(vault, '10-trash-vs-archive.png', report.shots);

      // Permanently purge item
      await vault.getByTestId(`trash-purge-${disposable.id}`).click();
      await vault.getByTestId('confirm-purge-item-btn').waitFor({ state: 'visible', timeout: 4000 });
      await vault.getByTestId('confirm-purge-item-btn').click();
      await vault.waitForTimeout(400);

      const afterPurge = await vault.evaluate(async (id) => {
        const active = await window.kapsula.queryVault({ includeArchived: false, limit: 200 });
        const archived = await window.kapsula.queryVault({ archivedOnly: true, limit: 200 });
        const trashed = await window.kapsula.queryVault({ onlyDeleted: true, limit: 200 });
        return {
          inActive: active.some((x) => x.id === id),
          inArchive: archived.some((x) => x.id === id),
          inTrash: trashed.some((x) => x.id === id),
        };
      }, disposable.id);
      assert.equal(afterPurge.inActive, false, 'Purged item still in active');
      assert.equal(afterPurge.inArchive, false, 'Purged item still in archive');
      assert.equal(afterPurge.inTrash, false, 'Purged item still in trash');

      return { disposableId: disposable.id, afterSoftDelete, afterPurge };
    });

    await runCheck('10b_en_locale_and_sidebar_prefs', 'Instant EN switch, zero Cyrillic chrome leaks & hideable sidebar sections', async () => {
      await vault.getByTestId('customize-sidebar-btn').click();
      await vault.getByTestId('customize-sidebar-toggle-calendar').click();
      assert.equal(await vault.getByTestId('nav-calendar').count(), 0, 'Hidden Calendar section must disappear from sidebar');
      await vault.getByTestId('customize-sidebar-show-all').click();
      assert.equal(await vault.getByTestId('nav-calendar').count(), 1, 'Show all must restore Calendar section');
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(160);

      await vault.getByTestId('open-settings-btn').click();
      const dialog = vault.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await vault.getByTestId('settings-language-switcher').getByText('English', { exact: true }).click();
      await vault.waitForFunction(
        () => document.querySelector('[data-testid="nav-flow"]')?.textContent?.includes('All Items'),
        undefined,
        { timeout: 4000 }
      );
      const chromeText = await vault.evaluate(() =>
        ['nav-flow', 'nav-notes', 'nav-tasks', 'nav-secrets', 'open-settings-btn']
          .map((id) => document.querySelector(`[data-testid="${id}"]`)?.textContent || '')
          .join(' | ')
      );
      assert.ok(chromeText.includes('Tasks') && chromeText.includes('Vault'), `Expected EN labels: ${chromeText}`);
      assert.ok(!/[А-Яа-яЁё]/.test(chromeText), `EN chrome leaked Cyrillic: ${chromeText}`);
      await vault.getByTestId('settings-language-switcher').getByText('Русский', { exact: true }).click();
      await vault.keyboard.press('Escape');
      await vault.waitForTimeout(180);
      return { chromeText };
    });
  } finally {
    if (app) {
      await Promise.race([app.close(), sleep(4000)]).catch(() => {});
    }
    killStrayProcesses();
    await sleep(300);
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      await sleep(300);
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  }

  const strayAfterExit = countStrayProcesses();
  report.checks['11_zero_stray_processes'] =
    strayAfterExit === 0
      ? { status: 'PASS', ms: 0, detail: { strayAfterExit } }
      : { status: 'FAIL', ms: 0, error: `Found ${strayAfterExit} stray Kapsula/electron processes after exit` };

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(AUDIT_DIR, 'v8-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const checkEntries = Object.entries(report.checks);
  const failedChecks = checkEntries.filter(([, v]) => v.status !== 'PASS');

  console.log('\n================ V8 DESKTOP E2E SUMMARY ================');
  for (const [k, v] of checkEntries) {
    console.log(`  [${v.status}] ${k}${v.error ? ` — ${v.error}` : ''}`);
  }
  console.log(`  Page errors:    ${report.pageErrors.length}`);
  console.log(`  Console errors: ${report.consoleErrors.length}`);
  console.log(`  Screenshots:    ${report.shots.length} saved in ${AUDIT_DIR}`);
  console.log(`  Report JSON:    ${reportPath}`);

  if (report.pageErrors.length > 0) {
    console.error('\n[v8-e2e] PAGE ERRORS:', JSON.stringify(report.pageErrors, null, 2));
  }
  if (report.consoleErrors.length > 0) {
    console.error('\n[v8-e2e] CONSOLE ERRORS:', JSON.stringify(report.consoleErrors, null, 2));
  }

  if (failedChecks.length > 0 || report.pageErrors.length > 0 || report.consoleErrors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[v8-e2e] FATAL:', err);
  killStrayProcesses();
  process.exitCode = 1;
});
