const RU_EN_SYNONYM_GROUPS: string[][] = [
  ['инстаграм', 'инстаграма', 'инстаграме', 'инстаграму', 'инста', 'инст', 'инсте', 'инсты', 'инстаграмм', 'instagram', 'reels', 'рилс', 'рилсы'],
  ['телеграм', 'телеграма', 'телеграме', 'телега', 'телеге', 'телеги', 'телеграмм', 'тг', 'telegram', 't.me'],
  ['ютуб', 'ютуба', 'ютубе', 'ютюб', 'ютьюб', 'youtube', 'youtu.be', 'видео', 'ролик'],
  ['твиттер', 'твиттера', 'икс', 'twitter', 'x.com', 'fxtwitter', 'твит'],
  ['гитхаб', 'гитхаба', 'гитхабе', 'гит', 'github', 'репозиторий', 'репо'],
  ['фигма', 'figma', 'макет', 'прототип'],
  ['дискорд', 'discord'],
  ['работа', 'проект', 'проекты', 'клиент', 'дедлайн', 'work', 'project', 'projects', 'client', 'deadline'],
  ['финансы', 'бюджет', 'чек', 'чеки', 'деньги', 'счёт', 'счет', 'оплата', 'finance', 'budget', 'receipt', 'invoice', 'payment'],
  ['карта', 'карты', 'банк', 'банковская', 'card', 'cards', 'bank'],
  ['поездка', 'путешествие', 'билет', 'билеты', 'отель', 'рейс', 'маршрут', 'travel', 'trip', 'ticket', 'hotel', 'flight'],
  ['учёба', 'учеба', 'книга', 'книги', 'статья', 'статьи', 'курс', 'конспект', 'study', 'book', 'article', 'course', 'guide'],
  ['покупка', 'покупки', 'заказ', 'товар', 'магазин', 'доставка', 'shopping', 'order', 'store', 'delivery'],
  ['здоровье', 'спорт', 'врач', 'тренировка', 'рецепт', 'health', 'sport', 'fitness', 'workout', 'doctor'],
  ['документ', 'документы', 'файл', 'файлы', 'пдф', 'pdf', 'договор', 'document', 'file', 'contract'],
  ['почта', 'письмо', 'письма', 'имейл', 'email', 'mail', 'inbox'],
  ['музыка', 'подкаст', 'фильм', 'кино', 'music', 'podcast', 'movie', 'film'],
  ['графика', 'эффект', 'эффекты', '3д', '3d', 'шейдер', 'шейдеры', 'shader', 'shaders', 'рендер', 'render', 'vfx'],
  ['жест', 'жесты', 'gesture', 'gestures', 'свайп', 'swipe', 'анимация', 'анимации', 'motion'],
  ['игра', 'игры', 'хобби', 'game', 'games', 'gaming', 'hobby'],
  ['дизайн', 'design', 'ui', 'ux', 'интерфейс', 'библиотека', 'library', 'компонент', 'components'],
  ['референс', 'реф', 'reference', 'мудборд', 'moodboard', 'вдохновение', 'идея', 'идеи', 'idea'],
  ['пароль', 'пароли', 'password', 'логин', 'login', 'ключ', 'токен', 'api', 'secret', 'сейф', '2fa', 'totp', 'код'],
  ['задача', 'задачи', 'таск', 'todo', 'task', 'чек', 'чеклист', 'checklist', 'канбан', 'доска', 'kanban'],
  ['голос', 'аудио', 'войс', 'voice', 'audio', 'звонок', 'встреча', 'созвон', 'meeting'],
  ['скрин', 'скриншот', 'фото', 'картинка', 'изображение', 'image', 'photo', 'screenshot'],
  ['календарь', 'событие', 'расписание', 'встреча', 'calendar', 'schedule', 'event'],
  ['баг', 'баги', 'ошибка', 'ошибки', 'фикс', 'починить', 'исправить', 'bug', 'bugs', 'fix', 'issue', 'error'],
  ['шрифт', 'шрифты', 'типографика', 'текст', 'font', 'fonts', 'typography'],
  ['цвет', 'цвета', 'палитра', 'тема', 'акцент', 'color', 'colors', 'palette', 'theme', 'accent'],
  ['настройка', 'настройки', 'параметры', 'конфиг', 'settings', 'preferences', 'config'],
  ['синхронизация', 'облако', 'синк', 'sync', 'cloud', 'backup', 'бэкап', 'резервная'],
  ['напоминание', 'напоминания', 'напомни', 'таймер', 'будильник', 'reminder', 'reminders', 'alert'],
  ['приглушённые', 'приглушенные', 'скрытые', 'тихие', 'muted', 'mute', 'hidden'],
  ['закреплённые', 'закрепленные', 'избранное', 'важное', 'pinned', 'pin', 'favorite', 'starred'],
];

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const LAT_MULTI_TO_CYR: Array<[string, string]> = [
  ['sch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['yu', 'ю'],
  ['ya', 'я'], ['yo', 'ё'], ['ts', 'ц'], ['ph', 'ф'], ['th', 'т'],
  ['ck', 'к'], ['oo', 'у'], ['ee', 'и'], ['qu', 'кв'],
];

const LAT_CHAR_TO_CYR: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и',
  j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р',
  s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з',
};

const QWERTY_TO_JCUKEN: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  '[': 'х', ']': 'ъ', a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л',
  l: 'д', ';': 'ж', "'": 'э', z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь',
  ',': 'б', '.': 'ю',
};

const JCUKEN_TO_QWERTY: Record<string, string> = Object.fromEntries(
  Object.entries(QWERTY_TO_JCUKEN).map(([en, ru]) => [ru, en])
);

const STOP_WORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'из', 'к', 'от', 'для', 'за', 'о', 'об', 'обо', 'у',
  'мне', 'меня', 'мной', 'мой', 'мои', 'моя', 'моё', 'моих', 'моего', 'есть', 'быть', 'были',
  'было', 'была', 'найди', 'найти', 'поищи', 'дай', 'скинь', 'покажи', 'вспомни', 'где', 'все', 'всё',
  'что', 'какие', 'какой', 'какая', 'какое', 'каких', 'про', 'под', 'над', 'или', 'а', 'но', 'ли',
  'это', 'эти', 'тут', 'здесь', 'там', 'откуда', 'когда', 'базе', 'хранилище', 'капсуле',
  'the', 'and', 'for', 'with', 'from', 'show', 'find', 'get', 'my', 'all', 'notes', 'note', 'saved',
  'заметки', 'заметок', 'заметку', 'записи', 'записей', 'запись', 'ссылка', 'ссылкой', 'ссылки', 'ссылок',
  'сохраненки', 'сохранёнки', 'сохраненок', 'сохранёнок', 'сохранения', 'сохранений', 'сохранено', 'сохранённое',
  'закладки', 'закладок', 'штуки', 'вещи', 'файлы', 'материалы',
]);

export function translitRuToEn(token: string): string {
  let out = '';
  for (const ch of token.toLowerCase()) {
    out += CYR_TO_LAT[ch] ?? ch;
  }
  return out;
}

export function translitEnToRu(token: string): string {
  let s = token.toLowerCase();
  for (const [pat, rep] of LAT_MULTI_TO_CYR) {
    s = s.replaceAll(pat, rep);
  }
  let out = '';
  for (const ch of s) {
    out += LAT_CHAR_TO_CYR[ch] ?? ch;
  }
  return out;
}

export function swapKeyboardLayout(token: string): string | null {
  const lower = token.toLowerCase();
  const hasCyr = /[а-яё]/i.test(lower);
  const hasLat = /[a-z]/i.test(lower);
  if (hasLat && !hasCyr) {
    const converted = Array.from(lower).map((c) => QWERTY_TO_JCUKEN[c] ?? c).join('');
    return converted !== lower ? converted : null;
  }
  if (hasCyr && !hasLat) {
    const converted = Array.from(lower).map((c) => JCUKEN_TO_QWERTY[c] ?? c).join('');
    return converted !== lower ? converted : null;
  }
  return null;
}

export function stemWord(raw: string): string {
  const token = raw.toLowerCase().trim();
  if (token.length <= 4) return token;
  if (/[а-яё]/i.test(token)) {
    return token.replace(
      /(?:ами|ями|ого|его|ому|ему|ими|ыми|ую|юю|ою|ею|ов|ев|ей|ом|ем|ам|ям|ах|ях|ая|яя|ое|ее|ие|ые|ий|ый|ой|ть|ти|ся|сь|а|я|у|ю|е|и|ы|о)$/i,
      ''
    );
  }
  return token.replace(/(?:ies|ing|ed|es|s)$/i, (m) => (m === 'ies' ? 'y' : ''));
}

export interface ExpandedTokenGroup {
  primary: string;
  variants: string[];
}

const SYNONYM_LOOKUP = new Map<string, string[]>();
for (const group of RU_EN_SYNONYM_GROUPS) {
  for (const word of group) {
    SYNONYM_LOOKUP.set(word.toLowerCase(), group);
    const stem = stemWord(word);
    if (stem.length >= 3 && !SYNONYM_LOOKUP.has(stem)) {
      SYNONYM_LOOKUP.set(stem, group);
    }
  }
}

/**
 * Expands a raw user search query into semantic token groups where each non-stopword
 * token carries RU<->EN synonyms, transliterations, keyboard-layout fixes, and stems.
 */
export function expandBilingualQuery(rawQuery: string): ExpandedTokenGroup[] {
  const cleaned = (rawQuery || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, ' ')
    .trim();
  if (!cleaned) return [];

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const targetTokens = meaningful.length > 0 ? meaningful : tokens;

  const groups: ExpandedTokenGroup[] = [];
  for (const tok of targetTokens.slice(0, 8)) {
    const variants = new Set<string>([tok]);
    const stem = stemWord(tok);
    if (stem.length >= 3) variants.add(stem);

    const directGroup = SYNONYM_LOOKUP.get(tok) ?? SYNONYM_LOOKUP.get(stem);
    if (directGroup) {
      for (const w of directGroup) variants.add(w);
    }

    if (/[а-яё]/i.test(tok) && tok.length >= 3) {
      const en = translitRuToEn(tok);
      if (en.length >= 3) {
        variants.add(en);
        const enSyn = SYNONYM_LOOKUP.get(en) ?? SYNONYM_LOOKUP.get(stemWord(en));
        if (enSyn) for (const w of enSyn) variants.add(w);
      }
    } else if (/[a-z]/i.test(tok) && tok.length >= 3) {
      const ru = translitEnToRu(tok);
      if (ru.length >= 3) {
        variants.add(ru);
      }
    }

    const swapped = swapKeyboardLayout(tok);
    if (swapped && swapped.length >= 3) {
      variants.add(swapped);
      const swStem = stemWord(swapped);
      if (swStem.length >= 3) variants.add(swStem);
      const swSyn = SYNONYM_LOOKUP.get(swapped) ?? SYNONYM_LOOKUP.get(swStem);
      if (swSyn) for (const w of swSyn) variants.add(w);
      if (/[а-яё]/i.test(swapped)) {
        const enFromSw = translitRuToEn(swapped);
        if (enFromSw.length >= 3) {
          variants.add(enFromSw);
          const enSyn = SYNONYM_LOOKUP.get(enFromSw);
          if (enSyn) for (const w of enSyn) variants.add(w);
        }
      }
    }

    groups.push({
      primary: tok,
      variants: Array.from(variants).filter((v) => v.length >= 2),
    });
  }

  return groups;
}

export type KnownPlatformIntent = 'instagram' | 'telegram' | 'youtube' | 'github' | 'x';

const PLATFORM_INTENT_RULES: Array<{
  platform: KnownPlatformIntent;
  domains: string[];
  pattern: RegExp;
}> = [
  {
    platform: 'instagram',
    domains: ['instagram.com'],
    pattern: /(?:^|[^\p{L}])(?:instagram|инста(?:грам[а-яё]*)?|инст[еауы]?|рилс[а-яё]*|reels)(?=$|[^\p{L}])/iu,
  },
  {
    platform: 'telegram',
    domains: ['t.me', 'telegram.me'],
    pattern: /(?:^|[^\p{L}])(?:telegram|телеграм[а-яё]*|телег[аеиу]|тг)(?=$|[^\p{L}])/iu,
  },
  {
    platform: 'youtube',
    domains: ['youtube.com', 'youtu.be'],
    pattern: /(?:^|[^\p{L}])(?:youtube|youtu\.be|ютуб[а-яё]*|ютьюб[а-яё]*)(?=$|[^\p{L}])/iu,
  },
  {
    platform: 'github',
    domains: ['github.com'],
    pattern: /(?:^|[^\p{L}])(?:github|гитхаб[а-яё]*)(?=$|[^\p{L}])/iu,
  },
  {
    platform: 'x',
    domains: ['x.com', 'twitter.com', 'fxtwitter.com'],
    pattern: /(?:^|[^\p{L}])(?:twitter|x\.com|твиттер[а-яё]*)(?=$|[^\p{L}])/iu,
  },
];

export function detectPlatformIntent(rawQuery: string): {
  platform: KnownPlatformIntent;
  domains: string[];
} | null {
  const q = (rawQuery || '').trim();
  if (!q) return null;
  for (const rule of PLATFORM_INTENT_RULES) {
    if (rule.pattern.test(q)) {
      return { platform: rule.platform, domains: rule.domains };
    }
  }
  return null;
}

export function normalizeSearchText(raw: string): string {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return lower.indexOf('ё') >= 0 ? lower.replace(/ё/g, 'е') : lower;
}

let dlScratch = new Int32Array(256);

function getDlBuffer(needed: number): Int32Array {
  if (dlScratch.length < needed) {
    let nextLen = dlScratch.length || 256;
    while (nextLen < needed) nextLen *= 2;
    dlScratch = new Int32Array(nextLen);
  }
  return dlScratch;
}

/**
 * Fast bounded Damerau-Levenshtein distance (supports adjacent transpositions like
 * "капусла" <-> "капсула", "выдление" <-> "выделение") with early exit when distance > maxDist.
 */
export function damerauDistanceWithin(a: string, b: string, maxDist: number): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (a === b) return 0;
  if (lenA === 0) return lenB <= maxDist ? lenB : maxDist + 1;
  if (lenB === 0) return lenA <= maxDist ? lenA : maxDist + 1;

  const cols = lenB + 1;
  const dp = getDlBuffer((lenA + 1) * cols);
  for (let i = 0; i <= lenA; i += 1) dp[i * cols] = i;
  for (let j = 0; j <= lenB; j += 1) dp[j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    let rowMin = maxDist + 1;
    const chA = a.charCodeAt(i - 1);
    const rowOffset = i * cols;
    const prevRowOffset = (i - 1) * cols;
    const prev2RowOffset = (i - 2) * cols;
    for (let j = 1; j <= lenB; j += 1) {
      const chB = b.charCodeAt(j - 1);
      const cost = chA === chB ? 0 : 1;
      let val = Math.min(
        dp[prevRowOffset + j]! + 1,
        dp[rowOffset + j - 1]! + 1,
        dp[prevRowOffset + j - 1]! + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        chA === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === chB
      ) {
        val = Math.min(val, dp[prev2RowOffset + j - 2]! + 1);
      }
      dp[rowOffset + j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  const d = dp[lenA * cols + lenB]!;
  return d <= maxDist ? d : maxDist + 1;
}

export function damerauDistanceWithinPrefix(
  a: string,
  b: string,
  lenB: number,
  maxDist: number
): number {
  const lenA = a.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (lenA === 0) return lenB <= maxDist ? lenB : maxDist + 1;
  if (lenB === 0) return lenA <= maxDist ? lenA : maxDist + 1;

  const cols = lenB + 1;
  const dp = getDlBuffer((lenA + 1) * cols);
  for (let i = 0; i <= lenA; i += 1) dp[i * cols] = i;
  for (let j = 0; j <= lenB; j += 1) dp[j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    let rowMin = maxDist + 1;
    const chA = a.charCodeAt(i - 1);
    const rowOffset = i * cols;
    const prevRowOffset = (i - 1) * cols;
    const prev2RowOffset = (i - 2) * cols;
    for (let j = 1; j <= lenB; j += 1) {
      const chB = b.charCodeAt(j - 1);
      const cost = chA === chB ? 0 : 1;
      let val = Math.min(
        dp[prevRowOffset + j]! + 1,
        dp[rowOffset + j - 1]! + 1,
        dp[prevRowOffset + j - 1]! + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        chA === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === chB
      ) {
        val = Math.min(val, dp[prev2RowOffset + j - 2]! + 1);
      }
      dp[rowOffset + j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  const d = dp[lenA * cols + lenB]!;
  return d <= maxDist ? d : maxDist + 1;
}

function tokenizeWords(normalizedText: string): string[] {
  return normalizedText.split(/[^\p{L}\p{N}._-]+/u).filter((w) => w.length >= 2);
}

function allowedTypoDistance(tokenLen: number): number {
  if (tokenLen >= 7) return 2;
  if (tokenLen >= 4) return 1;
  return 0;
}

const WORD_CHAR_RE = /[\p{L}\p{N}._-]/u;
const NON_ASCII_WORD_RE = /[\p{L}\p{N}]/u;
const ASCII_WORD_CHAR = new Uint8Array(128);
for (let c = 0; c < 128; c += 1) {
  if (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 45 ||
    c === 46
  ) {
    ASCII_WORD_CHAR[c] = 1;
  }
}

export function isSearchWordCharAt(str: string, idx: number): boolean {
  const c = str.charCodeAt(idx);
  if (c < 128) return ASCII_WORD_CHAR[c] === 1;
  if ((c >= 1040 && c <= 1103) || c === 1025 || c === 1105) return true;
  if (c >= 0xd800 && c <= 0xdfff) return false;
  return NON_ASCII_WORD_RE.test(str[idx]!);
}

const EMPTY_STR_ARR: string[] = [];

export interface CompiledCharFreq {
  ch: string;
  code: number;
  count: number;
}

export interface CompiledFuzzyCandidate {
  cand: string;
  candLen: number;
  maxDist: number;
  c0: number;
  c1: number;
  c2: number;
  ch0: string;
  ch1: string;
  ch2: string;
  nonWordCount: number;
  wordCharFreqs: CompiledCharFreq[];
  allCharFreqs: CompiledCharFreq[];
}

export function passesCharFreqs(
  text: string,
  freqs: CompiledCharFreq[],
  initialMisses: number,
  maxDist: number,
  limitEnd = text.length
): boolean {
  let misses = initialMisses;
  if (misses > maxDist) return false;
  for (let k = 0; k < freqs.length; k += 1) {
    const f = freqs[k]!;
    if (f.count === 1) {
      const found = text.indexOf(f.ch);
      if (found < 0 || found >= limitEnd) {
        misses += 1;
        if (misses > maxDist) return false;
      }
    } else {
      let pos = 0;
      for (let r = 0; r < f.count; r += 1) {
        const found = text.indexOf(f.ch, pos);
        if (found < 0 || found >= limitEnd) {
          misses += f.count - r;
          break;
        }
        pos = found + 1;
      }
      if (misses > maxDist) return false;
    }
  }
  return true;
}

function buildSortedCharFreqs(
  accMap: Map<string, { ch: string; code: number; count: number; lastIdx: number }>
): CompiledCharFreq[] {
  return Array.from(accMap.values())
    .sort((a, b) => b.count - a.count || b.lastIdx - a.lastIdx)
    .map(({ ch, code, count }) => ({ ch, code, count }));
}

export interface CompiledTokenGroup {
  primaryNorm: string;
  variantNorms: string[];
  fuzzyCandidates: CompiledFuzzyCandidate[];
}

export interface CompiledBilingualSearchQuery {
  trimmed: string;
  rawTagMatches: string[];
  cleanPhrase: string;
  groups: CompiledTokenGroup[];
}

function compileTokenGroup(group: ExpandedTokenGroup): CompiledTokenGroup {
  const primaryNorm = normalizeSearchText(group.primary);
  const variantSet = new Set<string>();
  for (const v of group.variants) {
    const vNorm = normalizeSearchText(v);
    if (vNorm && vNorm !== primaryNorm) {
      variantSet.add(vNorm);
    }
  }

  const fuzzyRaw: string[] = [primaryNorm];
  if (/[а-яё]/i.test(group.primary) && group.primary.length >= 4) {
    const en = normalizeSearchText(translitRuToEn(group.primary));
    if (en.length >= 4) fuzzyRaw.push(en);
  } else if (/[a-z]/i.test(group.primary) && group.primary.length >= 4) {
    const ru = normalizeSearchText(translitEnToRu(group.primary));
    if (ru.length >= 4) fuzzyRaw.push(ru);
  }
  const swapped = swapKeyboardLayout(group.primary);
  if (swapped) fuzzyRaw.push(normalizeSearchText(swapped));

  const fuzzyCandidates: CompiledFuzzyCandidate[] = [];
  for (const cand of fuzzyRaw) {
    const maxDist = allowedTypoDistance(cand.length);
    if (maxDist <= 0) continue;
    const wordMap = new Map<string, { ch: string; code: number; count: number; lastIdx: number }>();
    const allMap = new Map<string, { ch: string; code: number; count: number; lastIdx: number }>();
    let nonWordCount = 0;
    for (let k = cand.length - 1; k >= 0; k -= 1) {
      const ch = cand[k]!;
      const code = cand.charCodeAt(k);
      const existingAll = allMap.get(ch);
      if (existingAll) {
        existingAll.count += 1;
      } else {
        allMap.set(ch, { ch, code, count: 1, lastIdx: k });
      }
      if (WORD_CHAR_RE.test(ch)) {
        const existingWord = wordMap.get(ch);
        if (existingWord) {
          existingWord.count += 1;
        } else {
          wordMap.set(ch, { ch, code, count: 1, lastIdx: k });
        }
      } else {
        nonWordCount += 1;
      }
    }
    fuzzyCandidates.push({
      cand,
      candLen: cand.length,
      maxDist,
      c0: cand.charCodeAt(0),
      c1: cand.charCodeAt(1),
      c2: cand.length >= 3 ? cand.charCodeAt(2) : -1,
      ch0: cand[0]!,
      ch1: cand[1]!,
      ch2: cand.length >= 3 ? cand[2]! : '',
      nonWordCount,
      wordCharFreqs: buildSortedCharFreqs(wordMap),
      allCharFreqs: buildSortedCharFreqs(allMap),
    });
  }

  return {
    primaryNorm,
    variantNorms: Array.from(variantSet),
    fuzzyCandidates,
  };
}

export function compileBilingualSearchQuery(rawQuery: string): CompiledBilingualSearchQuery {
  const trimmed = (rawQuery || '').trim();
  if (!trimmed) {
    return { trimmed: '', rawTagMatches: [], cleanPhrase: '', groups: [] };
  }
  const rawTagMatches: string[] = [];
  for (const m of trimmed.matchAll(/(?:^|(?<=\s))#(?=[\p{L}\p{N}_-]*\p{L})([\p{L}\p{N}_-]+)/gu)) {
    const norm = normalizeSearchText(m[1] || '');
    if (norm) rawTagMatches.push(norm);
  }
  const queryWithoutHashes = trimmed
    .replace(/(?:^|(?<=\s))#(?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}_-]+/gu, ' ')
    .trim();
  const baseQuery = queryWithoutHashes || trimmed;
  const groups = expandBilingualQuery(baseQuery).map(compileTokenGroup);
  return {
    trimmed,
    rawTagMatches,
    cleanPhrase: normalizeSearchText(baseQuery),
    groups,
  };
}

function matchCompiledGroupInNormalizedText(
  normalizedText: string,
  wordsOrGetter: string[] | (() => string[]),
  group: CompiledTokenGroup,
  allowFuzzy = true
): 'exact' | 'variant' | 'fuzzy' | null {
  if (!normalizedText) return null;
  if (group.primaryNorm && normalizedText.includes(group.primaryNorm)) {
    return 'exact';
  }
  for (let i = 0; i < group.variantNorms.length; i += 1) {
    if (normalizedText.includes(group.variantNorms[i]!)) {
      return 'variant';
    }
  }
  if (!allowFuzzy || group.fuzzyCandidates.length === 0) return null;

  // Fast full-candidate multiplicity pigeonhole pre-check: at most `maxDist` character occurrences
  // of `cand` can be missing from `normalizedText` (and non-word chars cannot appear in tokenized words).
  // When false across all candidates, skip word tokenization and Damerau-Levenshtein entirely.
  const isTokenizedFn = typeof wordsOrGetter === 'function';
  let anyCandidatePossible = false;
  for (let i = 0; i < group.fuzzyCandidates.length; i += 1) {
    const fc = group.fuzzyCandidates[i]!;
    const freqs = isTokenizedFn ? fc.wordCharFreqs : fc.allCharFreqs;
    const initMisses = isTokenizedFn ? fc.nonWordCount : 0;
    if (passesCharFreqs(normalizedText, freqs, initMisses, fc.maxDist)) {
      anyCandidatePossible = true;
      break;
    }
  }
  if (!anyCandidatePossible) return null;

  const words = typeof wordsOrGetter === 'function' ? wordsOrGetter() : wordsOrGetter;
  if (words.length === 0) return null;

  for (let i = 0; i < group.fuzzyCandidates.length; i += 1) {
    const fc = group.fuzzyCandidates[i]!;
    const cand = fc.cand;
    const candLen = cand.length;
    const maxDist = fc.maxDist;
    const freqs = isTokenizedFn ? fc.wordCharFreqs : fc.allCharFreqs;
    const initMisses = isTokenizedFn ? fc.nonWordCount : 0;

    for (let j = 0; j < words.length; j += 1) {
      const w = words[j]!;
      const wLen = w.length;
      if (Math.abs(wLen - candLen) <= maxDist) {
        if (wLen >= 2 && candLen >= 2) {
          const w0 = w.charCodeAt(0);
          const w1 = w.charCodeAt(1);
          if (maxDist === 1) {
            if (w0 !== fc.c0 && w0 !== fc.c1 && w1 !== fc.c0 && w1 !== fc.c1) continue;
          } else if (maxDist === 2 && wLen >= 3 && candLen >= 3) {
            const w2 = w.charCodeAt(2);
            if (
              w0 !== fc.c0 &&
              w0 !== fc.c1 &&
              w0 !== fc.c2 &&
              w1 !== fc.c0 &&
              w1 !== fc.c1 &&
              w1 !== fc.c2 &&
              w2 !== fc.c0 &&
              w2 !== fc.c1 &&
              w2 !== fc.c2
            ) {
              continue;
            }
          }
        }
        if (!passesCharFreqs(w, freqs, initMisses, maxDist)) continue;
        if (damerauDistanceWithin(cand, w, maxDist) <= maxDist) {
          return 'fuzzy';
        }
      } else if (wLen > candLen && candLen >= 5) {
        const w0 = w.charCodeAt(0);
        const w1 = w.charCodeAt(1);
        if (w0 !== fc.c0 && w0 !== fc.c1 && w1 !== fc.c0 && w1 !== fc.c1) continue;
        if (!passesCharFreqs(w, freqs, initMisses, 1, candLen)) continue;
        if (damerauDistanceWithinPrefix(cand, w, candLen, 1) <= 1) {
          return 'fuzzy';
        }
      }
    }
  }
  return null;
}

function matchGroupInNormalizedText(
  normalizedText: string,
  wordsOrGetter: string[] | (() => string[]),
  group: ExpandedTokenGroup,
  allowFuzzy = true
): 'exact' | 'variant' | 'fuzzy' | null {
  return matchCompiledGroupInNormalizedText(
    normalizedText,
    wordsOrGetter,
    compileTokenGroup(group),
    allowFuzzy
  );
}

/**
 * Fast client-side / fallback matcher: returns true if `haystack` matches
 * EVERY meaningful token group (supports case-insensitivity, ё/е, RU<->EN synonyms,
 * transliteration, keyboard layout fixes, and typo tolerance via Damerau-Levenshtein).
 */
export function matchesBilingualHaystack(haystack: string, rawQuery: string): boolean {
  const groups = expandBilingualQuery(rawQuery);
  if (groups.length === 0) return true;
  const hayNorm = normalizeSearchText(haystack);
  const queryNorm = normalizeSearchText(rawQuery.trim());
  if (queryNorm && hayNorm.includes(queryNorm)) return true;
  const words = tokenizeWords(hayNorm);
  return groups.every((g) => matchGroupInNormalizedText(hayNorm, words, g) !== null);
}

export interface SmartSearchFields {
  title?: string | null;
  tags?: string[];
  orbitName?: string | null;
  boardName?: string | null;
  domain?: string | null;
  dnaLabel?: string | null;
  summary?: string | null;
  body?: string | null;
  ocrText?: string | null;
  url?: string | null;
  extra?: string | null;
  isPinned?: boolean;
  updatedAt?: number;
}

/**
 * Computes a relevance score (> 0 when matched, 0 when not matched) across structured fields.
 * Prioritizes exact phrase in title, title tokens, tags/section names, domain/type, then body/OCR.
 */
export function scoreBilingualFieldsCompiled(
  fields: SmartSearchFields,
  compiled: CompiledBilingualSearchQuery,
  opts?: { allowFuzzy?: boolean; nowMs?: number }
): number {
  if (!compiled.trimmed) return 1;
  const allowFuzzy = opts?.allowFuzzy !== false;

  const tagsNorm =
    fields.tags && fields.tags.length > 0
      ? fields.tags.map((tg) => normalizeSearchText(tg))
      : EMPTY_STR_ARR;
  for (let i = 0; i < compiled.rawTagMatches.length; i += 1) {
    const wantedTag = compiled.rawTagMatches[i]!;
    let hitTag = false;
    for (let j = 0; j < tagsNorm.length; j += 1) {
      if (tagsNorm[j]!.includes(wantedTag)) {
        hitTag = true;
        break;
      }
    }
    if (!hitTag) return 0;
  }

  if (compiled.groups.length === 0) {
    return compiled.rawTagMatches.length > 0 ? 80 : 1;
  }

  const titleNorm = normalizeSearchText(fields.title || '');
  const tagTextNorm = tagsNorm.length > 0 ? tagsNorm.join(' ') : '';
  let rawMeta = '';
  if (fields.orbitName) rawMeta = fields.orbitName;
  if (fields.boardName) rawMeta = rawMeta ? `${rawMeta} ${fields.boardName}` : fields.boardName;
  if (fields.domain) rawMeta = rawMeta ? `${rawMeta} ${fields.domain}` : fields.domain;
  if (fields.dnaLabel) rawMeta = rawMeta ? `${rawMeta} ${fields.dnaLabel}` : fields.dnaLabel;
  if (fields.url) rawMeta = rawMeta ? `${rawMeta} ${fields.url}` : fields.url;
  if (fields.extra) rawMeta = rawMeta ? `${rawMeta} ${fields.extra}` : fields.extra;
  const metaNorm = rawMeta ? normalizeSearchText(rawMeta) : '';

  let rawBody = '';
  if (fields.summary) rawBody = fields.summary;
  if (fields.body) rawBody = rawBody ? `${rawBody}\n${fields.body}` : fields.body;
  if (fields.ocrText) rawBody = rawBody ? `${rawBody}\n${fields.ocrText}` : fields.ocrText;
  const bodyNorm = rawBody ? normalizeSearchText(rawBody) : '';

  let titleWordsCache: string[] | null = null;
  let metaWordsCache: string[] | null = null;
  let bodyWordsCache: string[] | null = null;
  const getTitleWords = () => (titleWordsCache ??= tokenizeWords(titleNorm));
  const getMetaWords = () => (metaWordsCache ??= tokenizeWords(`${tagTextNorm} ${metaNorm}`));
  const getBodyWords = () => (bodyWordsCache ??= tokenizeWords(bodyNorm));

  let score = 0;
  const cleanPhrase = compiled.cleanPhrase;
  if (cleanPhrase.length >= 2) {
    if (titleNorm === cleanPhrase) score += 180;
    else if (titleNorm.startsWith(cleanPhrase)) score += 135;
    else if (titleNorm.includes(cleanPhrase)) score += 105;
    else if (
      tagTextNorm.includes(cleanPhrase) ||
      metaNorm.includes(cleanPhrase) ||
      bodyNorm.includes(cleanPhrase)
    ) {
      score += 45;
    }
  }

  for (let i = 0; i < compiled.groups.length; i += 1) {
    const group = compiled.groups[i]!;
    const titleHit = matchCompiledGroupInNormalizedText(titleNorm, getTitleWords, group, allowFuzzy);
    const tagHit = matchCompiledGroupInNormalizedText(tagTextNorm, tagsNorm, group, allowFuzzy);
    const metaHit = matchCompiledGroupInNormalizedText(metaNorm, getMetaWords, group, allowFuzzy);
    const bodyHit = matchCompiledGroupInNormalizedText(bodyNorm, getBodyWords, group, allowFuzzy);

    if (!titleHit && !tagHit && !metaHit && !bodyHit) {
      return 0;
    }

    if (titleHit === 'exact') score += 62;
    else if (titleHit === 'variant') score += 44;
    else if (titleHit === 'fuzzy') score += 32;

    if (tagHit === 'exact') score += 48;
    else if (tagHit) score += 32;

    if (metaHit === 'exact') score += 36;
    else if (metaHit) score += 24;

    if (bodyHit === 'exact') score += 20;
    else if (bodyHit === 'variant') score += 14;
    else if (bodyHit === 'fuzzy') score += 9;
  }

  if (compiled.rawTagMatches.length > 0) score += compiled.rawTagMatches.length * 40;
  if (fields.isPinned) score += 4;
  if (fields.updatedAt && fields.updatedAt > 0) {
    const nowMs = opts?.nowMs ?? Date.now();
    const ageDays = Math.max(0, (nowMs - fields.updatedAt) / 86_400_000);
    score += Math.max(0, 6 - Math.log10(ageDays + 1) * 2.5);
  }
  return score;
}

export function scoreBilingualFields(
  fields: SmartSearchFields,
  rawQuery: string,
  opts?: { allowFuzzy?: boolean }
): number {
  return scoreBilingualFieldsCompiled(fields, compileBilingualSearchQuery(rawQuery), opts);
}

/**
 * Extracts a contextual snippet centered around the first matching token so users
 * immediately see WHY a long note matched their query.
 */
export function extractMatchedSnippet(rawText: string, rawQuery: string, maxLen = 84): string {
  const clean = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;

  const groups = expandBilingualQuery(rawQuery);
  if (groups.length === 0) return `${clean.slice(0, maxLen - 1).trimEnd()}…`;

  const lower = normalizeSearchText(clean);
  let bestIdx = -1;
  for (const g of groups) {
    const pIdx = lower.indexOf(normalizeSearchText(g.primary));
    if (pIdx >= 0 && (bestIdx === -1 || pIdx < bestIdx)) {
      bestIdx = pIdx;
    }
  }
  if (bestIdx === -1) {
    for (const g of groups) {
      for (const v of g.variants) {
        const vIdx = lower.indexOf(normalizeSearchText(v));
        if (vIdx >= 0 && (bestIdx === -1 || vIdx < bestIdx)) {
          bestIdx = vIdx;
        }
      }
    }
  }
  if (bestIdx <= Math.floor(maxLen * 0.45)) {
    return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
  }

  const start = Math.max(0, bestIdx - Math.floor(maxLen * 0.35));
  const end = Math.min(clean.length, start + maxLen);
  const slice = clean.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${slice}${end < clean.length ? '…' : ''}`;
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Splits display text into highlighted / plain segments matching query tokens (case- & ё-insensitive).
 */
export function splitHighlightSegments(text: string, rawQuery: string): HighlightSegment[] {
  if (!text) return [];
  const groups = expandBilingualQuery(rawQuery);
  if (groups.length === 0) return [{ text, hit: false }];

  const needles = new Set<string>();
  for (const g of groups) {
    const p = normalizeSearchText(g.primary);
    if (p.length >= 2) needles.add(p);
    for (const v of g.variants.slice(0, 6)) {
      const vn = normalizeSearchText(v);
      if (vn.length >= 3) needles.add(vn);
    }
  }
  const sortedNeedles = Array.from(needles).sort((a, b) => b.length - a.length);
  if (sortedNeedles.length === 0) return [{ text, hit: false }];

  const norm = normalizeSearchText(text);
  const ranges: Array<[number, number]> = [];
  for (const needle of sortedNeedles) {
    let from = 0;
    while (from < norm.length) {
      const idx = norm.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push([idx, idx + needle.length]);
      from = idx + needle.length;
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (!prev || r[0] > prev[1]) {
      merged.push([r[0], r[1]]);
    } else if (r[1] > prev[1]) {
      prev[1] = r[1];
    }
  }

  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
