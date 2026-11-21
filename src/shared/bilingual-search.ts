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

/**
 * Fast client-side / fallback matcher: returns true if `haystackLower` matches
 * EVERY meaningful token group (at least one variant per group matches).
 */
export function matchesBilingualHaystack(haystackLower: string, rawQuery: string): boolean {
  const groups = expandBilingualQuery(rawQuery);
  if (groups.length === 0) return true;
  if (haystackLower.includes(rawQuery.trim().toLowerCase())) return true;
  return groups.every((g) => g.variants.some((v) => haystackLower.includes(v)));
}
