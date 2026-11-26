const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  rarr: '→',
  larr: '←',
  harr: '↔',
  times: '×',
  divide: '÷',
  plusmn: '±',
  euro: '€',
  rub: '₽',
  deg: '°',
  sect: '§',
  para: '¶',
  shy: '',
  zwj: '',
  zwnj: '',
};

/**
 * Decodes ALL numeric (decimal + hex) and common named HTML entities cleanly,
 * avoiding double-unescaping bugs while turning strings like `We&#x2019;re` into `We’re`.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  let out = input.replace(/[\u00AD\u200B\uFEFF]/g, '');
  if (!out.includes('&')) return out;
  const isSafeCodePoint = (cp: number): boolean =>
    Number.isFinite(cp) &&
    cp <= 0x10ffff &&
    !(cp >= 0xd800 && cp <= 0xdfff) &&
    (cp >= 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) &&
    cp !== 0x7f;
  out = out.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      if (isSafeCodePoint(cp)) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return full;
        }
      }
      return full;
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      if (isSafeCodePoint(cp)) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return full;
        }
      }
      return full;
    }
    const named = NAMED_HTML_ENTITIES[entity.toLowerCase()];
    return named !== undefined ? named : full;
  });
  return out.replace(/[\u00AD\u200B\uFEFF]/g, '');
}

const SINGLE_CONS_SPLIT_RE = /(?:^|(?<=[\s(«"']))([бвгджзйклмнпрстфхцчшщ])\s+[—–-]\s+([а-яё]{2,})/giu;
const KNOWN_SPLIT_ENDINGS_RE = /([а-яё]{2,})\s+[—–]\s+(овить|ой|кой|евероятной|анимац[а-яё]+|ирова[а-яё]+|ован[а-яё]+|ения|ение|ности|ность|ство|ться|ется|аться|овать|евать)(?=$|[^\p{L}])/giu;

/**
 * Repairs leaked soft-hyphenation artifacts (`с н — евероятной` -> `с невероятной`,
 * `устан — овить` -> `установить`) and strips stray unbalanced markdown `**` from plain titles.
 */
export function cleanBrokenTextArtifacts(input: string, stripAllMarkdown = false): string {
  if (!input) return '';
  let s = decodeHtmlEntities(input)
    .replace(/([а-яёa-z]{2,})[-‐]\r?\n([а-яёa-z]{2,})/giu, '$1$2')
    .replace(SINGLE_CONS_SPLIT_RE, '$1$2')
    .replace(KNOWN_SPLIT_ENDINGS_RE, '$1$2');

  if (stripAllMarkdown) {
    s = s.replace(/\*\*/g, '').replace(/__/g, '');
  } else {
    // Fix titles/phrases with unmatched bold markers like "**База ресурсов..."
    const boldPairs = (s.match(/\*\*/g) ?? []).length;
    if (boldPairs % 2 === 1) {
      s = s.replace(/\*\*/g, '');
    }
  }
  return s.trim();
}

/**
 * Truncates text at natural clause or word boundaries so Russian/English titles
 * never split mid-word (`колод` / `ка...`) or orphan trailing single letters.
 */
export function truncateAtWordBoundary(raw: string, maxChars = 92): string {
  const clean = decodeHtmlEntities(raw || '').replace(/\s+/g, ' ').trim();
  if (!clean) return clean;
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  const head = chars.slice(0, maxChars).join('');
  const minBreak = Math.floor(head.length * 0.5);
  let clauseEnd = -1;
  for (const sep of ['. ', '! ', '? ', ' — ', ': ', '; ']) {
    const idx = head.lastIndexOf(sep);
    if (idx >= minBreak && idx > clauseEnd) {
      clauseEnd = idx;
    }
  }
  if (clauseEnd >= minBreak) {
    return `${head.slice(0, clauseEnd).replace(/[,:;.\-—–\s]+$/, '')}…`;
  }
  if (/\s/.test(chars[maxChars] || '')) {
    return `${head.replace(/[,:;.\-—–\s]+$/, '')}…`;
  }
  const lastSpace = head.lastIndexOf(' ');
  const cutIdx = lastSpace >= Math.floor(head.length * 0.55) ? lastSpace : head.length;
  return `${head.slice(0, cutIdx).replace(/[,:;.\-—–\s]+$/, '')}…`;
}

const IG_TITLE_SUFFIX_RE = /^(.+?)\s+(?:on Instagram|в Instagram|на Instagram)\s*:\s*["«“]?([\s\S]*?)["»”]?$/i;
const IG_DESC_BOILERPLATE_EN_RE =
  /^[\d.,\s]+[KMkm]?\s+likes?,\s*[\d.,\s]+[KMkm]?\s+comments?\s*[-–—]\s*([^:\n]+?)\s+(?:on\s+)?[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*:\s*["«“]?([\s\S]*?)["»”]?$/i;
const IG_DESC_BOILERPLATE_RU_RE =
  /^[\d.,\s]+[KMkmтыс]*\s+отмет(?:ок|ки|ка)\s*«?Нравится»?,\s*[\d.,\s]+[KMkmтыс]*\s+комментар(?:иев|ия|ий)\s*[-–—]\s*([^:\n]+?)\s*:\s*["«“]?([\s\S]*?)["»”]?$/i;
const IG_LOGIN_WALL_RE =
  /(?:^log\s*in\b|^войти|^войдите|create an account or log in to instagram|sign up for instagram|log in to instagram|войдите в instagram|создайте аккаунт или войдите в instagram)/i;

export function cleanInstagramText(rawTitle: string, rawDescription: string): {
  author: string | null;
  caption: string;
  cleanTitle: string | null;
} {
  let author: string | null = null;
  let caption = decodeHtmlEntities(rawDescription || '').trim();

  const descEn = IG_DESC_BOILERPLATE_EN_RE.exec(caption);
  if (descEn) {
    author = (descEn[1] ?? '').trim().replace(/^@/, '') || null;
    caption = (descEn[2] ?? '').trim();
  } else {
    const descRu = IG_DESC_BOILERPLATE_RU_RE.exec(caption);
    if (descRu) {
      author = (descRu[1] ?? '').trim().replace(/^@/, '') || null;
      caption = (descRu[2] ?? '').trim();
    }
  }

  let decodedTitle = decodeHtmlEntities(rawTitle || '').trim();
  const titleBoilerEn = IG_DESC_BOILERPLATE_EN_RE.exec(decodedTitle);
  const titleBoilerRu = !titleBoilerEn ? IG_DESC_BOILERPLATE_RU_RE.exec(decodedTitle) : null;
  if (titleBoilerEn) {
    if (!author) author = (titleBoilerEn[1] ?? '').trim().replace(/^@/, '') || null;
    const inner = (titleBoilerEn[2] ?? '').trim();
    if (!caption && inner) caption = inner;
    decodedTitle = inner;
  } else if (titleBoilerRu) {
    if (!author) author = (titleBoilerRu[1] ?? '').trim().replace(/^@/, '') || null;
    const inner = (titleBoilerRu[2] ?? '').trim();
    if (!caption && inner) caption = inner;
    decodedTitle = inner;
  }

  const titleMatch = IG_TITLE_SUFFIX_RE.exec(decodedTitle);
  let cleanTitle: string | null = null;
  if (titleMatch) {
    if (!author) author = (titleMatch[1] ?? '').trim().replace(/^@/, '') || null;
    const inner = (titleMatch[2] ?? '').trim();
    if (!caption && inner) caption = inner;
  } else if (
    decodedTitle &&
    !/^instagram$/i.test(decodedTitle) &&
    !IG_LOGIN_WALL_RE.test(decodedTitle)
  ) {
    cleanTitle = decodedTitle.replace(/^["«“]+|["»”]+$/g, '').trim();
  }

  caption = caption.replace(/^["«“]+|["»”]+$/g, '').trim();
  if (IG_LOGIN_WALL_RE.test(caption)) {
    caption = '';
  }
  if (!cleanTitle && caption) {
    const firstLine = caption
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (firstLine) {
      cleanTitle = truncateAtWordBoundary(firstLine, 76);
    }
  }
  if (!cleanTitle && author) {
    cleanTitle = `Пост @${author}`;
  }
  return { author, caption, cleanTitle };
}
