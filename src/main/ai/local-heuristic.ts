import {
  cleanBrokenTextArtifacts,
  cleanInstagramText,
  decodeHtmlEntities,
  truncateAtWordBoundary,
} from '@shared/html-entities';
import type {
  AppLocale,
  AskVaultCitation,
  AskVaultResult,
  ContentDna,
  ItemSubKind,
  MediaMeta,
  OrbitDef,
  VaultInventorySummary,
  VaultItem,
} from '@shared/types';
import { getOrganicSectionCatalog } from '@shared/constants';
import { pluralize } from '@shared/i18n/core';

const GENERIC_IMAGE_TITLE_RE =
  /^(?:image|screenshot|screen[\s_-]?shot|clipboard|untitled|photo|picture|img[_-]?\d*|снимок(?:\s+экрана)?|скриншот|изображение|картинка)(?:\s*\(\d+\))?$/i;

export function isGenericImageTitle(raw?: string | null): boolean {
  const t = (raw ?? '').trim();
  return !t || GENERIC_IMAGE_TITLE_RE.test(t);
}

export interface LocalClassification {
  dna: ContentDna;
  subKind: ItemSubKind;
  orbit: string;
  suggestedNewSection: string | null;
  mediaMetaPatch?: Partial<MediaMeta>;
  title: string;
  summary: string;
  url: string | null;
  domain: string | null;
  platform: string | null;
  tags: string[];
  needsEnrichment: boolean;
  isFleetingScratch: boolean;
}

const DOMAIN_TOPIC_RULES: Array<{ match: RegExp; sectionName: string; platform?: string; tags: string[] }> = [
  { match: /(?:^|\.)instagram\.com$/i, sectionName: 'Дизайн', platform: 'instagram', tags: ['instagram'] },
  { match: /(?:^|\.)(?:t\.me|telegram\.me)$/i, sectionName: 'Чтение', platform: 'telegram', tags: ['telegram'] },
  { match: /(?:^|\.)(?:youtube\.com|youtu\.be)$/i, sectionName: 'Чтение', platform: 'youtube', tags: ['видео'] },
  {
    match: /(?:^|\.)(?:github\.com|gitlab\.com|npmjs\.com|stackoverflow\.com|vercel\.com|react\.dev|nodejs\.org|electronjs\.org)$/i,
    sectionName: 'Код',
    platform: 'github',
    tags: ['разработка', 'код'],
  },
  {
    match: /(?:^|\.)(?:figma\.com|dribbble\.com|behance\.net|pinterest\.com|svgartista\.net|coolors\.co)$/i,
    sectionName: 'Дизайн',
    platform: 'web',
    tags: ['дизайн'],
  },
  { match: /(?:^|\.)(?:x\.com|twitter\.com)$/i, sectionName: 'Чтение', platform: 'x', tags: ['пост'] },
  {
    match: /(?:^|\.)(?:ozon\.ru|wildberries\.ru|market\.yandex\.ru|aliexpress\.|avito\.ru|dns-shop\.ru|amazon\.)/i,
    sectionName: 'Покупки',
    platform: 'web',
    tags: ['покупки'],
  },
  {
    match: /(?:^|\.)(?:tbank\.ru|tinkoff\.ru|sberbank\.ru|nalog\.gov\.ru|gosuslugi\.ru|stripe\.com|wise\.com)/i,
    sectionName: 'Финансы',
    platform: 'web',
    tags: ['финансы'],
  },
  {
    match: /(?:^|\.)(?:booking\.com|aviasales\.ru|airbnb\.|skyscanner\.)/i,
    sectionName: 'Поездки',
    platform: 'web',
    tags: ['поездки'],
  },
  {
    match: /(?:^|\.)(?:habr\.com|vc\.ru|medium\.com|substack\.com|arxiv\.org|wikipedia\.org)/i,
    sectionName: 'Чтение',
    platform: 'web',
    tags: ['статья'],
  },
];

const CODE_SNIPPET_SIGNALS = [
  /(?:^|\n)\s*(?:import|export|const|let|var|function|class|async\s+function|def|SELECT|CREATE TABLE|npm\s+|pnpm\s+|yarn\s+|git\s+|curl\s+|uv\s+|docker\s+|npx\s+)\b/m,
  /```[\s\S]*```/,
  /^\s*[{[][\s\S]{12,}[}\]]\s*$/,
];

export function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;!?]+$/, '');
}

export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function detectPlatform(domain: string | null): string | null {
  if (!domain) return null;
  if (domain.includes('instagram.com')) return 'instagram';
  if (domain === 't.me' || domain === 'telegram.me') return 'telegram';
  if (domain.includes('youtube.com') || domain === 'youtu.be') return 'youtube';
  if (domain.includes('github.com')) return 'github';
  if (domain === 'x.com' || domain === 'twitter.com') return 'x';
  return 'web';
}

export function matchExistingOrbitForTopic(orbits: OrbitDef[] | undefined, sectionName: string | null): OrbitDef | null {
  if (!orbits || orbits.length === 0 || !sectionName) return null;
  const q = sectionName.trim().toLowerCase();
  const template = [...getOrganicSectionCatalog('ru'), ...getOrganicSectionCatalog('en')].find(
    (t) =>
      t.canonicalName.toLowerCase() === q ||
      t.aliases.some((a) => a.toLowerCase() === q)
  );
  const aliases = template ? [template.canonicalName.toLowerCase(), ...template.aliases] : [q];

  return (
    orbits.find((o) => {
      const idLow = o.id.toLowerCase();
      const nameLow = o.name.toLowerCase();
      return (
        nameLow === q ||
        idLow === q ||
        aliases.some((alias) => nameLow.includes(alias) || idLow.includes(alias))
      );
    }) ?? null
  );
}

export function detectContactInfo(
  rawText: string,
  explicitTitle?: string | null,
  locale: AppLocale = 'ru'
): {
  isContact: boolean;
  title: string;
  contactPhone?: string;
  contactHandle?: string;
  contactEmail?: string;
  contactRole?: string;
} {
  const text = rawText.trim();
  if (!text || text.length > 420) return { isContact: false, title: '' };

  const phoneMatch = text.match(/(?<!\d)(?:\+7|8|\+1|\+44|\+49|\+\d{1,3})[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/);
  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const cleanedForHandle = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ');
  const handleMatch = cleanedForHandle.match(/(?:^|\s)(@[a-zA-Z0-9_]{4,32})\b/);

  const hasPhone = Boolean(phoneMatch?.[0]);
  const hasHandle = Boolean(handleMatch?.[1]) && text.split(/\r?\n/).length <= 5;
  const hasEmail = Boolean(emailMatch?.[0]) && text.split(/\r?\n/).length <= 5 && text.length < 180;
  const urlCount = (text.match(/https?:\/\//gi) || []).length;

  if (urlCount > 0 && !hasPhone) return { isContact: false, title: '' };
  if (!hasPhone && !(hasHandle && (hasEmail || text.length <= 120)) && !(hasEmail && /контакт|почта|менеджер|врач|мастер|директор|hr|support/i.test(text))) {
    return { isContact: false, title: '' };
  }

  let remainder = text;
  if (phoneMatch?.[0]) remainder = remainder.replace(phoneMatch[0], ' ');
  if (emailMatch?.[0]) remainder = remainder.replace(emailMatch[0], ' ');
  if (handleMatch?.[1]) remainder = remainder.replace(handleMatch[1], ' ');
  const parenRoleMatch = remainder.match(/\(([^()]{2,48})\)/);
  if (parenRoleMatch?.[0]) {
    remainder = remainder.replace(parenRoleMatch[0], ' ');
  }
  remainder = remainder
    .replace(/^(?:тел(?:ефон)?|номер|контакт|tg|телеграм|telegram|email|почта)\s*[:\-—]?\s*/gim, ' ')
    .replace(/[()[\],;:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = remainder.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  const namePart =
    explicitTitle?.trim() ||
    parts[0] ||
    handleMatch?.[1] ||
    phoneMatch?.[0] ||
    emailMatch?.[0] ||
    (locale === 'en' ? 'Contact' : 'Контакт');
  const rolePart = parenRoleMatch?.[1]?.trim() || (parts.length > 1 ? parts.slice(1).join(', ') : undefined);

  return {
    isContact: true,
    title: namePart.slice(0, 62),
    contactPhone: phoneMatch?.[0]?.trim(),
    contactHandle: handleMatch?.[1]?.trim(),
    contactEmail: emailMatch?.[0]?.trim(),
    contactRole: rolePart?.slice(0, 64),
  };
}

export function isFleetingScratchNote(params: {
  text: string;
  hasImage: boolean;
  primaryUrl: string | null;
  isContact: boolean;
  isCode: boolean;
}): boolean {
  if (params.hasImage || params.primaryUrl || params.isContact || params.isCode) return false;
  const trimmed = params.text.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\n')) return false;
  if (trimmed.length > 34) return false;

  const lower = trimmed.toLowerCase();
  const strongIntent =
    /(оплат|чек|счет|счёт|инвойс|купить|заказ|подарок|билет|бронь|напом|позвон|встреч|дедлайн|иде[яюй]|парол|секрет|ключ|токен|договор|справк|pdf|api|react|electron|sqlite|docker|typescript|python|git|npm|figma|дизайн|палитр|шрифт|код|скрипт|книг|стать|курс|лекц|гайд)/i;
  if (strongIntent.test(lower)) return false;

  // Pure short digit runs (e.g. "123123", "42"), keyboard mashing ("фывфыв", "asdfgh"), casual greetings ("Привет", "тест", "ок")
  if (/^[\d\s-]{1,18}$/.test(trimmed) && trimmed.replace(/\D/g, '').length <= 12) return true;
  if (
    /^(?:привет|хай|здравствуй|салют|тест|проверка|черновик|test|check|ok|ок|ага|угу|хз|лол|кек|lol|kek|фыв+|йцу+|qwerty|asdf+|zxcv+|qaz+)[\s!?.,0-9]*$/i.test(
      lower
    )
  ) {
    return true;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && trimmed.length <= 18 && !/[0-9]{4,}/.test(trimmed)) {
    // Two short random/greeting words without numbers/URLs/tasks stay unsorted
    return true;
  }

  return false;
}

const GENERIC_OCR_BUTTON_RE =
  /^(?:войти|вход|регистрация|отмена|сохранить|далее|назад|закрыть|поиск|меню|настройки|ок|ok|cancel|save|next|back|close|search|menu|login|sign\s+in|settings|submit)$/i;

export function pickCleanScreenshotTitle(
  ocrText: string,
  userCaption: string,
  suggestedSection: string | null,
  explicitTitle?: string | null,
  locale: AppLocale = 'ru'
): string {
  if (explicitTitle?.trim() && !isGenericImageTitle(explicitTitle)) return truncateAtWordBoundary(explicitTitle.trim(), 96);
  if (userCaption.trim()) {
    const clean = userCaption.replace(/https?:\/\/\S+/gi, '').trim();
    if (clean.length >= 3) return truncateAtWordBoundary(clean, 96);
  }
  const lines = ocrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && l.length <= 68)
    // Filter common noisy OS/toolbar/time/status chrome
    .filter((l) => {
      const cleaned = l.trim();
      if (cleaned.length < 4) return false;
      if (GENERIC_OCR_BUTTON_RE.test(cleaned)) return false;
      if (/^(?:\d{1,2}[:.]\d{2}|chrome|safari|firefox|edge|localhost(?::\d+)?|\d+%|https?:\/\/\S*)$/i.test(cleaned)) {
        return false;
      }
      // Reject composite OS/editor/browser chrome lines ("14:32 File Edit View Chrome localhost:3000")
      if (
        /(?:\bfile\s+edit\b|\bedit\s+view\b|\bview\s+(?:go|run|help)\b)/i.test(cleaned) ||
        (/^\d{1,2}[:.]\d{2}\s+/.test(cleaned) && /(?:chrome|edge|localhost|http|file|edit|view|\d+%)/i.test(cleaned)) ||
        (/\bchrome\b/i.test(cleaned) && /\blocalhost\b/i.test(cleaned))
      ) {
        return false;
      }
      return true;
    })
    .filter((l) => /[\p{L}]{3,}/u.test(l));

  const headingCandidate = lines.find((l) => /^[\p{L}\d\s.,:—–!?/()-]{4,56}$/u.test(l));
  const isEn = locale === 'en';
  if (suggestedSection === 'Финансы' || suggestedSection === 'Finance') {
    return headingCandidate
      ? `${isEn ? 'Receipt' : 'Чек'} · ${truncateAtWordBoundary(headingCandidate, 48)}`
      : isEn
        ? 'Receipt / Invoice'
        : 'Чек / квитанция';
  }
  if (suggestedSection === 'Дизайн' || suggestedSection === 'Design') {
    return headingCandidate
      ? truncateAtWordBoundary(headingCandidate, 56)
      : isEn
        ? 'UI Reference'
        : 'Референс экрана';
  }
  if (headingCandidate) {
    return truncateAtWordBoundary(headingCandidate, 56);
  }
  return isEn ? 'Screenshot' : 'Скриншот';
}

export function classifyLocally(params: {
  text?: string;
  url?: string | null;
  title?: string | null;
  ocrText?: string;
  hasImage?: boolean;
  orbits?: OrbitDef[];
  extraTags?: string[];
  subKindHint?: ItemSubKind;
  preferLinkForUrlWithImage?: boolean;
  locale?: AppLocale;
}): LocalClassification {
  const locale: AppLocale = params.locale === 'en' ? 'en' : 'ru';
  const rawText = (params.text ?? '').trim();
  const primaryUrl = params.url || extractFirstUrl(rawText);
  const domain = extractDomain(primaryUrl);
  let platform = detectPlatform(domain);

  const isCode = !params.hasImage && CODE_SNIPPET_SIGNALS.some((re) => re.test(rawText));
  const contact = !params.hasImage
    ? detectContactInfo(rawText, params.title, locale)
    : { isContact: false, title: '' };
  const isChecklist =
    !params.hasImage &&
    !isCode &&
    rawText.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/.test(l)).length >= 2;

  const isScratch = isFleetingScratchNote({
    text: rawText,
    hasImage: Boolean(params.hasImage),
    primaryUrl,
    isContact: contact.isContact,
    isCode,
  });

  let dna: ContentDna = 'note';
  if (
    params.hasImage &&
    params.subKindHint !== 'post' &&
    !(params.preferLinkForUrlWithImage && primaryUrl)
  ) {
    dna = 'shot';
  } else if (primaryUrl && rawText.replace(primaryUrl, '').trim().length < 220 && !isCode) {
    dna = 'link';
  } else if (isCode) {
    dna = 'snippet';
  }

  const subKind: ItemSubKind = params.subKindHint ?? (contact.isContact ? 'contact' : isChecklist ? 'checklist' : null);

  let suggestedSection: string | null = null;
  const tags: string[] = [...(params.extraTags ?? [])];

  const isEn = locale === 'en';
  const localizeSection = (ruName: string): string => {
    if (!isEn) return ruName;
    const map: Record<string, string> = {
      'Финансы': 'Finance',
      'Контакты': 'Contacts',
      'Доступы': 'Credentials',
      'Код': 'Code',
      'Дизайн': 'Design',
      'Встречи': 'Meetings',
      'Документы': 'Documents',
      'Покупки': 'Shopping',
      'Поездки': 'Travel',
      'Чтение': 'Reading',
      'Работа': 'Work',
      'Учёба': 'Study',
      'Идеи': 'Ideas',
      'Здоровье': 'Health',
      'Игры': 'Games',
    };
    return map[ruName] ?? ruName;
  };
  const localizeTag = (ruTag: string): string => {
    if (!isEn) return ruTag;
    const map: Record<string, string> = {
      'контакт': 'contact',
      'финансы': 'finance',
      'покупки': 'shopping',
      'поездки': 'travel',
      'код': 'code',
      'разработка': 'dev',
      'чтение': 'reading',
      'статья': 'article',
      'дизайн': 'design',
      'документы': 'documents',
      'видео': 'video',
      'пост': 'post',
      'скриншот': 'screenshot',
    };
    return map[ruTag] ?? ruTag;
  };

  if (!isScratch) {
    if (contact.isContact) {
      suggestedSection = localizeSection('Контакты');
      tags.push(localizeTag('контакт'));
    } else {
      if (domain) {
        for (const rule of DOMAIN_TOPIC_RULES) {
          if (rule.match.test(domain)) {
            suggestedSection = suggestedSection ?? localizeSection(rule.sectionName);
            if (rule.platform) platform = rule.platform;
            tags.push(...rule.tags.map(localizeTag));
            break;
          }
        }
        if (!suggestedSection && dna === 'link') {
          suggestedSection = localizeSection('Чтение');
        }
      }

      const isSocialOrNewsFeed =
        ['telegram', 'x', 'instagram', 'youtube'].includes(platform || '') ||
        /(?:^|\.)(?:t\.me|telegram\.me|x\.com|twitter\.com|instagram\.com|youtube\.com|youtu\.be|vc\.ru|habr\.com)$/i.test(
          domain || ''
        );
      const combinedLower = `${rawText}\n${params.ocrText ?? ''}\n${params.title ?? ''}`.toLowerCase();
      const hasBankingCardContext =
        /(?:банковск\p{L}*\s+карт|номер\s+карт|выписк\p{L}*\s+по\s+карт|карт\p{L}*\s+(?:мир|visa|mastercard|сбер\p{L}*|т-банк\p{L}*|тинькофф|альфа|втб)|(?:\d{4}[\s-]*){3}\d{4})/iu.test(
          combinedLower
        );
      const hasUnambiguousFinance =
        hasBankingCardContext ||
        /(?:(?:^|[^\p{L}])(?:чек(?!\s*[-\s]?\s*(?:лист|бокс|поинт|ап))|оплата|оплатить|инвойс|налог\p{L}*|промокод\p{L}*|скидк\p{L}*|банк(?:а|е|ом|ов\p{L}*)?|кэшбэк\p{L}*|invoice|receipt|promo)(?=$|[^\p{L}])|(?:банковск\p{L}*\s+перевод\p{L}*|перевод\s+(?:на\s+карт\p{L}*|по\s+сбп|денег|средств)|денежн\p{L}*\s+перевод\p{L}*)|(?<!(?:за|на|в)\s)(?:^|[^\p{L}])(?:счет|счёт)(?!\s+(?:завтрашн|сегодняшн|этого|той|встреч))(?=$|[^\p{L}])|order\s*#)/iu.test(
          combinedLower
        );
      if (!isSocialOrNewsFeed && hasUnambiguousFinance) {
        suggestedSection = localizeSection('Финансы');
        tags.push(localizeTag('финансы'));
      } else if (
        !isSocialOrNewsFeed &&
        (/(купить|заказать|подарок|кроссовки|доставка|маркет|цена|₽|wishlist)/i.test(combinedLower) ||
          /(?:^|[^\p{L}])руб(?:л[еяьй])?(?=$|[^\p{L}])/u.test(combinedLower))
      ) {
        suggestedSection = localizeSection('Покупки');
        tags.push(localizeTag('покупки'));
      } else if (
        !isSocialOrNewsFeed &&
        /(билет|рейс|отель|бронь|аэропорт|вылет|маршрут|отпуск|flight|hotel|booking|itinerary|boarding\s+pass)/i.test(combinedLower)
      ) {
        suggestedSection = localizeSection('Поездки');
        tags.push(localizeTag('поездки'));
      } else if (
        isCode ||
        /(?:^|[^\p{L}])(?:api|endpoint|docker|react|electron|sqlite|typescript|python|deploy|sql|npm|git)(?=$|[^\p{L}])/iu.test(combinedLower)
      ) {
        suggestedSection = localizeSection('Код');
        tags.push(localizeTag('код'));
      } else if (/(гайд|туториал|книга|исследование|конспект|курс|лекция|статья|подкаст|tutorial|guide|article|essay|podcast)/i.test(combinedLower)) {
        suggestedSection = localizeSection('Чтение');
        tags.push(localizeTag('чтение'));
      } else if (
        /(дизайн|референс|палитра|шрифт|анимация|макет|figma|palette|typography|moodboard)/i.test(combinedLower) ||
        /(?:^|[^\p{L}])(?:ui|ux)(?=$|[^\p{L}])/iu.test(combinedLower)
      ) {
        suggestedSection = localizeSection('Дизайн');
        tags.push(localizeTag('дизайн'));
      } else if (
        !isSocialOrNewsFeed &&
        (/(договор|документ|паспорт|доверенность|contract|agreement|passport)/i.test(combinedLower) ||
          /(?:^|[^\p{L}])(?:справка|акт|pdf)(?=$|[^\p{L}])/iu.test(combinedLower))
      ) {
        suggestedSection = localizeSection('Документы');
        tags.push(localizeTag('документы'));
      }
    }
  }

  // Match against existing sections first; never assign to non-existent legacy IDs
  const matchedOrbit = matchExistingOrbitForTopic(params.orbits, suggestedSection);
  const orbit = matchedOrbit ? matchedOrbit.id : '';
  const suggestedNewSection = !isScratch && !matchedOrbit ? suggestedSection : null;

  const shotTag = localizeTag('скриншот');
  if (params.hasImage && dna === 'shot' && !tags.includes(shotTag)) {
    tags.push(shotTag);
  }

  // Readable title without dumping noisy OCR lines or duplicating short bodies
  let title = (params.title ?? '').trim();
  if (isGenericImageTitle(title) && (params.hasImage || !title)) {
    title = '';
  }
  if (!title) {
    if (contact.isContact) {
      title = contact.title;
    } else if (params.hasImage && dna === 'shot') {
      title = pickCleanScreenshotTitle(params.ocrText ?? '', rawText, suggestedSection, params.title, locale);
    } else if (primaryUrl && domain) {
      const cleanNote = rawText.replace(primaryUrl, '').trim();
      title = cleanNote ? truncateAtWordBoundary(cleanNote, 96) : domain;
    } else {
      const firstLine = rawText
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^(?:[-*•]\s*(?:\[[ xX]\]\s*)?|#+\s*)/, '').trim())
        .find((l) => l.length > 0);
      title = firstLine ? truncateAtWordBoundary(firstLine, 96) : isEn ? 'Quick Note' : 'Быстрая заметка';
    }
  }

  // Never duplicate short/medium body inside summary; reserve local summary for genuine condensation (>320 chars)
  const cleanRaw = rawText.replace(/\s+/g, ' ').trim();
  const summary =
    !isScratch && !contact.isContact && !(params.hasImage && dna === 'shot') && cleanRaw.length > 320
      ? truncateAtWordBoundary(cleanRaw, 148)
      : '';

  const needsEnrichment =
    !isScratch &&
    !contact.isContact &&
    (cleanRaw.length > 110 || (params.hasImage === true && (params.ocrText ?? '').length > 40));

  return {
    dna,
    subKind,
    orbit,
    suggestedNewSection,
    mediaMetaPatch: contact.isContact
      ? {
          contactPhone: contact.contactPhone,
          contactHandle: contact.contactHandle,
          contactEmail: contact.contactEmail,
          contactRole: contact.contactRole,
        }
      : undefined,
    title,
    summary,
    url: primaryUrl,
    domain,
    platform,
    tags: [...new Set(tags)].slice(0, 4),
    needsEnrichment,
    isFleetingScratch: isScratch,
  };
}

export const LOCKED_SECRET_QUERY_RE =
  /(?:карт\w*|виз[аеуы]|visa|mastercard|мир\b|банк\w*|cvv|cvc|сейф\w*|парол\w*|ключ\w*|токен\w*|секрет\w*|доступ\w*|пин\w*|pin|логин\w*|аккаунт\w*|учетк\w*|учётк\w*|сид\w*|seed|мнемоник\w*|реквизит\w*|кошел[её]к\w*|кошельк\w*|финанс\w*|сбер\w*|тинькофф|т-банк|альфа[-\s]?банк|втб\b|счет\w*|счёт\w*)/i;

export function answerVaultLocally(
  question: string,
  candidates: VaultItem[],
  inventory?: VaultInventorySummary,
  vaultLocked = false,
  locale: AppLocale = 'ru'
): AskVaultResult {
  const isEn = locale === 'en';
  const dateLocale = isEn ? 'en-US' : 'ru-RU';
  const qLower = question.toLowerCase();
  const safeItems = candidates.filter((c) => c.dna !== 'secret');

  if (vaultLocked && LOCKED_SECRET_QUERY_RE.test(qLower)) {
    return {
      answer: isEn
        ? 'Vault is currently locked with your master PIN. Unlock Vault so I can safely check your saved cards and logins.'
        : 'Сейф сейчас закрыт мастер-кодом. Разблокируй хранилище, чтобы я мог безопасно ответить по сохранённым картам и доступам.',
      citations: [],
      usedProvider: 'local',
      costUsd: 0,
    };
  }

  if (
    /(?:напоминан|просроч|дедлайн|когд[а\s]+напомн|запланир|на\s+сегодня|remind|overdue|deadline|due\b|schedule|today)/i.test(
      qLower
    )
  ) {
    const dueList = inventory?.dueReminders ?? [];
    const upcomingFromCandidates = safeItems
      .filter((item) => typeof item.remindAt === 'number' && item.remindAt > 0)
      .sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0));

    const combined =
      dueList.length > 0
        ? dueList
        : upcomingFromCandidates.slice(0, 6).map((item) => ({
            id: item.id,
            title: item.title,
            dna: item.dna,
            orbit: item.orbit,
            remindAt: item.remindAt!,
          }));

    if (combined.length === 0) {
      return {
        answer: isEn
          ? 'No active or scheduled reminders found among open items yet.'
          : 'Активных или запланированных напоминаний среди открытых записей пока нет.',
        citations: [],
        usedProvider: 'local',
        costUsd: 0,
      };
    }

    const now = Date.now();
    const lines = combined.slice(0, 6).map((r, idx) => {
      const when = new Date(r.remindAt).toLocaleString(dateLocale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const state = r.remindAt <= now ? (isEn ? 'due' : 'пора') : isEn ? 'scheduled' : 'запланировано';
      return isEn
        ? `${idx + 1}. "${r.title}" — ${when} (${state})`
        : `${idx + 1}. «${r.title}» — ${when} (${state})`;
    });
    const reminderCount =
      inventory?.dueReminderCount && dueList.length > 0 ? inventory.dueReminderCount : combined.length;
    return {
      answer: isEn
        ? `Found ${reminderCount} ${pluralize('en', reminderCount, { ru: ['запись', 'записи', 'записей'], en: ['reminder', 'reminders'] })}:\n\n${lines.join('\n')}`
        : `Напоминаний найдено ${reminderCount}:\n\n${lines.join('\n')}`,
      citations: combined.slice(0, 4).map((r) => ({
        id: r.id,
        title: r.title,
        dna: r.dna,
        orbit: r.orbit,
      })),
      usedProvider: 'local',
      costUsd: 0,
    };
  }

  if (
    inventory?.byOrbit &&
    /(?:в\s+раздел|разделы|по\s+разделам|папк|section|folder)/i.test(qLower)
  ) {
    const matchedSection = inventory.byOrbit.find((sec) =>
      qLower.includes(sec.name.toLowerCase())
    );
    if (matchedSection) {
      const inSection = safeItems.filter(
        (i) =>
          i.orbit === matchedSection.id ||
          i.orbit.toLowerCase() === matchedSection.name.toLowerCase()
      );
      const list = inSection
        .slice(0, 5)
        .map((i, idx) => (isEn ? `${idx + 1}. "${i.title}"` : `${idx + 1}. «${i.title}»`))
        .join('\n');
      const countWord = pluralize(locale, matchedSection.count, {
        ru: ['запись', 'записи', 'записей'],
        en: ['item', 'items'],
      });
      return {
        answer:
          inSection.length > 0
            ? isEn
              ? `Section "${matchedSection.name}" has ${matchedSection.count} ${countWord}. Closest open items:\n\n${list}`
              : `В разделе «${matchedSection.name}» всего ${matchedSection.count} ${countWord}. Вот ближайшие открытые:\n\n${list}`
            : matchedSection.count > 0
              ? isEn
                ? `Section "${matchedSection.name}" has ${matchedSection.count} ${countWord}. None are open (outside Vault) in this sample.`
                : `В разделе «${matchedSection.name}» всего записей: ${matchedSection.count}. Открытых (не в Сейфе) в текущей выборке нет.`
              : isEn
                ? `Section "${matchedSection.name}" has no items yet.`
                : `В разделе «${matchedSection.name}» пока нет записей.`,
        citations: inSection.slice(0, 4).map((i) => ({
          id: i.id,
          title: i.title,
          dna: i.dna,
          orbit: i.orbit,
        })),
        usedProvider: 'local',
        costUsd: 0,
      };
    }
    if (inventory.byOrbit.length > 0) {
      const secSummary = inventory.byOrbit
        .slice(0, 8)
        .map((s) => `• ${s.name}: ${s.count}`)
        .join('\n');
      return {
        answer: isEn
          ? `Sections in your workspace:\n\n${secSummary}`
          : `Разделы в хранилище:\n\n${secSummary}`,
        citations: [],
        usedProvider: 'local',
        costUsd: 0,
      };
    }
  }

  // Direct accurate answer for bank cards, secrets, or vault statistics questions
  if (
    inventory &&
    /(?:карт|виза|visa|mastercard|мир\b|банк|финанс|сколько.*сохранен|сколько.*запис|что в сейф|парол|ключ|статистик|сводк|напомин|card|bank|how\s+many|total|vault|password|secret|key|stats|summary)/i.test(
      qLower
    )
  ) {
    if (/(?:карт|visa|mastercard|мир\b|банковск|card|bank)/i.test(qLower)) {
      if (inventory.bankCardCount === 0) {
        return {
          answer: isEn
            ? 'No bank cards saved in your Vault yet. Add one via "Add to Vault" or paste card details into Quick Capture.'
            : 'В твоём Сейфе сейчас нет сохранённых банковских карт. Можешь добавить карту кнопкой «Секрет» сверху или просто вставить её данные в строку сохранения.',
          citations: [],
          usedProvider: 'local',
          costUsd: 0,
        };
      }
      const listLines = inventory.bankCards.map((c, idx) => {
        const brandLabel = c.brand && c.brand !== 'Card' ? c.brand : isEn ? 'Card' : 'Карта';
        const baseTitle = (c.title || brandLabel).trim();
        const alreadyHasLast4 = Boolean(c.last4 && baseTitle.includes(c.last4));
        const mask = c.last4 && !alreadyHasLast4 ? ` •••• ${c.last4}` : '';
        return `${idx + 1}. ${baseTitle}${mask}`;
      });
      const cardAnswer = isEn
        ? `Saved bank cards: ${inventory.bankCardCount}.\n\n${listLines.join('\n')}\n\nFull card numbers and CVV remain hidden in Vault until revealed.`
        : `У тебя сохранено банковских карт: ${inventory.bankCardCount}.\n\n${listLines.join('\n')}\n\nПолный номер и CVV скрыты в Сейфе и открываются только после подтверждения.`;
      const cardCitations: AskVaultCitation[] = inventory.bankCards.slice(0, 4).map((c) => ({
        id: c.id,
        title: c.title,
        dna: 'secret',
        orbit: c.orbit,
      }));

      const stopWords =
        /^(?:какие|какой|какая|есть|меня|базе|сейфе|карты|карт|виза|visa|мир|банковские|банковских|заметки|заметок|записи|записей|ссылки|ссылок|покажи|найди|найти|где|что|про|по|на|в|и|или|у|what|which|show|find|cards|card|notes|note|and|or|in|my|for)$/;
      const topicStems = qLower
        .replace(/[^a-zа-яё0-9\s-]/gi, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3 && !stopWords.test(w))
        .map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w));

      const asksGeneralNotes = /(?:заметк|запис|ссылк|скрин|иде[йяю]|документ|note|link|doc)/i.test(qLower);
      const matchingNotes =
        topicStems.length > 0
          ? safeItems.filter((item) => {
              const hay = `${item.title}\n${item.summary}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase();
              return topicStems.some((st) => hay.includes(st));
            })
          : asksGeneralNotes
            ? safeItems
            : [];

      if (matchingNotes.length > 0) {
        const extraTop = matchingNotes.slice(0, 4);
        const noteLines = extraTop.map((n, idx) => `${idx + 1}. **${decodeHtmlEntities(n.title)}**`);
        const extraCits: AskVaultCitation[] = extraTop.map((n) => ({
          id: n.id,
          title: decodeHtmlEntities(n.title),
          dna: n.dna,
          orbit: n.orbit,
          summary: truncateAtWordBoundary(decodeHtmlEntities(n.summary || n.body || ''), 120),
          domain: n.domain,
          url: n.url,
          thumbPath: n.thumbPath,
          imagePath: n.imagePath,
        }));
        return {
          answer: isEn
            ? `${cardAnswer}\n\nMatching notes (${matchingNotes.length}):\n\n${noteLines.join('\n')}`
            : `${cardAnswer}\n\nПо найденным записям (${matchingNotes.length}):\n\n${noteLines.join('\n')}`,
          citations: [...cardCitations.slice(0, 2), ...extraCits.slice(0, 3)],
          usedProvider: 'local',
          costUsd: 0,
        };
      }

      return {
        answer: cardAnswer,
        citations: cardCitations,
        usedProvider: 'local',
        costUsd: 0,
      };
    }

    if (/(?:парол|ключ|токен|сейф|доступ|секрет|password|key|token|vault|secret)/i.test(qLower)) {
      const totalSecrets = inventory.byDna.secret ?? 0;
      if (totalSecrets === 0) {
        return {
          answer: isEn
            ? 'Your Vault is empty — no bank cards, passwords, or keys have been saved yet.'
            : 'В Сейфе пока пусто — ни одной карты, пароля или ключа ещё не добавлено.',
          citations: [],
          usedProvider: 'local',
          costUsd: 0,
        };
      }
      const services = inventory.secretServices
        .slice(0, 8)
        .map((s, idx) => `${idx + 1}. ${s.title}`)
        .join('\n');
      const totalWord = pluralize(locale, totalSecrets, {
        ru: ['запись', 'записи', 'записей'],
        en: ['item', 'items'],
      });
      return {
        answer: isEn
          ? `Your Vault stores ${totalSecrets} ${totalWord} (cards: ${inventory.bankCardCount}, passwords: ${inventory.passwordCount}, keys: ${inventory.apiKeyCount}).\n\n${services}`
          : `Всего в Сейфе хранится ${totalSecrets} ${totalWord} (карт: ${inventory.bankCardCount}, паролей: ${inventory.passwordCount}, ключей: ${inventory.apiKeyCount}).\n\n${services}`,
        citations: inventory.secretServices.slice(0, 4).map((s) => ({
          id: s.id,
          title: s.title,
          dna: 'secret',
          orbit: s.orbit,
        })),
        usedProvider: 'local',
        costUsd: 0,
      };
    }

    if (/(?:сколько|всего|статистик|сводк|how\s+many|total|stats|summary)/i.test(qLower)) {
      const orbitSummary =
        inventory.byOrbit.length > 0
          ? inventory.byOrbit.map((o) => `${o.name}: ${o.count}`).join(', ')
          : isEn
            ? 'no custom sections yet'
            : 'пока без отдельных разделов';
      const secretSummary = vaultLocked
        ? isEn
          ? '; Vault is locked'
          : '; Сейф закрыт мастер-кодом'
        : isEn
          ? `, in Vault: ${inventory.byDna.secret ?? 0}`
          : `, в Сейфе: ${inventory.byDna.secret ?? 0}`;
      const totalWord = pluralize(locale, inventory.totalItems, {
        ru: ['запись', 'записи', 'записей'],
        en: ['item', 'items'],
      });
      return {
        answer: isEn
          ? `Your Kapsula currently has ${inventory.totalItems} ${totalWord} (${inventory.unassignedCount} unsorted${secretSummary}, ${inventory.dueReminderCount} reminders due).\n\nBy section: ${orbitSummary}.`
          : `Сейчас в твоей Капсуле ${inventory.totalItems} ${totalWord} (из них неразобранных: ${inventory.unassignedCount}${secretSummary}, напоминаний на очереди: ${inventory.dueReminderCount}).\n\nПо разделам: ${orbitSummary}.`,
        citations: [],
        usedProvider: 'local',
        costUsd: 0,
      };
    }
  }

  if (safeItems.length === 0) {
    return {
      answer: isEn
        ? 'No matches found for this query. Try another keyword or ask about your workspace stats or saved cards.'
        : 'По этому запросу ничего не нашлось. Попробуй другое слово или уточни тему — я проверю по всем заметкам, файлам и расшифровкам.',
      citations: [],
      usedProvider: 'local',
      costUsd: 0,
    };
  }

  const top = safeItems.slice(0, 6);
  const cleanPreviewForItem = (item: VaultItem): string => {
    let rawTitle = cleanBrokenTextArtifacts(item.title || '', true);
    let rawSnippet = cleanBrokenTextArtifacts(
      (item.summary || item.mediaMeta?.transcript || item.body || item.ocrText || item.url || '')
        .replace(/\s+/g, ' ')
        .trim(),
      true
    );
    if (item.platform === 'instagram' || (item.domain || '').includes('instagram.com')) {
      const cleaned = cleanInstagramText(rawTitle, rawSnippet);
      if (cleaned.cleanTitle) rawTitle = cleanBrokenTextArtifacts(cleaned.cleanTitle, true);
      if (cleaned.caption) rawSnippet = cleanBrokenTextArtifacts(cleaned.caption, true);
    }
    if (rawSnippet.toLowerCase().startsWith(rawTitle.toLowerCase())) {
      rawSnippet = rawSnippet.slice(rawTitle.length).replace(/^[\s.,:;—–-]+/, '').trim();
    }
    return rawSnippet;
  };

  const citations: AskVaultCitation[] = top.map((i) => {
    const cleanTitle = cleanBrokenTextArtifacts(i.title || '', true);
    const ig =
      i.platform === 'instagram' || (i.domain || '').includes('instagram.com')
        ? cleanInstagramText(cleanTitle, i.summary || i.body)
        : null;
    const cleanCitTitle = cleanBrokenTextArtifacts(ig?.cleanTitle || cleanTitle, true);
    const cleanCitSummary = cleanBrokenTextArtifacts(ig?.caption || i.summary || i.body || '', true);
    return {
      id: i.id,
      title: cleanCitTitle,
      dna: i.dna,
      orbit: i.orbit,
      summary: truncateAtWordBoundary(cleanCitSummary, 140),
      domain: i.domain,
      url: i.url,
      thumbPath: i.thumbPath,
      imagePath: i.imagePath,
    };
  });

  const lines = top.map((item, idx) => {
    const cit = citations[idx]!;
    const snippetSource = cleanPreviewForItem(item);
    const preview = snippetSource ? ` — ${truncateAtWordBoundary(snippetSource, 140)}` : '';
    return `${idx + 1}. **${cit.title}**${preview}`;
  });

  return {
    answer: isEn
      ? `Here’s what matched "${question.trim()}":\n\n${lines.join('\n')}`
      : `Вот что нашлось по запросу «${question.trim()}»:\n\n${lines.join('\n')}`,
    citations,
    usedProvider: 'local',
    costUsd: 0,
  };
}
