import { Button, Text } from '@glacier/react';
import { Check, Disc3, Play, Plus, Shuffle, Sparkles, X } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import { PROBE_URL, importable, resolveImportable } from '../search/resolveImport.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import { shuffled } from '../ux/shuffle.ts';
import { artSized, fetchAlbumTracks, type AlbumTrack } from '../server.ts';
import { SongTable, type GhostRow, type SongTableShape } from '../library/SongTable.tsx';
import { setHeaderActions } from '../nav/headerActions.ts';
import { albumCredit, byRunningOrder, isBy, nameFold } from './albums.ts';
import { titleKey } from '../library/owned.ts';
import type { Track } from '../core/tauri.ts';
import { DjCollectionTraitSheet } from '../booth/DjTraitSheet.tsx';
import { formatTotal } from '../ux/format.ts';

/**
 * One record, opened.
 *
 * Until now a tap on an album PLAYED it, which is the one thing a listener can
 * already do from the shelf and not the thing they were reaching for: an album
 * cover is a door. There was nowhere to go - no album page existed - so this
 * is that page, and it deliberately answers the questions the artist page
 * cannot: what is actually on this record, in the order it was meant to run,
 * which of it is yours, and how long it is.
 *
 * The tracks are gathered by the same rules the artist page uses (albums.ts),
 * so the two can never disagree about what is on a record - the disagreement
 * being exactly what made the counts on the artist page wrong.
 */

interface AlbumPageProps {
  album: string;
  /** Who the shelf credited it to, which is how it was reached. Kept so two
   *  different records with one title do not collapse into each other. */
  artist: string;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** The album no longer exists in the library - every track of it removed. */
  onGone: () => void;
}

/** The cover, with the skeleton-then-pop every other art on the page wears. */
function Cover({ art }: { art: string | null }) {
  const src = artSized(art, 640) ?? null;
  const load = useArtLoad(src, '');
  if (!src) {
    return (
      <div className="albumHead__cover albumHead__cover--glyph" aria-hidden>
        <Disc3 size={40} />
      </div>
    );
  }
  return <img {...load} className="albumHead__cover" src={src} alt="" />;
}

export function AlbumPage({ album, artist, onPlay, onOpenArtist, onGone }: AlbumPageProps) {
  const { tracks } = useLibrary();
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const acquire = useAcquire();
  const [mixing, setMixing] = useState(false);

  // Every track on this record: the album name matches, and the artist is one
  // of its credits - the second half being what keeps two different records
  // called "Greatest Hits" apart.
  const list = useMemo(() => {
    const want = nameFold(album);
    return tracks.filter((t) => nameFold(t.album || 'Unknown album') === want && isBy(t, artist))
      .slice()
      .sort(byRunningOrder);
  }, [tracks, album, artist]);

  /*
   * Every hook sits above the empty check below, because hooks must: a render
   * that bails early would call fewer of them than the one before it, which
   * React treats as a broken component and tears the whole app down. This page
   * exists because that rule was broken once already on PlaylistPage.
   */
  // The page root is STATE, not a ref: this component's first renders return
  // null while the tracks are still arriving (the bail below), so the elements
  // do not exist when a mount-time effect would look for them - and neither
  // `album` nor `artist` changes when they finally do. A state-carried node is
  // what re-runs the observer effect the moment the page actually renders.
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    // The sentinel mounts in the same commit as the root, so keying on the
    // root alone is enough to see them both.
    const mark = sentinelRef.current;
    if (!pageEl || !mark) return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry?.isIntersecting), {
      root: pageEl,
      threshold: 0,
    });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [pageEl, album, artist]);

  /*
   * The rest of the record, from the catalogue.
   *
   * A catalogue's album entry carries no songs, only a link to them, so
   * this is a second request per record - which is why the artist page
   * could never show it and this page has to ask for itself. It arrives
   * after the songs you own and only adds the holes: nothing above waits
   * on it, and a catalogue that cannot be reached leaves the page as your
   * own copy rather than claiming the record is complete.
   */
  const [catalogue, setCatalogue] = useState<AlbumTrack[]>([]);
  const [adding, setAdding] = useState<Record<string, 'finding' | 'added' | 'missing'>>({});
  useEffect(() => {
    setCatalogue([]);
    setAdding({});
    if (!session) return;
    const ctrl = new AbortController();
    void fetchAlbumTracks(session, artist, album, ctrl.signal)
      .then(setCatalogue)
      .catch(() => {
        // Older server, a record the catalogue does not list, or no
        // network. All three mean the same thing here: show what you have.
      });
    return () => ctrl.abort();
  }, [session, artist, album]);

  const cover = list.find((t) => t.artwork)?.artwork ?? null;
  const handlers = useRef<{ playAll: () => void; shuffleAll: () => void }>({
    playAll: () => {},
    shuffleAll: () => {},
  });
  useEffect(() => {
    if (!stuck || list.length === 0) return;
    setHeaderActions({
      title: album,
      art: cover,
      play: () => handlers.current.playAll(),
      shuffle: () => handlers.current.shuffleAll(),
      disabled: false,
    });
    return () => setHeaderActions(null);
  }, [stuck, album, cover, list.length]);

  /*
   * A record whose last track was deleted is not a page; step back rather than
   * stand on an empty one.
   *
   * The hard part is that "no tracks yet" and "no such album" look identical
   * from here, and only one is a reason to leave. The library's own `loading`
   * cannot tell them apart - it is hardcoded false for a server library, where
   * the tracks arrive over the network well after this mounts - so a naive
   * check bounces straight back out of a page opened on a cold start.
   *
   * Two things say the album is really gone: having HELD it and lost it, or a
   * library that has songs in it and none of them this record's.
   */
  const everHad = useRef(false);
  useEffect(() => {
    if (list.length > 0) {
      everHad.current = true;
      return;
    }
    if (everHad.current || tracks.length > 0) onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the transition, not on onGone changing
  }, [list.length, tracks.length]);

  // Still arriving: hold the page rather than flash an empty one on the way.
  if (list.length === 0) return null;

  const credit = albumCredit(list);
  // The server's `owned` is a snapshot from when the reply was built; the
  // local check is what makes a song stop being offered the moment it
  // lands, without asking the catalogue again.
  const heldTitles = new Set(list.map((t) => titleKey(t.title)));
  const totalSeconds = list.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const year = list.find((t) => t.year)?.year ?? null;
  // Discs only announce themselves on a set that has more than one; a single
  // disc wearing a "Disc 1" heading is a label for a distinction that is not
  // being made.
  const discs = [...new Set(list.map((t) => t.discNo ?? 1))].sort((a, b) => a - b);

  /*
   * The record as it actually is: your songs, plus the ones the catalogue says
   * belong here and you do not have, dimmed and one tap from being pulled.
   *
   * Grouped by the catalogue's own disc numbers, because positions restart on
   * every disc of a set - a deluxe's bonus disc opens at track 1 again, and
   * without the disc a hole there would land on top of side one. Discs the
   * catalogue knows and this library has nothing from (that whole unowned
   * bonus disc) get sections of their own after the ones you hold.
   */
  const missing =
    catalogue.length === 0
      ? []
      : catalogue.filter((c) => !c.owned && !heldTitles.has(titleKey(c.title)));
  const gapsByDisc = new Map<number, typeof missing>();
  for (const row of missing) {
    const disc = row.disc ?? 1;
    gapsByDisc.set(disc, [...(gapsByDisc.get(disc) ?? []), row]);
  }
  const gapOnlyDiscs = [...gapsByDisc.keys()]
    .filter((d) => !discs.includes(d))
    .sort((a, b) => a - b);
  const shownDiscs = [...discs, ...gapOnlyDiscs];
  const labelDiscs = shownDiscs.length > 1;

  /*
   * The record in running order, holes and all - flattened.
   *
   * What you own and what you don't share one list, sorted by the sleeve's own
   * numbers, so track 3 sits between 2 and 4 whether or not it is yours. Each
   * disc takes only its own holes: positions restart per disc, so a bonus
   * disc's track 1 belongs beside its neighbours and not on side one.
   *
   * That logic is unchanged from the hand-rolled list this replaces; what is
   * new is that it produces ONE flat sequence rather than a section per disc.
   * A table per disc would have been the easier port and the wrong one: each
   * would get its own sort, its own selection, its own keyboard grid and its
   * own now-playing follow, so a record would behave like several lists that
   * happen to be stacked. The disc break is a row instead.
   */
  const { ordered, albumGhosts } = useMemo(() => {
    const songs: Track[] = [];
    const ghosts: GhostRow[] = [];
    for (const disc of shownDiscs) {
      // The break goes in before the disc's first row, at the seat the next
      // song is about to take.
      if (labelDiscs) {
        ghosts.push({ key: `disc-${disc}`, kind: 'heading', title: `Disc ${disc}`, at: songs.length });
      }
      const owned = list
        .filter((t) => (t.discNo ?? 1) === disc)
        .map((track, index) => ({ pos: track.trackNo ?? index + 1, track }));
      const holes = (gapsByDisc.get(disc) ?? []).map((row) => ({ pos: row.position, row }));
      const merged: ({ pos: number; track?: Track; row?: AlbumTrack })[] = [...owned, ...holes];
      merged.sort((a, b) => a.pos - b.pos || (a.track ? -1 : 1));
      for (const entry of merged) {
        if (entry.track) {
          songs.push(entry.track);
        } else if (entry.row) {
          const row = entry.row;
          ghosts.push({
            key: `${row.disc ?? 1}:${row.position}:${row.title}`,
            title: row.title,
            // The sleeve's number, same column as an owned row's, so the
            // record reads as one list down one column.
            lead: row.position,
            at: songs.length,
          });
        }
      }
    }
    return { ordered: songs, albumGhosts: ghosts };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gapsByDisc is rebuilt each render from `missing`
  }, [list, shownDiscs.join(','), labelDiscs, missing]);

  /**
   * Pull one missing song. The catalogue's own link is a Deezer one, which
   * the importer will not take, so it is resolved to something importable
   * first - the same two-step the artist page's gap rows use, and the same
   * reason it takes a beat and can come back empty.
   */
  const addMissing = async (row: AlbumTrack) => {
    const key = `${row.disc ?? 1}:${row.position}:${row.title}`;
    if (!session || adding[key]) return;
    setAdding((prev) => ({ ...prev, [key]: 'finding' }));
    const take = (url: string) => {
      const target: AcquireTarget = { kind: 'track', title: row.title, artist, url };
      const viaImporter = acquire
        .handlersFor(target)
        .some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
      if (viaImporter && downloads) void downloads.enqueue(url).catch(() => {});
      else acquire.acquire(target);
    };
    if (importable({ url: row.url })) {
      take(row.url);
      setAdding((prev) => ({ ...prev, [key]: 'added' }));
      return;
    }
    let found = null;
    try {
      found = await resolveImportable(session, 'track', artist, row.title);
    } catch {
      // Same outcome as not being there.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [key]: 'missing' }));
      return;
    }
    take(found.url);
    setAdding((prev) => ({ ...prev, [key]: 'added' }));
  };

  /*
   * The Add button on a hole, and the page's cut of the table.
   *
   * Attached out here rather than inside the memo above because `adding` is
   * the one volatile thing on these rows - the memo holds the ORDER, which
   * only moves when the record does, and this holds the button, which moves
   * on every press.
   */
  const ghostsWithActions = useMemo<GhostRow[]>(
    () =>
      albumGhosts.map((g) => {
        if (g.kind === 'heading') return g;
        const state = adding[g.key];
        return {
          ...g,
          action: (
            <button
              type="button"
              className="incomingCell__act"
              disabled={!session || state === 'finding' || state === 'added'}
              aria-label={`Add ${g.title}`}
              title={
                state === 'missing'
                  ? 'Not found to import'
                  : state === 'added'
                    ? 'Added'
                    : `Add ${g.title}`
              }
              onClick={(e) => {
                e.stopPropagation();
                const row = missing.find(
                  (m) => `${m.disc ?? 1}:${m.position}:${m.title}` === g.key,
                );
                if (row) void addMissing(row);
              }}
            >
              {state === 'added' ? (
                <Check size={14} />
              ) : state === 'missing' ? (
                <X size={14} />
              ) : state === 'finding' ? (
                <span className="artistAlbumSpin" aria-label="Finding it" />
              ) : (
                <Plus size={14} />
              )}
            </button>
          ),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addMissing is rebuilt each render
    [albumGhosts, adding, session, missing],
  );

  const albumShape = useMemo<SongTableShape>(
    () => ({
      // Both would be the same string on every row: the album column would be
      // this page's own title, and "date added" is when the file was scanned,
      // which says nothing about a record.
      hide: ['album', 'addedAt'],
      fixedOrder: true,
      // The tagged position where there is one, so the numbers match the
      // sleeve rather than counting what survived: a rip missing track 3
      // reads 1, 2, 4.
      lead: (t, i) => t.trackNo ?? i + 1,
      // Only where it differs from the record's own credit - which is exactly
      // the guest that used to make this whole album vanish from the artist
      // page.
      hideArtistWhen: (t) => nameFold(t.artist) === nameFold(credit),
    }),
    [credit],
  );

  const playAll = () => onPlay(list[0]!, list);
  const shuffleAll = () => {
    const order = shuffled(list);
    onPlay(order[0]!, order);
  };
  handlers.current = { playAll, shuffleAll };

  return (
    <div className="homePage libraryPage albumPage" ref={setPageEl}>
      <header className="albumHead">
        <Cover art={cover} />
        <div className="albumHead__body">
          <Text tone="muted" size="xs" className="albumHead__kicker">
            Album
          </Text>
          <h2 className="albumHead__name">{album}</h2>
          {/* The credit is a door back to the artist, the same as every other
              artist name in the app. "Various artists" is not one - there is no
              single page behind it. */}
          {credit === 'Various artists' ? (
            <Text tone="muted" size="sm">
              Various artists
            </Text>
          ) : (
            <button
              type="button"
              className="albumHead__artist"
              onClick={() => onOpenArtist(credit)}
            >
              {credit}
            </button>
          )}
          <Text tone="muted" size="sm">
            {missing.length > 0
              ? `${list.length} of ${list.length + missing.length} songs`
              : `${list.length} ${list.length === 1 ? 'song' : 'songs'}`}
            {totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}
            {labelDiscs ? ` · ${shownDiscs.length} discs` : ''}
            {year ? ` · ${year}` : ''}
          </Text>
          <div className="albumHead__actions">
            <Button variant="solid" size="sm" onClick={playAll}>
              <Play size={15} fill="currentColor" />
              Play
            </Button>
            <Button variant="ghost" size="sm" onClick={shuffleAll}>
              <Shuffle size={15} />
              Shuffle
            </Button>
            {session && list.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setMixing(true)}>
                <Sparkles size={15} />
                AI DJ
              </Button>
            )}
          </div>
        </div>
      </header>
      <div ref={sentinelRef} aria-hidden />

      {/*
        * The record, on the same table as everything else.
        *
        * It was a hand-rolled <ol> of <li>s that had drifted into a private
        * imitation of the library table - its own row geometry, its own
        * hover, its own idea of where a duration sits - so an album looked
        * like a cousin of every other list of songs rather than the same
        * thing. Now it IS the same thing: one SongTable, its columns, its
        * hairlines, its long-press menu, its now-playing wash and follow.
        *
        * Everything the album knows that the library does not is carried in
        * the shape and the ghosts, not in markup of its own.
        */}
      <div className="pageSongs">
        <SongTable
          flow
          // The sleeve's order, not the alphabet. Both halves are needed:
          // `null` makes the handed order the displayed order AND the play
          // queue, `fixedOrder` takes away the headers that would offer to
          // destroy it.
          defaultSort={null}
          tracks={ordered}
          ghosts={ghostsWithActions}
          onPlay={(track) => onPlay(track, ordered)}
          onOpenArtist={onOpenArtist}
          shape={albumShape}
        />
      </div>
      <DjCollectionTraitSheet source="album" name={album} seedTracks={list}
        open={mixing} onClose={() => setMixing(false)} />
    </div>
  );
}
