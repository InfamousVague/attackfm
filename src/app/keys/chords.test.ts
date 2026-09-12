/**
 * The chord model: what a press is called, and that the name round-trips.
 *
 * The properties that matter are the ones a keymap depends on for its life:
 * the same press spelled the same way whatever case Shift left a letter in,
 * `mod` meaning ⌘ on one machine and Ctrl on the other from ONE stored
 * string, and a bare modifier never counting as a chord (a recording that
 * accepted "Shift" would bind the first half of every chord).
 */
import { describe, expect, it } from 'vitest';
import { chordCaps, chordFromEvent, chordsEqual, formatChord, normaliseKey, parseChord } from './chords.ts';

const press = (over: Partial<KeyboardEvent> & { key: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('normaliseKey', () => {
  it('spells the space bar and letters one way', () => {
    expect(normaliseKey(' ')).toBe('Space');
    expect(normaliseKey('Spacebar')).toBe('Space');
    expect(normaliseKey('s')).toBe('S');
    expect(normaliseKey('S')).toBe('S');
    expect(normaliseKey('Esc')).toBe('Escape');
    expect(normaliseKey('ArrowLeft')).toBe('ArrowLeft');
  });

  it('refuses a bare modifier', () => {
    for (const key of ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Dead', '']) {
      expect(normaliseKey(key)).toBeNull();
    }
  });
});

describe('parseChord / formatChord', () => {
  it('round-trips the canonical spelling', () => {
    for (const text of ['Space', 'S', 'mod+K', 'shift+ArrowLeft', 'mod+alt+shift+ArrowRight', '/']) {
      const chord = parseChord(text);
      expect(chord).not.toBeNull();
      expect(formatChord(chord!)).toBe(text);
    }
  });

  it('accepts any modifier order and the platform names, and writes one order back', () => {
    expect(formatChord(parseChord('shift+mod+s')!)).toBe('mod+shift+S');
    expect(formatChord(parseChord('cmd+S')!)).toBe('mod+S');
    expect(formatChord(parseChord('ctrl+S')!)).toBe('mod+S');
    expect(formatChord(parseChord('option+S')!)).toBe('alt+S');
  });

  it('can name the plus key itself', () => {
    expect(parseChord('+')).toEqual({ key: '+', mod: false, shift: false, alt: false });
    expect(formatChord(parseChord('shift++')!)).toBe('shift++');
  });

  it('returns null for nothing a keyboard can press', () => {
    expect(parseChord('')).toBeNull();
    expect(parseChord('shift')).toBeNull();
    expect(parseChord('bogus+S')).toBeNull();
    expect(parseChord('mod+')).toEqual({ key: '+', mod: true, shift: false, alt: false });
  });
});

describe('chordFromEvent', () => {
  it('reads mod as ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(chordFromEvent(press({ key: 'k', metaKey: true }), true)).toEqual({
      key: 'K',
      mod: true,
      shift: false,
      alt: false,
    });
    expect(chordFromEvent(press({ key: 'k', ctrlKey: true }), false)).toEqual({
      key: 'K',
      mod: true,
      shift: false,
      alt: false,
    });
  });

  it("refuses the platform's other modifier, so Ctrl+S on a Mac is not S", () => {
    expect(chordFromEvent(press({ key: 's', ctrlKey: true }), true)).toBeNull();
    expect(chordFromEvent(press({ key: 's', metaKey: true }), false)).toBeNull();
  });

  it('ignores a modifier pressed on its own', () => {
    expect(chordFromEvent(press({ key: 'Shift', shiftKey: true }), true)).toBeNull();
  });

  it('leaves Shift out of a symbol, where it is already in the key', () => {
    // `/` is Shift+7 on a German keyboard and `+` is Shift+= on an American
    // one: the event reports the symbol that came out, with shiftKey set.
    expect(formatChord(chordFromEvent(press({ key: '/', shiftKey: true }), false)!)).toBe('/');
    expect(formatChord(chordFromEvent(press({ key: '+', shiftKey: true }), false)!)).toBe('+');
    // A letter and a named key keep it.
    expect(formatChord(chordFromEvent(press({ key: 'ArrowRight', shiftKey: true }), false)!)).toBe(
      'shift+ArrowRight',
    );
    expect(formatChord(chordFromEvent(press({ key: ' ', shiftKey: true }), false)!)).toBe('shift+Space');
  });

  it('spells shift+letter the same whatever case the letter arrived in', () => {
    const upper = chordFromEvent(press({ key: 'S', shiftKey: true }), true)!;
    const lower = chordFromEvent(press({ key: 's', shiftKey: true }), true)!;
    expect(chordsEqual(upper, lower)).toBe(true);
    expect(formatChord(upper)).toBe('shift+S');
  });
});

describe('chordCaps', () => {
  const t = (key: string) => `<${key}>`;

  it('prints glyphs on a Mac and catalogue words elsewhere', () => {
    const chord = parseChord('mod+shift+ArrowRight')!;
    expect(chordCaps(chord, t, true)).toEqual(['⌘', '⇧', '→']);
    expect(chordCaps(chord, t, false)).toEqual(['<keys.capCtrl>', '<keys.capShift>', '→']);
  });

  it('names the word keys through the catalogue and leaves letters alone', () => {
    expect(chordCaps(parseChord('Space')!, t, true)).toEqual(['<keys.capSpace>']);
    expect(chordCaps(parseChord('Escape')!, t, true)).toEqual(['<keys.capEscape>']);
    expect(chordCaps(parseChord('S')!, t, true)).toEqual(['S']);
    expect(chordCaps(parseChord('/')!, t, true)).toEqual(['/']);
  });
});
