const statusEl = document.getElementById('status');
const noteEl = document.getElementById('note');
const orbitSelect = document.getElementById('orbitSelect');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const pairBox = document.getElementById('pairBox');
const pairCodeInput = document.getElementById('pairCodeInput');
const pairBtn = document.getElementById('pairBtn');
const igOverlayToggle = document.getElementById('igOverlayToggle');

const INSTAGRAM_ORIGIN_PATTERN = 'https://www.instagram.com/*';

const buttons = [
  document.getElementById('savePageBtn'),
  document.getElementById('saveSelectionBtn'),
  document.getElementById('saveShotBtn'),
  document.getElementById('saveSecretBtn'),
];

function populateOrbits(orbits) {
  while (orbitSelect.options.length > 1) {
    orbitSelect.remove(1);
  }
  for (const orb of Array.isArray(orbits) ? orbits : []) {
    const opt = document.createElement('option');
    opt.value = orb.id;
    opt.textContent = orb.name;
    orbitSelect.appendChild(opt);
  }
}

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function setBusy(busy) {
  for (const btn of buttons) {
    if (btn) btn.disabled = busy;
  }
}

async function initInstagramToggle() {
  if (!igOverlayToggle || !chrome.permissions?.contains) return;
  try {
    const granted = await chrome.permissions.contains({ origins: [INSTAGRAM_ORIGIN_PATTERN] });
    igOverlayToggle.checked = Boolean(granted);
  } catch {
    igOverlayToggle.checked = false;
  }
}

igOverlayToggle?.addEventListener('change', async () => {
  if (!chrome.permissions?.request || !chrome.permissions?.remove) return;
  const wantEnable = igOverlayToggle.checked;
  igOverlayToggle.disabled = true;
  try {
    if (wantEnable) {
      const granted = await chrome.permissions.request({ origins: [INSTAGRAM_ORIGIN_PATTERN] });
      igOverlayToggle.checked = Boolean(granted);
      if (!granted) {
        setStatus('Разрешение для Instagram не выдано', 'err');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'KAPSULA_IG_TOGGLE', enabled: true });
      setStatus('Кнопка для постов и подборки Instagram включена', 'ok');
    } else {
      await chrome.permissions.remove({ origins: [INSTAGRAM_ORIGIN_PATTERN] }).catch(() => false);
      await chrome.runtime.sendMessage({ type: 'KAPSULA_IG_TOGGLE', enabled: false });
      setStatus('Кнопка поверх Instagram отключена');
    }
  } catch {
    setStatus('Не удалось обновить разрешение для Instagram', 'err');
  } finally {
    igOverlayToggle.disabled = false;
  }
});

async function initConnection() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'KAPSULA_STATUS' });
    if (res?.connected && res?.pairingRequired) {
      connDot.classList.remove('online');
      connText.textContent = 'Нужен код';
      pairBox?.classList.add('visible');
      setStatus('Введи код подключения из Настроек Kapsula', 'err');
      setBusy(true);
    } else if (res?.connected) {
      connDot.classList.add('online');
      connText.textContent = 'Подключено';
      pairBox?.classList.remove('visible');
      setBusy(false);
      populateOrbits(res.orbits);
      setStatus('');
    } else {
      connDot.classList.remove('online');
      connText.textContent = 'Не запущена';
      pairBox?.classList.remove('visible');
      setStatus('Открой приложение Kapsula на компьютере', 'err');
    }
  } catch {
    connDot.classList.remove('online');
    connText.textContent = 'Нет связи';
  }
}

pairBtn?.addEventListener('click', async () => {
  const code = (pairCodeInput?.value || '').trim();
  if (!code) {
    setStatus('Введи код из Настроек Kapsula', 'err');
    return;
  }
  pairBtn.disabled = true;
  setStatus('Подключаю…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'KAPSULA_PAIR', pairCode: code });
    if (res?.ok) {
      pairBox?.classList.remove('visible');
      if (pairCodeInput) pairCodeInput.value = '';
      connDot.classList.add('online');
      connText.textContent = 'Подключено';
      populateOrbits(res.orbits);
      setBusy(false);
      setStatus('Расширение подключено', 'ok');
    } else {
      setStatus(res?.error || 'Неверный код подключения', 'err');
    }
  } catch {
    setStatus('Нет связи с Kapsula', 'err');
  } finally {
    pairBtn.disabled = false;
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getPageSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.getSelection ? window.getSelection().toString().trim() : ''),
    });
    return results?.[0]?.result || '';
  } catch {
    return '';
  }
}

async function extractInstagramFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-instagram.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const helpers = globalThis.__KapsulaIgHelpers;
        if (!helpers) return null;
        if (helpers.isSavedInstagramPath(window.location.pathname)) {
          return {
            kind: 'saved_batch',
            items: helpers.collectSavedPostItems(document, window.location),
          };
        }
        return {
          kind: 'post',
          data: helpers.extractInstagramPostData(document, window.location),
        };
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function sendClip(payload) {
  setBusy(true);
  setStatus('Сохраняю в Kapsula…');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'KAPSULA_CLIP',
      payload,
    });
    if (res?.ok) {
      setStatus('Сохранено в Kapsula', 'ok');
      setTimeout(() => window.close(), 850);
    } else {
      if (res?.pairingRequired) {
        pairBox?.classList.add('visible');
        connDot.classList.remove('online');
        connText.textContent = 'Нужен код';
      }
      setStatus(res?.error || 'Не удалось связаться с Kapsula', 'err');
      setBusy(false);
    }
  } catch {
    setStatus('Не удалось связаться с Kapsula', 'err');
    setBusy(false);
  }
}

document.getElementById('savePageBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.url) {
    setStatus('Нет активной вкладки', 'err');
    return;
  }
  const extra = noteEl.value.trim();
  const orbitId = orbitSelect.value || undefined;

  if (/^https:\/\/(?:www\.)?instagram\.com\//i.test(tab.url) && tab.id) {
    const igExtracted = await extractInstagramFromTab(tab.id);
    if (igExtracted?.kind === 'saved_batch' && Array.isArray(igExtracted.items) && igExtracted.items.length > 0) {
      setBusy(true);
      setStatus('Сохраняю подборку Instagram…');
      try {
        const items = igExtracted.items.map((it) => ({
          ...it,
          ...(orbitId ? { orbitId } : {}),
        }));
        const res = await chrome.runtime.sendMessage({
          type: 'KAPSULA_CLIP_BATCH',
          items,
        });
        if (res?.ok && res.saved > 0) {
          setStatus(`Сохранено постов: ${res.saved}`, 'ok');
          setTimeout(() => window.close(), 850);
        } else {
          setStatus(res?.error || 'Не удалось сохранить подборку', 'err');
          setBusy(false);
        }
      } catch {
        setStatus('Не удалось связаться с Kapsula', 'err');
        setBusy(false);
      }
      return;
    }
    if (igExtracted?.kind === 'post' && igExtracted.data) {
      const d = igExtracted.data;
      const text = [extra, d.text].filter(Boolean).join('\n\n');
      await sendClip({
        url: d.url || tab.url,
        title: d.title || tab.title || '',
        text,
        orbitId,
        platform: 'instagram',
        tags: ['instagram'],
        mode: 'autopilot',
      });
      return;
    }
  }

  const text = extra ? `${extra}\n${tab.url}` : `${tab.title || ''}\n${tab.url}`.trim();
  await sendClip({
    url: tab.url,
    title: tab.title || '',
    text,
    orbitId,
    mode: 'autopilot',
  });
});

document.getElementById('saveSelectionBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setStatus('Нет активной вкладки', 'err');
    return;
  }
  const selection = await getPageSelection(tab.id);
  const extra = noteEl.value.trim();
  if (!selection && !extra) {
    setStatus('Выдели текст на странице или напиши заметку выше', 'err');
    return;
  }
  const orbitId = orbitSelect.value || undefined;
  const text = [extra, selection, tab.url].filter(Boolean).join('\n\n');
  await sendClip({
    url: tab.url,
    title: tab.title || 'Фрагмент со страницы',
    text,
    orbitId,
    mode: 'autopilot',
  });
});

document.getElementById('saveShotBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.url) {
    setStatus('Нет активной вкладки', 'err');
    return;
  }
  try {
    setBusy(true);
    setStatus('Делаю снимок вкладки…');
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const extra = noteEl.value.trim();
    const orbitId = orbitSelect.value || undefined;
    await sendClip({
      url: tab.url,
      title: extra || tab.title || 'Скриншот страницы',
      text: extra || tab.title || tab.url,
      imageBase64: dataUrl,
      orbitId,
      mode: 'autopilot',
    });
  } catch {
    setStatus('Не удалось снять скриншот на этой служебной вкладке', 'err');
    setBusy(false);
  }
});

document.getElementById('saveSecretBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  const selection = tab?.id ? await getPageSelection(tab.id) : '';
  const extra = noteEl.value.trim();
  const content = [extra, selection].filter(Boolean).join('\n\n');
  if (!content) {
    setStatus('Выдели секрет на странице или введи его в поле выше', 'err');
    return;
  }
  await sendClip({
    text: content,
    mode: 'ghost',
  });
});

void initInstagramToggle();
void initConnection();
