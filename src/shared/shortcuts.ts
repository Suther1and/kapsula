export const DEFAULT_HUD_SHORTCUT = 'Alt+Space';
export const DEFAULT_SNATCH_SHORTCUT = 'CommandOrControl+Shift+S';
export const DEFAULT_SNATCH_SHORTCUT_MAC = 'Alt+Shift+S';

export function getDefaultSnatchShortcut(platform?: string | null): string {
  return platform === 'darwin' ? DEFAULT_SNATCH_SHORTCUT_MAC : DEFAULT_SNATCH_SHORTCUT;
}

const VALID_MODIFIERS = new Map<string, string>([
  ['ctrl', 'CommandOrControl'],
  ['control', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['commandorcontrol', 'CommandOrControl'],
  ['cmd', 'CommandOrControl'],
  ['command', 'CommandOrControl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super'],
  ['win', 'Super'],
]);

const MODIFIER_ORDER = ['CommandOrControl', 'Control', 'Alt', 'Shift', 'Super'];

const SPECIAL_KEY_MAP = new Map<string, string>([
  ['space', 'Space'],
  ['spacebar', 'Space'],
  [' ', 'Space'],
  ['enter', 'Return'],
  ['return', 'Return'],
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['insert', 'Insert'],
  ['ins', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right'],
  ['plus', 'Plus'],
  ['=', '='],
  ['equal', '='],
  ['minus', '-'],
  ['-', '-'],
  ['bracketleft', '['],
  ['[', '['],
  ['bracketright', ']'],
  [']', ']'],
  ['backslash', '\\'],
  ['\\', '\\'],
  ['semicolon', ';'],
  [';', ';'],
  ['quote', "'"],
  ["'", "'"],
  ['comma', ','],
  [',', ','],
  ['period', '.'],
  ['.', '.'],
  ['slash', '/'],
  ['/', '/'],
  ['backquote', '`'],
  ['`', '`'],
]);

function normalizeMainKeyToken(raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  const lower = token.toLowerCase();

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) {
    return token.toUpperCase();
  }
  if (/^[a-z0-9]$/i.test(token)) {
    return token.toUpperCase();
  }
  if (/^key([a-z])$/i.test(token)) {
    return token.slice(3).toUpperCase();
  }
  if (/^digit([0-9])$/i.test(token)) {
    return token.slice(5);
  }
  if (SPECIAL_KEY_MAP.has(lower)) {
    return SPECIAL_KEY_MAP.get(lower)!;
  }
  return null;
}

/**
 * Validates and canonicalizes an Electron globalShortcut accelerator string.
 * Returns null if the shortcut lacks at least one modifier + one key or has invalid tokens.
 */
export function normalizeShortcutAccelerator(
  raw: string | null | undefined,
  platform?: string | null
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const mac = isMacPlatform(platform);
  const mods = new Set<string>();
  let mainKey: string | null = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    let mod = VALID_MODIFIERS.get(lower);
    if (mac) {
      if (lower === 'ctrl' || lower === 'control') {
        mod = 'Control';
      } else if (mod === 'Super') {
        mod = 'CommandOrControl';
      }
    }
    if (mod) {
      mods.add(mod);
      continue;
    }
    const key = normalizeMainKeyToken(part);
    if (!key || mainKey) {
      return null;
    }
    mainKey = key;
  }

  if (mods.size === 0 || !mainKey) return null;

  const orderedMods = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...orderedMods, mainKey].join('+');
}

/**
 * Converts a browser KeyboardEvent into an Electron accelerator using event.code
 * first so Cyrillic / non-Latin layouts still produce valid Latin chords.
 * On macOS (`platform === 'darwin'`), Control (`⌃`) stays distinct from Command (`⌘`).
 */
export function keyboardEventToAccelerator(
  e: {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  platform?: string | null
): string | null {
  const mac = isMacPlatform(platform);
  const mods: string[] = [];
  if (mac) {
    if (e.metaKey) mods.push('CommandOrControl');
    if (e.ctrlKey) mods.push('Control');
  } else if (e.ctrlKey || e.metaKey) {
    mods.push('CommandOrControl');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  if (mods.length === 0) return null;

  const ignoreKeys = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'CapsLock', 'Escape']);
  if (ignoreKeys.has(e.key)) return null;

  const candidate = e.code && e.code !== '' ? e.code : e.key;
  const key = normalizeMainKeyToken(candidate) ?? normalizeMainKeyToken(e.key);
  if (!key) return null;

  return normalizeShortcutAccelerator([...mods, key].join('+'), platform);
}

export function isMacPlatform(platform?: string | null): boolean {
  return platform === 'darwin';
}

export function formatShortcutDisplay(
  accelerator: string | null | undefined,
  platform?: string | null
): string {
  const norm = normalizeShortcutAccelerator(accelerator, platform);
  const raw = norm || accelerator || '';
  if (!raw) return 'Не назначено';
  const mac = isMacPlatform(platform);
  return raw
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return mac ? '⌘' : 'Ctrl';
      if (part === 'Control') return mac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return mac ? '⌥' : 'Alt';
      if (part === 'Shift') return mac ? '⇧' : 'Shift';
      if (part === 'Super') return mac ? '⌘' : 'Super';
      if (part === 'Return') return 'Enter';
      if (part === 'Space') return 'Пробел';
      return part;
    })
    .join(' + ');
}

export function formatShortcutCompact(
  accelerator: string | null | undefined,
  platform?: string | null
): string {
  const norm = normalizeShortcutAccelerator(accelerator, platform);
  const raw = norm || accelerator || '';
  if (!raw) return '';
  const mac = isMacPlatform(platform);
  return raw
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return mac ? '⌘' : 'Ctrl';
      if (part === 'Control') return mac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return mac ? '⌥' : 'Alt';
      if (part === 'Shift') return mac ? '⇧' : 'Shift';
      if (part === 'Super') return mac ? '⌘' : 'Super';
      if (part === 'Return') return 'Enter';
      if (part === 'Space') return 'Пробел';
      return part;
    })
    .join('+');
}
