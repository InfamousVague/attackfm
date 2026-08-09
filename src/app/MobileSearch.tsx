import { IconButton, SearchField } from '@glacier/react';
import { ChevronLeft, Search } from '@glacier/icons';
import { useEffect, useRef } from 'react';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

// eslint note: SearchField is a plain function, not forwardRef, so the input is
// reached through the sheet root rather than a ref on the field itself.

/** A plugin action row, as the runtime hands it to the palette. */
export interface CommandRow {
  id: string;
  label: string;
  group?: string;
}

interface MobileSearchProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Matching library tracks (rich rows). Empty when a plugin claims the query. */
  tracks: Track[];
  /** Plugin action rows (e.g. "Import this link"). */
  commands: CommandRow[];
  /** Run a plugin command by id. */
  onRunCommand: (id: string) => void;
  /** Play a track and dismiss. */
  onPlayTrack: (track: Track) => void;
}

// Without a virtual list this view renders real DOM per row, so a bare query
// that matches half the library is capped - a search that broad is meant to be
// narrowed, not scrolled.
const MAX_ROWS = 100;

/**
 * The phone's search: a full-screen sheet rather than the desktop's centered
 * command palette. A field pinned to the top under the status bar, then the
 * results filling the rest of the screen as a plain tappable list - the shape a
 * phone search wants, with room for artwork and a thumb-sized target per row.
 *
 * It is a pure view: all the matching, the plugin commands, and the play wiring
 * live in SongSearch, which renders this on mobile and the CommandPalette on the
 * desktop from one set of state, so the two can never drift.
 */
export function MobileSearch({
  open,
  onClose,
  query,
  onQueryChange,
  tracks,
  commands,
  onRunCommand,
  onPlayTrack,
}: MobileSearchProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Focus the field the moment the sheet opens, and let Escape close it (a
  // hardware keyboard, or a desktop browser emulating the phone layout).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => rootRef.current?.querySelector('input')?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const searching = query.trim().length > 0;
  const shown = tracks.slice(0, MAX_ROWS);
  const overflow = tracks.length - shown.length;
  const nothing = searching && commands.length === 0 && tracks.length === 0;

  return (
    <div className="mobileSearch" role="dialog" aria-modal="true" aria-label="Search" ref={rootRef}>
      <header className="mobileSearch__bar">
        <IconButton variant="ghost" size="sm" aria-label="Close search" onClick={onClose}>
          <ChevronLeft size={20} />
        </IconButton>
        <SearchField
          className="mobileSearch__field"
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search songs, artists, albums, lyrics"
          aria-label="Search songs, artists, albums, lyrics"
        />
      </header>

      <div className="mobileSearch__results">
        {commands.length > 0 && (
          <ul className="mobileSearch__list">
            {commands.map((c) => (
              <li key={c.id}>
                <button type="button" className="mobileSearchRow" onClick={() => onRunCommand(c.id)}>
                  <span className="mobileSearchRow__glyph" aria-hidden>
                    <Search size={18} />
                  </span>
                  <span className="mobileSearchRow__body">
                    <span className="mobileSearchRow__title">{c.label}</span>
                    {c.group && <span className="mobileSearchRow__sub">{c.group}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {searching && shown.length > 0 && (
          <ul className="mobileSearch__list">
            {shown.map((t) => (
              <li key={t.path}>
                <button type="button" className="mobileSearchRow" onClick={() => onPlayTrack(t)}>
                  <img
                    className="mobileSearchRow__art"
                    src={t.artwork ?? placeholderArt}
                    alt=""
                    loading="lazy"
                  />
                  <span className="mobileSearchRow__body">
                    <span className="mobileSearchRow__title">{t.title}</span>
                    <span className="mobileSearchRow__sub">{t.artist}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {overflow > 0 && (
          <p className="mobileSearch__note">
            Showing the first {MAX_ROWS} — keep typing to narrow {overflow.toLocaleString()} more.
          </p>
        )}

        {nothing && <p className="mobileSearch__note">No songs match “{query.trim()}”.</p>}

        {!searching && commands.length === 0 && (
          <div className="mobileSearch__hint">
            <Search size={26} />
            <p>Search your library by song, artist, album, or a line of lyrics.</p>
          </div>
        )}
      </div>
    </div>
  );
}
