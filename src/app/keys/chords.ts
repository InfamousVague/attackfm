/**
 * A chord: one key and the modifiers held with it.
 *
 * Stored and compared as a plain string - `mod+shift+ArrowRight` - so a keymap
 * is a small JSON object anybody can read, and the same spelling works on
 * every machine. The one word that moves is `mod`: it means ⌘ on a Mac and
 * Ctrl everywhere else, which is the rule every desktop app already keeps, and
 * it is the reason a keymap can follow an account from a MacBook to a Windows
 * box without a single binding needing to be re-spelled.
 *
 * The OTHER modifier - Ctrl on a Mac, the Windows key elsewhere - is deliberately
 * not a chord at all. `Ctrl+S` on a Mac is the terminal's business and the
 * Windows key is the OS's; a chord that carried either would read as "S" here
 * and press shuffle on top of whatever the system did with it.
 */

export interface Chord {
  /** The key itself, normalised: a letter is uppercase, the space bar is
   *  `Space`, everything else is the browser's own `KeyboardEvent.key`. */
  key: string;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
  /** ⌥ on a Mac, Alt elsewhere. */
  alt: boolean;
}

/**
 * Whether this machine spells `mod` as ⌘.
 *
 * `navigator.platform` is deprecated but still the one field that says "Mac"
 * without a user-agent parse; the agent string is the fallback for engines
 * that have blanked it. iPads and iPhones count as Macs here: a hardware
 * keyboard on either carries a ⌘ key.
 */
export const isMacLike: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const agent = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Macintosh|iPhone|iPad|iPod/i.test(agent);
})();

/**
 * The keys that are only ever modifiers. Pressing one on its own is not a
 * chord - it is the first half of one - so recording ignores them and the
 * listener never matches them.
 */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Hyper',
  'Super',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Symbol',
  'Dead',
  'Unidentified',
]);

/**
 * One spelling per key.
 *
 * `KeyboardEvent.key` reports the space bar as a literal space and a letter in
 * whichever case Shift and CapsLock left it; both would make `shift+s` and
 * `shift+S` two different bindings for the same press. Null for a bare
 * modifier, so callers can say "not a chord" without a second check.
 */
export function normaliseKey(raw: string): string | null {
  if (!raw) return null;
  if (raw === ' ' || raw === 'Spacebar') return 'Space';
  if (raw === 'Esc') return 'Escape';
  if (MODIFIER_KEYS.has(raw)) return null;
  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}

/** Every word `parseChord` reads as a modifier - and so never as the key. */
const MODIFIER_WORDS = new Set(['mod', 'cmd', 'command', 'ctrl', 'control', 'meta', 'shift', 'alt', 'option', 'opt']);

/**
 * `mod+shift+ArrowRight` -> a chord, or null when the text names nothing a
 * keyboard can press. Token order is free on the way in (`shift+mod+S` reads
 * the same); `formatChord` is what writes the canonical order back out.
 * `cmd`, `ctrl`, `command` and `control` all mean `mod` - somebody editing the
 * stored JSON by hand should not have to know the one word this file chose.
 */
export function parseChord(text: string): Chord | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // The key is the LAST token. A chord whose key is the plus sign itself ends
  // in '+', which split would read as an empty token - so it is peeled off
  // first and everything before it is a modifier, or the text is not a chord.
  // And with modifiers in front of it, the `+` that JOINS them to the key is
  // peeled off too: `shift++` is Shift and the plus key, not Shift, an empty
  // token, and the plus key. (`mod+` on its own also reads as mod and plus -
  // the one spelling a person typing it can have meant.)
  const plusKey = trimmed.endsWith('+');
  let body = plusKey ? trimmed.slice(0, -1) : trimmed;
  if (plusKey && body.endsWith('+')) body = body.slice(0, -1);
  const tokens = body ? body.split('+') : [];
  const last = plusKey ? '+' : (tokens.pop() ?? '');
  // A modifier's own name is not a key: `shift` alone is half a chord, and
  // `normaliseKey` only knows the event's spelling (`Shift`), not the word a
  // person writes in a stored map.
  if (MODIFIER_WORDS.has(last.trim().toLowerCase())) return null;
  const key = normaliseKey(last);
  if (!key) return null;
  const chord: Chord = { key, mod: false, shift: false, alt: false };
  for (const token of tokens) {
    switch (token.trim().toLowerCase()) {
      case 'mod':
      case 'cmd':
      case 'command':
      case 'ctrl':
      case 'control':
      case 'meta':
        chord.mod = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      case 'alt':
      case 'option':
      case 'opt':
        chord.alt = true;
        break;
      default:
        return null;
    }
  }
  return chord;
}

/** The canonical spelling: modifiers in a fixed order, then the key. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('mod');
  if (chord.alt) parts.push('alt');
  if (chord.shift) parts.push('shift');
  parts.push(chord.key);
  return parts.join('+');
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

/**
 * The chord a key event is, or null when it is not one this app binds: a bare
 * modifier, or a press carrying the platform's OTHER modifier (see the note at
 * the top). `mac` is a parameter rather than read from the module constant so
 * the tests can ask both answers of one event.
 */
export function chordFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean = isMacLike,
): Chord | null {
  const key = normaliseKey(event.key);
  if (!key) return null;
  const foreign = mac ? event.ctrlKey : event.metaKey;
  if (foreign) return null;
  return {
    key,
    mod: mac ? event.metaKey : event.ctrlKey,
    // For a SYMBOL, Shift is already inside the key: `/` is Shift+7 on a German
    // keyboard and `+` is Shift+= on an American one, and the event reports
    // the symbol that came out. Keeping the flag would make those presses
    // `shift+/` and `shift++` - never the `/` and `+` the map is spelled with -
    // so search could not be opened from half the world's layouts. A letter
    // keeps it: `S` and `shift+S` are two different presses on every keyboard.
    shift: event.shiftKey && !isSymbolKey(key),
    alt: event.altKey,
  };
}

/** One printed character that is neither a letter nor a digit. */
function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[\p{L}\p{N}]/u.test(key);
}

/** The narrow face of the translator these caps need: a key in, a word out. */
type CapTranslate = (key: string) => string;

/**
 * Keys with a symbol every keyboard prints the same way. These need no
 * translation; a word would be longer and less familiar than the glyph.
 */
const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** Keys that are a WORD on the cap, and so a word in every language. */
const KEY_WORDS: Record<string, string> = {
  Space: 'keys.capSpace',
  Enter: 'keys.capEnter',
  Escape: 'keys.capEscape',
  Tab: 'keys.capTab',
  Backspace: 'keys.capBackspace',
  Delete: 'keys.capDelete',
  Home: 'keys.capHome',
  End: 'keys.capEnd',
  PageUp: 'keys.capPageUp',
  PageDown: 'keys.capPageDown',
};

/**
 * What to print on the key caps, in the order they are pressed: modifiers
 * first, the key last. A Mac gets its glyphs, because ⌘ ⌥ ⇧ are what its keys
 * are printed with; everywhere else the modifiers are words, and words are
 * the catalogue's business (a German keyboard says Strg, not Ctrl).
 */
export function chordCaps(chord: Chord, t: CapTranslate, mac: boolean = isMacLike): string[] {
  const caps: string[] = [];
  if (chord.mod) caps.push(mac ? '⌘' : t('keys.capCtrl'));
  if (chord.alt) caps.push(mac ? '⌥' : t('keys.capAlt'));
  if (chord.shift) caps.push(mac ? '⇧' : t('keys.capShift'));
  const word = KEY_WORDS[chord.key];
  caps.push(KEY_GLYPHS[chord.key] ?? (word ? t(word) : chord.key));
  return caps;
}
