import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DataGridColumn, DataGridRow } from '@glacier/react';
import { wrapGhostCell, wrapIncomingCell } from './wrapGhostCell.tsx';
import type { GhostRow } from './SongTable.tsx';

/**
 * A row in the song table that is not a song in this library.
 *
 * The point of the mechanism is that a song you HAVE and a song you don't
 * belong to one list, in the same columns and between the same hairlines - so
 * the two ways to be wrong are both about the seam. Draw a real row through
 * the ghost renderer and every song in the library loses its album, its date
 * and its duration at once. Draw a ghost through the real one and the table
 * asks a download-in-flight for fields it has never had.
 *
 * The wrapper is what keeps the two apart, and it does it on ONE fact: is
 * this row's id in the ghost map.
 */

/** A column with a renderer of its own, the way every real column has one. */
const col = (key: string): DataGridColumn => ({
  key,
  header: key,
  render: (row) => <span data-testid="real">real {String(row[key])}</span>,
});

const ghost = (over: Partial<GhostRow> = {}): GhostRow => ({
  key: 'artist|song',
  title: 'Arriving Song',
  ...over,
});

/** The grid's own id shape for a ghost - `ghost:` plus the identity key. */
const ghostRow = (g: GhostRow): DataGridRow => ({ id: `ghost:${g.key}` });
const ghostMap = (g: GhostRow) => new Map([[`ghost:${g.key}`, g]]);

/** Renders one cell and hands back the fragment's markup. */
function cell(column: DataGridColumn, row: DataGridRow) {
  const { container } = render(<>{column.render?.(row, 0)}</>);
  return container;
}

describe('a row that is not a ghost', () => {
  it('falls straight through to the column’s own renderer', () => {
    // The overwhelmingly common case: six thousand real rows and one ghost.
    const wrapped = wrapGhostCell(col('album'), ghostMap(ghost()));
    cell(wrapped, { id: 'afm://1', album: 'Kid A' });
    expect(screen.getByTestId('real')).toHaveTextContent('real Kid A');
  });

  it('falls back to the raw field when the column has no renderer', () => {
    // A plain column (no `render`) is the grid's default, and dropping to
    // null here would silently blank whole columns of real songs.
    const wrapped = wrapGhostCell({ key: 'album', header: 'Album' }, ghostMap(ghost()));
    expect(wrapped.render?.({ id: 'afm://1', album: 'Kid A' }, 0)).toBe('Kid A');
  });

  it('is not fooled by a row that merely looks like a ghost', () => {
    // Membership of the map is the test, not the shape of the id - so a real
    // row is only ever a ghost if this table put it there.
    const wrapped = wrapGhostCell(col('album'), new Map());
    cell(wrapped, { id: 'ghost:artist|song', album: 'Kid A' });
    expect(screen.getByTestId('real')).toBeTruthy();
  });
});

describe('a ghost song', () => {
  it('wears its title and its status line in the title cell', () => {
    const g = ghost({ note: 'Artist — downloading' });
    const c = cell(wrapGhostCell(col('title'), ghostMap(g)), ghostRow(g));
    expect(screen.getByText('Arriving Song')).toBeTruthy();
    expect(screen.getByText('Artist — downloading')).toBeTruthy();
    // ...and it is marked as one, which is what the styling hangs off.
    expect(c.querySelector('[data-ghost]')).toBeTruthy();
    expect(screen.queryByTestId('real')).toBeNull();
  });

  it('prefers the note to the credit, because the note is why the row is here', () => {
    // Both are offered; a row showing the artist where a status belongs is a
    // row that looks settled while it is still on the wire.
    const g = ghost({ note: 'waiting its turn', artist: 'Artist' });
    cell(wrapGhostCell(col('title'), ghostMap(g)), ghostRow(g));
    expect(screen.getByText('waiting its turn')).toBeTruthy();
    expect(screen.queryByText('Artist')).toBeNull();
  });

  it('shows the credit when there is no status, and neither line when there is neither', () => {
    const credited = ghost({ artist: 'Artist' });
    const c1 = cell(wrapGhostCell(col('title'), ghostMap(credited)), ghostRow(credited));
    expect(c1.querySelector('.songArtist--status')?.textContent).toBe('Artist');
    const bare = ghost();
    const c2 = cell(wrapGhostCell(col('title'), ghostMap(bare)), ghostRow(bare));
    expect(c2.querySelector('.songArtist--status')).toBeNull();
  });

  it('draws NOTHING in the columns it cannot answer', () => {
    /*
     * Album, date and on-device are facts about a file on this box, and a
     * song still arriving has none of them. Anything but a blank here is the
     * table inventing an answer - and `render` returning undefined would let
     * the grid fall back to `row[key]`, printing "undefined" down the column.
     */
    const g = ghost({ note: 'downloading' });
    for (const key of ['album', 'addedAt', 'onDevice']) {
      expect(wrapGhostCell(col(key), ghostMap(g)).render?.(ghostRow(g), 0)).toBeNull();
    }
  });

  it('puts the leading mark in the index column and the verbs in the duration one', () => {
    // The spinner takes the row-number slot and the cancel/retry buttons take
    // the running time's, so a ghost occupies the grid's columns rather than
    // widening it.
    const g = ghost({
      lead: <span data-testid="spinner" />,
      action: <button type="button" data-testid="cancel" />,
    });
    cell(wrapGhostCell(col('index'), ghostMap(g)), ghostRow(g));
    expect(screen.getByTestId('spinner')).toBeTruthy();
    const c = cell(wrapGhostCell(col('duration'), ghostMap(g)), ghostRow(g));
    expect(screen.getByTestId('cancel')).toBeTruthy();
    expect(c.querySelector('.incomingCell__actions')).toBeTruthy();
  });

  it('leaves those two cells blank when the ghost has no mark and no verb', () => {
    // A chart row nobody owns has neither; an empty <span> wrapper would draw
    // its padding into a column that should read as empty.
    const g = ghost();
    expect(wrapGhostCell(col('index'), ghostMap(g)).render?.(ghostRow(g), 0)).toBeNull();
    expect(wrapGhostCell(col('duration'), ghostMap(g)).render?.(ghostRow(g), 0)).toBeNull();
  });
});

describe('a heading ghost', () => {
  it('owns the row: its label in the title cell and nothing anywhere else', () => {
    /*
     * A disc break. The grid has no concept of a spanning cell, so the label
     * goes in the widest column - where the eye already is - and every other
     * cell of that row must stay empty or the break reads as a song with a
     * very odd name.
     */
    const g = ghost({ kind: 'heading', title: 'Disc 2', note: 'ignored', action: <button type="button" /> });
    const c = cell(wrapGhostCell(col('title'), ghostMap(g)), ghostRow(g));
    expect(c.querySelector('.songSection')?.textContent).toBe('Disc 2');
    for (const key of ['index', 'album', 'addedAt', 'duration']) {
      expect(wrapGhostCell(col(key), ghostMap(g)).render?.(ghostRow(g), 0)).toBeNull();
    }
  });
});

describe('the older name', () => {
  it('is the same function, so nothing that kept calling it changed behaviour', () => {
    // `wrapIncomingCell` is what this was born as, kept so callers outside
    // did not have to move. An alias that had drifted into a copy would be
    // two renderers to keep in step.
    expect(wrapIncomingCell).toBe(wrapGhostCell);
  });
});
