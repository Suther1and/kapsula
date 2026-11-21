(() => {
  if (document.getElementById('kapsula-ig-pill')) return;

  const pill = document.createElement('button');
  pill.id = 'kapsula-ig-pill';
  pill.type = 'button';
  pill.textContent = '⚡ В Kapsula';
  Object.assign(pill.style, {
    position: 'fixed',
    right: '20px',
    bottom: '22px',
    zIndex: '2147483647',
    padding: '10px 16px',
    borderRadius: '999px',
    border: '1px solid rgba(245, 165, 36, 0.45)',
    background: 'rgba(14, 16, 21, 0.92)',
    color: '#F4F4F5',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
    backdropFilter: 'blur(12px)',
    transition: 'transform 140ms ease-out, border-color 140ms ease-out',
  });

  function extractVisiblePostData() {
    const url = window.location.href;
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
    const ogDesc =
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
    const articleText =
      document.querySelector('article h1, main h1, article span[dir="auto"]')?.textContent?.trim() ||
      '';
    return {
      url,
      title: ogTitle || document.title || 'Instagram пост',
      text: [articleText || ogDesc, url].filter(Boolean).join('\n'),
      platform: 'instagram',
      tags: ['instagram'],
    };
  }

  pill.addEventListener('click', async () => {
    const isSavedGrid = /\/saved\//i.test(window.location.pathname);
    pill.textContent = 'Сохраняю…';

    if (isSavedGrid) {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))
        .map((a) => a.href)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .slice(0, 30);

      let saved = 0;
      for (const href of links) {
        const res = await chrome.runtime.sendMessage({
          type: 'KAPSULA_CLIP',
          payload: {
            url: href,
            title: 'Сохранёнка Instagram',
            text: href,
            platform: 'instagram',
            tags: ['instagram'],
          },
        });
        if (res?.ok) saved++;
      }
      pill.textContent = saved > 0 ? `✓ Сохранено: ${saved}` : 'Открой Kapsula на ПК';
      setTimeout(() => {
        pill.textContent = '⚡ В Kapsula';
      }, 2400);
      return;
    }

    const res = await chrome.runtime.sendMessage({
      type: 'KAPSULA_CLIP',
      payload: extractVisiblePostData(),
    });
    pill.textContent = res?.ok ? '✓ В Kapsula!' : 'Запусти Kapsula';
    setTimeout(() => {
      pill.textContent = '⚡ В Kapsula';
    }, 2200);
  });

  document.body.appendChild(pill);
})();
