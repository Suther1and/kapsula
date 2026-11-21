(() => {
  'use strict';

  const DEFAULT_VERSION = '1.0.2';
  const RELEASE_API = 'https://api.github.com/repos/Suther1and/kapsula/releases/latest';
  const DOWNLOAD_BASE = 'https://github.com/Suther1and/kapsula/releases/download/v';

  const ACCENT_META = {
    terracotta: {
      hex: '#d95826',
      darkName: 'Obsidian',
      lightName: 'Porcelain',
      enDesc: 'Terracotta accent over warm Obsidian dark and Porcelain light surfaces.',
      ruDesc: 'Терракотовый акцент на\u00A0тёплом графите или светлом фоне.',
    },
    emerald: {
      hex: '#2db57d',
      darkName: 'Pine',
      lightName: 'Sage',
      enDesc: 'Emerald green accent paired with calm Pine dark and soft Sage surfaces.',
      ruDesc: 'Изумрудный акцент с\u00A0глубоким хвойным или мягким шалфейным фоном.',
    },
    cobalt: {
      hex: '#4f86f7',
      darkName: 'Midnight',
      lightName: 'Ice',
      enDesc: 'Cobalt blue accent paired with Midnight dark and crisp Ice light surfaces.',
      ruDesc: 'Кобальтовый акцент на\u00A0полуночном тёмном или прохладном светлом фоне.',
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
      metaTitle: 'Kapsula — Quick notes, links, tasks, and encrypted sync',
      metaDesc:
        'Kapsula captures notes, links, screenshots, voice memos, tasks, and 2FA secrets in one local-first workspace for Windows, macOS, and Android with end-to-end encrypted sync.',
      'nav.demo': 'Overview',
      'nav.workflow': 'Workflow',
      'nav.themes': 'Themes',
      'nav.sync': 'Cloud Sync',
      'nav.download': 'Download',

      'hero.kicker': 'v1.0.2 · Windows · macOS · Android',
      'hero.title': 'One box for notes, links, and tasks\u00A0— before they scatter',
      'hero.lead':
        'Press <span class="kbd-pill">Alt + Space</span> from any window to save a thought, paste a link, or look something up. It starts as one simple input box and expands into boards, themes, a\u00A02FA Vault, and encrypted cloud sync when you want it.',
      'hero.secondaryCta': 'See how it works',
      'hero.metaPlatforms': 'Free &amp; local-first · Sync is optional',
      'hero.stageCaption':
        'Appears over any app, detects dates automatically, and saves right away with <span class="kbd-pill">Ctrl+Enter</span>.',

      'demo.eyebrow': 'Overview',
      'demo.title': 'From one shortcut to a structured workspace',
      'demo.sub':
        'A quick walkthrough of capture, note linking, Kanban boards, theme presets, 2FA Vault, and sync on Windows, macOS, and Android.',
      'demo.playLabel': 'Play 30-sec walkthrough',

      'workflow.eyebrow': 'Progressive depth',
      'workflow.title': 'Start with a single note. Turn on more only when you need it.',
      'workflow.sub':
        'Kapsula never forces you into folders or templates on day one. Capture first — organize into boards, checklists, and protected secrets at your own pace.',

      'beat1.tag': '01 · Instant HUD',
      'beat1.title': 'Drop a note or search without switching windows',
      'beat1.desc':
        'Keep your focus in the game engine, browser, or terminal. Tap <span class="kbd-pill">Alt + Space</span> to save a link, record a voice memo, grab a screenshot, or find an older note in milliseconds.',
      'beat1.b1': 'Recognizes dates like “Friday 3pm” and queues reminders right as you type',
      'beat1.b2': 'Instant full-text search across titles, checkboxes, links, and 2FA entries',
      'beat1.b3': 'Paste results back into your active app with Ctrl+Enter',
      'beat1.btnCapture': 'Quick capture',
      'beat1.btnSearch': 'Instant search',

      'beat2.tag': '02 · Notes & Tasks',
      'beat2.title': 'Checklists inside notes become real task boards',
      'beat2.desc':
        'Write checklists naturally inside any note alongside diagrams, links, and screenshots. Everything flows straight into the Tasks hub — switch between a Kanban board or tasks grouped by note.',
      'beat2.b1': 'Custom columns, drag-and-drop priorities, and due-date filters',
      'beat2.b2': 'Tick a task on the board or inside the note — both stay in sync',
      'beat2.b3': 'Rich notes support embedded charts, screenshots, and [[note links]]',
      'beat2.btnBoard': 'Kanban board',
      'beat2.btnGrouped': 'Grouped by note',
      'beat2.btnNote': 'Note editor',

      'beat3.tag': '03 · 2FA Vault & Mobile',
      'beat3.title': 'Passwords, 2FA codes, and your whole archive on Android',
      'beat3.desc':
        'Keep sensitive logins, API keys, bank cards, and live 2FA codes behind your Vault lock. Take the exact same notes, boards, and secrets onto Android phones and foldables like Galaxy Z Fold.',
      'beat3.b1': 'Live 2FA countdown timers with one-tap copy and 30-second clipboard wipe',
      'beat3.b2': 'Two-pane adaptive layout on foldable screens and tablets',
      'beat3.b3': 'Works completely offline on every platform',
      'beat3.btnVault': '2FA Vault',
      'beat3.btnFold': 'Android Fold',
      'beat3.btnPhone': 'Phone',

      'tour.heading': 'Explore every screen',
      'tour.tabFeed': 'Feed',
      'tour.tabNote': 'Note Studio',
      'tour.tabBoard': 'Kanban Board',
      'tour.tabVault': '2FA Vault',
      'tour.tabFold': 'Android Fold',
      'tour.tabPhone': 'Android Phone',

      'themes.eyebrow': 'Themes & Accent Colors',
      'themes.title': 'Make the workspace yours in one click',
      'themes.sub':
        'Pick Dark or Light mode, choose a background palette, or slide through any accent color — button text contrast recalculates automatically across the app.',
      'themes.presetTerracotta': 'Terracotta · Obsidian',
      'themes.presetEmerald': 'Emerald · Pine',
      'themes.presetCobalt': 'Cobalt · Midnight',
      'themes.presetAmethyst': 'Amethyst · Graphite',
      'themes.modeDark': 'Dark',
      'themes.modeLight': 'Light',
      'themes.viewWorkspace': 'Live feed',
      'themes.viewSettings': 'Theme picker',

      'sync.eyebrow': 'Encrypted Cloud Sync',
      'sync.title': 'Works offline on disk. Encrypted across your devices.',
      'sync.sub':
        'You never need an account to use Kapsula. Sign in with Google or email whenever you want notes, checklists, media, and Vault entries synced between Windows, macOS, and Android.',
      'sync.s1Title': 'Encrypted on your device',
      'sync.s1Desc':
        'Notes, files, and Vault items are encrypted locally with AES-256-GCM before upload. Only scrambled data ever touches the server.',
      'sync.s2Title': 'Cross-platform & offline-ready',
      'sync.s2Desc':
        'Write offline on Windows, macOS, or Android; pending updates reconcile automatically as soon as any device comes back online.',
      'sync.s3Title': 'Printable recovery key',
      'sync.s3Desc':
        'Save one personal recovery phrase to restore your entire archive if you switch laptops or wipe your phone — with optional custom sync server support.',
      'sync.s4Title': 'Clipboard & Vault safety',
      'sync.s4Desc':
        'Lock secrets behind a PIN or biometrics. Any password, card number, or 2FA code you copy wipes itself from the clipboard after 30 seconds.',
      'sync.capDesktopTitle': 'Desktop · Sync status & connected devices',
      'sync.capDesktopDesc': 'Real-time status, device list, recovery key export, and one-click reconcile.',
      'sync.capMobileTitle': 'Android · Encrypted mobile sync',
      'sync.capMobileDesc': 'Instant sync with desktop, share-sheet capture, and offline queue.',

      'dl.eyebrow': 'Download v1.0.2',
      'dl.title': 'Ready on all your devices',
      'dl.sub': 'Direct installers from the official GitHub release. Everything runs offline from minute one.',
      'dl.recommended': 'Your device',
      'dl.winDesc': '64-bit desktop installer (.exe)',
      'dl.macArmDesc': 'M1 / M2 / M3 / M4 image (.dmg)',
      'dl.macX64Desc': 'x86_64 Mac image (.dmg)',
      'dl.androidDesc': 'Phones, tablets & Galaxy Z Fold (.apk)',
      'dl.btnExe': 'Download .exe',
      'dl.btnDmg': 'Download .dmg',
      'dl.btnApk': 'Download .apk',
      'dl.firstRunTitle': 'Note on first launch (Windows SmartScreen & macOS)',
      'dl.firstRunWin':
        '<strong>Windows:</strong> builds are independent open-source releases without a paid EV certificate. If SmartScreen appears, click <em>More info</em> → <em>Run anyway</em>.',
      'dl.firstRunMac':
        '<strong>macOS:</strong> if Gatekeeper marks the downloaded build as unverified, right-click the app in Applications and choose <em>Open</em>, or run <code>xattr -dr com.apple.quarantine /Applications/Kapsula.app</code>.',

      'footer.releases': 'Releases',
      'footer.issues': 'Issues',

      cta: {
        win: 'Download for Windows',
        'mac-arm': 'Download for Mac (Apple Silicon)',
        'mac-x64': 'Download for Mac (Intel)',
        android: 'Download for Android (.apk)',
      },

      tour: {
        feed: {
          mode: 'desktop',
          base: 'theme-terracotta',
          title: 'Clean Feed for notes, links, voice, and screenshots',
          desc: 'Everything lands cleanly without crowding — filter by type, sort into boards, or keep a single stream.',
          meta: 'Desktop · 1280×800',
          alt: 'Kapsula desktop Feed showing notes, frame budget chart, voice cue, and link card',
        },
        note: {
          mode: 'desktop',
          base: 'note-studio',
          title: 'Rich Note Studio with checkboxes and diagrams',
          desc: 'Combine checklists, inline screenshots, reminders, tags, and [[cross-note links]] in a calm editor.',
          meta: 'Desktop · Editor',
          alt: 'Kapsula Note Studio showing formatted checklist and embedded diagram',
        },
        board: {
          mode: 'desktop',
          base: 'tasks-kanban',
          title: 'Kanban Board synced straight from your notes',
          desc: 'Turn note checklists into Inbox, In Progress, Waiting, and Done columns with priorities and due dates.',
          meta: 'Desktop · Tasks',
          alt: 'Kapsula Kanban tasks board',
        },
        vault: {
          mode: 'desktop',
          base: 'vault-2fa',
          title: 'Encrypted Vault with live 2FA codes',
          desc: 'Bank cards, logins, API keys, and 2FA authenticators locked locally with automatic 30-second clipboard clear.',
          meta: 'Desktop · Vault',
          alt: 'Kapsula encrypted 2FA Vault screen',
        },
        fold: {
          mode: 'fold',
          base: 'mobile-fold',
          title: 'Two-pane adaptive layout on Galaxy Z Fold',
          desc: 'Browse sections and notes on the left while editing markdown and checklists side by side on the inner display.',
          meta: 'Android Fold · 860×840',
          alt: 'Kapsula running on unfolded Android foldable with two-pane notes editor',
        },
        phone: {
          mode: 'phone',
          base: 'mobile-phone',
          title: 'Android Phone with share-sheet capture & offline queue',
          desc: 'Thumb-friendly navigation dock, voice memos, offline search, and end-to-end encrypted sync.',
          meta: 'Android · 390×844',
          alt: 'Kapsula Android phone feed with notes, palette capture, and bottom navigation',
        },
      },
    },

    ru: {
      metaTitle: 'Kapsula\u00A0— заметки, ссылки, задачи и\u00A0шифрованная синхронизация',
      metaDesc:
        'Kapsula собирает заметки, ссылки, скриншоты, голосовые записи, задачи и\u00A0пароли с\u00A02FA на\u00A0Windows, macOS и\u00A0Android\u00A0— без привязки к\u00A0интернету и\u00A0со\u00A0сквозным шифрованием.',
      'nav.demo': 'Обзор',
      'nav.workflow': 'Как работает',
      'nav.themes': 'Темы',
      'nav.sync': 'Синхронизация',
      'nav.download': 'Скачать',

      'hero.kicker': 'v1.0.2 · Windows, macOS и\u00A0Android',
      'hero.title': 'Одно окно для заметок, ссылок и\u00A0задач',
      'hero.lead':
        'Нажмите <span class="kbd-pill">Alt + Space</span> в\u00A0любом приложении, чтобы записать мысль, сохранить ссылку или найти карточку. Вначале это одна строка ввода, а\u00A0когда захочется порядка\u00A0— доска задач, сейф с\u00A02FA, свои темы и\u00A0шифрованная синхронизация.',
      'hero.secondaryCta': 'Как устроено',
      'hero.metaPlatforms': 'Бесплатно и\u00A0офлайн · облако по\u00A0желанию',
      'hero.stageCaption':
        'Открывается поверх любого окна, само распознаёт дату и\u00A0сохраняет запись по\u00A0<span class="kbd-pill">Ctrl+Enter</span>.',

      'demo.eyebrow': 'Короткий обзор',
      'demo.title': 'От\u00A0одной горячей клавиши\u00A0— к\u00A0собранному архиву',
      'demo.sub':
        'За\u00A030\u00A0секунд показываем быстрый ввод, связи между заметками, канбан-доску, выбор тем, сейф с\u00A02FA и\u00A0синхронизацию между компьютером и\u00A0Android.',
      'demo.playLabel': 'Смотреть обзор за\u00A030\u00A0секунд',

      'workflow.eyebrow': 'От\u00A0простого к\u00A0большему',
      'workflow.title': 'Сначала простая строка записи. Всё остальное\u00A0— когда понадобится.',
      'workflow.sub':
        'Никакой настройки папок и\u00A0шаблонов на\u00A0старте. Просто сбрасывайте сюда всё нужное, а\u00A0дальше подключайте доску задач, разделы и\u00A0защищённый сейф.',

      'beat1.tag': '01 · Быстрая панель',
      'beat1.title': 'Записывайте и\u00A0ищите, не\u00A0уходя из\u00A0рабочей программы',
      'beat1.desc':
        'Нажмите <span class="kbd-pill">Alt + Space</span> прямо из\u00A0браузера, редактора кода или игры\u00A0— вставьте ссылку, надиктуйте голос, снимите область экрана или найдите нужную заметку за\u00A0пару секунд.',
      'beat1.b1': 'Распознаёт фразы вроде «пятница в\u00A015:00» и\u00A0сразу предлагает напоминание',
      'beat1.b2': 'Мгновенно ищет по\u00A0заголовкам, чек-листам, ссылкам и\u00A0записям сейфа',
      'beat1.b3': 'Выбранный фрагмент можно вставить обратно в\u00A0открытое окно по\u00A0Ctrl+Enter',
      'beat1.btnCapture': 'Быстрая запись',
      'beat1.btnSearch': 'Мгновенный поиск',

      'beat2.tag': '02 · Заметки и\u00A0задачи',
      'beat2.title': 'Чек-листы внутри заметок сами собираются в\u00A0канбан',
      'beat2.desc':
        'Добавляйте списки дел прямо в\u00A0текст заметки вместе с\u00A0картинками и\u00A0ссылками. Задачи сразу появляются на\u00A0общей доске\u00A0— и\u00A0переключаются между колонками и\u00A0списком по\u00A0заметкам.',
      'beat2.b1': 'Свои колонки, приоритеты, фильтры по\u00A0разделам и\u00A0срокам',
      'beat2.b2': 'Отметка задачи на\u00A0доске сразу обновляет чек-лист внутри заметки',
      'beat2.b3': 'Упоминания через [[название]] связывают заметки между собой',
      'beat2.btnBoard': 'Канбан-доска',
      'beat2.btnGrouped': 'По\u00A0заметкам',
      'beat2.btnNote': 'Редактор',

      'beat3.tag': '03 · Сейф и\u00A0Android',
      'beat3.title': 'Пароли, коды 2FA и\u00A0весь архив\u00A0— на\u00A0компьютере и\u00A0в\u00A0телефоне',
      'beat3.desc':
        'Храните карты, токены и\u00A0одноразовые коды 2FA под ПИН-кодом. На\u00A0Android и\u00A0складных экранах вроде Galaxy Z Fold открываются те\u00A0же заметки, задачи и\u00A0сейф.',
      'beat3.b1': 'Таймеры кодов 2FA и\u00A0автоочистка буфера обмена через 30\u00A0секунд',
      'beat3.b2': 'На\u00A0складных экранах слева список, а\u00A0справа сразу открытый текст',
      'beat3.b3': 'Всё работает и\u00A0ищется без интернета на\u00A0любом устройстве',
      'beat3.btnVault': 'Сейф и\u00A02FA',
      'beat3.btnFold': 'Android Fold',
      'beat3.btnPhone': 'Смартфон',

      'tour.heading': 'Все экраны приложения',
      'tour.tabFeed': 'Лента',
      'tour.tabNote': 'Заметка',
      'tour.tabBoard': 'Канбан',
      'tour.tabVault': 'Сейф 2FA',
      'tour.tabFold': 'Android Fold',
      'tour.tabPhone': 'Смартфон',

      'themes.eyebrow': 'Темы и\u00A0палитра',
      'themes.title': 'Подстройте вид приложения под свой монитор',
      'themes.sub':
        'Тёмная или светлая тема, 11\u00A0фоновых палитр и\u00A0любой акцентный цвет\u00A0— читаемость кнопок и\u00A0бейджей подбирается автоматически.',
      'themes.presetTerracotta': 'Терракота · Графит',
      'themes.presetEmerald': 'Изумруд · Хвоя',
      'themes.presetCobalt': 'Кобальт · Ночь',
      'themes.presetAmethyst': 'Аметист · Камень',
      'themes.modeDark': 'Тёмная',
      'themes.modeLight': 'Светлая',
      'themes.viewWorkspace': 'Лента',
      'themes.viewSettings': 'Окно тем',

      'sync.eyebrow': 'Шифрованная синхронизация',
      'sync.title': 'Сначала на\u00A0диске. В\u00A0облако\u00A0— только в\u00A0шифре.',
      'sync.sub':
        'Для работы не\u00A0нужен аккаунт и\u00A0интернет. Войдите через Google или по\u00A0почте, только если хотите, чтобы заметки, задачи и\u00A0сейф синхронизировались между Windows, macOS и\u00A0Android.',
      'sync.s1Title': 'Шифр на\u00A0вашем устройстве',
      'sync.s1Desc':
        'Заметки, вложения и\u00A0карточки сейфа шифруются ключом AES-256-GCM ещё до\u00A0отправки. Сервер видит только закрытый набор байтов.',
      'sync.s2Title': 'Офлайн без потерь',
      'sync.s2Desc':
        'Править заметки и\u00A0отмечать задачи можно в\u00A0самолёте или без сети\u00A0— когда связь появится, изменения подтянутся.',
      'sync.s3Title': 'Резервный ключ восстановления',
      'sync.s3Desc':
        'Сохраните один ключ на\u00A0бумаге или в\u00A0менеджере: с\u00A0ним можно перенести весь архив на\u00A0новый ноутбук или телефон.',
      'sync.s4Title': 'Сейф и\u00A0чистый буфер обмена',
      'sync.s4Desc':
        'Секреты закрыты ПИН-кодом или отпечатком, а\u00A0скопированные пароли, номера карт и\u00A02FA удаляются из\u00A0буфера через 30\u00A0секунд.',
      'sync.capDesktopTitle': 'Компьютер · Статус и\u00A0список устройств',
      'sync.capDesktopDesc': 'Подключённые устройства, резервный ключ и\u00A0принудительная сверка в\u00A0один клик.',
      'sync.capMobileTitle': 'Android · Шифрованная синхронизация',
      'sync.capMobileDesc': 'Обмен с\u00A0компьютером, быстрое «Поделиться» из\u00A0браузера и\u00A0работа без сети.',

      'dl.eyebrow': 'Скачать v1.0.2',
      'dl.title': 'Сборки для компьютера и\u00A0телефона',
      'dl.sub':
        'Прямые установщики с\u00A0GitHub Releases. Работает локально с\u00A0первой минуты без обязательной регистрации.',
      'dl.recommended': 'Ваша система',
      'dl.winDesc': 'Установщик для 64-бит (.exe)',
      'dl.macArmDesc': 'Образ для M1 / M2 / M3 / M4 (.dmg)',
      'dl.macX64Desc': 'Образ для Mac на\u00A0Intel (.dmg)',
      'dl.androidDesc': 'Телефоны, планшеты и\u00A0Galaxy Z Fold (.apk)',
      'dl.btnExe': 'Скачать .exe',
      'dl.btnDmg': 'Скачать .dmg',
      'dl.btnApk': 'Скачать .apk',
      'dl.firstRunTitle': 'Про первый запуск на\u00A0Windows и\u00A0macOS',
      'dl.firstRunWin':
        '<strong>Windows:</strong> у\u00A0открытых сборок нет дорогой EV-подписи, поэтому SmartScreen может предупредить о\u00A0неизвестном авторе. Нажмите <em>Подробнее</em> → <em>Выполнить в\u00A0любом случае</em>.',
      'dl.firstRunMac':
        '<strong>macOS:</strong> если Gatekeeper не\u00A0пускает скачанное приложение, откройте его через правую кнопку мыши → <em>Открыть</em> или выполните в\u00A0терминале <code>xattr -dr com.apple.quarantine /Applications/Kapsula.app</code>.',

      'footer.releases': 'Релизы',
      'footer.issues': 'Сообщить об ошибке',

      cta: {
        win: 'Скачать для Windows',
        'mac-arm': 'Скачать для Mac (Apple Silicon)',
        'mac-x64': 'Скачать для Mac (Intel)',
        android: 'Скачать для Android (.apk)',
      },

      tour: {
        feed: {
          mode: 'desktop',
          base: 'theme-terracotta',
          title: 'Лента без лишнего шума',
          desc: 'Заметки, графики, голосовые записи и\u00A0ссылки лежат в\u00A0аккуратной сетке с\u00A0быстрыми фильтрами.',
          meta: 'Десктоп · 1280×800',
          alt: 'Главная лента Kapsula на\u00A0компьютере с\u00A0заметками, графиком и\u00A0голосовой записью',
        },
        note: {
          mode: 'desktop',
          base: 'note-studio',
          title: 'Редактор с\u00A0чек-листами и\u00A0картинками',
          desc: 'Объединяйте списки дел, скриншоты, теги, напоминания и\u00A0[[связи]] в\u00A0одном окне.',
          meta: 'Десктоп · Редактор',
          alt: 'Редактор заметки Kapsula с\u00A0чек-листом и\u00A0встроенной диаграммой',
        },
        board: {
          mode: 'desktop',
          base: 'tasks-kanban',
          title: 'Канбан-доска прямо из\u00A0заметок',
          desc: 'Колонки «Входящие», «В\u00A0работе», «Ожидание» и\u00A0«Готово» с\u00A0приоритетами и\u00A0быстрым переключением в\u00A0список.',
          meta: 'Десктоп · Задачи',
          alt: 'Канбан-доска задач Kapsula',
        },
        vault: {
          mode: 'desktop',
          base: 'vault-2fa',
          title: 'Сейф с\u00A0паролями и\u00A0живыми кодами 2FA',
          desc: 'Банковские карты, ключи API, логины и\u00A0таймеры 2FA с\u00A0автоочисткой буфера обмена через 30\u00A0секунд.',
          meta: 'Десктоп · Сейф',
          alt: 'Экран сейфа Kapsula с\u00A0банковской картой и\u00A0кодами 2FA',
        },
        fold: {
          mode: 'fold',
          base: 'mobile-fold',
          title: 'Две панели на\u00A0складном Galaxy Z Fold',
          desc: 'На\u00A0широком экране список заметок и\u00A0фильтры по\u00A0разделам остаются слева, а\u00A0редактор\u00A0— справа.',
          meta: 'Android Fold · 860×840',
          alt: 'Kapsula на\u00A0развёрнутом складном экране Android в\u00A0две панели',
        },
        phone: {
          mode: 'phone',
          base: 'mobile-phone',
          title: 'Быстрый ввод, голос и\u00A0офлайн-поиск на\u00A0смартфоне',
          desc: 'Удобная нижняя панель под большой палец, голосовые записи, быстрый поиск без сети и\u00A0шифрованная синхронизация.',
          meta: 'Android · 390×844',
          alt: 'Kapsula на\u00A0смартфоне Android\u00A0— лента с\u00A0заметками и\u00A0нижней панелью',
        },
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

  const state = {
    lang: getInitialLang(),
    theme: getInitialTheme(),
    accent: getInitialAccent(),
    themeView: 'workspace',
    tourId: 'feed',
    beatShots: {
      'beat1-img': 'hud-capture',
      'beat2-img': 'tasks-kanban',
      'beat3-img': 'vault-2fa',
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
    return 'win';
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
    document.querySelectorAll('.dl-card').forEach((card) => {
      card.classList.toggle('is-recommended', card.dataset.platform === platform);
    });

    const heroBtn = document.getElementById('hero-download-btn');
    const heroLabel = document.getElementById('hero-download-label');
    const cardLink = document.querySelector(`[data-dl="${platform}"]`);
    if (heroBtn && cardLink) {
      heroBtn.setAttribute('href', cardLink.getAttribute('href') || '#download');
    }
    if (heroLabel) {
      heroLabel.textContent = I18N[state.lang].cta[platform] || I18N[state.lang].cta.win;
    }
  }

  function applyThemeStage() {
    const meta = ACCENT_META[state.accent] || ACCENT_META.terracotta;
    const img = document.getElementById('theme-preview-img');
    const cap = document.getElementById('theme-stage-caption');
    const tok = document.getElementById('theme-stage-tokens');

    const base = state.themeView === 'settings' ? 'settings-appearance' : `theme-${state.accent}`;
    if (img) {
      img.src = shotPath(base);
    }
    if (cap) {
      cap.innerHTML = state.lang === 'ru' ? meta.ruDesc : meta.enDesc;
    }
    if (tok) {
      const surfaceName = state.theme === 'dark' ? meta.darkName : meta.lightName;
      tok.textContent = `${meta.hex} · ${surfaceName}`;
    }

    document.querySelectorAll('[data-accent-preset]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.accentPreset === state.accent));
    });
    document.querySelectorAll('[data-theme-pick]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.themePick === state.theme));
    });
    document.querySelectorAll('[data-theme-view]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeView === state.themeView));
    });
  }

  function applyTour(swapWithFade = false) {
    const dict = I18N[state.lang].tour;
    const item = dict[state.tourId] || dict.feed;
    const frame = document.getElementById('tour-media-frame');
    const img = document.getElementById('tour-stage-img');
    const title = document.getElementById('tour-caption-title');
    const desc = document.getElementById('tour-caption-desc');
    const meta = document.getElementById('tour-caption-meta');

    if (frame) frame.setAttribute('data-mode', item.mode);
    if (title) title.innerHTML = item.title;
    if (desc) desc.innerHTML = item.desc;
    if (meta) meta.textContent = item.meta;

    document.querySelectorAll('.tour-tab').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.tourId === state.tourId));
    });

    if (img) {
      const nextSrc = shotPath(item.base);
      img.alt = item.alt;
      if (swapWithFade && frame && img.getAttribute('src') !== nextSrc) {
        frame.classList.add('is-swapping');
        window.setTimeout(() => {
          img.src = nextSrc;
          frame.classList.remove('is-swapping');
        }, 110);
      } else {
        img.src = nextSrc;
      }
    }
  }

  function applyAllLocalizedShots() {
    document.querySelectorAll('img[data-shot-base]').forEach((img) => {
      const base = state.beatShots[img.id] || img.dataset.shotBase;
      if (base) img.src = shotPath(base);
    });
    applyTour(false);
    applyThemeStage();
  }

  function applyVideoLocale() {
    const video = document.getElementById('demo-video');
    const source = document.getElementById('demo-video-source');
    const frame = document.getElementById('video-frame');
    if (!video || !source) return;

    const nextSrc = `assets/kapsula-promo-${state.lang}.mp4`;
    const nextPoster = `assets/kapsula-promo-${state.lang}-poster.jpg`;
    const currentSrc = source.getAttribute('src');

    video.setAttribute('poster', nextPoster);
    if (currentSrc !== nextSrc) {
      source.setAttribute('src', nextSrc);
      video.load();
      if (frame) {
        frame.setAttribute('data-playing', 'false');
      }
    }
  }

  function applyLanguage(lang, persist = true) {
    state.lang = lang === 'ru' ? 'ru' : 'en';
    document.documentElement.setAttribute('lang', state.lang);
    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-lang', state.lang);
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
        state.lang === 'ru' ? 'Переключить тему оформления' : 'Toggle theme'
      );
    }

    updateDownloadsAndPlatform();
    applyAllLocalizedShots();
    applyVideoLocale();
  }

  function applyThemeMode(theme, persist = true) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'light' ? '#faf9f6' : '#161614');

    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));

    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-theme', state.theme);
      } catch (e) {}
    }
    applyAllLocalizedShots();
  }

  function applyAccent(accent, persist = true) {
    state.accent = ACCENT_META[accent] ? accent : 'terracotta';
    document.documentElement.setAttribute('data-accent', state.accent);
    if (persist) {
      try {
        localStorage.setItem('kapsula-docs-accent', state.accent);
      } catch (e) {}
    }
    applyThemeStage();
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

    document.querySelectorAll('[data-theme-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.themePick) applyThemeMode(btn.dataset.themePick, true);
      });
    });

    document.querySelectorAll('[data-accent-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.accentPreset) {
          state.themeView = 'workspace';
          applyAccent(btn.dataset.accentPreset, true);
        }
      });
    });

    document.querySelectorAll('[data-theme-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.themeView = btn.dataset.themeView === 'settings' ? 'settings' : 'workspace';
        applyThemeStage();
      });
    });

    document.querySelectorAll('.subswitch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.beatTarget;
        const shotBase = btn.dataset.shotBase;
        if (!targetId || !shotBase) return;
        const group = btn.closest('.story-subswitch');
        if (group) {
          group.querySelectorAll('.subswitch-btn').forEach((other) => {
            other.setAttribute('aria-pressed', String(other === btn));
          });
        }
        state.beatShots[targetId] = shotBase;
        const img = document.getElementById(targetId);
        if (img) img.src = shotPath(shotBase);
      });
    });

    document.querySelectorAll('.tour-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.tourId) {
          state.tourId = tab.dataset.tourId;
          applyTour(true);
        }
      });
    });

    const frame = document.getElementById('video-frame');
    const video = document.getElementById('demo-video');
    const playBtn = document.getElementById('video-play-btn');
    if (frame && video && playBtn) {
      const startPlay = () => {
        frame.setAttribute('data-playing', 'true');
        const promise = video.play();
        if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      };
      playBtn.addEventListener('click', startPlay);
      video.addEventListener('play', () => frame.setAttribute('data-playing', 'true'));
      video.addEventListener('ended', () => frame.setAttribute('data-playing', 'false'));
    }
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const rawTag = String(rel.tag_name || '').trim();
      const ver = rawTag.replace(/^v/i, '');
      if (!ver || compareSemver(ver, DEFAULT_VERSION) <= 0) return;

      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const findUrl = (re) => {
        const hit = assets.find((a) => re.test(a.name || ''));
        return hit && hit.browser_download_url ? hit.browser_download_url : null;
      };

      const urls = {
        win: findUrl(/Setup-.*\.exe$/i) || `${DOWNLOAD_BASE}${ver}/Kapsula-Setup-${ver}.exe`,
        'mac-arm': findUrl(/arm64\.dmg$/i) || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-arm64.dmg`,
        'mac-x64': findUrl(/-x64\.dmg$/i) || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-x64.dmg`,
        android: findUrl(/android.*\.apk$/i) || `${DOWNLOAD_BASE}${ver}/Kapsula-${ver}-android-release.apk`,
      };
      const names = {
        win: `Kapsula-Setup-${ver}.exe`,
        'mac-arm': `Kapsula-${ver}-arm64.dmg`,
        'mac-x64': `Kapsula-${ver}-x64.dmg`,
        android: `Kapsula-${ver}-android-release.apk`,
      };

      const vPill = document.getElementById('release-version');
      const vFooter = document.getElementById('footer-version');
      if (vPill) vPill.textContent = `v${ver}`;
      if (vFooter) vFooter.textContent = `v${ver}`;

      Object.keys(urls).forEach((key) => {
        const a = document.querySelector(`[data-dl="${key}"]`);
        if (a && urls[key]) a.setAttribute('href', urls[key]);
        const lbl = document.querySelector(`[data-file-label="${key}"]`);
        if (lbl) lbl.textContent = names[key];
      });
      updateDownloadsAndPlatform();
    } catch (e) {}
  }

  applyLanguage(state.lang, false);
  applyThemeMode(state.theme, false);
  applyAccent(state.accent, false);
  bindEvents();
  hydrateLatestRelease();
})();
