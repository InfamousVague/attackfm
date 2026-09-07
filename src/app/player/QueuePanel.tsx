//! The queue, laid open on the Now Playing sheet: what is playing, and the line
//! of songs behind it that you can drag into whatever order you like or lift out
//! entirely. The list is the play order - a reorder here is what the deck's own
//! skips will follow, and (over AttackFM Connect) what every other device sees.
//!
//! Only the UPCOMING run is editable: the current track is pinned at the top and
//! anything already played has left the line. Reordering resolves through the
//! kit's SortableList, which carries both drag and full keyboard reordering.

import { fireNativeHaptic } from '../core/haptics.ts';
import { ArtistLink } from '../ux/ArtistLink.tsx';
import { djReason } from '../booth/djReasons.ts';
import { djWhy, useDjRun } from '../booth/djSession.ts';
import { SayNoItems, Thumbs, useSayNo } from '../booth/sayNo.tsx';
import { deckNext } from './mediaSession.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { trackIdFromPath } from '../server.ts';
import { Button, IconButton, Slider, SortableList, Text, useToast } from '@glacier/react';
import { ChevronDown, Hourglass, Music, Radio, Sparkles, X } from '@glacier/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import { hostWaiting, useJamOptional, type PendingAdd } from './jam.tsx';
import { useRoomTracks, type RoomTrackAnswer } from './roomTrack.ts';
import { useRadioOptional } from './radio.tsx';
import { enhancerLabel } from './smartShuffle.ts';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { fetchHousehold, type HouseholdPerson } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import type { Track } from '../core/tauri.ts';

interface QueueRow {
  id: string;
  track: Track;
}

export function QueuePanel({
  queue,
  current,
  onQueueChange,
  onPlayTrack,
  onClose,
  inJam = false,
}: {
  queue: Track[];
  current: Track | null;
  /** The new play order, current track and all. Skips read whatever it holds. */
  onQueueChange: (next: Track[]) => void;
  /** Jump straight to a queued track. */
  onPlayTrack: (track: Track) => void;
  onClose: () => void;
  inJam?: boolean;
}) {
  // The current track's spot splits the line: everything after it is still to
  // come. With the current track absent from the queue (a lone DJ pick, say),
  // there is nothing behind it to arrange.
  const curIdx = current ? queue.findIndex((t) => t.path === current.path) : -1;
  const head = curIdx >= 0 ? queue.slice(0, curIdx + 1) : queue.slice();
  const upcoming = curIdx >= 0 ? queue.slice(curIdx + 1) : [];
  // Only the near horizon is drawn. "Shuffle all" hands this panel the whole
  // library, and a list of five thousand rows is not a queue anyone reads - it
  // is a scroll with no bottom, and it made reordering the next few songs
  // impossible. The rest is still QUEUED and still plays; it is simply summed
  // up in a line rather than laid out row by row.
  const UP_NEXT_SHOWN = 10;
  const shown = upcoming.slice(0, UP_NEXT_SHOWN);
  const hiddenCount = upcoming.length - shown.length;
  const rows: QueueRow[] = shown.map((t) => ({ id: t.path, track: t }));

  // The station, when one is on: the queue is where "what's next" is read, so
  // it is where the dial belongs.
  const radio = useRadioOptional();
  /*
   * Whose pick a row is. The thumbs and the hold's refusals appear only on
   * a song the MACHINE chose - one the live DJ set dealt, or anything while
   * the station is feeding the line - because "less like this" said about
   * a song you queued yourself would be a strange thing to record. The set
   * is app-level state (djSession); the station is the provider above.
   */
  const run = useDjRun();
  const chosen = (track: Track): boolean => Boolean(radio?.on) || Boolean(run?.paths.has(track.path));
  const { position } = useNowPlayingMotion();
  const { down } = useSayNo();

  /*
   * ONE queue in a groove.
   *
   * The room has a single line: the host's deck's play order, carried out in
   * every beat, which every member's send flows into. The host reads that
   * list off its own deck (the sortable rows below - a reorder here is a
   * reorder for everyone); a guest reads it off the room. Either way the
   * panel draws the same thing: the members' sends the host's player has
   * not folded in yet, ahead of the line, and then the line itself - and
   * says whose taste each song is.
   *
   * A guest's rows are resolved by hub id through roomTrack.ts: this
   * library first, then the hub's own row for anything it never listed (a
   * song the host adopted from a collector pull is on the host's shelf and
   * nobody else's, but the hub knows it - and streams it). One request per
   * missing id, shared with the deck, so the queue that used to read
   * "Nothing queued yet" when every song on it was the host's private find
   * now reads the songs. Only an id the hub has never heard of shows as
   * "Not in your library".
   */
  const jam = useJamOptional();
  const room = jam?.current ?? null;
  const inRoom = room !== null;
  const hosting = inRoom && !!jam?.hosting;
  const following = inRoom && !hosting;
  const addedBy = room?.addedBy ?? {};
  /** Who asked for a track, when somebody in the room did. */
  const creditOf = (id: number | null): string | null => (id == null ? null : (addedBy[String(id)] ?? null));
  const creditFor = (track: Track): string | null => creditOf(trackIdFromPath(track.path));
  // The room's line PAST what is on. The host's list is the whole play
  // order - what played, what is on, what is next - and only the last of
  // those is a queue; the host's own panel cuts it at the song playing (see
  // `upcoming`), so a guest's cuts it at the same place, by the room's word.
  const roomIds: number[] = (() => {
    if (!room || !following) return [];
    const at = room.trackId != null ? room.queue.indexOf(room.trackId) : -1;
    return at >= 0 ? room.queue.slice(at + 1) : room.queue;
  })();
  // The members' sends the host's player has not folded in yet - the room's
  // rows for the host, the hub's plus this device's own for a guest. A send
  // from this device carries its own Track; the rest resolve like the line.
  const pendingAdds: PendingAdd[] = inRoom ? (jam?.pending ?? []) : [];
  // One ask for the lot (the hook keys on the ids themselves, so a poll that
  // changes nothing asks nothing).
  const asked = useRoomTracks([...roomIds, ...pendingAdds.filter((p) => !p.track).map((p) => p.trackId)]);
  /** The room's line, row by row: a Track, null once the hub has said there
   *  is no such track, undefined while it is still being asked. */
  const lineRows: { id: number; track: RoomTrackAnswer | undefined }[] = roomIds.map((id) => ({
    id,
    track: asked.get(id),
  }));
  const pendingRows = pendingAdds.map((p) => ({ ...p, track: p.track ?? asked.get(p.trackId) }));
  // The host's player has gone quiet: nothing pending will land until it is
  // back, and the room should say so rather than leave a guest wondering
  // why the song they sent has not moved - or the host wondering why the
  // room is not hearing their deck.
  const waiting = inRoom && hostWaiting(room);
  /** The room's own name for an id it plays, for a row the hub could not
   *  answer: better a title than a shrug, when the room gave one. */
  const roomNames = (id: number): { title: string; artist: string } | null =>
    room && room.trackId === id && room.trackTitle
      ? { title: room.trackTitle, artist: room.trackArtist ?? '' }
      : null;
  // Who else is in the house, so a station can belong to two people. Asked
  // only while one is on - it is a question about this room, not about the app.
  const { session } = useServerSession();
  const [house, setHouse] = useState<HouseholdPerson[]>([]);
  useEffect(() => {
    if (!radio?.on || !session) return;
    const ctrl = new AbortController();
    void fetchHousehold(session, ctrl.signal)
      .then((people) => setHouse(people.filter((p) => !p.me)))
      .catch(() => {
        // An older server without the endpoint: the station stays personal.
      });
    return () => ctrl.abort();
  }, [radio?.on, session]);

  // The tail beyond the drawn rows has to be carried through a reorder, or
  // dragging one of the visible songs would silently discard everything queued
  // behind them.
  const reorder = (next: QueueRow[]) =>
    onQueueChange([...head, ...next.map((r) => r.track), ...upcoming.slice(UP_NEXT_SHOWN)]);
  /*
   * Undo works on the queue AS IT STANDS when pressed, not as it stood when
   * the toast appeared: songs advance and reorders land inside the toast's
   * few seconds, and restoring a stale snapshot would eat them. The ref
   * always holds the latest pair, so the restore splices into the present.
   */
  const latest = useRef({ queue, onQueueChange });
  latest.current = { queue, onQueueChange };
  const { toast } = useToast();

  const remove = (path: string) => {
    const at = queue.findIndex((t) => t.path === path);
    if (at < 0) return;
    const track = queue[at]!;
    onQueueChange(queue.filter((t) => t.path !== path));
    toast({
      message: `Removed “${track.title}” from the queue`,
      action: {
        label: 'Undo',
        onPress: () => {
          const { queue: now, onQueueChange: apply } = latest.current;
          if (now.some((t) => t.path === path)) return; // re-queued by hand already
          const back = [...now];
          back.splice(Math.min(at, back.length), 0, track);
          apply(back);
        },
      },
    });
  };
  /** Empty what is still to come. The song playing is not "next", so it keeps
   *  playing - clearing the queue should never also stop the music. The whole
   *  list is captured first: this is the panel's one sweeping act, and undo
   *  puts back everything it swept. */
  const clearUpcoming = () => {
    const before = queue;
    if (upcoming.length === 0) return;
    onQueueChange(head);
    toast({
      message: `Cleared ${upcoming.length} upcoming ${upcoming.length === 1 ? 'song' : 'songs'}`,
      action: { label: 'Undo', onPress: () => latest.current.onQueueChange(before) },
    });
  };
  /*
   * A no, in the queue. The song is refused (the ledger, the hub) by
   * useSayNo; what this adds is the queue's half - a refused row leaves the
   * line, a refused artist takes every upcoming row of theirs with it, and
   * a no on the song PLAYING moves the deck on. No undo toast here: the no
   * has its own, and the row was not the listener's to begin with.
   */
  const dropRow = (path: string) => {
    const { queue: now, onQueueChange: apply } = latest.current;
    if (now.some((t) => t.path === path)) apply(now.filter((t) => t.path !== path));
  };
  const dropArtist = (artist: string) => {
    const key = artist.trim().toLowerCase();
    const { queue: now, onQueueChange: apply } = latest.current;
    const at = current ? now.findIndex((t) => t.path === current.path) : -1;
    const keep = (t: Track, i: number) => i <= at || t.artist.trim().toLowerCase() !== key;
    apply(now.filter(keep));
    if (current && current.artist.trim().toLowerCase() === key) deckNext();
  };
  /** Move on from the song playing: the deck's own next, or - with no deck
   *  bound (a probe, a remote seat) - the panel's own jump to the next row. */
  const skipNow = () => {
    if (deckNext()) return;
    const next = upcoming[0];
    if (next) onPlayTrack(next);
  };

  return (
    <div className="queuePanel" role="dialog" aria-label="Queue">
      <header className="queuePanel__head">
        <span className="queuePanel__title">{inJam ? 'Groove queue' : 'Queue'}</span>
        <IconButton variant="ghost" aria-label="Close queue" onClick={onClose}>
          <ChevronDown size={22} />
        </IconButton>
      </header>

      <div className="queuePanel__body">
        {/* On air: what it was seeded from, the two knobs, and the way out.
            The list below keeps filling itself for as long as this is here. */}
        {radio?.on && (
          <div className="radioBar">
            <div className="radioBar__head">
              <span className="radioBar__title">
                <Radio size={15} />
                {radio.seed ? `Radio from ${radio.seed.title}` : 'Radio'}
              </span>
              <Button variant="ghost" size="sm" onClick={radio.stop}>
                Stop
              </Button>
            </div>
            <label className="radioBar__dial">
              <span>Calmer</span>
              <Slider
                aria-label="Energy"
                min={-1}
                max={1}
                step={0.1}
                value={radio.dial.energy}
                onValueChange={(v) => radio.setDial({ energy: v })}
              />
              <span>Harder</span>
            </label>
            <label className="radioBar__dial">
              <span>Deep cuts</span>
              <Slider
                aria-label="Familiarity"
                min={0}
                max={1}
                step={0.1}
                value={radio.dial.familiar}
                onValueChange={(v) => radio.setDial({ familiar: v })}
              />
              <span>Favourites</span>
            </label>
            {/* Two people, one queue: the blend scores every candidate against
                BOTH tastes and keeps the worse of the two, so nobody's
                obsession carries a song the other would skip. */}
            {house.length > 0 && (
              <div className="radioBar__blend">
                <span>With</span>
                {house.map((p) => (
                  <Button
                    key={p.id}
                    variant={radio.blendWith === p.id ? 'solid' : 'outline'}
                    size="sm"
                    onClick={() => radio.setBlendWith(radio.blendWith === p.id ? null : p.id)}
                  >
                    {p.username}
                  </Button>
                ))}
              </div>
            )}
            {radio.filling && (
              <Text size="xs" tone="subtle">
                Finding the next few…
              </Text>
            )}
          </div>
        )}

        {current && (
          <div className="queueNow">
            <span className="queueNow__label">Now playing</span>
            {/* The one row that had no menu, in the panel whose own comment
                says the queue is a list of songs like any other. Wrapped like
                the rest, so the playing song can be filed or queued-next from
                here too. */}
            <TrackMenu
              track={current}
              lead={
                chosen(current) ? (
                  <SayNoItems
                    why={djReason(trackIdFromPath(current.path)) ?? djWhy(current.path)}
                    artist={current.artist}
                    onTrack={() => down(current, { positionMs: position * 1000, onLeave: skipNow })}
                    onArtist={() =>
                      down(current, {
                        scope: 'artist',
                        positionMs: position * 1000,
                        onLeave: () => dropArtist(current.artist),
                      })
                    }
                  />
                ) : undefined
              }
            >
              <div className="queueRow queueRow--now">
                <Cover track={current} />
                <div className="queueRow__meta">
                  <span className="queueRow__title">{current.title}</span>
                  <span className="queueRow__artist">
                    <ArtistLink artist={current.artist} beforeOpen={onClose} />
                  </span>
                  <DjPickBadge path={current.path} />
                  {(() => {
                    const why = djReason(trackIdFromPath(current.path)) ?? djWhy(current.path);
                    return why ? <span className="queueRow__why">{why}</span> : null;
                  })()}
                </div>
                {/* The thumbs, on the song the machine is playing right now:
                    a down skips it, an up is recorded and nothing more. */}
                {chosen(current) && (
                  <Thumbs
                    track={current}
                    positionMs={position * 1000}
                    onDown={skipNow}
                    className="queueRow__thumbs"
                  />
                )}
              </div>
            </TrackMenu>
          </div>
        )}

        <div className="queueUp">
          <div className="queueUp__head">
            <span className="queueUp__label">{inRoom ? 'Next up in the groove' : 'Next up'}</span>
            {!following && rows.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearUpcoming}>
                Clear
              </Button>
            )}
          </div>
          {waiting && (
            <Text tone="muted" size="xs" className="queueUp__note">
              {hosting
                ? 'Waiting on your player — nothing lands until it reports'
                : `Waiting for ${room?.hostName ?? 'the host'}’s player`}
            </Text>
          )}
          {/* The members' sends, ahead of the line: the newest thing in the
              room and the one thing everybody is waiting on. Drawn for the
              host too - a send is invisible to the host's deck until its
              player folds it in, and a paused deck folds nothing. */}
          {pendingRows.length > 0 && (
            <div
              className="queueRows queueRows--pending"
              role="list"
              aria-label={`${pendingRows.length} waiting ${hosting ? 'on your player' : 'for the host'}`}
            >
              {pendingRows.map((p) => {
                const who = p.mine ? 'you' : p.by;
                const credit = (
                  <span className="queueRow__credit queueRow__credit--pending">
                    <Hourglass size={11} aria-hidden />
                    by {who}
                  </span>
                );
                const withdraw = p.mine && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="queueRow__withdraw queueRow__act"
                    aria-label={`Withdraw ${p.track?.title ?? 'your add'} from the groove`}
                    onClick={() => void jam?.withdraw(p.trackId)}
                  >
                    <X size={16} />
                  </IconButton>
                );
                if (!p.track) {
                  return (
                    <AskedRow
                      key={`pending:${p.trackId}`}
                      answer={p.track}
                      named={roomNames(p.trackId)}
                      note={`waiting, sent by ${who}`}
                      chip={credit}
                      action={withdraw}
                      pending
                    />
                  );
                }
                return (
                  <TrackMenu key={`pending:${p.trackId}`} track={p.track} className="queueRowMenu">
                    <div
                      className="queueRow"
                      data-static
                      data-pending
                      role="listitem"
                      aria-label={`${p.track.title} by ${p.track.artist}, waiting, sent by ${who}`}
                    >
                      <Cover track={p.track} />
                      <div className="queueRow__meta">
                        <span className="queueRow__title">{p.track.title}</span>
                        <span className="queueRow__artist">
                          <ArtistLink artist={p.track.artist} beforeOpen={onClose} />
                          {credit}
                        </span>
                      </div>
                      {/* Your own ask, taken back before the host's player
                          picks it up. Gone here at once; the hub is told. */}
                      {withdraw}
                    </div>
                  </TrackMenu>
                );
              })}
            </div>
          )}
          {following ? (
            lineRows.length === 0 && pendingRows.length === 0 ? (
              <Text tone="muted" size="sm" className="queueUp__empty">
                Nothing queued yet. Tap a song anywhere and it goes to the
                groove - {room?.hostName ?? 'the host'} plays it for everyone.
              </Text>
            ) : lineRows.length === 0 ? null : (
              // A guest reads the room's list; nobody else's device can
              // reorder it.
              <div className="queueRows" role="list" aria-label="The groove's queue">
                {lineRows.map(({ id, track: t }, i) => {
                  const credit = creditOf(id);
                  const chip = credit ? <span className="queueRow__credit">added by {credit}</span> : null;
                  if (!t) {
                    return (
                      <AskedRow key={`${id}-${i}`} answer={t} named={roomNames(id)} note={credit ? `added by ${credit}` : ''} chip={chip} />
                    );
                  }
                  return (
                    <TrackMenu key={t.path} track={t} className="queueRowMenu">
                      <div className="queueRow" data-static role="listitem">
                        <Cover track={t} />
                        <div className="queueRow__meta">
                          <span className="queueRow__title">{t.title}</span>
                          <span className="queueRow__artist">
                            <ArtistLink artist={t.artist} beforeOpen={onClose} />
                            {chip}
                          </span>
                        </div>
                      </div>
                    </TrackMenu>
                  );
                })}
              </div>
            )
          ) : rows.length === 0 ? (
            pendingRows.length > 0 ? null : (
              <Text tone="muted" size="sm" className="queueUp__empty">
                {inRoom
                  ? 'Nothing queued yet. Add songs from anywhere - yours and your guests’ line up here, and the groove plays them in this order.'
                  : 'Nothing queued. Add songs from anywhere with “Add to queue,” and they line up here.'}
              </Text>
            )
          ) : (
            <SortableList
              items={rows}
              /* The drop, felt. Pick up, carry, drop is the most physically
                 direct gesture in the app and it answered at none of the three
                 moments. onReorder fires only on release and only when the
                 index actually changed, so this is the cheap, honest half:
                 "it landed". Per-slot ticks during the carry would need a kit
                 change and a floor, and are not worth that yet. */
              onReorder={(next) => {
                fireNativeHaptic('medium');
                reorder(next);
              }}
              getLabel={(r) => r.track.title}
              className="queueSortable"
              renderItem={(r) => (
                /* The queue is a list of songs like any other, so it carries
                   the same menu - file one you like into a playlist without
                   going to find it again somewhere that had a menu. */
                <TrackMenu
                  track={r.track}
                  className="queueRowMenu"
                  lead={
                    chosen(r.track) ? (
                      <SayNoItems
                        why={djReason(trackIdFromPath(r.track.path)) ?? djWhy(r.track.path)}
                        artist={r.track.artist}
                        onTrack={() => down(r.track, { onLeave: () => dropRow(r.track.path) })}
                        onArtist={() =>
                          down(r.track, { scope: 'artist', onLeave: () => dropArtist(r.track.artist) })
                        }
                      />
                    ) : undefined
                  }
                >
                <div className="queueRow">
                  <button
                    type="button"
                    className="queueRow__play"
                    onClick={() => onPlayTrack(r.track)}
                  >
                    <Cover track={r.track} />
                    <div className="queueRow__meta">
                      <span className="queueRow__title">{r.track.title}</span>
                      <span className="queueRow__artist">
                        <ArtistLink artist={r.track.artist} beforeOpen={onClose} />
                        {(() => {
                          const credit = creditFor(r.track);
                          return credit ? (
                            <span className="queueRow__credit">added by {credit}</span>
                          ) : null;
                        })()}
                      </span>
                      <DjPickBadge path={r.track.path} />
                      {(() => {
                        // The DJ's own reason for this pick, when this queue
                        // came from the DJ. Computed server-side either way;
                        // showing it is what makes a ranking change audible
                        // AND visible. A trait mix's explanation first, else
                        // the live set's line for the song.
                        const why = djReason(trackIdFromPath(r.track.path)) ?? djWhy(r.track.path);
                        return why ? <span className="queueRow__why">{why}</span> : null;
                      })()}
                    </div>
                  </button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="queueRow__act"
                    aria-label={`Remove ${r.track.title} from the queue`}
                    onClick={() => remove(r.track.path)}
                  >
                    <X size={16} />
                  </IconButton>
                </div>
                </TrackMenu>
              )}
            />
          )}
          {/* Everything past the drawn rows still plays; it just is not worth
              five thousand rows to say so. */}
          {!following && hiddenCount > 0 && (
            <Text tone="muted" size="sm" className="queueUp__more">
              and {hiddenCount.toLocaleString()} more
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A row for an id this library does not list, in the two states the hub
 * leaves it in: still being asked (an ellipsis over a shimmering sleeve -
 * the row holds its place rather than vanishing), or denied - "Not in your
 * library", with the room's own name for the song when it gave one. Never
 * for a row the hub answered: that one is a Track and draws like any other.
 */
function AskedRow({
  answer,
  named,
  note,
  chip,
  action,
  pending = false,
}: {
  answer: null | undefined;
  named: { title: string; artist: string } | null;
  /** Read out with the row, so the state is heard as well as seen. */
  note: string;
  /** The credit, on the artist line. */
  chip?: ReactNode;
  /** A control at the row's end (a withdraw). */
  action?: ReactNode;
  pending?: boolean;
}) {
  const asking = answer === undefined;
  const title = asking ? '…' : (named?.title ?? 'Not in your library');
  const sub = asking ? '' : named ? [named.artist, 'Not in your library'].filter(Boolean).join(' · ') : '';
  return (
    <div
      className="queueRow"
      data-static
      data-asking={asking || undefined}
      data-missing={!asking || undefined}
      data-pending={pending || undefined}
      role="listitem"
      aria-label={`${asking ? 'Still looking up a song' : `${title}${sub ? `, ${sub}` : ''}`}${note ? `, ${note}` : ''}`}
    >
      <span className="queueRow__cover" aria-hidden>
        <Music size={16} />
      </span>
      <div className="queueRow__meta">
        <span className="queueRow__title">{title}</span>
        <span className="queueRow__artist">
          {sub}
          {chip}
        </span>
      </div>
      {action}
    </div>
  );
}

function Cover({ track }: { track: Track }) {
  // Queue rows draw the cover at thumb size, so the 160 variant carries it;
  // the skeleton shimmer holds the square until the bytes arrive.
  const src = artSized(track.artwork, 160);
  const art = useArtLoad(src, '');
  return (
    <span className="queueRow__cover" aria-hidden>
      {track.artwork ? <img {...art} src={src ?? undefined} alt="" loading="lazy" /> : <Music size={16} />}
    </span>
  );
}

/**
 * Smart shuffle's mark on a song the DJ dealt into the line, with the lane it
 * came down - new music, on repeat, similar - so a stranger in the queue
 * arrives with its reason. Nothing for a song the listener queued.
 */
function DjPickBadge({ path }: { path: string }) {
  const label = enhancerLabel(path);
  if (!label) return null;
  return (
    <span className="queueRow__pick">
      <Sparkles size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
