import { normalizeCardExpiry } from '@shared/russian-event-parser';
import type { AppLocale, SecretMeta, SecretPayload } from '@shared/types';

export interface SecretAnalysis {
  isSecret: boolean;
  reason: string | null;
  meta: SecretMeta | null;
  payload: SecretPayload | null;
}

const API_TOKEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Private Key (PEM)', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'OpenAI / OpenRouter Key', regex: /\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Stripe Key', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { label: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Google AI / Gemini Key', regex: /\bAIza[0-9A-Za-z_-]{32,}\b/ },
  { label: 'GitHub Token', regex: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{24,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: 'Telegram Bot Token', regex: /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/ },
  { label: 'Kapsula Recovery Key', regex: /\bKAPS(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}\b/i },
  { label: '2FA Secret (TOTP URI)', regex: /\botpauth:\/\/totp\/[^\s"'<>]+/i },
  { label: 'JWT Token', regex: /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const LABELED_LOGIN_RE =
  /(?:^|[\n\r·|;])\s*(?:логин|login|user(?:name)?|почта|email|аккаунт|account)\s*[:=\-—]\s*([^\n\r·|;]+)/i;
const LABELED_PASS_RE =
  /(?:^|[\n\r·|;]|[.!?]\s+)\s*(пароль|pass(?:word)?|pwd|pin(?:\s*[-]?\s*код)?|пин(?:\s*[-]?\s*код)?|код\s*(?:доступа|подтверждения|входа)|token|токен|key|ключ|secret|секрет)\s*[:=\-—]\s*([^\n\r·;]+)/i;
const PROMO_CONTEXT_RE = /(?:промокод|промо|promo|coupon|купон|скидк|voucher|ваучер|акци[яи])/i;

function isPlausibleLabeledSecretValue(label: string, value: string, hasLogin: boolean): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  if (/^\[REDACTED_/i.test(v)) return false;

  if (
    /^(?:HTTP[_-]?\d{3}|ERR(?:OR)?[_-][A-Z0-9_]+|STATUS[_-]?\d{3}|E[A-Z]{4,}|[45]\d{2}(?:\s+[A-Za-z ]+)?)$/i.test(
      v
    )
  ) {
    return false;
  }

  if (/^\d{4}$/.test(v)) {
    const isExplicitPinOrAuth =
      /^(?:пароль|pass(?:word)?|pwd|pin(?:\s*[-]?\s*код)?|пин(?:\s*[-]?\s*код)?|secret|секрет)$/i.test(
        label.trim()
      );
    if (!isExplicitPinOrAuth && !hasLogin) {
      return false;
    }
  }

  if (/\s/.test(v)) {
    const words = v.split(/\s+/).filter(Boolean);
    const startsWithProsePrefix =
      /^(?:от|на|в|к|у|с|для|из|под|над|про|не|нет|ошибка|статус|лежит|хранится)\s+[а-яё]{2,}/i.test(
        v
      );
    const hasTokenMarkers = /[_=/+*@{}[\]<>@#$%^&!]/.test(v);
    if (startsWithProsePrefix && !hasTokenMarkers && !hasLogin) {
      return false;
    }
    if (
      words.length >= 2 &&
      !/\d/.test(v) &&
      !hasTokenMarkers &&
      words.some((w) => /[а-яёА-ЯЁ]{2,}/.test(w))
    ) {
      return false;
    }
  }

  return true;
}
const LABELED_SERVICE_RE =
  /(?:^|[\n\r·|;])\s*(?:сервис|сайт|service|site|app|host|ресурс|проект)\s*[:=\-—]\s*([^\n\r·|;]+)/i;

const COMPACT_EMAIL_PASS_RE =
  /^\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*(?::|\/|\||->|\s{2,})\s*(\S{4,})\s*$/m;
const COMPACT_USER_PASS_RE =
  /^\s*([A-Za-z0-9._@-]{3,48})\s*:\s*([^\s:]{6,64})\s*$/;

const NON_CREDENTIAL_LABEL_KEYS = new Set([
  'subject', 'server', 'order', 'branch', 'status', 'project', 'env', 'environment',
  'channel', 'author', 'date', 'time', 'step', 'error', 'warning', 'info', 'host',
  'port', 'model', 'version', 'topic', 'note', 'link', 'file', 'path', 'type',
  'mode', 'stage', 'phase', 'region', 'client', 'vendor', 'brand', 'title', 'name',
  'city', 'country', 'room', 'floor', 'desk', 'task', 'ticket', 'issue', 'sprint',
  'release', 'build', 'commit', 'format', 'codec', 'aspect', 'genre', 'album',
  'artist', 'track', 'episode', 'season', 'summary', 'theme', 'тема', 'сервер',
  'заказ', 'ветка', 'статус', 'проект', 'канал', 'автор', 'дата', 'время',
]);

function looksLikeCompactCredentialPair(rawLine: string, left: string, right: string): boolean {
  const lowerLeft = left.toLowerCase();
  if (NON_CREDENTIAL_LABEL_KEYS.has(lowerLeft)) return false;
  if (/^https?|mailto|tg|file|ftp|tel|data$/i.test(lowerLeft)) return false;
  // Order/issue tags (#12345) or kebab-case slugs (feature-1) after whitespace aren't passwords
  if (/^#\d+$/.test(right)) return false;

  const hasSpaceAfterColon = /^\s*[^:\s]+\s*:\s+/.test(rawLine);
  const leftLooksLikeAccount =
    left.includes('@') || /[_0-9]/.test(left) || /(?:user|login|mail|acct|admin|root|db|ssh)/i.test(lowerLeft);
  const rightHasLower = /[a-z]/.test(right);
  const rightHasUpper = /[A-Z]/.test(right);
  const rightHasDigitOrSym = /[0-9!@#$%^&*_+\-=]/.test(right);

  if (hasSpaceAfterColon) {
    // Require strong account/password signals when written as prose "Key: value"
    if (left.includes('@') && rightHasDigitOrSym) return true;
    return leftLooksLikeAccount && rightHasDigitOrSym && (rightHasLower || rightHasUpper) && !/^[a-z]+-\d+$/i.test(right);
  }

  // Tight format "login:secret" without space after colon
  if (left.includes('@')) return right.length >= 6;
  return rightHasDigitOrSym && (rightHasLower || rightHasUpper) && !/^[a-z]+-\d+$/i.test(right);
}

const CARD_CANDIDATE_RE =
  /(?<!\d)(?:\d{4}(?:[ -]\d{4}){3}(?:[ -]\d{2,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19})(?!\d)/g;
const FOUR_GROUP_CARD_RE = /^\d{4}(?:[ -]\d{4}){3}/;
const CARD_KEYWORD_RE =
  /(?:^|[^a-zа-яё0-9])(?:карт[аеуы]?|card|cvv2?|cvc|мир|mir|visa|mastercard|unionpay|срок)(?=$|[^a-zа-яё0-9])/iu;
const BANK_NAME_RE =
  /(?:^|[^a-zа-яё0-9])(Т-?Банк|Тинькофф|Tinkoff|Сбер(?:банк)?|Sber(?:bank)?|Альфа(?:-?Банк)?|Alfa|ВТБ|VTB|Ozon\s*Банк|Озон\s*Банк|Яндекс\s*(?:Банк|Пэй)|Райффайзен|Raiffeisen|Газпромбанк|ПСБ|Открытие|Модульбанк|Точка|Статус\s*Банк|Status\s*Bank|Беларусбанк|Приорбанк|МТБанк|БНБ(?:-?Банк)?|Белгазпромбанк|Kaspi|Revolut|Wise)(?=$|[^a-zа-яё0-9])/iu;

export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function detectCardBrand(digits: string, locale: AppLocale = 'ru'): string | null {
  if (/^220[0-4]/.test(digits)) return locale === 'en' ? 'MIR' : 'МИР';
  if (digits.startsWith('4')) return 'Visa';
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return 'Mastercard';
  if (digits.startsWith('62')) return 'UnionPay';
  if (digits.startsWith('34') || digits.startsWith('37')) return 'Amex';
  return null;
}

export function formatCardDigits(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

export interface DetectedBankCard {
  digits: string;
  formatted: string;
  last4: string;
  brand: string;
  service: string;
  expiry?: string;
  cvv?: string;
  cardHolder?: string;
}

function resolveValidCardMatch(
  rawMatch: string,
  nextChar: string,
): { matchedSpan: string; digits: string } | null {
  const fullDigits = rawMatch.replace(/\D/g, '');
  if (
    fullDigits.length >= 13 &&
    fullDigits.length <= 19 &&
    nextChar !== '/' &&
    nextChar !== '.' &&
    passesLuhn(fullDigits)
  ) {
    return { matchedSpan: rawMatch, digits: fullDigits };
  }

  const fourGroup = rawMatch.match(FOUR_GROUP_CARD_RE)?.[0];
  if (fourGroup) {
    const fgDigits = fourGroup.replace(/\D/g, '');
    if (fgDigits.length === 16 && passesLuhn(fgDigits)) {
      return { matchedSpan: fourGroup, digits: fgDigits };
    }
  }
  return null;
}

export function detectBankCard(
  rawText: string,
  locale: AppLocale = 'ru'
): DetectedBankCard | null {
  const noUrls = rawText.replace(/https?:\/\/\S+/gi, ' ');
  const hasCardCue = CARD_KEYWORD_RE.test(noUrls);

  for (const m of noUrls.matchAll(CARD_CANDIDATE_RE)) {
    const rawMatch = m[0];
    const matchStart = m.index ?? 0;
    const nextChar = noUrls[matchStart + rawMatch.length] ?? '';
    const resolved = resolveValidCardMatch(rawMatch, nextChar);
    if (!resolved) continue;

    const { matchedSpan, digits } = resolved;
    const brand = detectCardBrand(digits, locale);
    if (!brand && !hasCardCue) continue;

    const stripped = `${noUrls.slice(0, matchStart)} ${noUrls.slice(matchStart + matchedSpan.length)}`;
    let expiry: string | undefined;
    const expMatch =
      stripped.match(/(?:срок|exp(?:iry)?|valid(?:\s+thru)?|до)?\s*(?:^|\D)(0?[1-9]|1[0-2])\s*[\/.\-\s]\s*(?:20)?(\d{2})(?!\d)/i) ??
      stripped.match(/(?:срок|exp(?:iry)?|valid(?:\s+thru)?|до)\s*[:=]?\s*(0[1-9]|1[0-2])(\d{2})(?!\d)/i);
    if (expMatch?.[1] && expMatch[2]) {
      expiry = normalizeCardExpiry(`${expMatch[1]}/${expMatch[2]}`);
    }

    let cvv: string | undefined;
    const labeledCvv = stripped.match(/(?:cvv2?|cvc|код(?:\s*безопасности)?)\s*[:=\-—]?\s*(\d{3,4})(?!\d)/i);
    if (labeledCvv?.[1]) {
      cvv = labeledCvv[1];
    } else if (expMatch && expMatch.index !== undefined) {
      const afterExp = stripped.slice(expMatch.index + expMatch[0].length);
      const trailingDigits = afterExp.match(/^\s*[,;|/\-]?\s*(\d{3,4})(?!\d)/);
      if (trailingDigits?.[1]) {
        cvv = trailingDigits[1];
      }
    }

    const holderMatch = stripped.match(
      /(?:держатель|владелец|holder|name)\s*[:=\-—]?\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\s.'-]{2,40})/i
    );
    const cardHolder = holderMatch?.[1]?.trim() || undefined;
    const bankMatch = stripped.match(BANK_NAME_RE);
    const finalBrand = brand ?? (locale === 'en' ? 'Bank Card' : 'Банковская карта');
    const service = bankMatch?.[1] ? `${bankMatch[1]} · ${finalBrand}` : finalBrand;

    return {
      digits,
      formatted: formatCardDigits(digits),
      last4: digits.slice(-4),
      brand: finalBrand,
      service,
      expiry,
      cvv,
      cardHolder,
    };
  }
  return null;
}

export function maskLoginHint(login: string): string {
  const trimmed = login.trim();
  if (!trimmed) return '';
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 1) {
    return `${trimmed[0]}***${trimmed.slice(atIdx)}`;
  }
  if (trimmed.length <= 3) return `${trimmed[0]}**`;
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
}

function isLikelySeedPhrase(text: string): boolean {
  const normalized = text.trim();
  if (/https?:\/\//i.test(normalized)) return false;
  const words = normalized.split(/\s+/);
  if (words.length !== 12 && words.length !== 24) return false;
  return words.every((w) => /^[a-z]{3,8}$/.test(w));
}

function extractDomainService(text: string, locale: AppLocale = 'ru'): string {
  const m = text.match(/https?:\/\/([a-z0-9.-]+)/i);
  if (m?.[1]) return m[1].replace(/^www\./, '');
  const emailM = text.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (emailM?.[1]) return emailM[1];
  return locale === 'en' ? 'Personal Vault' : 'Личный сейф';
}

export function analyzeForSecret(
  rawText: string,
  options?: { forceSecret?: boolean; service?: string; login?: string; notes?: string; locale?: AppLocale }
): SecretAnalysis {
  const text = rawText.trim();
  const locale: AppLocale = options?.locale === 'en' ? 'en' : 'ru';
  const isEn = locale === 'en';
  const personalVaultLabel = isEn ? 'Personal Vault' : 'Личный сейф';
  const empty: SecretAnalysis = { isSecret: false, reason: null, meta: null, payload: null };
  if (!text && !options?.forceSecret) return empty;

  const serviceMatch = text.match(LABELED_SERVICE_RE);
  const detectedService = (
    options?.service ||
    serviceMatch?.[1] ||
    extractDomainService(text, locale)
  ).trim();

  // 1. Check API tokens / Private keys / JWTs
  for (const pat of API_TOKEN_PATTERNS) {
    const match = text.match(pat.regex);
    if (match) {
      const token = match[0];
      const loginMatch = text.match(LABELED_LOGIN_RE);
      const login = (options?.login || loginMatch?.[1] || '').trim();
      return {
        isSecret: true,
        reason: pat.label,
        meta: {
          service: detectedService !== personalVaultLabel ? detectedService : pat.label,
          loginHint:
            maskLoginHint(login) || (token.length > 8 ? `••••${token.slice(-4)}` : '••••'),
          kind: 'api_key',
        },
        payload: {
          service: detectedService !== personalVaultLabel ? detectedService : pat.label,
          login,
          secretValue: token,
          notes: options?.notes ?? text,
        },
      };
    }
  }

  // 2. Check BIP-39 style 12/24 word seed phrases
  if (isLikelySeedPhrase(text)) {
    const wordCount = text.split(/\s+/).length;
    return {
      isSecret: true,
      reason: isEn ? 'Seed phrase (12/24 words)' : 'Seed-фраза (12/24 слова)',
      meta: {
        service: options?.service || 'Crypto / Wallet Seed',
        loginHint: isEn ? `${wordCount} words` : `${wordCount} слов`,
        kind: 'seed',
      },
      payload: {
        service: options?.service || 'Crypto / Wallet Seed',
        login: options?.login || '',
        secretValue: text,
        notes: options?.notes || '',
      },
    };
  }

  // 2.5 Check Luhn-valid Bank Cards (13-19 digits) before generic password matching
  const bankCard = detectBankCard(text, locale);
  if (bankCard) {
    const svcName = options?.service?.trim() || bankCard.service;
    return {
      isSecret: true,
      reason: isEn ? `Bank card (${bankCard.brand})` : `Банковская карта (${bankCard.brand})`,
      meta: {
        service: svcName,
        loginHint: `•••• ${bankCard.last4}`,
        kind: 'bank_card',
        cardBrand: bankCard.brand,
        last4: bankCard.last4,
        hasCvv: Boolean(bankCard.cvv?.trim()),
        expiry: bankCard.expiry,
        hasLogin: Boolean(options?.login || bankCard.cardHolder),
      },
      payload: {
        service: svcName,
        login: options?.login || bankCard.cardHolder || '',
        secretValue: bankCard.formatted,
        expiry: bankCard.expiry,
        cvv: bankCard.cvv,
        cardHolder: bankCard.cardHolder,
        notes: options?.notes ?? text,
      },
    };
  }

  // 3. Labeled login + password / standalone PIN / Token / Key fields (ignore promo coupons)
  const labeledLogin = text.match(LABELED_LOGIN_RE)?.[1]?.trim() ?? '';
  const passMatch = text.match(LABELED_PASS_RE);
  const labeledPassLabel = passMatch?.[1]?.trim() ?? '';
  const labeledPass = passMatch?.[2]?.trim() ?? '';
  const isPromoNote = PROMO_CONTEXT_RE.test(text) && !labeledLogin;
  if (
    !isPromoNote &&
    labeledPass &&
    isPlausibleLabeledSecretValue(labeledPassLabel, labeledPass, Boolean(labeledLogin)) &&
    (labeledLogin ||
      /(?:пароль|pass(?:word)?|pwd|pin|код\s*(?:доступа|подтверждения|входа)|secret|секрет|token|токен|ключ|key)/i.test(text))
  ) {
    const finalLogin = options?.login || labeledLogin;
    return {
      isSecret: true,
      reason: isEn ? 'Login / Password' : 'Логин / Пароль',
      meta: {
        service: detectedService,
        loginHint: maskLoginHint(finalLogin),
        kind: 'password',
      },
      payload: {
        service: detectedService,
        login: finalLogin,
        secretValue: labeledPass,
        notes: options?.notes ?? text,
      },
    };
  }

  // 4. Compact `email : password` or `user:password` (excluding URLs)
  const noUrls = text.replace(/https?:\/\/\S+/gi, '').trim();
  const emailPair = noUrls.match(COMPACT_EMAIL_PASS_RE);
  if (emailPair?.[1] && emailPair?.[2]) {
    const login = options?.login || emailPair[1];
    return {
      isSecret: true,
      reason: isEn ? 'Email : password pair' : 'Пара почта : пароль',
      meta: {
        service: options?.service || extractDomainService(login, locale),
        loginHint: maskLoginHint(login),
        kind: 'password',
      },
      payload: {
        service: options?.service || extractDomainService(login, locale),
        login,
        secretValue: emailPair[2],
        notes: options?.notes || '',
      },
    };
  }

  if (!/https?:\/\//i.test(text) && !/\b\d{1,2}:\d{2}\b/.test(text)) {
    const userPair = noUrls.match(COMPACT_USER_PASS_RE);
    if (
      userPair?.[1] &&
      userPair?.[2] &&
      looksLikeCompactCredentialPair(noUrls, userPair[1], userPair[2])
    ) {
      const login = options?.login || userPair[1];
      return {
        isSecret: true,
        reason: isEn ? 'Login : password pair' : 'Пара логин : пароль',
        meta: {
          service: detectedService,
          loginHint: maskLoginHint(login),
          kind: 'password',
        },
        payload: {
          service: detectedService,
          login,
          secretValue: userPair[2],
          notes: options?.notes || '',
        },
      };
    }
  }

  // 5. Explicit Ghost/Safe mode override even for arbitrary confidential notes
  if (options?.forceSecret) {
    return {
      isSecret: true,
      reason: isEn ? 'Vault Mode' : 'Сейф-режим',
      meta: {
        service: detectedService,
        loginHint: maskLoginHint(options.login || ''),
        kind: 'note',
      },
      payload: {
        service: detectedService,
        login: options.login || '',
        secretValue: text,
        notes: options.notes || '',
      },
    };
  }

  return empty;
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const pat of API_TOKEN_PATTERNS) {
    out = out.replace(new RegExp(pat.regex.source, 'g'), '[REDACTED_SECRET]');
  }
  // Redact Basic Auth credentials inside URLs and Bearer headers
  out = out.replace(/https?:\/\/[^\s/:@]+:[^\s/@]+@/gi, 'https://[REDACTED_AUTH]@');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]');
  out = out.replace(/\b(?:cvv2?|cvc|pin|пин)\s*[:=-]?\s*\d{3,6}\b/gi, '[REDACTED_CODE]');
  out = out.replace(
    /(^|[^\p{L}\p{N}_])((пароль|pass(?:word)?|pwd|pin(?:\s*[-]?\s*код)?|пин(?:\s*[-]?\s*код)?|код|token|токен|key|ключ|secret|секрет)\s*[:=\-—]\s*)([^\n\r·|;]+)/giu,
    (full, boundary: string, prefix: string, label: string, rawVal: string) =>
      isPlausibleLabeledSecretValue(label, rawVal, LABELED_LOGIN_RE.test(out))
        ? `${boundary}${prefix}[REDACTED_SECRET]`
        : full
  );
  // Redact compact email:password pairs outside URLs
  out = out.replace(
    /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*(?::|->|\|)\s*([^\s:]{4,})/g,
    '$1:[REDACTED_SECRET]'
  );
  // Redact compact username:password pairs outside URLs/times
  out = out.replace(/(^|\s)([A-Za-z0-9_.-]{3,32}):([^\s:]{6,64})(?=\s|$)/gm, (full, prefix: string, user: string, pass: string) => {
    if (/^(?:https?|mailto|tg|file)$/i.test(user)) return full;
    if (!looksLikeCompactCredentialPair(`${user}:${pass}`, user, pass)) return full;
    return `${prefix}${user}:[REDACTED_SECRET]`;
  });
  // Redact Luhn-valid bank card numbers outside URLs
  out = out.replace(CARD_CANDIDATE_RE, (candidate, offset: number, fullStr: string) => {
    const nextChar = fullStr[offset + candidate.length] ?? '';
    const resolved = resolveValidCardMatch(candidate, nextChar);
    if (resolved && (detectCardBrand(resolved.digits) || CARD_KEYWORD_RE.test(out))) {
      return `[REDACTED_CARD]${candidate.slice(resolved.matchedSpan.length)}`;
    }
    return candidate;
  });
  // Redact 12 or 24 lowercase word seed-phrase lines
  out = out
    .split(/\r?\n/)
    .map((line) => (isLikelySeedPhrase(line) ? '[REDACTED_SEED_PHRASE]' : line))
    .join('\n');
  return out;
}
