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
import { SayNoItems, useSayNo } from '../booth/sayNo.tsx';
import { deckNext } from './mediaSession.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { trackIdFromPath } from '../server.ts';
import { Button, IconButton, Slider, SortableList, Text, useToast } from '@glacier/react';
import { ArrowUpToLine, ChevronDown, Hourglass, Music, Radio, Sparkles, X } from '@glacier/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import { useJamOptional, type PendingAdd } from './jam.tsx';
import { hostWaiting } from './hostQuiet.ts';
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

/*
 * What a pending send is READ OUT as - a whole sentence per state, rather than
 * one sentence with a `{{state}}` hole and "playing next" / "waiting" dropped
 * into it. Those two are a bare verb phrase in English and an inflected one in
 * most of Europe, and a translator handed the fragment on its own cannot see
 * which sentence it lands in or what it has to agree with. Four entries is the
 * price of two that can actually be translated.
 *
 * `alone` is the row with no title yet (the hub has not answered); `row` is the
 * one that names the song.
 */
const SEND_ARIA = {
  next: { alone: 'player.sendAriaNext', row: 'player.sendRowAriaNext' },
  waiting: { alone: 'player.sendAriaWaiting', row: 'player.sendRowAriaWaiting' },
} as const;

export function QueuePanel({
  queue,
  upNext,
  mirroring = false,
  onUpNextChange,
  current,
  onPlayTrack,
  onClose,
  inJam = false,
}: {
  queue: Track[];
  /** The songs put here by hand. THIS is the queue as far as this panel is
   *  concerned - see the note on `rows` below. */
  upNext: Track[];
  onUpNextChange: (next: Track[]) => void;
  current: Track | null;
  /** The new play order, current track and all. Skips read whatever it holds. */
  onQueueChange: (next: Track[]) => void;
  /**
   * Another device holds playback and this one is watching it.
   *
   * It changes what this panel can HONESTLY say. Everything it knows arrives
   * as one flat list of ids from the seat holder, with no marker for where
   * the hand-queued part of it ends - so the two sections below cannot be
   * told apart here, and the local lane is not what is going to play either
   * (an add from this device is sent to the other one). Split it anyway and
   * the panel reads "Nothing queued" directly above the songs you queued.
   */
  mirroring?: boolean;
  /** Jump straight to a queued track. */
  onPlayTrack: (track: Track) => void;
  onClose: () => void;
  inJam?: boolean;
}) {
  // The current track's spot splits the line: everything after it is still to
  // come. With the current track absent from the queue (a lone DJ pick, say),
  // there is nothing behind it to arrange.
  const t = useT();
  const curIdx = current ? queue.findIndex((s) => s.path === current.path) : -1;
  const upcoming = curIdx >= 0 ? queue.slice(curIdx + 1) : [];
  // Only the near horizon is drawn. "Shuffle all" hands this panel the whole
  // library, and a list of five thousand rows is not a queue anyone reads - it
  // is a scroll with no bottom, and it made reordering the next few songs
  // impossible. The rest is still QUEUED and still plays; it is simply summed
  // up in a line rather than laid out row by row.
  const UP_NEXT_SHOWN = 10;
  /*
   * The drawn list is the HAND-PICKED lane, not the list being played through.
   *
   * These were one array, so opening Liked songs put nine hundred rows in here
   * and "add to queue" appended song nine hundred and one - the listener's own
   * pick, filed somewhere they would never scroll to, behind a wall of songs
   * they had not chosen individually at all. A queue you cannot find your own
   * additions in is not a queue; it is the playlist again.
   *
   * So this panel shows what you asked for, in the order it will play, and the
   * list you are playing through is summarised underneath as context. The
   * empty-state copy - "Add songs from anywhere with Add to queue, and they
   * line up here" - is finally true.
   */
  // While mirroring, this device's own lane is not what is going to play -
  // an add from here is sent to the seat holder - so it is not drawn.
  const shown = mirroring ? [] : upNext.slice(0, UP_NEXT_SHOWN);
  const hiddenCount = upNext.length - shown.length;
  const rows: QueueRow[] = shown.map((s) => ({ id: s.path, track: s }));
  /** The next few from the list being played through, for the tail below. */
  const CONTEXT_SHOWN = 5;
  const contextNext = upcoming.slice(0, CONTEXT_SHOWN);

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
  const { down, up } = useSayNo();

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
  // The tail beyond the drawn rows still has to survive a drag, or reordering
  // the visible few would silently discard everything queued behind them.
  const reorder = (next: QueueRow[]) =>
    onUpNextChange([...next.map((r) => r.track), ...upNext.slice(UP_NEXT_SHOWN)]);
  /*
   * Undo works on the queue AS IT STANDS when pressed, not as it stood when
   * the toast appeared: songs advance and reorders land inside the toast's
   * few seconds, and restoring a stale snapshot would eat them. The ref
   * always holds the latest pair, so the restore splices into the present.
   */
  const latest = useRef({ queue: upNext, onQueueChange: onUpNextChange });
  latest.current = { queue: upNext, onQueueChange: onUpNextChange };
  const { toast } = useToast();

  const remove = (path: string) => {
    const at = upNext.findIndex((s) => s.path === path);
    if (at < 0) return;
    const track = upNext[at]!;
    onUpNextChange(upNext.filter((s) => s.path !== path));
    toast({
      message: t('player.queueRemoved', { title: track.title }),
      action: {
        label: t('common.undo'),
        onPress: () => {
          const { queue: now, onQueueChange: apply } = latest.current;
          if (now.some((s) => s.path === path)) return; // re-queued by hand already
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
    const before = upNext;
    if (upNext.length === 0) return;
    onUpNextChange([]);
    toast({
      message: t('player.queueCleared', { count: before.length }),
      action: { label: t('common.undo'), onPress: () => latest.current.onQueueChange(before) },
    });
  };
  /*
   * A no, in the queue. The song is refused (the ledger, the hub) by
   * useSayNo; what this adds is the queue's half - a refused row leaves the
   * line, a refused artist takes every upcoming row of theirs with it, and
   * a no on the song PLAYING moves the deck on. No undo toast here: the no
   * has its own, and the row was not the listener's to begin with.
   *
   * The queue says all of this through the HOLD, not through thumbs. The
   * pair used to ride the now row as well, which made the queue the third
   * place the same two circles appeared; they belong to the DJ's popover
   * now, where the voice that made the pick is. Nothing was lost by that:
   * the hold already carried the reason and both refusals at a granularity
   * the thumbs never had - this song, or this artist - and it now carries
   * the approval too, so every verdict is still one gesture from the row it
   * is about, and the now row's title has the width back.
   */
  const dropRow = (path: string) => {
    const { queue: now, onQueueChange: apply } = latest.current;
    if (now.some((s) => s.path === path)) apply(now.filter((s) => s.path !== path));
  };
  const dropArtist = (artist: string) => {
    const key = artist.trim().toLowerCase();
    const { queue: now, onQueueChange: apply } = latest.current;
    const at = current ? now.findIndex((s) => s.path === current.path) : -1;
    const keep = (s: Track, i: number) => i <= at || s.artist.trim().toLowerCase() !== key;
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
    <div className="queuePanel" role="dialog" aria-label={t('player.queue')}>
      <header className="queuePanel__head">
        <span className="queuePanel__title">{inJam ? t('player.grooveQueue') : t('player.queue')}</span>
        <IconButton variant="ghost" aria-label={t('player.closeQueue')} onClick={onClose}>
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
                {radio.seed ? t('player.radioFrom', { title: radio.seed.title }) : t('player.radio')}
              </span>
              <Button variant="ghost" size="sm" onClick={radio.stop}>
                {t('player.radioStop')}
              </Button>
            </div>
            <label className="radioBar__dial">
              <span>{t('player.dialCalmer')}</span>
              <Slider
                aria-label={t('player.dialEnergy')}
                min={-1}
                max={1}
                step={0.1}
                value={radio.dial.energy}
                onValueChange={(v) => radio.setDial({ energy: v })}
              />
              <span>{t('player.dialHarder')}</span>
            </label>
            <label className="radioBar__dial">
              <span>{t('player.dialDeepCuts')}</span>
              <Slider
                aria-label={t('player.dialFamiliarity')}
                min={0}
                max={1}
                step={0.1}
                value={radio.dial.familiar}
                onValueChange={(v) => radio.setDial({ familiar: v })}
              />
              <span>{t('player.dialFavourites')}</span>
            </label>
            {/* Two people, one queue: the blend scores every candidate against
                BOTH tastes and keeps the worse of the two, so nobody's
                obsession carries a song the other would skip. */}
            {house.length > 0 && (
              <div className="radioBar__blend">
                <span>{t('player.blendWith')}</span>
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
                {t('player.radioFilling')}
              </Text>
            )}
          </div>
        )}

        {current && (
          <div className="queueNow">
            <span className="queueNow__label">{t('player.nowPlaying')}</span>
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
                    onUp={() => up(current, position * 1000)}
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
              </div>
            </TrackMenu>
          </div>
        )}

        <div className="queueUp">
          <div className="queueUp__head">
            <span className="queueUp__label">
              {inRoom ? t('player.nextUpInGroove') : t('player.nextUp')}
            </span>
            {!following && rows.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearUpcoming}>
                {t('player.clearQueue')}
              </Button>
            )}
          </div>
          {waiting && (
            <Text tone="muted" size="xs" className="queueUp__note">
              {hosting
                ? t('player.waitingOnYourPlayer')
                : t('player.waitingForHostPlayer', { host: room?.hostName ?? t('player.theHost') })}
            </Text>
          )}
          {/* The members' sends, ahead of the line: the newest thing in the
              room and the one thing everybody is waiting on. Drawn for the
              host too - a send is invisible to the host's deck until its
              player folds it in, and a paused deck folds nothing. In the
              order they will land (jam.tsx byLanding): a send asked to play
              NEXT wears an arrow-to-top and says so, and stands ahead of the
              appends - it goes in right after the song on. */}
          {pendingRows.length > 0 && (
            <div
              className="queueRows queueRows--pending"
              role="list"
              aria-label={
                hosting
                  ? t('player.pendingWaitingOnYou', { count: pendingRows.length })
                  : t('player.pendingWaitingOnHost', { count: pendingRows.length })
              }
            >
              {pendingRows.map((p) => {
                // Lower case and its own key: this is dropped INTO a sentence
                // ("by you"), which is a different word from the standalone
                // "You" in common - and a different one again in German.
                const who = p.mine ? t('player.you') : p.by;
                const next = p.next === true;
                const aria = SEND_ARIA[next ? 'next' : 'waiting'];
                const credit = next ? (
                  <span className="queueRow__credit queueRow__credit--pending queueRow__credit--next">
                    <ArrowUpToLine size={11} aria-hidden />
                    {t('player.sendNextBy', { who })}
                  </span>
                ) : (
                  <span className="queueRow__credit queueRow__credit--pending">
                    <Hourglass size={11} aria-hidden />
                    {t('player.sentBy', { who })}
                  </span>
                );
                const withdraw = p.mine && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="queueRow__withdraw queueRow__act"
                    aria-label={t('player.withdrawSend', {
                      title: p.track?.title ?? t('player.yourAdd'),
                    })}
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
                      note={t(aria.alone, { who })}
                      chip={credit}
                      action={withdraw}
                      pending
                      next={next}
                    />
                  );
                }
                return (
                  <TrackMenu key={`pending:${p.trackId}`} track={p.track} className="queueRowMenu">
                    <div
                      className="queueRow"
                      data-static
                      data-pending
                      data-next={next || undefined}
                      role="listitem"
                      aria-label={t(aria.row, {
                        title: p.track.title,
                        artist: p.track.artist,
                        who,
                      })}
                    >
                      <Cover track={p.track} />
                      <div className="queueRow__meta">
                        <span className="queueRow__title">{p.track.title}</span>
                        <span className="queueRow__artist">
                          <ArtistLink artist={p.track.artist} beforeOpen={onClose} />
                        </span>
                        {/* Its own line, not a tail on the artist's: that span
                            ellipsises, and a long artist name ate the pill. */}
                        {credit}
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
                {t('player.grooveQueueEmptyGuest', { host: room?.hostName ?? t('player.theHost') })}
              </Text>
            ) : lineRows.length === 0 ? null : (
              // A guest reads the room's list; nobody else's device can
              // reorder it.
              <div className="queueRows" role="list" aria-label={t('player.grooveQueueList')}>
                {lineRows.map(({ id, track: song }, i) => {
                  const credit = creditOf(id);
                  const added = credit ? t('player.addedBy', { who: credit }) : '';
                  const chip = credit ? <span className="queueRow__credit">{added}</span> : null;
                  if (!song) {
                    return (
                      <AskedRow key={`${id}-${i}`} answer={song} named={roomNames(id)} note={added} chip={chip} />
                    );
                  }
                  return (
                    <TrackMenu key={song.path} track={song} className="queueRowMenu">
                      <div className="queueRow" data-static role="listitem">
                        <Cover track={song} />
                        <div className="queueRow__meta">
                          <span className="queueRow__title">{song.title}</span>
                          <span className="queueRow__artist">
                            <ArtistLink artist={song.artist} beforeOpen={onClose} />
                            {chip}
                          </span>
                        </div>
                      </div>
                    </TrackMenu>
                  );
                })}
              </div>
            )
          ) : mirroring ? (
            /* The seat holder's order is drawn whole, below. Saying "nothing
               queued" here would be false: the songs are there, they are just
               not separable from the list they arrived in. */
            contextNext.length === 0 ? (
              <Text tone="muted" size="sm" className="queueUp__empty">
                {t('player.queueMirroredEmpty')}
              </Text>
            ) : null
          ) : rows.length === 0 ? (
            pendingRows.length > 0 ? null : (
              <Text tone="muted" size="sm" className="queueUp__empty">
                {inRoom ? t('player.grooveQueueEmptyHost') : t('player.queueEmpty')}
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
                            <span className="queueRow__credit">
                              {t('player.addedBy', { who: credit })}
                            </span>
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
                    aria-label={t('player.removeFromQueue', { title: r.track.title })}
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
              {/* `count` picks the plural form; `n` is the number as the
                  locale groups it, which is not the same string. */}
              {t('player.andMore', { count: hiddenCount, n: formatNumber(hiddenCount) })}
            </Text>
          )}
          {/*
            * What the list itself will play once your own picks run out.
            *
            * Read-only, and deliberately short. This is the lane that used to
            * BE the queue, and putting it back in full is how the panel became
            * unreadable in the first place - what a listener wants from it is
            * "what did I ask for, and what happens after that", not nine
            * hundred rows they never chose one at a time. Removing from here
            * would mean editing the playlist you are playing, which is a
            * different act with a different undo.
            */}
          {!following && contextNext.length > 0 && (
            <div className="queueUp__context">
              {/* Two labels for two states, not a count: this says whether the
                  list picks up after your own picks or straight away. Neither
                  is true while mirroring, where this IS the whole queue rather
                  than what is left of the list after it - so it goes unheaded
                  and the panel's own title names it. */}
              {!mirroring && (
                <Text tone="muted" size="xs" className="queueUp__contextHead">
                  {upNext.length > 0 ? t('player.thenFromList') : t('player.nextFromList')}
                </Text>
              )}
              <div className="queueRows" role="list" aria-label={t('player.comingUpFromList')}>
                {contextNext.map((song) => (
                  <TrackMenu key={song.path} track={song} className="queueRowMenu">
                    <div className="queueRow" data-static role="listitem">
                      <Cover track={song} />
                      <div className="queueRow__meta">
                        <span className="queueRow__title">{song.title}</span>
                        <span className="queueRow__artist">
                          <ArtistLink artist={song.artist} beforeOpen={onClose} />
                        </span>
                      </div>
                    </div>
                  </TrackMenu>
                ))}
              </div>
              {upcoming.length > contextNext.length && (
                <Text tone="muted" size="xs" className="queueUp__more">
                  {t('player.andMoreInList', {
                    count: upcoming.length - contextNext.length,
                    n: formatNumber(upcoming.length - contextNext.length),
                  })}
                </Text>
              )}
            </div>
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
  next = false,
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
  /** A pending send asked to play next (the mark rides on the row). */
  next?: boolean;
}) {
  const t = useT();
  const missing = t('player.notInLibrary');
  const asking = answer === undefined;
  const title = asking ? '…' : (named?.title ?? missing);
  const sub = asking ? '' : named ? [named.artist, missing].filter(Boolean).join(' · ') : '';
  return (
    <div
      className="queueRow"
      data-static
      data-asking={asking || undefined}
      data-missing={!asking || undefined}
      data-pending={pending || undefined}
      data-next={next || undefined}
      role="listitem"
      /* Facts read out in sequence - the song, then what state it is in -
         rather than one sentence, because any of the three can be absent and
         each is already a whole phrase in its own right. */
      aria-label={[asking ? t('player.stillLookingUp') : title, asking ? '' : sub, note]
        .filter(Boolean)
        .join(', ')}
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
