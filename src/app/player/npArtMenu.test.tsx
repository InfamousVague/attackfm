import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ArtView } from './deckShared.ts';
import { npArtMenuItems } from './npArtMenu.tsx';

/**
 * The art chooser, which is one menu wearing three doorways.
 *
 * The strip's square, the sheet's art and the Canvas clip all open THIS, so
 * the setting stays one setting wherever the press lands - and that is
 * exactly what makes the conditional rows worth pinning. A face offered that
 * cannot draw is a dead end: picking "Chapters" on a song leaves an empty
 * square, and picking "Lyrics" on a book takes away the Chapters face it
 * already had.
 *
 * `t` is passed in as the identity function, so the assertions read as
 * catalogue keys. That is deliberate on two counts: it proves the translator
 * argument is actually consulted rather than ignored in favour of the
 * module-level `translate`, and it keeps this suite from failing every time
 * somebody rewords a menu item.
 */

const key = (k: string) => k;

/**
 * The menu, rendered on its own - MenuItem is a plain button and needs no
 * menu around it, which is the whole reason this helper is testable.
 *
 * Rows are read out of this render's OWN container rather than off `screen`,
 * because several cases below open the menu twice to compare two states and
 * a document-wide query would hand back both menus at once.
 */
function open(
  artView: ArtView,
  opts: { book?: boolean; lyrics?: boolean; visualizer?: boolean; choose?: (next: ArtView) => void } = {},
) {
  const choose = opts.choose ?? vi.fn();
  const { container } = render(
    <>{npArtMenuItems(artView, choose, opts.book ?? false, opts.lyrics ?? false, opts.visualizer ?? false, key)}</>,
  );
  return { choose, rows: [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')] };
}

const labels = (rows: HTMLElement[]) =>
  rows.map((r) => r.querySelector('[class*="label"]')?.textContent ?? '');

/** The tick is a Check glyph in the row's shortcut slot; exactly one row
 *  should ever carry one. */
const tickedRow = (rows: HTMLElement[]) =>
  rows.filter((r) => r.querySelector('svg.lucide-check') !== null);

describe('npArtMenuItems - which faces are offered', () => {
  it('always offers the four a song can always draw', () => {
    const { rows } = open('cd');
    expect(labels(rows)).toEqual([
      'player.artSpinningCd',
      'player.artAlbumCover',
      'player.artAnalyser',
      'player.artHidden',
    ]);
  });

  it('offers Chapters only for a book', () => {
    expect(labels(open('cd', { book: true }).rows)).toContain('books.chapters');
    expect(labels(open('cd').rows)).not.toContain('books.chapters');
  });

  it('offers Lyrics only when the song carries synced words', () => {
    // A song with only plain lyrics keeps the mic popover: a read-along that
    // cannot light a word is worse than no read-along.
    expect(labels(open('cd', { lyrics: true }).rows)).toContain('player.lyrics');
    expect(labels(open('cd').rows)).not.toContain('player.lyrics');
  });

  it('never offers Lyrics for a book, even when asked to', () => {
    // A book has its Chapters face instead, and the two would fight over the
    // same square. `!book && lyrics` - both halves of that condition are load
    // bearing, and dropping the first is invisible until a reading offers a
    // read-along that never lights.
    const { rows } = open('cd', { book: true, lyrics: true });
    expect(labels(rows)).toContain('books.chapters');
    expect(labels(rows)).not.toContain('player.lyrics');
  });

  it('offers the Visualizer only when a plugin is there to fill the square', () => {
    expect(labels(open('cd', { visualizer: true }).rows)).toContain('player.artVisualizer');
    expect(labels(open('cd').rows)).not.toContain('player.artVisualizer');
  });

  it('keeps every face in one order, whichever ones are showing', () => {
    // The rows move under the finger otherwise: a book's menu and a song's
    // would put Analyser in different places.
    expect(labels(open('cd', { book: true, visualizer: true }).rows)).toEqual([
      'player.artSpinningCd',
      'player.artAlbumCover',
      'books.chapters',
      'player.artAnalyser',
      'player.artVisualizer',
      'player.artHidden',
    ]);
  });
});

describe('npArtMenuItems - which face is showing', () => {
  it('ticks exactly one row, and it is the current face', () => {
    const { rows } = open('analyser', { book: true, visualizer: true });
    const ticked = tickedRow(rows);
    expect(ticked).toHaveLength(1);
    expect(labels(ticked)).toEqual(['player.artAnalyser']);
  });

  it('ticks a conditional face as readily as a permanent one', () => {
    // The tick compares against `artView`, not against a position: a book
    // sitting on Chapters must see it ticked.
    expect(labels(tickedRow(open('chapters', { book: true }).rows))).toEqual(['books.chapters']);
    expect(labels(tickedRow(open('lyrics', { lyrics: true }).rows))).toEqual(['player.lyrics']);
  });

  it('ticks nothing when the current face is not on the menu', () => {
    // A song left on 'visualizer' after the plugin was disabled: the row is
    // gone, and no OTHER row may inherit its tick.
    expect(tickedRow(open('visualizer').rows)).toHaveLength(0);
  });
});

describe('npArtMenuItems - choosing', () => {
  it('hands back the face the row names, not the row’s position', () => {
    const choose = vi.fn();
    const { rows } = open('cd', { book: true, visualizer: true, choose });
    rows.forEach((r) => r.click());
    expect(choose.mock.calls.map(([v]) => v)).toEqual([
      'cd',
      'cover',
      'chapters',
      'analyser',
      'visualizer',
      'hidden',
    ]);
  });

  it('offers the face already showing, so the menu can be dismissed by re-picking', () => {
    const choose = vi.fn();
    const { rows } = open('cover', { choose });
    rows[1]!.click();
    expect(choose).toHaveBeenCalledWith('cover');
  });
});
