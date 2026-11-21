const PORTS = [47831, 47832, 47833, 47834, 47835];

async function findKapsulaPort() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(700),
      });
      if (r.ok) return port;
    } catch {
      // try next port
    }
  }
  return null;
}

async function fetchHandshakeToken(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: { 'X-Kapsula-Client': 'ext-v1' },
      signal: AbortSignal.timeout(800),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.token || null;
  } catch {
    return null;
  }
}

async function fetchKapsulaStatus() {
  const port = await findKapsulaPort();
  if (!port) {
    return { connected: false, port: null, orbits: [] };
  }
  try {
    const token = await fetchHandshakeToken(port);
    if (!token) {
      return { connected: true, port, orbits: [] };
    }
    const resp = await fetch(`http://127.0.0.1:${port}/api/orbits`, {
      method: 'GET',
      headers: {
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Token': token,
      },
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) {
      return { connected: true, port, orbits: [] };
    }
    const data = await resp.json();
    return {
      connected: true,
      port,
      orbits: Array.isArray(data.orbits) ? data.orbits : [],
    };
  } catch {
    return { connected: true, port, orbits: [] };
  }
}

async function sendToKapsula(payload) {
  const port = await findKapsulaPort();
  if (!port) {
    return { ok: false, error: 'Запусти приложение Kapsula на компьютере' };
  }
  try {
    const token = await fetchHandshakeToken(port);
    const headers = {
      'Content-Type': 'application/json',
      'X-Kapsula-Client': 'ext-v1',
    };
    if (token) headers['X-Kapsula-Token'] = token;

    const resp = await fetch(`http://127.0.0.1:${port}/api/clip`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    return resp.ok ? { ok: true, data } : { ok: false, error: data.error || 'Ошибка сохранения' };
  } catch (err) {
    return { ok: false, error: err?.message || 'Нет связи с Kapsula' };
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
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab?.url || '';
  const text = info.selectionText || (tab?.title ? `${tab.title}\n${url}` : url);
  const mode = info.menuItemId === 'kapsula-save-secret' ? 'ghost' : 'autopilot';
  await sendToKapsula({
    url,
    title: tab?.title || '',
    text,
    mode,
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'KAPSULA_STATUS') {
    fetchKapsulaStatus().then(sendResponse);
    return true;
  }
  if (msg?.type === 'KAPSULA_CLIP') {
    sendToKapsula(msg.payload).then(sendResponse);
    return true;
  }
  return false;
});
