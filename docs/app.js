(() => {
  'use strict';

  const DEFAULT_VERSION = '1.0.4';
  const RELEASE_API = 'https://api.github.com/repos/Suther1and/kapsula/releases/latest';
  const DOWNLOAD_BASE = 'https://github.com/Suther1and/kapsula/releases/download/v';

  const HERO_VIEWS = {
    'theme-terracotta': {
      enNote: 'All notes, pinned items, and folders',
      ruNote: 'Лента заметок, закрепы и\u00A0разделы',
      enAlt: 'Kapsula desktop workspace',
      ruAlt: 'Рабочее пространство Kapsula на\u00A0компьютере',
    },
    'hud-search': {
      enNote: 'Instant Ctrl+Space search across notes & 2FA',
      ruNote: 'Мгновенный поиск по\u00A0Ctrl+Пробел поверх окон',
      enAlt: 'Kapsula Command HUD search launcher',
      ruAlt: 'Быстрый поиск по\u00A0Ctrl+Пробел в\u00A0Kapsula',
    },
    'note-studio': {
      enNote: 'Full post extraction from Telegram, YouTube, X & GitHub',
      ruNote: 'Полный текст и\u00A0медиа по\u00A0ссылкам из\u00A0Телеграма и\u00A0веба',
      enAlt: 'Kapsula Note Studio with extracted link content',
      ruAlt: 'Редактор заметки и\u00A0разбор ссылок в\u00A0Kapsula',
    },
    'tasks-kanban': {
      enNote: 'Checklists synced between notes, boards & calendar',
      ruNote: 'Задачи из\u00A0заметок, канбан-доска и\u00A0календарь',
      enAlt: 'Kapsula tasks Kanban board',
      ruAlt: 'Доска задач и\u00A0сроков в\u00A0Kapsula',
    },
  };

  const ACCENT_META = {
    terracotta: {
      hex: '#d95826',
      darkName: 'Obsidian',
      lightName: 'Porcelain',
      enDesc: 'Terracotta accent over warm Obsidian dark and Porcelain light surfaces.',
      ruDesc: 'Терракотовый акцент на\u00A0тёплом графите или светлой бумаге.',
    },
    emerald: {
      hex: '#168055',
      darkName: 'Pine',
      lightName: 'Sage',
      enDesc: 'Emerald green accent paired with calm Pine dark and soft Sage surfaces.',
      ruDesc: 'Изумрудный акцент с\u00A0хвойным тёмным и\u00A0мягким светлым фоном.',
    },
    cobalt: {
      hex: '#4f86f7',
      darkName: 'Midnight',
      lightName: 'Ice',
      enDesc: 'Cobalt blue accent paired with Midnight dark and crisp Ice light surfaces.',
      ruDesc: 'Кобальтовый акцент на\u00A0полуночном тёмном и\u00A0чистом светлом фоне.',
    },
    amethyst: {
      hex: '#9a75f5',
      darkName: 'Graphite',
      lightName: 'Paper',
      enDesc: 'Amethyst violet accent paired with neutral Graphite and clean Paper surfaces.',
      ruDesc: 'Аметистовый акцент с\u00A0нейтральным графитом и\u00A0светлой бумагой.',
    },
  };

  const I18N = {
    en: {
      metaTitle: 'Kapsula — Notes, links, tasks, and encrypted vault',
      metaDesc:
        'Kapsula keeps notes, web captures, tasks, voice memos, 2FA secrets, and encrypted cloud sync across Windows, macOS, and Android.',
      skip: 'Skip to content',
      'nav.overview': 'Overview',
      'nav.themes': 'Themes',
      'nav.sync': 'Sync & Vault',
      'nav.download': 'Download',
      'nav.cta': 'Download',

      'hero.title': 'Notes, links, and secrets — held in one place',
      'hero.lead':
        'Press <kbd>Ctrl+Space</kbd> in any app to save a note, unpack a link, or grab a 2FA code. Offline first, with end-to-end encrypted sync when you turn on cloud.',
      'hero.secondaryCta': 'Watch 30s walkthrough',
      'hero.metaPlatforms': 'Windows, macOS & Android',
      'hero.tabFeed': 'Workspace',
      'hero.tabHud': 'Quick HUD',
      'hero.tabStudio': 'Link Studio',
      'hero.tabTasks': 'Task Board',

      'overview.title': 'From quick capture to a structured archive',
      'overview.sub':
        'Start with one plain text box. Add folders, task boards, AI cleanup, and multi-device sync at your own pace.',
      'overview.playLabel': 'Play 30s walkthrough',

      'pillar1.title': 'Instant Command HUD',
      'pillar1.desc':
        'Pull up Ctrl+Space anywhere to search notes, paste results, record voice memos, or copy 2FA codes without losing focus.',
      'pillar2.title': 'Clean Link & Task Extraction',
      'pillar2.desc':
        'Telegram posts, YouTube, X, and GitHub URLs keep full text, code blocks, and previews. Checklists flow into boards and Google Calendar.',
      'pillar3.title': 'Optional BYOK AI',
      'pillar3.desc':
        'Add your own OpenAI, OpenRouter, or Gemini key to merge scattered drafts, sort unfiled items, or transcribe voice notes.',

      'themes.title': 'Built for late nights and daylight desks',
      'themes.sub':
        'Pick between obsidian dark and warm porcelain light, swap signature accent palettes, and customize 24+ folder colors.',
      'themes.light': 'Light',
      'themes.dark': 'Dark',
      'themes.viewApp': 'Workspace',
      'themes.viewSettings': 'Settings',

      'sync.title': 'Encrypted cloud where only you hold the key',
      'sync.sub':
        'Records and media encrypt locally before leaving your machine. Sync Windows, macOS, and Android automatically — or keep everything offline.',
      'sync.k1': 'Local cipher',
      'sync.k2': 'Key derivation',
      'sync.k3': 'Cross-platform',
      'sync.k4': 'Portability',
      'sync.v4': 'One-click JSON & Markdown export',

      'duo1.title': 'Passwords, Cards & 2FA Vault',
      'duo1.desc':
        'Store logins, cards, and live TOTP codes locked behind biometrics or your system keychain.',
      'duo2.title': 'Phones & Foldable Tablets',
      'duo2.desc':
        'One-handed bottom bar on phones and an automatic two-pane workspace on Android foldables.',

      'dl.title': 'Download Kapsula v1.0.4',
      'dl.sub':
        'Free desktop and Android installers with clean, human-readable filenames. Updates preserve your local vault.',
      'dl.allReleases': 'Release notes on GitHub ↗',
      'dl.recommended': 'Your OS',
      'dl.winReq': 'Windows 10 / 11 (x64 installer)',
      'dl.macArmReq': 'M1, M2, M3 & M4 Macs (.dmg)',
      'dl.macIntelReq': 'Intel x64 Macs (.dmg)',
      'dl.androidReq': 'Android 8.0+ phones & Fold (.apk)',
      'dl.btn': 'Download',
      'dl.helpSummary': 'First-run instructions (SmartScreen, macOS Gatekeeper, Android APK)',
      'dl.helpWin':
        '<strong>Windows:</strong> Open-source preview builds do not yet include a paid EV Authenticode certificate. If Microsoft SmartScreen appears once, click <em>More info → Run anyway</em>.',
      'dl.helpMac':
        '<strong>macOS:</strong> Drag Kapsula.app to Applications. If Gatekeeper blocks an unnotarized build, run once in Terminal: <code>xattr -cr /Applications/Kapsula.app</code>',
      'dl.helpAndroid':
        '<strong>Android:</strong> Allow app installs from your browser or file manager once. Signed with the persistent release key so later updates install directly over v1.0.4.',

      'footer.repo': 'GitHub',
      'footer.releases': 'Releases',
      'footer.license': 'License',

      cta: {
        win: 'Download for Windows',
        'mac-arm': 'Download for macOS (Apple Silicon)',
        'mac-x64': 'Download for macOS (Intel)',
        android: 'Download Android APK',
        fallback: 'Download Kapsula v1.0.4',
      },
    },
    ru: {
      metaTitle: 'Kapsula — Заметки, ссылки, задачи и зашифрованный сейф',
      metaDesc:
        'Kapsula хранит заметки, посты из Телеграма, задачи, голосовые наброски, 2FA-коды и пароли на Windows, macOS и Android с шифрованной синхронизацией.',
      skip: 'Перейти к\u00A0содержимому',
      'nav.overview': 'Обзор',
      'nav.themes': 'Темы',
      'nav.sync': 'Синхронизация',
      'nav.download': 'Скачать',
      'nav.cta': 'Скачать',

      'hero.title': 'Заметки, ссылки и\u00A0пароли в\u00A0одном быстром окне',
      'hero.lead':
        'Нажмите <kbd>Ctrl+Пробел</kbd> в\u00A0любой программе, чтобы записать мысль, разобрать ссылку или скопировать 2FA-код. Работает без сети, а\u00A0облако включается по желанию.',
      'hero.secondaryCta': 'Ролик за 30\u00A0секунд',
      'hero.metaPlatforms': 'Windows, macOS и\u00A0Android',
      'hero.tabFeed': 'Лента',
      'hero.tabHud': 'Ctrl+Пробел',
      'hero.tabStudio': 'Редактор',
      'hero.tabTasks': 'Задачи',

      'overview.title': 'От\u00A0одной строчки до\u00A0собранной базы',
      'overview.sub':
        'Начните с\u00A0чистого поля для ввода. Разделы, доски задач, ИИ-разбор и\u00A0синхронизация подключаются тогда, когда нужны.',
      'overview.playLabel': 'Смотреть ролик (30\u00A0с)',

      'pillar1.title': 'Панель поверх всех окон',
      'pillar1.desc':
        'Вызывайте поиск по Ctrl+Пробел из любой программы: находите заметки, диктуйте голосом или копируйте коды подтверждения без смены окна.',
      'pillar2.title': 'Глубокий разбор ссылок и\u00A0дел',
      'pillar2.desc':
        'Посты из Телеграма, YouTube, X и\u00A0GitHub сохраняются с\u00A0текстом, кодом и\u00A0обложкой. Чеклисты сами уходят на доску и\u00A0в\u00A0Google Календарь.',
      'pillar3.title': 'ИИ по\u00A0вашему ключу',
      'pillar3.desc':
        'Подключите свой ключ OpenAI, OpenRouter или Gemini, чтобы сводить разрозненные черновики, раскладывать архив и\u00A0расшифровывать голос.',

      'themes.title': 'Тёмный графит и\u00A0тёплая светлая бумага',
      'themes.sub':
        'Переключайте полярность темы, выбирайте из\u00A0четырёх акцентных палитр и\u00A0настраивайте более 24 оттенков для иконок разделов.',
      'themes.light': 'Светлая',
      'themes.dark': 'Тёмная',
      'themes.viewApp': 'Интерфейс',
      'themes.viewSettings': 'Настройки',

      'sync.title': 'Облако с\u00A0шифрованием на\u00A0вашем устройстве',
      'sync.sub':
        'Заметки и\u00A0вложения шифруются мастер-ключом ещё до отправки в\u00A0сеть. Синхронизируйте Windows, macOS и\u00A0Android или храните всё только локально.',
      'sync.k1': 'Шифрование',
      'sync.k2': 'Ключ доступа',
      'sync.k3': 'Платформы',
      'sync.k4': 'Экспорт',
      'sync.v4': 'Экспорт в\u00A0JSON и\u00A0Markdown в\u00A0один клик',

      'duo1.title': 'Сейф паролей, карт и\u00A02FA',
      'duo1.desc':
        'Логины, номера карт и\u00A0одноразовые коды скрыты за биометрией или системной связкой ключей.',
      'duo2.title': 'Телефоны и\u00A0складные экраны',
      'duo2.desc':
        'Нижняя панель под большой палец на смартфонах и\u00A0широкий двухпанельный режим на Android Fold.',

      'dl.title': 'Скачать Kapsula v1.0.4',
      'dl.sub':
        'Готовые установщики под Windows, macOS и\u00A0Android. Обновления сохраняют все локальные записи и\u00A0сейф.',
      'dl.allReleases': 'История версий на GitHub ↗',
      'dl.recommended': 'Ваша система',
      'dl.winReq': 'Windows 10 / 11 (x64-установщик)',
      'dl.macArmReq': 'Mac на Apple Silicon M1–M4 (.dmg)',
      'dl.macIntelReq': 'Mac на Intel x64 (.dmg)',
      'dl.androidReq': 'Android 8.0+ смартфоны и\u00A0Fold (.apk)',
      'dl.btn': 'Скачать',
      'dl.helpSummary': 'Памятка при первом запуске (SmartScreen, macOS, Android)',
      'dl.helpWin':
        '<strong>Windows:</strong> открытые сборки пока не подписаны платным EV-сертификатом. Если SmartScreen покажет предупреждение, нажмите <em>Подробнее → Выполнить в\u00A0любом случае</em>.',
      'dl.helpMac':
        '<strong>macOS:</strong> перетащите Kapsula.app в\u00A0Программы. Если система не открывает ненотаризованную сборку, выполните в\u00A0Терминале: <code>xattr -cr /Applications/Kapsula.app</code>',
      'dl.helpAndroid':
        '<strong>Android:</strong> при первом запуске разрешите установку из браузера или проводника. Релизный APK подписан постоянным ключом — будущие обновления встанут поверх без потери базы.',

      'footer.repo': 'GitHub',
      'footer.releases': 'Релизы',
      'footer.license': 'Лицензия',

      cta: {
        win: 'Скачать для Windows',
        'mac-arm': 'Скачать для macOS (Apple Silicon)',
        'mac-x64': 'Скачать для macOS (Intel)',
        android: 'Скачать APK для Android',
        fallback: 'Скачать Kapsula v1.0.4',
      },
    },
  };

  function getInitialLang() {
    const htmlLang = document.documentElement.getAttribute('lang');
    return htmlLang === 'ru' ? 'ru' : 'en';
  }

  function getInitialTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';
  }

  function getInitialAccent() {
    const a = document.documentElement.getAttribute('data-accent');
    return ACCENT_META[a] ? a : 'terracotta';
  }

  function getInitialBandAccent(fallbackAccent) {
    try {
      const saved = localStorage.getItem('kapsula-docs-accent');
      if (saved && ACCENT_META[saved]) return saved;
    } catch (e) {}
    return fallbackAccent === 'emerald' ? 'cobalt' : 'emerald';
  }

  const initialTheme = getInitialTheme();
  const initialAccent = getInitialAccent();
  const state = {
    lang: getInitialLang(),
    theme: initialTheme,
    accent: initialAccent,
    heroShot: 'theme-terracotta',
    bandAccent: getInitialBandAccent(initialAccent),
    bandTheme: initialTheme === 'dark' ? 'light' : 'dark',
    bandView: 'workspace',
    filenames: {
      win: `Kapsula-${DEFAULT_VERSION}-windows.exe`,
      'mac-arm': `Kapsula-${DEFAULT_VERSION}-mac-apple-silicon.dmg`,
      'mac-x64': `Kapsula-${DEFAULT_VERSION}-mac-intel.dmg`,
      android: `Kapsula-${DEFAULT_VERSION}-android.apk`,
    },
  };

  function shotPath(base, lang = state.lang, theme = state.theme) {
    return `assets/${base}-${lang}-${theme}.png`;
  }

  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const uad = navigator.userAgentData;
    const plat = (uad && uad.platform) || navigator.platform || '';

    if (/android/i.test(ua)) return 'android';
    if (/mac/i.test(plat) || /macintosh|mac os x/i.test(ua)) {
      if (/iphone|ipad|ipod/i.test(ua)) return null;
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
        if (/apple/i.test(gpu) && !/intel/i.test(gpu)) return 'mac-arm';
        if (/intel/i.test(gpu)) return 'mac-x64';
      } catch (e) {}
      return 'mac-arm';
    }
    if (/win/i.test(plat) || /windows/i.test(ua)) return 'win';
    return null;
  }

  function compareSemver(a, b) {
    const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  function updateDownloadsAndPlatform() {
    const platform = detectPlatform();
    document.querySelectorAll('.dl-item').forEach((card) => {
      card.classList.toggle('is-recommended', Boolean(platform && card.dataset.platform === platform));
    });

    const heroBtn = document.getElementById('hero-download-btn');
    const heroLabel = document.getElementById('hero-download-label');
    const heroFile = document.getElementById('hero-file-name');
    const heroFileSep = document.getElementById('hero-file-sep');
    const cardLink = platform ? document.querySelector(`[data-dl="${platform}"]`) : null;

    if (heroBtn) {
      heroBtn.setAttribute('href', (cardLink && cardLink.getAttribute('href')) || '#download');
    }
    if (heroLabel) {
      heroLabel.textContent = (platform && I18N[state.lang].cta[platform]) || I18N[state.lang].cta.fallback;
    }
    if (heroFile && heroFileSep) {
      if (platform && state.filenames[platform]) {
        heroFile.textContent = state.filenames[platform];
        heroFile.hidden = false;
        heroFileSep.hidden = false;
      } else {
        heroFile.hidden = true;
        heroFileSep.hidden = true;
      }
    }
  }

  function applyHeroStage() {
    const view = HERO_VIEWS[state.heroShot] || HERO_VIEWS['theme-terracotta'];
    const img = document.getElementById('hero-stage-img');
    const note = document.getElementById('hero-stage-note');
    const panel = document.getElementById('hero-panel');

    if (img) {
      img.src = shotPath(state.heroShot);
      img.alt = state.lang === 'ru' ? view.ruAlt : view.enAlt;
    }
    if (note) {
      note.textContent = state.lang === 'ru' ? view.ruNote : view.enNote;
    }
    document.querySelectorAll('[data-hero-shot]').forEach((btn) => {
      const isSelected = btn.dataset.heroShot === state.heroShot;
      btn.setAttribute('aria-selected', String(isSelected));
      btn.setAttribute('tabindex', isSelected ? '0' : '-1');
      if (isSelected && panel && btn.id) {
        panel.setAttribute('aria-labelledby', btn.id);
      }
    });
  }

  function applyThemesBand() {
    const meta = ACCENT_META[state.bandAccent] || ACCENT_META.emerald;
    const img = document.getElementById('theme-preview-img');
    const cap = document.getElementById('theme-stage-caption');
    const tok = document.getElementById('theme-stage-tokens');

    const base = state.bandView === 'settings' ? 'settings-appearance' : `theme-${state.bandAccent}`;
    if (img) {
      img.src = shotPath(base, state.lang, state.bandTheme);
    }
    if (cap) {
      cap.textContent = state.lang === 'ru' ? meta.ruDesc : meta.enDesc;
    }
    if (tok) {
      const surfaceName = state.bandTheme === 'dark' ? meta.darkName : meta.lightName;
      tok.textContent = `${meta.hex} · ${surfaceName}`;
    }

    document.querySelectorAll('[data-accent-preset]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.accentPreset === state.bandAccent));
    });
    document.querySelectorAll('[data-band-mode]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.bandMode === state.bandTheme));
    });
    document.querySelectorAll('[data-theme-view]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeView === state.bandView));
    });
  }

  function applyAllLocalizedShots() {
    applyHeroStage();
    applyThemesBand();
    document.querySelectorAll('img[data-shot-base]').forEach((img) => {
      const base = img.dataset.shotBase;
      if (base) img.src = shotPath(base);
    });
  }

  function applyVideoLocale() {
    const video = document.getElementById('demo-video');
    const source = document.getElementById('demo-video-source');
    const frame = document.getElementById('video-frame');
    const posterImg = document.getElementById('video-poster-img');
    if (!video || !source) return;

    const nextSrc = `assets/kapsula-promo-${state.lang}.mp4`;
    const nextPoster = `assets/kapsula-promo-${state.lang}-poster.jpg`;
    const currentSrc = source.getAttribute('src');

    video.setAttribute('poster', nextPoster);
    if (posterImg) {
      posterImg.setAttribute('src', nextPoster);
      posterImg.setAttribute(
        'alt',
        state.lang === 'ru' ? 'Превью ролика Kapsula за 30 секунд' : 'Kapsula walkthrough preview'
      );
    }
    if (currentSrc !== nextSrc) {
      video.pause();
      video.removeAttribute('controls');
      source.setAttribute('src', nextSrc);
      video.load();
      if (frame) frame.setAttribute('data-playing', 'false');
    }
  }

  function applyLanguage(lang, persist = true) {
    state.lang = lang === 'ru' ? 'ru' : 'en';
    document.documentElement.setAttribute('lang', state.lang);

    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-lang', state.lang);
      } catch (e) {}
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('lang', state.lang);
        window.history.replaceState(null, '', url.toString());
      } catch (e) {}
    }

    const dict = I18N[state.lang];
    document.title = dict.metaTitle;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', dict.metaDesc);

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (key && typeof dict[key] === 'string') {
        el.textContent = dict[key];
      }
    });

    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.dataset.i18nHtml;
      if (key && typeof dict[key] === 'string') {
        el.innerHTML = dict[key];
      }
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang));
    });

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute(
        'aria-label',
        state.lang === 'ru' ? 'Переключить светлую и тёмную тему' : 'Toggle color mode'
      );
    }

    updateDownloadsAndPlatform();
    applyAllLocalizedShots();
    applyVideoLocale();
  }

  function applyThemeMode(theme, persist = true) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    state.bandTheme = state.theme === 'dark' ? 'light' : 'dark';

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'light' ? '#f5f3ee' : '#111113');

    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));

    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-theme', state.theme);
      } catch (e) {}
    }
    applyAllLocalizedShots();
  }

  function applyGlobalAccent(accent, persist = true) {
    state.accent = ACCENT_META[accent] ? accent : 'terracotta';
    document.documentElement.setAttribute('data-accent', state.accent);
    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-accent', state.accent);
      } catch (e) {}
    }
  }

  function bindEvents() {
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.lang) applyLanguage(btn.dataset.lang, true);
      });
    });

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        applyThemeMode(state.theme === 'dark' ? 'light' : 'dark', true);
      });
    }

    const heroTabs = Array.from(document.querySelectorAll('[data-hero-shot]'));
    heroTabs.forEach((btn, index) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.heroShot) {
          state.heroShot = btn.dataset.heroShot;
          applyHeroStage();
        }
      });
      btn.addEventListener('keydown', (e) => {
        let nextIndex = -1;
        if (e.key === 'ArrowRight') nextIndex = (index + 1) % heroTabs.length;
        else if (e.key === 'ArrowLeft') nextIndex = (index - 1 + heroTabs.length) % heroTabs.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = heroTabs.length - 1;
        if (nextIndex >= 0) {
          e.preventDefault();
          const target = heroTabs[nextIndex];
          if (target && target.dataset.heroShot) {
            state.heroShot = target.dataset.heroShot;
            applyHeroStage();
            target.focus();
          }
        }
      });
    });

    document.querySelectorAll('[data-accent-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const accent = btn.dataset.accentPreset;
        if (!accent) return;
        state.bandAccent = accent;
        state.bandView = 'workspace';
        applyGlobalAccent(accent, true);
        applyThemesBand();
      });
    });

    document.querySelectorAll('[data-band-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.bandMode) {
          state.bandTheme = btn.dataset.bandMode === 'dark' ? 'dark' : 'light';
          applyThemesBand();
        }
      });
    });

    document.querySelectorAll('[data-theme-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.themeView) {
          state.bandView = btn.dataset.themeView === 'settings' ? 'settings' : 'workspace';
          applyThemesBand();
        }
      });
    });

    const frame = document.getElementById('video-frame');
    const video = document.getElementById('demo-video');
    const playBtn = document.getElementById('video-play-btn');
    if (frame && video && playBtn) {
      const startPlay = () => {
        video.setAttribute('controls', '');
        frame.setAttribute('data-playing', 'true');
        const promise = video.play();
        if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      };
      playBtn.addEventListener('click', startPlay);
      video.addEventListener('play', () => {
        video.setAttribute('controls', '');
        frame.setAttribute('data-playing', 'true');
      });
      video.addEventListener('ended', () => {
        frame.setAttribute('data-playing', 'false');
      });
    }
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const rawTag = String(rel.tag_name || '').trim();
      const ver = rawTag.replace(/^v/i, '');
      if (!ver || compareSemver(ver, DEFAULT_VERSION) < 0) return;

      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const findAsset = (re) => assets.find((a) => re.test(a.name || '')) || null;

      const winAsset = findAsset(/(-windows|Setup-).*\.exe$/i);
      const macArmAsset = findAsset(/(-mac-apple-silicon|-arm64)\.dmg$/i);
      const macX64Asset = findAsset(/(-mac-intel|-x64)\.dmg$/i);
      const androidAsset = findAsset(/android.*\.apk$/i);

      const resolved = {
        win: {
          url: winAsset?.browser_download_url || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-windows.exe`,
          name: winAsset?.name || `Kapsula-${ver}-windows.exe`,
        },
        'mac-arm': {
          url: macArmAsset?.browser_download_url || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-mac-apple-silicon.dmg`,
          name: macArmAsset?.name || `Kapsula-${ver}-mac-apple-silicon.dmg`,
        },
        'mac-x64': {
          url: macX64Asset?.browser_download_url || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-mac-intel.dmg`,
          name: macX64Asset?.name || `Kapsula-${ver}-mac-intel.dmg`,
        },
        android: {
          url: androidAsset?.browser_download_url || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-android.apk`,
          name: androidAsset?.name || `Kapsula-${ver}-android.apk`,
        },
      };

      const vPill = document.getElementById('release-version');
      const vFooter = document.getElementById('footer-version');
      if (vPill) vPill.textContent = `v${ver}`;
      if (vFooter) vFooter.textContent = `v${ver}`;

      Object.keys(resolved).forEach((key) => {
        state.filenames[key] = resolved[key].name;
        const link = document.querySelector(`[data-dl="${key}"]`);
        if (link) link.setAttribute('href', resolved[key].url);
        const label = document.querySelector(`[data-file-label="${key}"]`);
        if (label) label.textContent = resolved[key].name;
      });
      updateDownloadsAndPlatform();
    } catch (e) {}
  }

  applyThemeMode(state.theme, false);
  applyGlobalAccent(state.accent, false);
  applyLanguage(state.lang, false);
  bindEvents();
  hydrateLatestRelease();
})();
