import type { DataGridColumn } from '@glacier/react';
import type { ReactNode } from 'react';
import { SongArt } from './SongArt.tsx';
import type { GhostRow } from './SongTable.tsx';

/**
 * Give a resolved column a second life for rows that are not songs here.
 *
 * A real row falls straight through to the column's own renderer; a ghost (id
 * `ghost:<key>`) gets the cell that fits its column. Everything a ghost cannot
 * answer - album, date, on-device - draws nothing, exactly as a blank should.
 *
 * Wrapped here, once, so no column definition in the table has to know ghosts
 * exist.
 */
export function wrapGhostCell(
  col: DataGridColumn,
  ghostById: Map<string, GhostRow>,
): DataGridColumn {
  const base = col.render;
  return {
    ...col,
    render: (row, rowIndex) => {
      const g = ghostById.get(row.id as string);
      if (!g) return base ? base(row, rowIndex) : (row[col.key] as ReactNode);
      // A heading owns the row. It draws in the TITLE cell rather than a
      // spanning one because the grid has no concept of a spanning cell -
      // and the title is the widest column, so the label lands where the eye
      // already is. Every other cell stays empty.
      if (g.kind === 'heading') {
        return col.key === 'title' ? (
          <span className="songSection">{g.title}</span>
        ) : null;
      }
      switch (col.key) {
        case 'index':
          return g.lead ?? null;
        case 'title':
          return (
            <div className="songTitleCell" data-incoming data-ghost>
              <SongArt artwork={g.artwork ?? null} />
              <div className="songTitleText">
                <span className="songTitle">
                  <span className="songTitle__name">{g.title}</span>
                </span>
                {(g.note || g.artist) && (
                  <span className="songArtist songArtist--status">{g.note ?? g.artist}</span>
                )}
              </div>
            </div>
          );
        case 'duration':
          return g.action ? <span className="incomingCell__actions">{g.action}</span> : null;
        default:
          return null;
      }
    },
  };
}

/** The name this was born with, kept so nothing outside has to change. */
export const wrapIncomingCell = wrapGhostCell;
