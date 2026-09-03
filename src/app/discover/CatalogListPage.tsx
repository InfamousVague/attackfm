import { Button, Text } from '@glacier/react';
import { Check, ListMusic, Play, Plus } from '@glacier/icons';
import { useMemo } from 'react';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { formatClock } from '../ux/format.ts';
import { fold } from '../core/fold.ts';
import { useLibrary } from '../library/library.tsx';
import { titleKey } from '../library/owned.ts';
import type { Suggestion } from '../api/curator.ts';
import type { Track } from '../core/tauri.ts';

/**
 * A catalogue list, opened as a page: what is actually on it, before you
 * decide to take it.
 *
 * The suggestion cards on Discover were one tap and one meaning - the tap WAS
 * the import, fifty songs on the strength of a title and a picture. The list
 * itself was already on the wire the whole time: the server reads the public
 * embed for the title and cover, and that same read carries every song with
 * its artist and length. Nothing rendered it. So this is that read, drawn.
 *
 * It wears the mix page's clothes - same head, same rows, same stylesheet -
 * because a list is a list and this should not become a third way of drawing
 * one. What it cannot wear is the mix page's BEHAVIOUR: these songs are not in
 * the library, so there is nothing to play and no track to hand a menu to.
 * Rows the library turns out to already hold are the exception, and they are
 * marked and playable - which is also the honest answer to "how much of this
 * do I already have", asked before the download rather than found out after.
 *
 * The one verb is Add, and it does exactly what tapping the card used to do.
 */
export function CatalogListPage({
  suggestion,
  onPlay,
  onOpenArtist,
  onAdd,
  adding,
}: {
  suggestion: Suggestion;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Hand the whole list to whatever fetches things on this box. */
  onAdd: () => void;
  /** Where the list has got to, read from the download queue. */
  adding: 'idle' | 'adding' | 'added';
}) {
  const { tracks } = useLibrary();

  /*
   * The list, as rows. `items` is the shape a page wants - artist and length
   * per song - and `tracks` is the older titles-only shape, which still draws
   * a readable list, just without an artist column.
   */
  const rows = useMemo(() => {
    if (suggestion.items?.length) {
      return suggestion.items.map((i) => ({
        title: i.title,
        artist: i.artist ?? '',
        seconds: i.durationMs ? i.durationMs / 1000 : null,
      }));
    }
    return (suggestion.tracks ?? []).map((t) => ({ title: t, artist: '', seconds: null }));
  }, [suggestion]);

  /*
   * Which of these the library already holds, folded the way the rest of the
   * app matches a name to a song. A titles-only row can only match on the
   * title, which is looser than this app usually allows - but the alternative
   * on an older server is marking nothing at all, and being wrong here costs a
   * tick on a row, not a download.
   */
  const owned = useMemo(() => {
    const byPair = new Map<string, Track>();
    const byTitle = new Map<string, Track>();
    for (const t of tracks) {
      const key = titleKey(t.title);
      byPair.set(`${fold(t.artist)}${key}`, t);
      if (!byTitle.has(key)) byTitle.set(key, t);
    }
    return rows.map((r) =>
      r.artist
        ? (byPair.get(`${fold(r.artist)}${titleKey(r.title)}`) ?? null)
        : (byTitle.get(titleKey(r.title)) ?? null),
    );
  }, [rows, tracks]);

  const have = useMemo(() => owned.filter((t): t is Track => t !== null), [owned]);
  const count = suggestion.trackCount ?? rows.length;
  const kicker = suggestion.source
    ? `${suggestion.source[0]!.toUpperCase()}${suggestion.source.slice(1)} playlist`
    : 'Playlist';

  return (
    /* The mix page's own frame, for the reasons written there: `.homePage` is
       the scroller and carries the inset that holds the last row clear of the
       player bar and the nav. */
    <div className="homePage libraryPage playlistPage">
      <header className="playlistHead">
        <div className="playlistHead__cover">
          <div className="tileSquircle tileRecent playlistHead__mosaic">
            {suggestion.cover ? <img src={suggestion.cover} alt="" /> : <ListMusic size={28} />}
          </div>
        </div>

        <div className="playlistHead__body">
          {/* The kicker names whose list this is, which is the one thing that
              explains why the verb below is Add and not Play. */}
          <Text tone="muted" size="xs" className="playlistHead__kicker">
            {kicker}
          </Text>
          <h2 className="playlistHead__name">{suggestion.title}</h2>
          <Text tone="muted" size="sm">
            {count} {count === 1 ? 'song' : 'songs'}
            {rows.length > 0 ? ` · ${have.length} already yours` : ''}
          </Text>

          <div className="playlistHead__actions">
            {/* Play is offered only for what is HERE, and says so rather than
                counting: a Play that silently skipped four fifths of a list
                would be a lie about what you were about to hear, and the
                number is already in the line above. */}
            {have.length > 0 && (
              <Button variant="solid" size="sm" onClick={() => have[0] && onPlay(have[0], have)}>
                <Play size={15} />
                {have.length === rows.length ? 'Play' : 'Play yours'}
              </Button>
            )}
            <Button
              variant={have.length > 0 ? 'soft' : 'solid'}
              size="sm"
              disabled={adding !== 'idle'}
              onClick={onAdd}
            >
              {adding === 'added' ? <Check size={15} /> : <Plus size={15} />}
              {adding === 'added'
                ? 'In your library'
                : adding === 'adding'
                  ? 'Adding…'
                  : 'Add the list'}
            </Button>
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="search" />
          <Text tone="muted">
            This server did not send the songs on this list. It can still be added whole.
          </Text>
        </div>
      ) : (
        <div className="playlistPageScroll">
          <div className="playlistRows">
            {rows.map((row, i) => {
              const mine = owned[i] ?? null;
              return (
                <div
                  key={`${row.title}-${i}`}
                  className="playlistRow catalogRow"
                  data-owned={mine ? '' : undefined}
                >
                  {/*
                    The playlist row's own body, down to the class names, so
                    the phone gets what it gets everywhere else: no room for
                    an artist column, so the artist folds under the title -
                    and on THIS page that fold is the difference between a
                    list of songs and a list of titles you do not recognise.
                    A div with the button role rather than a button, for
                    RowMain's reason: the artist inside it must stay its own
                    control, and a button inside a button is not honoured.
                    Owned rows play; the rest are a reading of the list.
                  */}
                  <div
                    role={mine ? 'button' : undefined}
                    tabIndex={mine ? 0 : undefined}
                    className="playlistRow__main catalogRow__main"
                    onClick={() => mine && onPlay(mine, have)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || !mine) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPlay(mine, have);
                      }
                    }}
                  >
                    <span className="catalogRow__n" aria-hidden>
                      {mine ? <Play size={13} /> : i + 1}
                    </span>
                    <span className="playlistRow__text">
                      <span className="songTitle">{row.title}</span>
                      {row.artist && (
                        <button
                          type="button"
                          className="songArtist songArtistLink"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenArtist(row.artist);
                          }}
                        >
                          {row.artist}
                        </button>
                      )}
                    </span>
                  </div>
                  {row.artist ? (
                    <button
                      type="button"
                      className="songArtist songArtistLink playlistRow__artist"
                      onClick={() => onOpenArtist(row.artist)}
                    >
                      {row.artist}
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className="songMuted playlistRow__time">
                    {row.seconds != null ? formatClock(row.seconds, '--:--') : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
