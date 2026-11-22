(() => {
  const IG_POST_PATH_RE = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+(?:\/|$)/i;
  const IG_SAVED_PATH_RE = /^\/(?:[A-Za-z0-9._]+\/)?saved(?:\/|$)/i;
  const UI_CHROME_TEXT_RE =
    /^(?:instagram|verified|подписаться|подписки|подписчики|нравится|комментарии|поделиться|сохранить|ещё|аудио|оригинальное аудио|follow|following|followers|like|likes|comments|share|save|more|audio|original audio|view all(?:\s+\d+\s+comments)?|посмотреть все комментар\S*|\d+\s*(?:сек|мин|ч|д|нед|г|s|m|h|d|w|y)\.?|•)$/i;

  function cleanInstagramUrl(rawHref, origin = 'https://www.instagram.com') {
    if (!rawHref || typeof rawHref !== 'string') return '';
    try {
      const parsed = new URL(rawHref, origin);
      if (!/instagram\.com$/i.test(parsed.hostname)) return '';
      const stripParams = ['igsh', 'igshid', 'fbclid', 'ref', 'hl', 'img_index'];
      for (const p of stripParams) parsed.searchParams.delete(p);
      for (const k of Array.from(parsed.searchParams.keys())) {
        if (k.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(k);
      }
      const normalizedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
      const query = parsed.searchParams.toString();
      return `${parsed.origin}${normalizedPath}${query ? `?${query}` : ''}`;
    } catch {
      return '';
    }
  }

  function isSavedInstagramPath(pathname) {
    return typeof pathname === 'string' && IG_SAVED_PATH_RE.test(pathname);
  }

  function isEligibleInstagramRoute(pathname) {
    if (typeof pathname !== 'string' || !pathname) return false;
    return IG_POST_PATH_RE.test(pathname) || IG_SAVED_PATH_RE.test(pathname);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function unwrapOgDescription(rawOg) {
    const clean = normalizeText(rawOg);
    if (!clean) return '';
    const quoteMatch = /^[^"«»]+:\s*["«]([\s\S]+)["»]\.?$/.exec(clean);
    if (quoteMatch && quoteMatch[1]) {
      return quoteMatch[1].trim();
    }
    return clean;
  }

  function extractAuthorHandle(container) {
    if (!container) return '';
    const anchors = container.querySelectorAll('header a[href^="/"], a[href^="/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = /^\/([A-Za-z0-9._]{1,40})\/?(?:\?.*)?$/.exec(href);
      if (!m) continue;
      const slug = m[1];
      if (/^(explore|p|reel|reels|tv|direct|accounts|stories|saved|audio)$/i.test(slug)) {
        continue;
      }
      return slug;
    }
    return '';
  }

  function isInsideChromeElement(node, container) {
    let cur = node;
    while (cur && cur !== container) {
      const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      if (
        tag === 'header' ||
        tag === 'nav' ||
        tag === 'footer' ||
        tag === 'button' ||
        tag === 'time' ||
        tag === 'form' ||
        tag === 'textarea' ||
        tag === 'input'
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function isNoiseCaptionCandidate(text, authorHandle) {
    if (!text) return true;
    const norm = normalizeText(text);
    if (!norm) return true;
    if (UI_CHROME_TEXT_RE.test(norm)) return true;
    if (/^[\d\s.,kKmM]+$/.test(norm)) return true;
    if (authorHandle) {
      const lower = norm.toLowerCase();
      const handleLower = authorHandle.toLowerCase();
      if (lower === handleLower || lower === `@${handleLower}`) return true;
    }
    return false;
  }

  function extractInstagramPostData(doc, loc) {
    const activeLoc = loc || (typeof window !== 'undefined' ? window.location : { href: '', pathname: '/', origin: 'https://www.instagram.com' });
    const cleanUrl = cleanInstagramUrl(activeLoc.href, activeLoc.origin || 'https://www.instagram.com') || activeLoc.href || '';
    const container =
      doc.querySelector('div[role="dialog"] article') ||
      doc.querySelector('article') ||
      doc.querySelector('main') ||
      doc.body;

    const author = extractAuthorHandle(container);
    let caption = '';

    // 1. Prefer <h1> caption inside active post/reel container
    if (container) {
      const headings = container.querySelectorAll('h1');
      for (const h1 of headings) {
        if (isInsideChromeElement(h1, container)) continue;
        const candidate = normalizeText(h1.innerText ?? h1.textContent);
        if (!isNoiseCaptionCandidate(candidate, author)) {
          caption = candidate;
          break;
        }
      }
    }

    // 2. Scan dir="auto" text nodes outside chrome/links when <h1> is absent
    if (!caption && container) {
      const candidates = container.querySelectorAll('span[dir="auto"], div[dir="auto"]');
      let fallbackShort = '';
      for (const el of candidates) {
        if (isInsideChromeElement(el, container)) continue;
        // Skip standalone profile links (author handle or mention-only anchor)
        if (el.closest('a')) continue;
        const text = normalizeText(el.innerText ?? el.textContent);
        if (isNoiseCaptionCandidate(text, author)) continue;
        // Skip wrapper nodes that include another sub-caption span or massive comment threads
        if (text.length > 4000) continue;
        if (text.length >= 16 || /\s/.test(text)) {
          caption = text;
          break;
        }
        if (!fallbackShort) {
          fallbackShort = text;
        }
      }
      if (!caption && fallbackShort) {
        caption = fallbackShort;
      }
    }

    // 3. Fallback to og:description ONLY when SSR metadata matches current SPA URL
    if (!caption) {
      const ogUrlRaw =
        doc.querySelector('meta[property="og:url"]')?.getAttribute('content') ||
        doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
        '';
      let metadataMatchesPath = false;
      if (ogUrlRaw) {
        try {
          const ogPath = new URL(ogUrlRaw, 'https://www.instagram.com').pathname.replace(/\/+$/, '');
          const curPath = String(activeLoc.pathname || '').replace(/\/+$/, '');
          metadataMatchesPath = Boolean(ogPath && curPath && ogPath === curPath);
        } catch {
          metadataMatchesPath = false;
        }
      }
      if (metadataMatchesPath) {
        const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const unwrapped = unwrapOgDescription(ogDesc);
        if (!isNoiseCaptionCandidate(unwrapped, author)) {
          caption = unwrapped;
        }
      }
    }

    const firstLine = caption
      .split(/\r?\n/)[0]
      ?.trim()
      .slice(0, 72);
    const title = author
      ? `Instagram · @${author}${firstLine ? ` — ${firstLine}` : ''}`
      : firstLine
        ? `Instagram · ${firstLine}`
        : 'Instagram пост';

    return {
      url: cleanUrl,
      title: title.slice(0, 140),
      text: [caption, cleanUrl].filter(Boolean).join('\n\n'),
      platform: 'instagram',
      tags: ['instagram'],
    };
  }

  function collectSavedPostItems(doc, loc) {
    const activeLoc = loc || (typeof window !== 'undefined' ? window.location : { origin: 'https://www.instagram.com' });
    const origin = activeLoc.origin || 'https://www.instagram.com';
    const root = doc.querySelector('main') || doc;
    const anchors = Array.from(root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'));
    const seen = new Set();
    const items = [];

    for (const a of anchors) {
      const rawHref = a.getAttribute('href') || a.href || '';
      const cleanUrl = cleanInstagramUrl(rawHref, origin);
      if (!cleanUrl || seen.has(cleanUrl)) continue;
      seen.add(cleanUrl);

      const imgAlt = normalizeText(a.querySelector('img')?.getAttribute('alt') || '');
      const cleanAlt =
        imgAlt && !/^Photo by /i.test(imgAlt) && imgAlt.length >= 6
          ? imgAlt.slice(0, 240)
          : '';

      items.push({
        url: cleanUrl,
        title: cleanAlt ? `Instagram · ${cleanAlt.slice(0, 72)}` : 'Сохранёнка Instagram',
        text: [cleanAlt, cleanUrl].filter(Boolean).join('\n\n'),
        platform: 'instagram',
        tags: ['instagram'],
      });
      if (items.length >= 30) break;
    }

    return items;
  }

  globalThis.__KapsulaIgHelpers = {
    cleanInstagramUrl,
    isSavedInstagramPath,
    isEligibleInstagramRoute,
    extractInstagramPostData,
    collectSavedPostItems,
  };

  if (typeof window === 'undefined' || typeof document === 'undefined' || !chrome?.runtime?.id) {
    return;
  }
  if (window.__kapsulaIgMounted) return;
  window.__kapsulaIgMounted = true;

  let pill = null;
  let isSaving = false;
  let resetTimer = null;
  let lastHref = window.location.href;
  let mutationTimer = null;

  function defaultPillLabel() {
    return isSavedInstagramPath(window.location.pathname)
      ? '⚡ Сохранить подборку'
      : '⚡ В Kapsula';
  }

  function ensurePill() {
    if (pill && document.body?.contains(pill)) return pill;
    pill = document.getElementById('kapsula-ig-pill');
    if (pill) return pill;

    pill = document.createElement('button');
    pill.id = 'kapsula-ig-pill';
    pill.type = 'button';
    pill.textContent = defaultPillLabel();
    Object.assign(pill.style, {
      position: 'fixed',
      right: '20px',
      bottom: '22px',
      zIndex: '2147483647',
      padding: '10px 16px',
      borderRadius: '999px',
      border: '1px solid rgba(245, 165, 36, 0.45)',
      background: 'rgba(14, 16, 21, 0.94)',
      color: '#F4F4F5',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
      backdropFilter: 'blur(12px)',
      transition: 'transform 140ms ease-out, border-color 140ms ease-out, opacity 140ms ease-out',
    });

    pill.addEventListener('click', handlePillClick);
    document.body?.appendChild(pill);
    return pill;
  }

  function removePill() {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    const existing = document.getElementById('kapsula-ig-pill');
    if (existing) existing.remove();
    pill = null;
  }

  function setTemporaryLabel(el, text, ms = 2400) {
    if (resetTimer) clearTimeout(resetTimer);
    el.textContent = text;
    resetTimer = setTimeout(() => {
      resetTimer = null;
      if (el.isConnected && !isSaving) {
        el.textContent = defaultPillLabel();
      }
    }, ms);
  }

  function formatErrorLabel(res) {
    if (res?.pairingRequired) return 'Введи код в расширении';
    const raw = typeof res?.error === 'string' ? res.error.trim() : '';
    if (!raw) return 'Запусти Kapsula на ПК';
    return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
  }

  async function handlePillClick() {
    if (isSaving || !pill) return;
    isSaving = true;
    pill.disabled = true;
    pill.style.opacity = '0.8';
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    pill.textContent = 'Сохраняю…';

    try {
      if (isSavedInstagramPath(window.location.pathname)) {
        const items = collectSavedPostItems(document, window.location);
        if (items.length === 0) {
          setTemporaryLabel(pill, 'Посты не найдены', 2200);
          return;
        }
        const res = await chrome.runtime.sendMessage({
          type: 'KAPSULA_CLIP_BATCH',
          items,
        });
        if (res?.ok && res.saved > 0) {
          setTemporaryLabel(pill, `✓ Сохранено: ${res.saved}`, 2600);
        } else {
          setTemporaryLabel(pill, formatErrorLabel(res), 2800);
        }
        return;
      }

      const payload = extractInstagramPostData(document, window.location);
      const res = await chrome.runtime.sendMessage({
        type: 'KAPSULA_CLIP',
        payload,
      });
      if (res?.ok) {
        setTemporaryLabel(pill, '✓ В Kapsula!', 2200);
      } else {
        setTemporaryLabel(pill, formatErrorLabel(res), 2800);
      }
    } catch {
      setTemporaryLabel(pill, 'Нет связи с Kapsula', 2600);
    } finally {
      isSaving = false;
      if (pill) {
        pill.disabled = false;
        pill.style.opacity = '1';
      }
    }
  }

  function syncPillState() {
    if (!document.body) return;
    if (isEligibleInstagramRoute(window.location.pathname)) {
      const btn = ensurePill();
      if (!isSaving && !resetTimer) {
        btn.textContent = defaultPillLabel();
      }
    } else {
      removePill();
    }
  }

  function checkRouteChange() {
    const cur = window.location.href;
    if (cur !== lastHref) {
      lastHref = cur;
      syncPillState();
    }
  }

  syncPillState();

  window.addEventListener('popstate', syncPillState);
  window.addEventListener('hashchange', syncPillState);

  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      checkRouteChange();
      if (isEligibleInstagramRoute(window.location.pathname) && !document.getElementById('kapsula-ig-pill')) {
        syncPillState();
      }
    }, 180);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      checkRouteChange();
    }
  }, 1000);
})();
