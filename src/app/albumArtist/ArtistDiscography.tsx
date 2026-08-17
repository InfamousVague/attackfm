import { Text } from '@glacier/react';
import { Check, Disc3, Plus, X } from '@glacier/icons';
import { AlbumMenu } from './AlbumMenu.tsx';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import type { Track } from '../core/tauri.ts';
import type { AddingState } from './artistAcquire.ts';
import type { DiscRow } from './artistData.ts';

/** A record's cover in the discography grid: skeleton while the bytes come,
 *  pop on arrival. A component of its own so the hook lives outside the map
 *  that draws the grid. */
function DiscCover({ src }: { src: string }) {
  const sized = artSized(src, 640) ?? src;
  const art = useArtLoad(sized, 'artistAlbumCover');
  return <img {...art} src={sized} alt="" loading="lazy" />;
}

interface DiscCardProps {
  row: DiscRow;
  artist: string;
  adding: AddingState;
  addRecord: (row: DiscRow) => Promise<void>;
  canAddAlbum: (title: string) => boolean;
  hiRes: Record<string, string>;
  /** Whether the importer's download queue is running - picks the "added" copy. */
  hasDownloads: boolean;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
}

/** One record in the discography. Yours plays; the rest can be pulled, via a
 *  Spotify lookup when their own link is one the importer will not take. */
function DiscCard({
  row,
  artist,
  adding,
  addRecord,
  canAddAlbum,
  hiRes,
  hasDownloads,
  onPlay,
  onOpenAlbum,
}: DiscCardProps) {
  const state = adding[row.key];
  const canAdd = !row.owned && canAddAlbum(row.title);
  const act = row.owned
    ? // A cover is a door. This used to play the record, which is the one
      // thing already reachable from here (the page it opens leads with
      // Play) and not what a tap on artwork means anywhere else in the app.
      // Without a handler the old behaviour stands, rather than an enabled
      // button that does nothing at all.
      onOpenAlbum
      ? () => onOpenAlbum(row.owned!.name, artist)
      : () => onPlay(row.owned!.list[0]!, row.owned!.list)
    : canAdd && !state
      ? () => void addRecord(row)
      : undefined;
  const cover = (row.owned && hiRes[row.owned.name]) || row.cover;
  const card = (
    <button
      key={row.key}
      type="button"
      className="artistAlbum"
      data-have={row.owned ? '' : undefined}
      data-state={state}
      disabled={!act}
      title={
        row.owned
          ? `Open ${row.title}`
          : state === 'missing'
            ? `${row.title} is not on Spotify to import`
            : canAdd
              ? `Add ${row.title}`
              : `${row.title} — no way to add this; enable Music import or Buy in Plugins`
      }
      onClick={act}
    >
      <span className="artistAlbumArt">
        {cover ? (
          <DiscCover src={cover} />
        ) : (
          <span className="artistAlbumCover artistAlbumCover--glyph" aria-hidden>
            <Disc3 size={26} />
          </span>
        )}
        {/* Owned is the state worth a mark and Add is an offer; a record that
            is neither says nothing rather than wearing a badge meaning "no". */}
        {row.owned ? (
          <span className="artistAlbumBadge" data-have>
            <Check size={13} />
          </span>
        ) : state === 'finding' ? (
          <span className="artistAlbumBadge" data-busy>
            <span className="artistAlbumSpin" aria-label="Finding it on Spotify" />
          </span>
        ) : state === 'added' ? (
          <span className="artistAlbumBadge" data-have>
            <Check size={13} />
          </span>
        ) : state === 'missing' ? (
          <span className="artistAlbumBadge" data-missing>
            <X size={13} />
          </span>
        ) : canAdd ? (
          <span className="artistAlbumBadge">
            <Plus size={13} />
          </span>
        ) : null}
      </span>
      <span className="artistAlbumName">{row.title}</span>
      <span className="artistAlbumSub">
        {state === 'finding'
          ? 'Finding it…'
          : state === 'added'
            ? hasDownloads
              ? 'Added to downloads'
              : 'Sent to add'
            : state === 'missing'
              ? 'Not on Spotify'
              : [
                  row.year,
                  row.owned
                    ? `${row.owned.list.length} of ${row.trackCount ?? row.owned.list.length}`
                    : row.trackCount
                      ? `${row.trackCount} tracks`
                      : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
      </span>
    </button>
  );
  // A record you own answers a hold with its own verbs; one still in the
  // catalogue has exactly one verb (the add badge) and no menu to offer.
  // Keyed here, not on the button, so the wrap does not double the key.
  return row.owned ? (
    <AlbumMenu key={row.key} tracks={row.owned.list} onPlay={onPlay}>
      {card}
    </AlbumMenu>
  ) : (
    card
  );
}

interface ArtistDiscographyProps {
  artist: string;
  discography: { records: DiscRow[]; singles: DiscRow[] };
  adding: AddingState;
  addRecord: (row: DiscRow) => Promise<void>;
  canAddAlbum: (title: string) => boolean;
  hiRes: Record<string, string>;
  hasDownloads: boolean;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
}

/** The Albums and Singles & EPs grids, plus the tap-to-add note under them. */
export function ArtistDiscography({
  artist,
  discography,
  adding,
  addRecord,
  canAddAlbum,
  hiRes,
  hasDownloads,
  onPlay,
  onOpenAlbum,
}: ArtistDiscographyProps) {
  if (discography.records.length === 0 && discography.singles.length === 0) return null;
  const ownedRecords = discography.records.filter((r) => r.owned).length;
  const discCard = (row: DiscRow) => (
    <DiscCard
      key={row.key}
      row={row}
      artist={artist}
      adding={adding}
      addRecord={addRecord}
      canAddAlbum={canAddAlbum}
      hiRes={hiRes}
      hasDownloads={hasDownloads}
      onPlay={onPlay}
      onOpenAlbum={onOpenAlbum}
    />
  );
  return (
    <>
      {discography.records.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">
            Albums
            <span className="artistDiscCount">
              {ownedRecords} of {discography.records.length}
            </span>
          </h2>
          {/* A grid rather than the horizontal shelf the rest of the page
              uses: a discography is read, not skimmed past, and a body of
              work fifteen records deep does not belong behind a sideways
              scroll. */}
          <div className="artistDisc">{discography.records.map(discCard)}</div>
        </section>
      )}

      {discography.singles.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">
            Singles &amp; EPs
            <span className="artistDiscCount">{discography.singles.length}</span>
          </h2>
          <div className="artistDisc">{discography.singles.map(discCard)}</div>
        </section>
      )}

      {/* Said once, under the discography: a record you do not own is a
          tap away, it just takes a beat to find first. */}
      {[...discography.records, ...discography.singles].some((r) => !r.owned) && (
        <Text tone="muted" size="sm" className="artistDiscNote">
          Tap anything you do not own and it is looked up on Spotify and sent to your
          downloads.
        </Text>
      )}
    </>
  );
}
