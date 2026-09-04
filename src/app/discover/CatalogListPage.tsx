import { Button, Text } from '@glacier/react';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { Check, ListMusic, Play, Plus } from '@glacier/icons';
import { useMemo } from 'react';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { SongTable, type GhostRow, type SongTableShape } from '../library/SongTable.tsx';
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

  /*
   * The songs on this list that are not here, seated where they belong.
   *
   * `at` counts the OWNED songs before each one, because that is the index the
   * table splices against - the same arithmetic the album page uses for its
   * holes. Get it wrong and a chart reads in the right order with the wrong
   * gaps.
   */
  const catalogueGhosts = useMemo<GhostRow[]>(() => {
    const out: GhostRow[] = [];
    let ownedSoFar = 0;
    rows.forEach((row, i) => {
      if (owned[i]) {
        ownedSoFar += 1;
        return;
      }
      out.push({
        key: `${i}:${row.title}`,
        title: row.title,
        note: row.artist || undefined,
        lead: i + 1,
        at: ownedSoFar,
      });
    });
    return out;
  }, [rows, owned]);

  const catalogueShape = useMemo<SongTableShape>(
    () => ({
      // A chart's rows come from a catalogue, not from this library: the album
      // is often absent, the scan date is meaningless, and "on this device"
      // would answer for the handful that are here and blank for the rest.
      hide: ['album', 'addedAt', 'onDevice'],
      fixedOrder: true,
      // The published position, not a count of what survived - so row 7 is the
      // list's seventh song whether or not you have the six above it.
      lead: (t) => {
        const at = rows.findIndex((_, i) => owned[i]?.path === t.path);
        return at === -1 ? '' : at + 1;
      },
      empty: 'This server did not send the songs on this list.',
    }),
    [rows, owned],
  );

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

          <EdgeScrollRow className="playlistHead__actions">
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
          </EdgeScrollRow>
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
        <div className="pageSongs">
          {/*
            The list as one table, whether or not you own the songs in it.
            Owned rows are real rows and play; the rest are ghosts sitting in
            their own place in the running order, so the list reads as the list
            somebody published rather than as the subset that happens to be
            here. This page's own note said it should not become a third way of
            drawing a list - now there is only one.
          */}
          <SongTable
            flow
            defaultSort={null}
            tracks={have}
            ghosts={catalogueGhosts}
            onPlay={(track) => onPlay(track, have)}
            onOpenArtist={onOpenArtist}
            shape={catalogueShape}
          />
        </div>
      )}
    </div>
  );
}
