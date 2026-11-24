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
  return (raw || '').toLowerCase().replace(/ё/g, 'е');
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

  const dp: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= lenB; j += 1) dp[0]![j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    let rowMin = maxDist + 1;
    const chA = a.charCodeAt(i - 1);
    for (let j = 1; j <= lenB; j += 1) {
      const chB = b.charCodeAt(j - 1);
      const cost = chA === chB ? 0 : 1;
      let val = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        chA === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === chB
      ) {
        val = Math.min(val, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[lenA]![lenB]!;
}

function tokenizeWords(normalizedText: string): string[] {
  return normalizedText.split(/[^\p{L}\p{N}._-]+/u).filter((w) => w.length >= 2);
}

function allowedTypoDistance(tokenLen: number): number {
  if (tokenLen >= 7) return 2;
  if (tokenLen >= 4) return 1;
  return 0;
}

function matchGroupInNormalizedText(
  normalizedText: string,
  words: string[],
  group: ExpandedTokenGroup
): 'exact' | 'variant' | 'fuzzy' | null {
  if (!normalizedText) return null;
  const primaryNorm = normalizeSearchText(group.primary);
  if (primaryNorm && normalizedText.includes(primaryNorm)) {
    return 'exact';
  }
  for (const v of group.variants) {
    const vNorm = normalizeSearchText(v);
    if (vNorm && vNorm !== primaryNorm && normalizedText.includes(vNorm)) {
      return 'variant';
    }
  }
  // Typo-tolerant fallback against words in text (primary, transliteration, and layout-swapped variant)
  const fuzzyCandidates: string[] = [primaryNorm];
  if (/[а-яё]/i.test(group.primary) && group.primary.length >= 4) {
    const en = normalizeSearchText(translitRuToEn(group.primary));
    if (en.length >= 4) fuzzyCandidates.push(en);
  } else if (/[a-z]/i.test(group.primary) && group.primary.length >= 4) {
    const ru = normalizeSearchText(translitEnToRu(group.primary));
    if (ru.length >= 4) fuzzyCandidates.push(ru);
  }
  const swapped = swapKeyboardLayout(group.primary);
  if (swapped) fuzzyCandidates.push(normalizeSearchText(swapped));
  for (const cand of fuzzyCandidates) {
    const maxDist = allowedTypoDistance(cand.length);
    if (maxDist <= 0) continue;
    for (const w of words) {
      if (Math.abs(w.length - cand.length) <= maxDist) {
        if (damerauDistanceWithin(cand, w, maxDist) <= maxDist) {
          return 'fuzzy';
        }
      } else if (w.length > cand.length && cand.length >= 5) {
        // Also allow 1 typo inside the prefix of a longer inflected Russian word
        const prefix = w.slice(0, cand.length);
        if (damerauDistanceWithin(cand, prefix, 1) <= 1) {
          return 'fuzzy';
        }
      }
    }
  }
  return null;
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
export function scoreBilingualFields(fields: SmartSearchFields, rawQuery: string): number {
  const trimmed = (rawQuery || '').trim();
  if (!trimmed) return 1;

  // Support explicit `#tag` filtering mixed with free text
  const rawTagMatches = Array.from(trimmed.matchAll(/#([\p{L}\p{N}_-]+)/gu)).map((m) =>
    normalizeSearchText(m[1] || '')
  );
  const queryWithoutHashes = trimmed.replace(/#[\p{L}\p{N}_-]+/gu, ' ').trim();
  const tagsNorm = (fields.tags || []).map((tg) => normalizeSearchText(tg));
  for (const wantedTag of rawTagMatches) {
    if (!wantedTag) continue;
    const hitTag = tagsNorm.some((tg) => tg.includes(wantedTag));
    if (!hitTag) return 0;
  }

  const groups = expandBilingualQuery(queryWithoutHashes || trimmed);
  const titleNorm = normalizeSearchText(fields.title || '');
  const tagTextNorm = tagsNorm.join(' ');
  const metaNorm = normalizeSearchText(
    [fields.orbitName, fields.boardName, fields.domain, fields.dnaLabel, fields.url, fields.extra]
      .filter(Boolean)
      .join(' ')
  );
  const bodyNorm = normalizeSearchText(
    [fields.summary, fields.body, fields.ocrText].filter(Boolean).join('\n')
  );
  const combinedNorm = `${titleNorm}\n${tagTextNorm}\n${metaNorm}\n${bodyNorm}`;

  if (groups.length === 0) {
    return rawTagMatches.length > 0 ? 80 : 1;
  }

  const titleWords = tokenizeWords(titleNorm);
  const metaWords = tokenizeWords(`${tagTextNorm} ${metaNorm}`);
  const bodyWords = tokenizeWords(bodyNorm);

  let score = 0;
  const cleanPhrase = normalizeSearchText(queryWithoutHashes || trimmed);
  if (cleanPhrase.length >= 2) {
    if (titleNorm === cleanPhrase) score += 180;
    else if (titleNorm.startsWith(cleanPhrase)) score += 135;
    else if (titleNorm.includes(cleanPhrase)) score += 105;
    else if (combinedNorm.includes(cleanPhrase)) score += 45;
  }

  for (const group of groups) {
    const titleHit = matchGroupInNormalizedText(titleNorm, titleWords, group);
    const tagHit = matchGroupInNormalizedText(tagTextNorm, tagsNorm, group);
    const metaHit = matchGroupInNormalizedText(metaNorm, metaWords, group);
    const bodyHit = matchGroupInNormalizedText(bodyNorm, bodyWords, group);

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

  if (rawTagMatches.length > 0) score += rawTagMatches.length * 40;
  if (fields.isPinned) score += 4;
  if (fields.updatedAt && fields.updatedAt > 0) {
    const ageDays = Math.max(0, (Date.now() - fields.updatedAt) / 86_400_000);
    score += Math.max(0, 6 - Math.log10(ageDays + 1) * 2.5);
  }
  return score;
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
