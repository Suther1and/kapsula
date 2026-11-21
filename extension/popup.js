const statusEl = document.getElementById('status');
const noteEl = document.getElementById('note');
const orbitSelect = document.getElementById('orbitSelect');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');

const buttons = [
  document.getElementById('savePageBtn'),
  document.getElementById('saveSelectionBtn'),
  document.getElementById('saveShotBtn'),
  document.getElementById('saveSecretBtn'),
];

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function setBusy(busy) {
  for (const btn of buttons) {
    if (btn) btn.disabled = busy;
  }
}

async function initConnection() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'KAPSULA_STATUS' });
    if (res?.connected) {
      connDot.classList.add('online');
      connText.textContent = 'Подключено';
      const orbits = Array.isArray(res.orbits) ? res.orbits : [];
      for (const orb of orbits) {
        const opt = document.createElement('option');
        opt.value = orb.id;
        opt.textContent = orb.name;
        orbitSelect.appendChild(opt);
      }
    } else {
      connDot.classList.remove('online');
      connText.textContent = 'Не запущена';
      setStatus('Открой приложение Kapsula на компьютере', 'err');
    }
  } catch {
    connDot.classList.remove('online');
    connText.textContent = 'Нет связи';
  }
}

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
    url: tab?.url || undefined,
    title: tab?.title || '',
    text: content,
    mode: 'ghost',
  });
});

void initConnection();
