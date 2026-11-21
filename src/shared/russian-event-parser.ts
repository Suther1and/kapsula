import { truncateAtWordBoundary } from './html-entities';
import type { ParsedRussianEvent } from './types';

export function normalizeCardExpiry(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  const sep = /^(?:0?([1-9])|(1[0-2]))\s*[\/.\-\s]\s*(?:20)?(\d{2})$/.exec(s);
  if (sep) {
    const monthNum = Number(sep[1] || sep[2]);
    const yearNum = Number(sep[3]);
    if (monthNum >= 1 && monthNum <= 12 && yearNum >= 20 && yearNum <= 49) {
      return `${String(monthNum).padStart(2, '0')}/${String(yearNum).padStart(2, '0')}`;
    }
    return undefined;
  }
  const compact = /^(0[1-9]|1[0-2])(\d{2})$/.exec(s);
  if (compact) {
    const monthNum = Number(compact[1]);
    const yearNum = Number(compact[2]);
    if (monthNum >= 1 && monthNum <= 12 && yearNum >= 20 && yearNum <= 49) {
      return `${compact[1]}/${compact[2]}`;
    }
  }
  return undefined;
}

export function formatCardExpiryDraft(raw: string): string {
  const cleaned = String(raw ?? '').replace(/[^0-9/.]/g, '');
  if (!cleaned) return '';
  if (cleaned.includes('/') || cleaned.includes('.')) {
    const parts = cleaned.split(/[/.]/);
    let mm = (parts[0] || '').replace(/\D/g, '').slice(0, 2);
    const yy = (parts[1] || '').replace(/\D/g, '').slice(0, 2);
    if (mm.length === 1 && Number(mm) > 1 && Number(mm) <= 9) {
      mm = `0${mm}`;
    }
    return parts.length > 1 ? `${mm}/${yy}` : mm;
  }
  const digits = cleaned.replace(/\D/g, '').slice(0, 4);
  if (digits.length === 1 && Number(digits) > 1 && Number(digits) <= 9) {
    return `0${digits}/`;
  }
  if (digits.length >= 2 && Number(digits[0]) > 1) {
    return `0${digits[0]}/${digits.slice(1, 3)}`;
  }
  if (digits.length === 2 && cleaned.length >= 2 && Number(digits) >= 1 && Number(digits) <= 12) {
    return digits;
  }
  if (digits.length > 2) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}`;
  }
  return digits;
}

export function recoverBankCardExpiry(expiry?: string | null, notes?: string | null): string | undefined {
  return (
    normalizeCardExpiry(expiry) ||
    normalizeCardExpiry(notes?.match(/\b(0?[1-9]|1[0-2])\s*[\/.\-]\s*(?:20)?(\d{2})\b/)?.[0])
  );
}

const MONTH_STEMS: Array<{ stem: RegExp; month: number }> = [
  { stem: /январ\p{L}*/iu, month: 0 },
  { stem: /феврал\p{L}*/iu, month: 1 },
  { stem: /март\p{L}*/iu, month: 2 },
  { stem: /апрел\p{L}*/iu, month: 3 },
  { stem: /ма[йя](?=$|[^\p{L}])/iu, month: 4 },
  { stem: /июн\p{L}*/iu, month: 5 },
  { stem: /июл\p{L}*/iu, month: 6 },
  { stem: /август\p{L}*/iu, month: 7 },
  { stem: /сентябр\p{L}*/iu, month: 8 },
  { stem: /октябр\p{L}*/iu, month: 9 },
  { stem: /ноябр\p{L}*/iu, month: 10 },
  { stem: /декабр\p{L}*/iu, month: 11 },
];

const SHORT_MONTH_MAP: Record<string, number> = {
  янв: 0,
  фев: 1,
  мар: 2,
  апр: 3,
  май: 4,
  июн: 5,
  июл: 6,
  авг: 7,
  сен: 8,
  сент: 8,
  окт: 9,
  ноя: 10,
  нояб: 10,
  дек: 11,
};

const WEEKDAY_SPECS: Array<{ re: RegExp; dow: number }> = [
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?понедельник(?=$|[^\p{L}])/iu, dow: 1 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?вторник(?=$|[^\p{L}])/iu, dow: 2 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?сред[ау](?=$|[^\p{L}])/iu, dow: 3 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?четверг(?=$|[^\p{L}])/iu, dow: 4 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?пятниц[ау](?=$|[^\p{L}])/iu, dow: 5 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?суббот[ау](?=$|[^\p{L}])/iu, dow: 6 },
  { re: /(?:в\s+(?:эт[уот]\s+|следующ[уюийе]+\s+)?|во\s+|на\s+|ближайш[уюийе]+\s+)?воскресенье(?=$|[^\p{L}])/iu, dow: 0 },
  { re: /(?:в|во|на)\s+(пн|вт|ср|чт|пт|сб|вс)(?=$|[^\p{L}])/iu, dow: -1 },
  { re: /(?:^|[\s,(])(пн|вт|ср|чт|пт|сб|вс)(?=[\s,.)]|$)/iu, dow: -1 },
];

const SHORT_DOW: Record<string, number> = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0 };

const ACTION_EVENT_CUE_RE =
  /(?:^|[^\p{L}])(?:напомн\p{L}*|не\s+забыть|запис\p{L}*|при[её]м\p{L}*|созвон\p{L}*|звонок\p{L}*|позвонить|встреч\p{L}*|митинг\p{L}*|дедлайн\p{L}*|релиз\p{L}*|вылет\p{L}*|поезд\p{L}*|рейс\p{L}*|врач\p{L}*|стоматолог\p{L}*|чистк\p{L}*|парикмахер\p{L}*|тренировк\p{L}*|стрим\p{L}*|концерт\p{L}*|экзамен\p{L}*|бронь|доставк\p{L}*|оплатить|отправить|сдать)(?=$|[^\p{L}])/iu;

const SHORT_DURATION_CUE_RE =
  /(?:чистк|врач|стоматолог|доктор|клиник|при[её]м|звонок|созвон|позвонить|дейли|стендап|стрижк|маникюр)/iu;

function removeSpan(src: string, match: RegExpMatchArray | null): string {
  if (!match || match.index === undefined) return src;
  return `${src.slice(0, match.index)} ${src.slice(match.index + match[0].length)}`;
}

function cleanExtractedTitle(raw: string): string {
  let s = (raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';
  s = s
    .replace(/^[-*•]\s*(?:\[[ xX]\]\s*)?/, '')
    .replace(/^(?:привет|добрый\s+(?:день|вечер)|здравствуйте)[,!.\s]*/iu, '')
    .replace(/^(?:напомина(?:ю|ем)[,\s]*(?:что\s+)?|вы\s+записан[аы]?\s+на\s+|записан[аы]?\s+на\s+)/iu, '')
    .replace(/^(?:напомни(?:ть)?(?:\s+мне)?|не\s+забыть|запиши|событие)\s*[:—-]?\s*/iu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,—:.\-]+/, '')
    .replace(/[\s,—:;\-]+(?:в|во|на|с|по|к|около)$/iu, '')
    .replace(/[\s,—:;\-]+$/, '')
    .trim();
  if (!s || s.length < 2) return '';
  return truncateAtWordBoundary(s.charAt(0).toUpperCase() + s.slice(1), 84);
}

export function parseRussianEvent(
  rawText: string,
  nowMs = Date.now(),
  fallbackDayMs?: number
): ParsedRussianEvent | null {
  const input = (rawText || '').trim();
  if (!input || input.length < 3) return null;
  if (/^https?:\/\/\S+$/i.test(input)) return null;

  const base = new Date(nowMs);
  let remaining = input;

  let hour = 10;
  let minute = 0;
  let hasExplicitTime = false;
  let endHour: number | null = null;
  let endMinute: number | null = null;
  let hasEndTime = false;
  let explicitDurationMin: number | null = null;
  let explicitYear: number | null = null;
  let explicitMonth: number | null = null;
  let explicitDay: number | null = null;
  let resolvedDate: Date | null = null;
  let isRelativeOffset = false;
  let isNamedDay = false;

  // 1. Extract explicit call/meeting URL first so digits inside URL aren't parsed as times/dates
  let location = '';
  const callLinkMatch = remaining.match(
    /https?:\/\/(?:[\w.-]*zoom\.us|meet\.google\.com|teams\.microsoft\.com|telemost\.yandex\.\w+|t\.me\/\+)\S+/i
  );
  if (callLinkMatch) {
    location = callLinkMatch[0].replace(/[),.;]+$/, '');
    remaining = removeSpan(remaining, callLinkMatch);
  }

  // 2. Parse time ranges & explicit times FIRST (prevents `в 10.11` being confused with Oct 11)
  const rangeMatch = remaining.match(
    /(?:^|[^\d])(?:с\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:-|–|—|до)\s*([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/i
  );
  if (rangeMatch) {
    hour = Number(rangeMatch[1]);
    minute = Number(rangeMatch[2]);
    endHour = Number(rangeMatch[3]);
    endMinute = Number(rangeMatch[4]);
    hasExplicitTime = true;
    hasEndTime = true;
    remaining = removeSpan(remaining, rangeMatch);
  } else {
    const colonTime = remaining.match(
      /(?:^|[^\d])(?:в\s*)?([01]?\d|2[0-3]):([0-5]\d)(?:\s*(утра|дня|вечера|ночи))?(?!\d)/iu
    );
    const dotPrefixedTime = !colonTime
      ? remaining.match(/(?:^|[^\d])(?:в|к|около)\s+([01]?\d|2[0-3])\.([0-5]\d)(?!\d)/iu)
      : null;
    const wordPrefixedTime =
      !colonTime && !dotPrefixedTime
        ? remaining.match(
            /(?:^|[^\p{L}\d])в\s+(?:(\d{1,2})\s*(утра|дня|вечера|ночи|час\p{L}*)?|полдень)(?=$|[^\p{L}\d])/iu
          )
        : null;

    if (colonTime) {
      hour = Number(colonTime[1]);
      minute = Number(colonTime[2]);
      const mod = colonTime[3]?.toLowerCase();
      if ((mod === 'дня' || mod === 'вечера') && hour >= 1 && hour <= 11) hour += 12;
      hasExplicitTime = true;
      remaining = removeSpan(remaining, colonTime);
    } else if (dotPrefixedTime) {
      hour = Number(dotPrefixedTime[1]);
      minute = Number(dotPrefixedTime[2]);
      hasExplicitTime = true;
      remaining = removeSpan(remaining, dotPrefixedTime);
    } else if (wordPrefixedTime) {
      if (/полдень/i.test(wordPrefixedTime[0])) {
        hour = 12;
        minute = 0;
        hasExplicitTime = true;
        remaining = removeSpan(remaining, wordPrefixedTime);
      } else if (wordPrefixedTime[1]) {
        const candidateH = Number(wordPrefixedTime[1]);
        const afterMatch = remaining.slice((wordPrefixedTime.index ?? 0) + wordPrefixedTime[0].length);
        const followedByCountUnit =
          /^\s*(?:клик|этап|шаг|раз|пункт|раздел|уровн|режим|ряд|сло[йев]|человек|дн|недел|мес|год|лет|процент)/iu.test(
            afterMatch
          );
        if (candidateH >= 0 && candidateH <= 23 && (Boolean(wordPrefixedTime[2]) || !followedByCountUnit)) {
          hour = candidateH;
          minute = 0;
          const mod = wordPrefixedTime[2]?.toLowerCase() ?? '';
          if ((mod === 'дня' || mod === 'вечера') && hour >= 1 && hour <= 11) hour += 12;
          hasExplicitTime = true;
          remaining = removeSpan(remaining, wordPrefixedTime);
        }
      }
    }
  }

  // 3. Explicit duration (`на 30 минут`, `на 1.5 часа`, `на полчаса`)
  const halfHourDur = remaining.match(/(?:^|[^\p{L}])на\s+полчаса(?=$|[^\p{L}])/iu);
  if (halfHourDur) {
    explicitDurationMin = 30;
    hasEndTime = true;
    remaining = removeSpan(remaining, halfHourDur);
  } else {
    const durMatch = remaining.match(
      /(?:^|[^\p{L}])на\s+(\d+(?:[.,]\d+)?)\s*(мин\p{L}*|час\p{L}*|[мч](?=$|[^\p{L}\d]))/iu
    );
    if (durMatch?.[1] && durMatch[2]) {
      const val = Number(durMatch[1].replace(',', '.'));
      if (Number.isFinite(val) && val > 0 && val <= 720) {
        explicitDurationMin = /^м/i.test(durMatch[2]) ? Math.round(val) : Math.round(val * 60);
        hasEndTime = true;
        remaining = removeSpan(remaining, durMatch);
      }
    }
  }

  // 4. Relative offsets (`через 2 часа`, `через 30 минут`, `через 3 дня`, `через неделю`)
  const relMatch = remaining.match(
    /(?:^|[^\p{L}])через\s+(\d+|пол(?:часа)?|одн[уо]?|пару)?\s*(минут[уы]?|мин|час(?:а|ов)?|ч(?=$|[^\p{L}])|д(?:ень|ня|ней)|недел[юи])(?=$|[^\p{L}])/iu
  );
  if (relMatch) {
    isRelativeOffset = true;
    const rawQty = (relMatch[1] || '1').toLowerCase();
    const qty = rawQty.startsWith('пол') ? 0.5 : rawQty.startsWith('пар') ? 2 : rawQty.startsWith('одн') ? 1 : Number(rawQty) || 1;
    const unit = (relMatch[2] || '').toLowerCase();
    if (unit.startsWith('мин')) {
      const target = new Date(nowMs + Math.round(qty * 60_000));
      resolvedDate = target;
      hour = target.getHours();
      minute = target.getMinutes();
      hasExplicitTime = true;
    } else if (unit.startsWith('ч')) {
      const target = new Date(nowMs + Math.round(qty * 3_600_000));
      resolvedDate = target;
      if (!hasExplicitTime) {
        hour = target.getHours();
        minute = target.getMinutes();
        hasExplicitTime = true;
      }
    } else if (unit.startsWith('д')) {
      resolvedDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.round(qty), hour, minute, 0, 0);
    } else if (unit.startsWith('нед')) {
      resolvedDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.round(qty * 7), hour, minute, 0, 0);
    }
    remaining = removeSpan(remaining, relMatch);
  }

  // 5. Named days (`сегодня`, `завтра`, `послезавтра`)
  if (!resolvedDate) {
    const namedDay = remaining.match(
      /(?:^|[^\p{L}\d])(послезавтра|завтра|сегодня)(?=$|[^\p{L}\d])/iu
    );
    if (namedDay?.[1]) {
      const tok = namedDay[1].toLowerCase();
      const addDays = tok === 'послезавтра' ? 2 : tok === 'завтра' ? 1 : 0;
      isNamedDay = true;
      resolvedDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, minute, 0, 0);
      remaining = removeSpan(remaining, namedDay);
    }
  }

  // 6. Weekdays (`Пятница 15:00`, `в среду`, `на следующей неделе в пн`, bare `пятница`)
  if (!resolvedDate) {
    for (const spec of WEEKDAY_SPECS) {
      const m = remaining.match(spec.re);
      if (!m) continue;
      let dow = spec.dow;
      if (dow === -1 && m[1]) {
        dow = SHORT_DOW[m[1].toLowerCase()] ?? -1;
      }
      if (dow >= 0) {
        const currentDow = base.getDay();
        let delta = (dow - currentDow + 7) % 7;
        const explicitNext = /следующ/iu.test(m[0]);
        if (delta === 0) {
          if (explicitNext || (hasExplicitTime && hour * 60 + minute <= base.getHours() * 60 + base.getMinutes())) {
            delta = 7;
          }
        } else if (explicitNext && delta < 7) {
          delta += 7;
        }
        resolvedDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta, hour, minute, 0, 0);
        remaining = removeSpan(remaining, m);
        break;
      }
    }
  }

  // 7. Month names (`19 ноября`, `19 нояб.`, `3 дек 2026`)
  if (!resolvedDate) {
    const monthMatch = remaining.match(
      /(?:^|[^\d])([12]?\d|3[01])\s+([а-яё]{3,10})\.?(?:\s*(20\d{2}))?(?=$|[^\p{L}\d])/iu
    );
    if (monthMatch?.[1] && monthMatch[2]) {
      const mText = monthMatch[2].toLowerCase();
      let foundMonth: number | null = SHORT_MONTH_MAP[mText] ?? null;
      if (foundMonth === null) {
        for (const ms of MONTH_STEMS) {
          if (ms.stem.test(mText)) {
            foundMonth = ms.month;
            break;
          }
        }
      }
      if (foundMonth !== null) {
        explicitDay = Number(monthMatch[1]);
        explicitMonth = foundMonth;
        explicitYear = monthMatch[3] ? Number(monthMatch[3]) : null;
        remaining = removeSpan(remaining, monthMatch);
      }
    }
  }

  // 8. Numeric dates (`21.11.2026`, `21.11`, `21/11/2026`, `2026-11-21`)
  if (!resolvedDate && explicitMonth === null) {
    const isoMatch = remaining.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
    const dmyMatch = !isoMatch
      ? remaining.match(
          /(?:^|[^\d.])(0?[1-9]|[12]\d|3[01])[./](0?[1-9]|1[0-2])(?:[./](20\d{2}|\d{2}))?(?=$|[^\d.])/
        )
      : null;
    if (isoMatch) {
      explicitYear = Number(isoMatch[1]);
      explicitMonth = Number(isoMatch[2]) - 1;
      explicitDay = Number(isoMatch[3]);
      remaining = removeSpan(remaining, isoMatch);
    } else if (dmyMatch) {
      const d = Number(dmyMatch[1]);
      const m = Number(dmyMatch[2]) - 1;
      const rawY = dmyMatch[3];
      explicitDay = d;
      explicitMonth = m;
      if (rawY) {
        explicitYear = rawY.length === 2 ? 2000 + Number(rawY) : Number(rawY);
      }
      remaining = removeSpan(remaining, dmyMatch);
    }
  }

  // 9. Extract venue/address AFTER times, durations and dates are already stripped so greedy spans never swallow time/date
  if (!location) {
    const addrMatch = remaining.match(
      /(?:^|[\s,;(])(?:по\s+адресу|адрес|место|локация|клиника|офис|каб\.?)\s*[:—-]?\s*([^\n;,]+)/iu
    );
    if (addrMatch?.[1]) {
      location = addrMatch[1].replace(/[.,]+$/, '').trim().slice(0, 100);
      remaining = removeSpan(remaining, addrMatch);
    } else {
      const streetMatch = remaining.match(
        /(?:^|[\s,])(?:на\s+(?:ул\.?\s*)?|по\s+|ул\.?\s+|пр-т\.?\s+|пр\.?\s+)([А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ]?[а-яё]+)?\s+\d+[а-яА-Я0-9/\-]*)/u
      );
      if (streetMatch?.[1]) {
        location = streetMatch[1].trim().slice(0, 100);
        remaining = removeSpan(remaining, streetMatch);
      }
    }
  }

  if (!resolvedDate && explicitMonth !== null && explicitDay !== null) {
    let yr = explicitYear ?? base.getFullYear();
    const candidate = new Date(yr, explicitMonth, explicitDay, hour, minute, 0, 0);
    if (!explicitYear && candidate.getTime() < nowMs - 2 * 86_400_000) {
      yr += 1;
    }
    resolvedDate = new Date(yr, explicitMonth, explicitDay, hour, minute, 0, 0);
  }

  // Fallback to selected calendar day when explicitly supplied (e.g. Calendar quick bar)
  if (!resolvedDate && fallbackDayMs !== undefined) {
    const fb = new Date(fallbackDayMs);
    resolvedDate = new Date(fb.getFullYear(), fb.getMonth(), fb.getDate(), hour, minute, 0, 0);
  }

  if (!resolvedDate) return null;

  const allDay = !hasExplicitTime && !isRelativeOffset && fallbackDayMs === undefined;
  const startDate = allDay
    ? new Date(resolvedDate.getFullYear(), resolvedDate.getMonth(), resolvedDate.getDate(), 0, 0, 0, 0)
    : resolvedDate;
  const startAt = startDate.getTime();

  let durationMin = explicitDurationMin ?? 60;
  let endAt: number;
  if (allDay) {
    durationMin = 1440;
    endAt = startAt + 86_400_000 - 1000;
  } else if (hasEndTime && endHour !== null && endMinute !== null) {
    const endDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate(),
      endHour,
      endMinute,
      0,
      0
    );
    if (endDate.getTime() <= startAt) {
      endDate.setDate(endDate.getDate() + 1);
    }
    endAt = endDate.getTime();
    durationMin = Math.max(15, Math.round((endAt - startAt) / 60_000));
  } else if (explicitDurationMin) {
    endAt = startAt + explicitDurationMin * 60_000;
  } else {
    durationMin = SHORT_DURATION_CUE_RE.test(input) ? 30 : 60;
    endAt = startAt + durationMin * 60_000;
  }

  const title = cleanExtractedTitle(remaining) || 'Событие';
  const hasActionCue = ACTION_EVENT_CUE_RE.test(input);
  const looksLikeNewsOrArticle =
    input.length > 420 ||
    /(?:опубликовано|подписаться|читать далее|выш(?:ел|ла|ли)|выпустил\p{L}*|анонсировал\p{L}*|состоял(?:ся|ась|ось)|http\S+.*\n.*http)/iu.test(
      input
    );
  const isEventIntent =
    !looksLikeNewsOrArticle &&
    (isRelativeOffset ||
      fallbackDayMs !== undefined ||
      (input.length <= 240 && (isNamedDay || hasExplicitTime || hasActionCue)));

  const datePart = startDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const timePart = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
  const label = allDay ? `${datePart} (весь день)` : `${datePart}, ${timePart}`;

  return {
    title,
    startAt,
    endAt,
    allDay,
    hasEndTime,
    durationMin,
    location,
    notes: input.length > title.length + 12 ? input : '',
    label,
    isEventIntent,
  };
}
