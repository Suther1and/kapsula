(() => {
  const RELEASES_API = 'https://api.github.com/repos/Suther1and/kapsula/releases/latest';
  const RELEASES_FALLBACK = 'https://github.com/Suther1and/kapsula/releases/latest';
  const THEME_STORAGE_KEY = 'kapsula-docs-theme';

  /* ---------- Theme Toggle (Obsidian Dark <-> Porcelain Light) ---------- */
  const root = document.documentElement;
  const themeToggle = document.getElementById('theme-toggle');
  const themeToggleLabel = document.getElementById('theme-toggle-label');
  const metaThemeColor = document.getElementById('meta-theme-color');

  function syncThemeUi(theme) {
    const isLight = theme === 'light';
    root.setAttribute('data-theme', theme);
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isLight ? '#f4f5f7' : '#0e0e11');
    }
    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', String(isLight));
      themeToggle.setAttribute(
        'aria-label',
        isLight ? 'Переключить на тёмную тему' : 'Переключить на светлую тему',
      );
    }
    if (themeToggleLabel) {
      themeToggleLabel.textContent = isLight ? 'Тёмная' : 'Светлая';
    }
  }

  syncThemeUi(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      const apply = () => {
        syncThemeUi(next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // ignore storage restrictions
        }
      };

      const prefersReduced =
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof document.startViewTransition === 'function' && !prefersReduced) {
        document.startViewTransition(apply);
      } else {
        apply();
      }
    });
  }

  /* ---------- Video Poster Play Overlay ---------- */
  const video = document.getElementById('demo-video');
  const videoFrame = document.querySelector('.video-frame');
  const videoPlayBtn = document.getElementById('video-play-btn');

  if (video && videoFrame && videoPlayBtn) {
    const setPlaying = (playing) => {
      videoFrame.setAttribute('data-playing', playing ? 'true' : 'false');
    };

    videoPlayBtn.addEventListener('click', () => {
      setPlaying(true);
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => setPlaying(false));
      }
    });

    video.addEventListener('play', () => setPlaying(true));
    video.addEventListener('ended', () => setPlaying(false));
  }

  /* ---------- Interactive Product Tour ---------- */
  const TOUR_ITEMS = [
    {
      id: 'tab-notes',
      src: 'assets/hero-feed-dark.png',
      alt: 'Главный экран Kapsula с разделами, заметками, голосовыми записями и референсами',
      title: 'Лента, разделы и\u00A0связанные заметки',
      desc: 'Текстовые заметки, чек-листы, голосовые с\u00A0расшифровкой, ссылки и\u00A0визуальные референсы живут в\u00A0одной ленте. База открывается мгновенно без сети.',
      meta: 'Ctrl + F · мгновенный поиск',
      mode: 'desktop',
    },
    {
      id: 'tab-hud',
      src: 'assets/hud-dark.png',
      alt: 'Быстрая панель Kapsula Alt+Space с поиском слева и живым редактором заметки справа',
      title: 'Быстрая панель поверх любого окна',
      desc: 'Открывается клавишами Alt\u00A0+\u00A0Space без переключения рабочего стола. Ищите по\u00A0всей базе, отмечайте пункты и\u00A0дописывайте заметку прямо в\u00A0правой колонке.',
      meta: 'Alt + Space · работает везде',
      mode: 'desktop',
    },
    {
      id: 'tab-kanban',
      src: 'assets/kanban-dark.png',
      alt: 'Канбан-доска задач Kapsula с колонками, приоритетами и сроками',
      title: 'Канбан-доска из чек-листов заметок',
      desc: 'Любой чек-лист внутри заметки автоматически попадает на\u00A0доску задач. Настраивайте колонки, приоритеты и\u00A0сроки, переносите карточки перетаскиванием.',
      meta: 'Список · Доска · Календарь',
      mode: 'desktop',
    },
    {
      id: 'tab-vault',
      src: 'assets/vault-2fa-dark.png',
      alt: 'Зашифрованный Сейф Kapsula с банковской картой и живыми 2FA-кодами',
      title: 'Сейф с\u00A0картами, паролями и\u00A0живым 2FA',
      desc: 'Карты, логины и\u00A0одноразовые TOTP-коды закрыты мастер-PIN и\u00A0биометрией. Скопированный секрет стирается из\u00A0буфера обмена через 30\u00A0секунд.',
      meta: 'PIN · TOTP · автоочистка 30\u00A0с',
      mode: 'desktop',
    },
    {
      id: 'tab-light',
      src: 'assets/note-modal-light.png',
      alt: 'Центрированное окно редактора заметки Kapsula в светлой фарфоровой теме',
      title: 'Спокойная светлая тема для письма',
      desc: 'Фарфоровая палитра с\u00A0контрастным текстом и\u00A0центрированным окном редактора. Поддерживает заголовки, изображения, историю версий и\u00A0связи [[между заметками]].',
      meta: 'Тёмная · Светлая · свой акцент',
      mode: 'desktop',
    },
    {
      id: 'tab-fold',
      src: 'assets/mobile-fold-dark.png',
      alt: 'Двухпанельный интерфейс Kapsula на раскрытом Samsung Galaxy Z Fold',
      title: 'Android и\u00A0адаптация под Galaxy Z\u00A0Fold',
      desc: 'На\u00A0внешнем экране удобно управлять одной рукой, а\u00A0при раскрытии Fold список заметок и\u00A0редактор встают рядом без потери набранного текста.',
      meta: 'Android 10+ · синхронизация E2EE',
      mode: 'fold',
    },
  ];

  // Preload tour screenshots gently after first paint so tab switching feels instant
  window.addEventListener('load', () => {
    TOUR_ITEMS.slice(1).forEach((item) => {
      const preload = new Image();
      preload.src = item.src;
    });
  });

  const tabs = Array.from(document.querySelectorAll('.tour-tab'));
  const tourPanel = document.getElementById('tour-panel');
  const tourMediaFrame = document.getElementById('tour-media-frame');
  const tourImage = document.getElementById('tour-image');
  const tourTitle = document.getElementById('tour-title');
  const tourDesc = document.getElementById('tour-desc');
  const tourShortcut = document.getElementById('tour-shortcut');

  let swapTimer = null;

  function selectTour(index, focusTab = false) {
    const safeIdx = ((index % TOUR_ITEMS.length) + TOUR_ITEMS.length) % TOUR_ITEMS.length;
    const item = TOUR_ITEMS[safeIdx];

    tabs.forEach((btn, i) => {
      const selected = i === safeIdx;
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected && focusTab) {
        btn.focus();
      }
    });

    if (tourPanel) {
      tourPanel.setAttribute('aria-labelledby', item.id);
    }

    if (tourTitle) tourTitle.textContent = item.title;
    if (tourDesc) tourDesc.textContent = item.desc;
    if (tourShortcut) tourShortcut.textContent = item.meta;

    if (tourImage && tourMediaFrame) {
      if (swapTimer) window.clearTimeout(swapTimer);
      tourMediaFrame.classList.add('is-swapping');
      swapTimer = window.setTimeout(() => {
        tourMediaFrame.setAttribute('data-mode', item.mode);
        tourImage.src = item.src;
        tourImage.alt = item.alt;
        tourMediaFrame.classList.remove('is-swapping');
      }, 90);
    }
  }

  tabs.forEach((btn, idx) => {
    btn.addEventListener('click', () => selectTour(idx));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        selectTour(idx + 1, true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTour(idx - 1, true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectTour(0, true);
      } else if (e.key === 'End') {
        e.preventDefault();
        selectTour(TOUR_ITEMS.length - 1, true);
      }
    });
  });

  /* ---------- OS Detection + Live GitHub Releases Wiring ---------- */
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const platform =
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      '';

    if (/android/i.test(ua)) return 'android';
    if (/mac|darwin/i.test(platform) || /mac os x/i.test(ua)) {
      return 'macos-arm64';
    }
    if (/win/i.test(platform) || /windows/i.test(ua)) {
      return 'windows';
    }
    return 'windows';
  }

  const detectedOs = detectPlatform();
  const dlCards = Array.from(document.querySelectorAll('.dl-card'));
  dlCards.forEach((card) => {
    card.classList.toggle('is-recommended', card.dataset.platform === detectedOs);
  });

  const OS_HERO_LABELS = {
    windows: {
      cta: 'Скачать для Windows',
      note: 'Windows 10/11 (x64), также macOS и\u00A0Android',
    },
    'macos-arm64': {
      cta: 'Скачать для macOS (Apple Silicon)',
      note: 'macOS M1–M4, также Intel, Windows и\u00A0Android',
    },
    'macos-x64': {
      cta: 'Скачать для macOS (Intel)',
      note: 'macOS Intel, также Apple Silicon, Windows и\u00A0Android',
    },
    android: {
      cta: 'Скачать APK для Android',
      note: 'Android 10+ и\u00A0Galaxy Z\u00A0Fold, также Windows и\u00A0macOS',
    },
  };

  const heroBtn = document.getElementById('hero-download-btn');
  const heroBtnLabel = document.getElementById('hero-download-label');
  const heroOsNote = document.getElementById('hero-os-note');

  const osMeta = OS_HERO_LABELS[detectedOs] || OS_HERO_LABELS.windows;
  if (heroBtnLabel) heroBtnLabel.textContent = osMeta.cta;
  if (heroOsNote) heroOsNote.textContent = osMeta.note;

  function formatMb(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const release = await res.json();
      const tag = typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : null;
      const assets = Array.isArray(release.assets) ? release.assets : [];

      if (tag) {
        ['hero-version', 'download-version', 'footer-version'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.textContent = tag;
        });
      }

      const pickAsset = (predicate) => assets.find((a) => a && typeof a.name === 'string' && predicate(a.name));

      const winAsset =
        pickAsset((n) => /setup.*\.exe$/i.test(n)) || pickAsset((n) => /\.exe$/i.test(n));
      const macArmAsset =
        pickAsset((n) => /arm64.*\.dmg$/i.test(n)) || pickAsset((n) => /apple.*silicon.*\.dmg$/i.test(n));
      const macX64Asset =
        pickAsset((n) => /(?:x64|intel).*\.dmg$/i.test(n)) ||
        pickAsset((n) => /\.dmg$/i.test(n) && n !== macArmAsset?.name);
      const androidAsset =
        pickAsset((n) => /release\.apk$/i.test(n)) || pickAsset((n) => /\.apk$/i.test(n));

      const map = {
        windows: { asset: winAsset, btnId: 'dl-btn-windows', fileId: 'dl-file-windows' },
        'macos-arm64': { asset: macArmAsset, btnId: 'dl-btn-mac-arm64', fileId: 'dl-file-mac-arm64' },
        'macos-x64': { asset: macX64Asset, btnId: 'dl-btn-mac-x64', fileId: 'dl-file-mac-x64' },
        android: { asset: androidAsset, btnId: 'dl-btn-android', fileId: 'dl-file-android' },
      };

      Object.values(map).forEach(({ asset, btnId, fileId }) => {
        if (!asset || !asset.browser_download_url) return;
        const btn = document.getElementById(btnId);
        const fileEl = document.getElementById(fileId);
        if (btn) btn.href = asset.browser_download_url;
        if (fileEl) {
          const sizeStr = formatMb(asset.size);
          fileEl.textContent = sizeStr ? `${asset.name} · ${sizeStr}` : asset.name;
        }
      });

      const primary = map[detectedOs]?.asset;
      if (heroBtn) {
        heroBtn.href = primary?.browser_download_url || release.html_url || RELEASES_FALLBACK;
      }
    } catch {
      // Offline or GitHub API rate-limited: fallback URLs already point to /releases/latest
    }
  }

  hydrateLatestRelease();
})();
