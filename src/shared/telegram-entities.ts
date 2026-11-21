export interface RawTelegramEntity {
  type?: string;
  className?: string;
  offset?: number;
  length?: number;
  url?: string;
  language?: string;
}

export interface SerializedTelegramMessage {
  markdown: string;
  links: string[];
  hasCodeBlocks: boolean;
}

type CanonicalEntityKind =
  | 'pre'
  | 'code'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'blockquote'
  | 'text_link'
  | 'url'
  | 'other';

function mapEntityKind(e: RawTelegramEntity): CanonicalEntityKind {
  const t = String(e.type || e.className || '').toLowerCase();
  if (t === 'pre' || t === 'messageentitypre') return 'pre';
  if (t === 'code' || t === 'messageentitycode') return 'code';
  if (t === 'bold' || t === 'messageentitybold') return 'bold';
  if (t === 'italic' || t === 'messageentityitalic') return 'italic';
  if (t === 'strikethrough' || t === 'messageentitystrike') return 'strike';
  if (t === 'blockquote' || t === 'expandable_blockquote' || t === 'messageentityblockquote') {
    return 'blockquote';
  }
  if (t === 'text_link' || t === 'messageentitytexturl') return 'text_link';
  if (t === 'url' || t === 'messageentityurl') return 'url';
  return 'other';
}

interface BoundaryMarker {
  pos: number;
  open: string;
  close: string;
  order: number;
}

/**
 * Serializes Telegram UTF-16 code-unit MessageEntities (`offset`/`length`) into clean Markdown.
 * Preserves multi-block fenced code (`pre`), inline `code`, `bold`, `italic`, `blockquote`, and `[label](url)`.
 */
export function serializeTelegramEntitiesToMarkdown(
  rawText: string,
  entities?: RawTelegramEntity[] | null
): SerializedTelegramMessage {
  const text = rawText ?? '';
  if (!text) return { markdown: '', links: [], hasCodeBlocks: false };
  if (!Array.isArray(entities) || entities.length === 0) {
    const plainLinks = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0]);
    return {
      markdown: text,
      links: [...new Set(plainLinks)],
      hasCodeBlocks: /```[\s\S]+?```/.test(text),
    };
  }

  const links: string[] = [];
  let hasCodeBlocks = false;

  // Separate pre/code blocks first so inner styles don't corrupt fenced code
  const validEntities = entities
    .map((ent, idx) => ({
      ent,
      kind: mapEntityKind(ent),
      start: Math.max(0, Math.min(text.length, Number(ent.offset ?? 0))),
      end: Math.max(0, Math.min(text.length, Number(ent.offset ?? 0) + Number(ent.length ?? 0))),
      idx,
    }))
    .filter((item) => item.end > item.start && item.kind !== 'other')
    .sort((a, b) => a.start - b.start || b.end - a.end || a.idx - b.idx);

  const opens = new Map<number, BoundaryMarker[]>();
  const closes = new Map<number, BoundaryMarker[]>();
  const addPair = (start: number, end: number, open: string, close: string, order: number) => {
    const oList = opens.get(start) ?? [];
    oList.push({ pos: start, open, close, order });
    opens.set(start, oList);
    const cList = closes.get(end) ?? [];
    cList.push({ pos: end, open, close, order });
    closes.set(end, cList);
  };

  // Track pre/code ranges so inner bold/italic/link markers never corrupt fenced code blocks
  const codeRanges: Array<{ start: number; end: number }> = [];
  for (const item of validEntities) {
    if (item.kind === 'pre' || item.kind === 'code') {
      codeRanges.push({ start: item.start, end: item.end });
    }
  }
  const insideCodeRange = (start: number, end: number, kind: CanonicalEntityKind): boolean => {
    if (kind === 'pre' || kind === 'code') return false;
    return codeRanges.some((r) => start >= r.start && end <= r.end);
  };

  for (const item of validEntities) {
    if (insideCodeRange(item.start, item.end, item.kind)) continue;
    const slice = text.slice(item.start, item.end);
    switch (item.kind) {
      case 'pre': {
        hasCodeBlocks = true;
        const lang = (item.ent.language || '').replace(/[^a-zA-Z0-9_+#.-]/g, '').slice(0, 24);
        const needsLeadNl = item.start > 0 && text[item.start - 1] !== '\n' ? '\n' : '';
        const needsTrailNl = item.end < text.length && text[item.end] !== '\n' ? '\n' : '';
        const bodyLeadNl = slice.startsWith('\n') ? '' : '\n';
        const bodyTrailNl = slice.endsWith('\n') ? '' : '\n';
        addPair(
          item.start,
          item.end,
          `${needsLeadNl}\`\`\`${lang}${bodyLeadNl}`,
          `${bodyTrailNl}\`\`\`${needsTrailNl}`,
          item.idx
        );
        break;
      }
      case 'code': {
        if (slice.includes('\n')) {
          hasCodeBlocks = true;
          addPair(item.start, item.end, '\n```\n', '\n```\n', item.idx);
        } else if (!slice.startsWith('`')) {
          addPair(item.start, item.end, '`', '`', item.idx);
        }
        break;
      }
      case 'bold': {
        if (slice.trim()) addPair(item.start, item.end, '**', '**', item.idx);
        break;
      }
      case 'italic': {
        if (slice.trim()) addPair(item.start, item.end, '*', '*', item.idx);
        break;
      }
      case 'strike': {
        if (slice.trim()) addPair(item.start, item.end, '~~', '~~', item.idx);
        break;
      }
      case 'text_link': {
        const u = (item.ent.url || '').trim();
        if (u) {
          links.push(u);
          if (!slice.includes(u)) {
            addPair(item.start, item.end, '[', `](${u})`, item.idx);
          }
        }
        break;
      }
      case 'url': {
        const u = slice.trim();
        if (u) links.push(u);
        break;
      }
      case 'blockquote': {
        if (slice.trim()) addPair(item.start, item.end, '\n> ', '\n', item.idx);
        break;
      }
      default:
        break;
    }
  }

  // Handle legacy Bot API entities without valid offset/length (e.g., unit test fixtures with omitted offsets)
  const fallbackLinks = entities
    .filter(
      (e) =>
        (e.type === 'text_link' || e.className === 'MessageEntityTextUrl') &&
        typeof e.url === 'string' &&
        (e.length === undefined || e.length <= 0)
    )
    .map((e) => e.url!.trim())
    .filter((u) => u && !text.includes(u));

  const boundaries = new Set<number>([0, text.length]);
  for (const pos of opens.keys()) boundaries.add(pos);
  for (const pos of closes.keys()) boundaries.add(pos);
  const sortedBounds = [...boundaries].sort((a, b) => a - b);

  let out = '';
  for (let i = 0; i < sortedBounds.length; i++) {
    const pos = sortedBounds[i]!;
    const cHere = closes.get(pos);
    if (cHere) {
      // Close innermost tags first
      cHere.sort((a, b) => b.order - a.order);
      for (const m of cHere) out += m.close;
    }
    const oHere = opens.get(pos);
    if (oHere) {
      oHere.sort((a, b) => a.order - b.order);
      for (const m of oHere) out += m.open;
    }
    if (i + 1 < sortedBounds.length) {
      out += text.slice(pos, sortedBounds[i + 1]!);
    }
  }

  for (const fl of fallbackLinks) {
    links.push(fl);
    out += `\n${fl}`;
  }

  // Normalize excessive blank lines around fenced blocks
  const normalized = out.replace(/\n{3,}/g, '\n\n').trim();
  const inlineLinks = [...normalized.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0]);
  return {
    markdown: normalized,
    links: [...new Set([...links, ...inlineLinks])],
    hasCodeBlocks: hasCodeBlocks || /```[\s\S]+?```/.test(normalized),
  };
}
