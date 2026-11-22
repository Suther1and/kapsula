const PORTS = [47831, 47832, 47833, 47834, 47835];
const STORAGE_TOKEN_KEY = 'kapsula_token_cache_v1';
const INSTAGRAM_ORIGIN_PATTERN = 'https://www.instagram.com/*';
const INSTAGRAM_SCRIPT_ID = 'kapsula-instagram';

let cachedPort = null;

async function getCachedToken(port) {
  try {
    if (!chrome.storage?.local) return null;
    const bag = await chrome.storage.local.get(STORAGE_TOKEN_KEY);
    const entry = bag?.[STORAGE_TOKEN_KEY];
    if (entry && entry.port === port && typeof entry.token === 'string' && entry.token) {
      return entry.token;
    }
  } catch {
    // ignore storage failures
  }
  return null;
}

async function setCachedToken(port, token) {
  try {
    if (!chrome.storage?.local) return;
    if (token) {
      await chrome.storage.local.set({ [STORAGE_TOKEN_KEY]: { port, token } });
    } else {
      await chrome.storage.local.remove(STORAGE_TOKEN_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

async function probeHealthPort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return false;
    const data = await r.json().catch(() => null);
    return data?.ok === true && data?.app === 'kapsula';
  } catch {
    return false;
  }
}

async function findKapsulaPort() {
  if (cachedPort && PORTS.includes(cachedPort)) {
    if (await probeHealthPort(cachedPort)) {
      return cachedPort;
    }
    cachedPort = null;
  }
  for (const port of PORTS) {
    if (await probeHealthPort(port)) {
      cachedPort = port;
      return port;
    }
  }
  return null;
}

async function fetchHandshakeToken(port, { pairCode, forceRefresh = false } = {}) {
  if (!forceRefresh && !pairCode) {
    const cached = await getCachedToken(port);
    if (cached) return { ok: true, token: cached };
  }
  try {
    const headers = { 'X-Kapsula-Client': 'ext-v1' };
    if (pairCode && typeof pairCode === 'string' && pairCode.trim()) {
      headers['X-Kapsula-Pair-Code'] = pairCode.trim();
    }
    const resp = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(1200),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      await setCachedToken(port, null);
      return {
        ok: false,
        pairingRequired: data?.code === 'pairing_required',
        error: data?.error || 'Требуется код подключения',
      };
    }
    const token = typeof data?.token === 'string' ? data.token : null;
    if (!token) {
      return { ok: false, error: 'Не удалось получить ключ доступа' };
    }
    await setCachedToken(port, token);
    return { ok: true, token };
  } catch {
    cachedPort = null;
    return { ok: false, error: 'Нет связи с Kapsula' };
  }
}

async function fetchKapsulaStatus() {
  const port = await findKapsulaPort();
  if (!port) {
    return { connected: false, port: null, pairingRequired: false, orbits: [] };
  }
  try {
    let handshake = await fetchHandshakeToken(port);
    if (!handshake.ok) {
      return {
        connected: true,
        port,
        pairingRequired: Boolean(handshake.pairingRequired),
        error: handshake.error,
        orbits: [],
      };
    }
    let resp = await fetch(`http://127.0.0.1:${port}/api/orbits`, {
      method: 'GET',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Token': handshake.token,
      },
      signal: AbortSignal.timeout(1500),
    });
    if (resp.status === 401 || resp.status === 403) {
      handshake = await fetchHandshakeToken(port, { forceRefresh: true });
      if (!handshake.ok) {
        return {
          connected: true,
          port,
          pairingRequired: Boolean(handshake.pairingRequired),
          error: handshake.error,
          orbits: [],
        };
      }
      resp = await fetch(`http://127.0.0.1:${port}/api/orbits`, {
        method: 'GET',
        headers: {
          'X-Kapsula-Client': 'ext-v1',
          'X-Kapsula-Token': handshake.token,
        },
        signal: AbortSignal.timeout(1500),
      });
    }
    if (!resp.ok) {
      return { connected: true, port, pairingRequired: false, orbits: [] };
    }
    const data = await resp.json().catch(() => ({}));
    return {
      connected: true,
      port,
      pairingRequired: false,
      orbits: Array.isArray(data.orbits) ? data.orbits : [],
    };
  } catch {
    cachedPort = null;
    return { connected: true, port, pairingRequired: false, orbits: [] };
  }
}

async function pairWithCode(pairCode) {
  const port = await findKapsulaPort();
  if (!port) {
    return { ok: false, error: 'Запусти приложение Kapsula на компьютере' };
  }
  const handshake = await fetchHandshakeToken(port, {
    pairCode: typeof pairCode === 'string' ? pairCode.trim() : '',
    forceRefresh: true,
  });
  if (!handshake.ok) {
    return {
      ok: false,
      pairingRequired: Boolean(handshake.pairingRequired),
      error: handshake.error || 'Неверный код подключения',
    };
  }
  const status = await fetchKapsulaStatus();
  return { ok: true, orbits: status.orbits || [] };
}

function isSafeHttpUrl(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  return /^https?:\/\//i.test(trimmed);
}

function sanitizeClipPayload(raw, { allowGhost = false, allowImage = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const modeRaw = typeof raw.mode === 'string' ? raw.mode : 'autopilot';
  const allowedModes = allowGhost
    ? ['autopilot', 'buffer', 'focus', 'ghost']
    : ['autopilot', 'buffer', 'focus'];
  const mode = allowedModes.includes(modeRaw) ? modeRaw : 'autopilot';
  const clean = { mode };

  if (mode !== 'ghost') {
    if (isSafeHttpUrl(raw.url)) clean.url = raw.url.trim();
    if (typeof raw.title === 'string' && raw.title.trim()) {
      clean.title = raw.title.trim().slice(0, 300);
    }
  }
  if (typeof raw.text === 'string' && raw.text.length > 0) {
    clean.text = raw.text.slice(0, 100_000);
  }
  if (typeof raw.html === 'string' && raw.html.length > 0) {
    clean.html = raw.html.slice(0, 200_000);
  }
  if (
    allowImage &&
    typeof raw.imageBase64 === 'string' &&
    raw.imageBase64.length > 0 &&
    raw.imageBase64.length <= 7_000_000
  ) {
    clean.imageBase64 = raw.imageBase64;
  }
  if (typeof raw.orbitId === 'string' && raw.orbitId.trim()) {
    clean.orbitId = raw.orbitId.trim().slice(0, 80);
  }
  if (typeof raw.platform === 'string' && raw.platform.trim()) {
    clean.platform = raw.platform.trim().slice(0, 40);
  }
  if (Array.isArray(raw.tags)) {
    const cleanTags = raw.tags
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, 48))
      .slice(0, 12);
    if (cleanTags.length > 0) clean.tags = cleanTags;
  }
  if (!clean.url && !clean.text && !clean.html && !clean.imageBase64) {
    return null;
  }
  return clean;
}

async function resolveClipSession() {
  const port = await findKapsulaPort();
  if (!port) {
    return { ok: false, error: 'Запусти приложение Kapsula на компьютере' };
  }
  const handshake = await fetchHandshakeToken(port);
  if (!handshake.ok) {
    return {
      ok: false,
      pairingRequired: Boolean(handshake.pairingRequired),
      error: handshake.error || 'Требуется код подключения в расширении',
    };
  }
  return { ok: true, port, token: handshake.token };
}

async function postClipRequest(port, token, path, bodyObj, timeoutMs) {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kapsula-Client': 'ext-v1',
      'X-Kapsula-Token': token,
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

async function sendToKapsula(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Некорректные данные для сохранения' };
  }
  const session = await resolveClipSession();
  if (!session.ok) return session;

  try {
    let { resp, data } = await postClipRequest(session.port, session.token, '/api/clip', payload, 8000);
    if (resp.status === 401 || resp.status === 403) {
      const refreshed = await fetchHandshakeToken(session.port, { forceRefresh: true });
      if (!refreshed.ok) {
        return {
          ok: false,
          pairingRequired: Boolean(refreshed.pairingRequired),
          error: refreshed.error || 'Требуется код подключения',
        };
      }
      ({ resp, data } = await postClipRequest(session.port, refreshed.token, '/api/clip', payload, 8000));
    }

    return resp.ok
      ? { ok: true, data }
      : { ok: false, error: data?.error || 'Ошибка сохранения' };
  } catch (err) {
    cachedPort = null;
    return { ok: false, error: err?.message || 'Нет связи с Kapsula' };
  }
}

async function sendBatchToKapsula(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, saved: 0, failed: 0, total: 0, error: 'Посты для сохранения не найдены' };
  }
  const cleanItems = rawItems
    .map((item) => sanitizeClipPayload(item, { allowGhost: false, allowImage: false }))
    .filter(Boolean)
    .slice(0, 30);

  if (cleanItems.length === 0) {
    return { ok: false, saved: 0, failed: 0, total: 0, error: 'Нет корректных ссылок для сохранения' };
  }

  const session = await resolveClipSession();
  if (!session.ok) {
    return { ...session, saved: 0, failed: cleanItems.length, total: cleanItems.length };
  }

  let activeToken = session.token;
  try {
    let { resp, data } = await postClipRequest(
      session.port,
      activeToken,
      '/api/clip-batch',
      { items: cleanItems },
      25000
    );
    if (resp.status === 401 || resp.status === 403) {
      const refreshed = await fetchHandshakeToken(session.port, { forceRefresh: true });
      if (!refreshed.ok) {
        return {
          ok: false,
          saved: 0,
          failed: cleanItems.length,
          total: cleanItems.length,
          pairingRequired: Boolean(refreshed.pairingRequired),
          error: refreshed.error || 'Требуется код подключения',
        };
      }
      activeToken = refreshed.token;
      ({ resp, data } = await postClipRequest(
        session.port,
        activeToken,
        '/api/clip-batch',
        { items: cleanItems },
        25000
      ));
    }

    // Fallback for older ClipperServer versions without /api/clip-batch (reusing single port & token)
    if (resp.status === 404) {
      let saved = 0;
      let failed = 0;
      let lastError = null;
      for (const item of cleanItems) {
        const single = await postClipRequest(session.port, activeToken, '/api/clip', item, 8000);
        if (single.resp.ok) saved += 1;
        else {
          failed += 1;
          lastError = single.data?.error || lastError;
        }
      }
      return {
        ok: saved > 0,
        saved,
        failed,
        total: cleanItems.length,
        ...(saved === 0 ? { error: lastError || 'Не удалось сохранить подборку' } : {}),
      };
    }

    return {
      ok: Boolean(resp.ok && data?.ok),
      saved: typeof data?.saved === 'number' ? data.saved : 0,
      failed: typeof data?.failed === 'number' ? data.failed : cleanItems.length,
      total: cleanItems.length,
      ...(data?.error ? { error: data.error } : {}),
    };
  } catch (err) {
    cachedPort = null;
    return {
      ok: false,
      saved: 0,
      failed: cleanItems.length,
      total: cleanItems.length,
      error: err?.message || 'Нет связи с Kapsula',
    };
  }
}

async function hasInstagramPermission() {
  try {
    if (!chrome.permissions?.contains) return false;
    return await chrome.permissions.contains({ origins: [INSTAGRAM_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}

async function syncInstagramContentScript({ injectOpenTabs = false } = {}) {
  if (!chrome.scripting?.registerContentScripts) return false;
  const granted = await hasInstagramPermission();
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [INSTAGRAM_SCRIPT_ID],
    });
    if (granted) {
      if (!existing || existing.length === 0) {
        await chrome.scripting.registerContentScripts([
          {
            id: INSTAGRAM_SCRIPT_ID,
            matches: [INSTAGRAM_ORIGIN_PATTERN],
            js: ['content-instagram.js'],
            runAt: 'document_idle',
            persistAcrossSessions: true,
          },
        ]);
      }
      if (injectOpenTabs && chrome.tabs?.query) {
        const tabs = await chrome.tabs.query({ url: INSTAGRAM_ORIGIN_PATTERN }).catch(() => []);
        for (const tab of tabs) {
          if (!tab?.id) continue;
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-instagram.js'],
            });
          } catch {
            // ignore restricted tabs
          }
        }
      }
      return true;
    }

    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [INSTAGRAM_SCRIPT_ID] });
    }
    return false;
  } catch {
    return granted;
  }
}

async function showBadgeFeedback(ok, message) {
  if (!chrome.action?.setBadgeText) return;
  try {
    await chrome.action.setBadgeBackgroundColor({
      color: ok ? '#2ea06b' : '#ef4444',
    });
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    if (message && chrome.action.setTitle) {
      await chrome.action.setTitle({ title: ok ? 'Сохранено в Kapsula' : `Kapsula: ${message}` });
    }
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
      if (chrome.action.setTitle) {
        void chrome.action.setTitle({ title: 'Сохранить в Kapsula' });
      }
    }, 5000);
  } catch {
    // ignore badge errors
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'kapsula-save',
      title: 'Сохранить в Kapsula',
      contexts: ['page', 'selection', 'link'],
    });
    chrome.contextMenus.create({
      id: 'kapsula-save-secret',
      title: 'Отправить в Сейф Kapsula',
      contexts: ['selection'],
    });
  });
  void syncInstagramContentScript();
});

chrome.runtime.onStartup?.addListener(() => {
  void syncInstagramContentScript();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const isGhost = info.menuItemId === 'kapsula-save-secret';
  if (isGhost) {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    const res = await sendToKapsula({ text, mode: 'ghost' });
    await showBadgeFeedback(Boolean(res?.ok), res?.error);
    return;
  }
  const url = info.linkUrl || info.pageUrl || tab?.url || '';
  const text = info.selectionText || (tab?.title ? `${tab.title}\n${url}` : url);
  const res = await sendToKapsula({
    url,
    title: tab?.title || '',
    text,
    mode: 'autopilot',
  });
  await showBadgeFeedback(Boolean(res?.ok), res?.error);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  const isExtensionPage =
    typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

  if (msg?.type === 'KAPSULA_STATUS') {
    fetchKapsulaStatus().then(sendResponse);
    return true;
  }
  if (msg?.type === 'KAPSULA_PAIR') {
    if (!isExtensionPage) {
      sendResponse({ ok: false, error: 'Недостаточно прав' });
      return false;
    }
    pairWithCode(msg.pairCode).then(sendResponse);
    return true;
  }
  if (msg?.type === 'KAPSULA_IG_TOGGLE') {
    if (!isExtensionPage) {
      sendResponse({ ok: false, error: 'Недостаточно прав' });
      return false;
    }
    syncInstagramContentScript({ injectOpenTabs: Boolean(msg.enabled) })
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch(() => sendResponse({ ok: false, enabled: false }));
    return true;
  }
  if (msg?.type === 'KAPSULA_CLIP') {
    const payload = sanitizeClipPayload(msg.payload, {
      allowGhost: isExtensionPage,
      allowImage: isExtensionPage,
    });
    if (!payload) {
      sendResponse({ ok: false, error: 'Некорректные данные' });
      return false;
    }
    sendToKapsula(payload).then(sendResponse);
    return true;
  }
  if (msg?.type === 'KAPSULA_CLIP_BATCH') {
    sendBatchToKapsula(msg.items).then(sendResponse);
    return true;
  }
  return false;
});
