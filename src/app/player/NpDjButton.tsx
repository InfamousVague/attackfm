import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { IconButton, Popover, Text } from '@glacier/react';
import { djDoorOpen, openDj } from '../nav/djDoor.ts';
import { Bot, History, MessageCircle, Mic, Play, Radio, Sparkles, Users } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { usePlayNowOptional } from './playNow.tsx';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { useJamOptional } from './jam.tsx';
import { startDjRun } from '../booth/djSession.ts';
import { MOODS, moodLabel } from '../booth/DjLauncher.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { peekDj, fetchDjStations, type DjStation } from '../api/dj.ts';
import { recentDjAsks } from '../booth/djAsks.ts';
import { clockInWords } from '../booth/djClock.ts';
import { artSized, trackIdFromPath } from '../server.ts';
import { mosaicArts } from '../ux/artLoad.ts';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { fireNativeHaptic } from '../core/haptics.ts';
import type { ServerSession } from '../api/http.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The DJ, at the decks: a seat on the Now Playing action row that starts a
 * live set right here, by request, so the voice can be met where the music
 * already is instead of a page away in the Booth.
 *
 * The panel is a small DECK of cards rather than a row of chips, and it
 * reads the room before it asks anything: the hour (the hub orders its
 * stations for it, and the card at the top says the time in words), the
 * song on the deck (a "more like this" card wearing its sleeve), the groove
 * (a host's set goes to the room; a follower is told the host sets the
 * pace), and what the listener asked for last (three chips). Every card is
 * one tap from sound, and the set it starts is the same shared run
 * (djSession) the Booth publishes - the bridge toasts the lines and speaks
 * the beats no matter which door opened the set.
 *
 * Fetch discipline: the stations once an hour, one peek at what the top
 * card would play (cached per seed per hour), nothing at all for the moods.
 */

/** What the DJ is up to while you wait - cycled under the hero's title.
 *  Keys, not lines: this array is built when the module loads, and a line
 *  translated here would still be in the boot language an hour after the
 *  listener changed it. `useCueClock` resolves the one it hands back. */
const CUE_LINES = [
  'booth.cueReadingRoom',
  'booth.cueDigging',
  'booth.cueMatchingMood',
  'booth.cueLiningUp',
  'booth.cueDroppingNeedle',
];

/** The wait budget the countdown paces itself to - the server holds the
 *  patter model to five seconds, so the whole reply lands inside this. */
const CUE_SECONDS = 8;

/** The card that stands in when the hub has no stations yet. Its words are
 *  keys for the same reason the cue lines are: nothing at module scope can
 *  know what language the listener will be reading in. */
const TASTE = { nameKey: 'booth.tasteStation', blurbKey: 'booth.tasteStationBlurb' };

// --- the hour's caches -----------------------------------------------------

/** The current hour, as a cache stamp: everything below is good for one. */
const hourStamp = () => Math.floor(Date.now() / 3_600_000);

const stationsByHub = new Map<string, { at: number; list: DjStation[] }>();
const peekBySeed = new Map<string, { at: number; ids: number[] }>();

/**
 * The hub's stations, ordered for this hour by the hub itself. Fetched when
 * the panel opens and kept for the hour, so reopening the deck costs
 * nothing; `null` until the first answer, so the hero can tell "no stations"
 * from "not yet".
 */
function useStations(session: ServerSession | null, open: boolean): DjStation[] | null {
  const hit = session ? stationsByHub.get(session.url) : undefined;
  const fresh = hit && hit.at === hourStamp() ? hit.list : null;
  const [list, setList] = useState<DjStation[] | null>(fresh);
  useEffect(() => {
    if (!open || !session) return;
    const cached = stationsByHub.get(session.url);
    if (cached && cached.at === hourStamp()) {
      setList(cached.list);
      return;
    }
    let live = true;
    void fetchDjStations(session)
      .then((got) => {
        stationsByHub.set(session.url, { at: hourStamp(), list: got });
        if (live) setList(got);
      })
      .catch(() => {
        // No stations is a quiet absence: the hero falls back to taste.
        if (live) setList([]);
      });
    return () => {
      live = false;
    };
  }, [open, session]);
  return list;
}

/**
 * What the DJ would deal for the hero's seed - the ids, so the card can wear
 * their sleeves. One ask per seed per hour; a hub older than the preview
 * door (0.5.115) answers 404 and the card keeps its local guess.
 */
function usePeek(
  session: ServerSession | null,
  seed: string | null,
  filter: string | undefined,
): number[] | null {
  const key = seed === null || !session ? null : `${session.url}|${seed}|${filter ?? ''}`;
  const hit = key ? peekBySeed.get(key) : undefined;
  const fresh = hit && hit.at === hourStamp() ? hit.ids : null;
  const [ids, setIds] = useState<number[] | null>(fresh);
  useEffect(() => {
    if (key === null || seed === null || !session) {
      setIds(null);
      return;
    }
    const cached = peekBySeed.get(key);
    if (cached && cached.at === hourStamp()) {
      setIds(cached.ids);
      return;
    }
    const ctl = new AbortController();
    void peekDj(session, seed, filter, ctl.signal)
      .then((got) => {
        peekBySeed.set(key, { at: hourStamp(), ids: got });
        if (!ctl.signal.aborted) setIds(got);
      })
      .catch(() => {
        // An older hub or a slow one: the local guess stays. Not cached, so
        // the next open asks again in case the hub has caught up.
      });
    return () => ctl.abort();
  }, [key, seed, filter, session]);
  return ids;
}

// --- picking sleeves -------------------------------------------------------

/** A station's literal constraint, read the way the hub writes it. */
function filterOf(filter: string | undefined, kind: 'artist' | 'genre'): string | null {
  if (!filter) return null;
  const head = `${kind}:`;
  return filter.startsWith(head) ? filter.slice(head.length).trim().toLowerCase() : null;
}

function byArtist(tracks: Track[], artist: string): Track[] {
  return tracks.filter(
    (t) => t.artist.toLowerCase() === artist || (t.albumArtist ?? '').toLowerCase() === artist,
  );
}

/**
 * What the card can guess it would play WITHOUT asking: an artist station's
 * own records, a genre's, the newest arrivals for "unplayed", and for a
 * mood the library's own sleeves. Shown while the peek is out and kept
 * when the hub cannot answer one.
 */
function localPicks(filter: string | undefined, tracks: Track[], forYou: Track[]): Track[] {
  const artist = filterOf(filter, 'artist');
  if (artist) {
    const mine = byArtist(tracks, artist);
    if (mine.length > 0) return mine;
  }
  const genre = filterOf(filter, 'genre');
  if (genre) {
    const mine = tracks.filter((t) => t.genre.toLowerCase().includes(genre));
    if (mine.length > 0) return mine;
  }
  if (filter === 'unplayed') {
    const fresh = [...forYou, ...tracks].sort((a, b) => b.addedAt - a.addedAt);
    if (fresh.length > 0) return fresh;
  }
  return tracks;
}

/** A 2x2 of sleeves: the four distinct covers, or the first alone, or a glyph. */
function Mosaic({ arts }: { arts: string[] }) {
  if (arts.length === 0) {
    return (
      <span className="npDjMosaic npDjMosaic--blank" aria-hidden>
        <Bot size={26} />
      </span>
    );
  }
  const shown = arts.length >= 4 ? arts : arts.slice(0, 1);
  return (
    <span className="npDjMosaic" data-n={shown.length} aria-hidden>
      {shown.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy" decoding="async" />
      ))}
    </span>
  );
}

// --- the cue clock ---------------------------------------------------------

/**
 * The countdown, as numbers: seconds left, the fraction run, and the DJ's
 * busywork line for this moment. If the set lands early the panel simply
 * closes mid-count; if the count runs dry first, the number gives way to an
 * ellipsis and the ring stays full - a promise, not a stopwatch.
 */
function useCueClock(running: boolean): { left: number; frac: number; line: string } {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(tick);
  }, [running]);
  return {
    left: Math.max(0, CUE_SECONDS - elapsed),
    frac: Math.min(1, elapsed / CUE_SECONDS),
    line: t(CUE_LINES[Math.min(CUE_LINES.length - 1, Math.floor(elapsed / 1.7))]!),
  };
}

/** The ring, laid over the hero's mosaic while a set is cut. */
function CueRing({ left, frac }: { left: number; frac: number }) {
  const R = 42;
  const C = 2 * Math.PI * R;
  return (
    <span className="npDjCue" aria-hidden>
      <svg className="npDjCue__ring" viewBox="0 0 100 100">
        <circle className="npDjCue__rail" cx="50" cy="50" r={R} />
        <circle
          className="npDjCue__fill"
          cx="50"
          cy="50"
          r={R}
          transform="rotate(-90 50 50)"
          style={{ strokeDasharray: C, strokeDashoffset: C * (1 - frac) } as CSSProperties}
        />
      </svg>
      <span className="npDjCue__num">{left > 0.05 ? Math.ceil(left) : '…'}</span>
    </span>
  );
}

/** Resolves once the deck's panel has left the DOM - or after a beat, so a
 *  panel that cannot animate out (no frames, a hidden tab) never holds the
 *  music. Polled on a timer rather than a frame for the same reason. */
function panelGone(): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (!document.querySelector('.npDjPanel') || Date.now() - started > 350) resolve();
      else window.setTimeout(check, 40);
    };
    window.setTimeout(check, 40);
  });
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="npDjSection" role="group" aria-label={label}>
      <span className="npDjSection__label" aria-hidden>
        {label}
      </span>
      {children}
    </div>
  );
}

// --- the deck --------------------------------------------------------------

/** What is being cued: the brief, and the name the hero wears meanwhile. */
interface Cue {
  seed: string;
  filter?: string;
  /** Shown, never sent: the seed and the filter are the hub's contract, so
   *  this one is safe to hand over in the listener's language. */
  name: string;
}

export function NpDjButton() {
  const t = useT();
  const { session } = useServerSession();
  const { tracks, forYou } = useLibrary();
  const play = usePlayNowOptional();
  const { track: playing } = useNowPlayingMotion();
  const jam = useJamOptional();
  const [open, setOpen] = useState(false);
  const [cue, setCue] = useState<Cue | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = cue !== null;
  const clock = useCueClock(busy);

  // The room: a host's set goes out to it; a follower's deck is silent (it
  // steers to the host's clock), so nothing here can start for them.
  const room = jam?.current ?? null;
  const hosting = room !== null && !!jam?.hosting;
  const following = room !== null && !hosting;

  // Hooks stay above the early return: the seat's absence must not reorder them.
  const stations = useStations(session, open);
  const hero = stations?.[0] ?? null;
  const heroSeed = hero?.seed ?? '';
  const heroFilter = hero?.filter;
  const peek = usePeek(session, open && stations !== null && !following ? heroSeed : null, heroFilter);
  const asks = useMemo(() => (open ? recentDjAsks() : []), [open]);

  const byId = useMemo(() => {
    const m = new Map<number, Track>();
    for (const t of [...tracks, ...forYou]) {
      const id = trackIdFromPath(t.path);
      if (id != null && !m.has(id)) m.set(id, t);
    }
    return m;
  }, [tracks, forYou]);

  // The hero's sleeves: the hub's picks first, topped up from the local
  // guess so the square is always a full 2x2 when four sleeves exist at all.
  const heroArts = useMemo(() => {
    const picked = (peek ?? []).map((id) => byId.get(id)).filter((t): t is Track => !!t);
    const guess = localPicks(heroFilter, tracks, forYou);
    return mosaicArts([...picked, ...guess].map((t) => t.artwork), 4, 160);
  }, [peek, byId, heroFilter, tracks, forYou]);

  // The rest of the dial, minus the card the hero took.
  const rest = useMemo(() => (stations ?? []).slice(1), [stations]);
  const stationArt = useMemo(() => {
    const m = new Map<string, string>();
    for (const st of rest) {
      const artist = filterOf(st.filter, 'artist');
      if (!artist) continue;
      const own = byArtist(tracks, artist).find((t) => !!t.artwork);
      const src = own ? artSized(own.artwork, 160) : null;
      if (src) m.set(st.id, src);
    }
    return m;
  }, [rest, tracks]);

  // No server, no library, no play door: the seat simply is not there.
  if (!session || !play || tracks.length === 0) return null;

  const start = async (next: Cue) => {
    if (busy || following) return;
    setCue(next);
    setNote(null);
    try {
      const { queue } = await startDjRun(session, [...tracks, ...forYou], next.seed, {
        filter: next.filter,
      });
      const opener = queue[0];
      if (!opener) {
        setNote(t('booth.emptyRun'));
        return;
      }
      // Close FIRST: starting the set re-renders the whole sheet (new
      // track), and unmounting a kit Popover while it is open strands its
      // portalled panel on screen. Shut the door, let it finish closing (the
      // kit's exit is an animation, and a sheet re-rendering under it
      // mid-flight is the strand), then change the record.
      setOpen(false);
      fireNativeHaptic('medium');
      await panelGone();
      play(opener, queue);
    } catch (err) {
      setNote(err instanceof Error ? err.message : t('booth.couldNotStart'));
    } finally {
      setCue(null);
    }
  };

  // The hero's words: the clock, or the room, or what is being cued.
  const heroName = hero?.name ?? t(TASTE.nameKey);
  const heroBlurb = hero?.blurb || t(TASTE.blurbKey);
  const eyebrow = busy
    ? t('booth.cueingUp')
    : hosting
      ? t('booth.intoTheGroove')
      : clockInWords();
  const title = busy
    ? cue.name
    : following
      ? t('booth.hostSetsThePace', { host: room.hostName })
      : heroName;
  const blurb = busy
    ? clock.line
    : hosting
      ? t('booth.toTheRoom', { count: room.memberCount })
      : following
        ? t('booth.followerLocked', { host: room.hostName })
        : heroBlurb;

  const playingArt = playing ? artSized(playing.artwork, 160) : null;
  const canTalk = djDoorOpen();

  return (
    <Popover
      placement="top"
      aria-label="DJ"
      className="popoverSheet npDjPanel"
      open={open}
      onOpenChange={setOpen}
      trigger={
        /* A robot head, not a record. Every other disc in the app means an
           ALBUM (the library tiles, the Booth platter, the notification for a
           new record), so the one control that summons the AI voice was
           wearing the same glyph as the thing it plays. The DJ is a machine
           that talks - say so, and the seat stops reading as "another album
           button" on a row where the neighbours are a book and a microphone. */
        <IconButton variant="ghost" aria-label={t('player.startDjSet')}>
          <Bot size={20} />
        </IconButton>
      }
    >
      <div className="npDj" data-cueing={busy || undefined} data-locked={following || undefined}>
        {/* 1. For right now: the hour's station, wearing what it would play.
            While a set is cued THIS card becomes the console - the ring on
            the mosaic, the DJ's busywork under the title - and the rest of
            the deck stands down until the needle drops. */}
        <Section label={t('booth.deckNow')}>
          {following ? (
            <div className="npDjCard npDjHero npDjHero--locked" role="note">
              <span className="npDjHero__art">
                <Mosaic arts={heroArts} />
              </span>
              <span className="npDjHero__text">
                <span className="npDjHero__eyebrow">
                  <Users size={12} aria-hidden />
                  {t('booth.inHostGroove', { host: room.hostName })}
                </span>
                <span className="npDjHero__title">{title}</span>
                <span className="npDjHero__blurb npDjHero__blurb--wrap">{blurb}</span>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="npDjCard npDjHero"
              aria-label={
                busy
                  ? t('booth.cueingNamed', { name: cue.name })
                  : t('booth.playStation', { name: heroName, blurb: heroBlurb })
              }
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => void start({ seed: heroSeed, filter: heroFilter, name: heroName })}
            >
              <span className="npDjHero__art" data-dim={busy || undefined}>
                <Mosaic arts={heroArts} />
                {busy && <CueRing left={clock.left} frac={clock.frac} />}
              </span>
              <span className="npDjHero__text">
                <span className="npDjHero__eyebrow">
                  {hosting && !busy && <Users size={12} aria-hidden />}
                  {eyebrow}
                </span>
                <span className="npDjHero__title">{title}</span>
                <span className="npDjHero__blurb" role={busy ? 'status' : undefined} aria-live={busy ? 'polite' : undefined}>
                  {blurb}
                </span>
              </span>
              <span className="npDjHero__play" aria-hidden>
                <Play size={18} fill="currentColor" />
              </span>
            </button>
          )}
        </Section>

        {/* 2. More like this: the song on the deck, as a station of one. */}
        {playing && playing.kind !== 'book' && (
          <Section label={t('booth.deckMoreLikeThis')}>
            <button
              type="button"
              className="npDjCard npDjLike"
              aria-label={t('booth.playMoreLike', { title: playing.title, artist: playing.artist })}
              disabled={busy || following}
              onClick={() =>
                void start({
                  seed: `more like ${playing.title} by ${playing.artist}`,
                  filter: `artist:${playing.artist}`,
                  name: t('booth.moreLikeTitle', { title: playing.title }),
                })
              }
            >
              {playingArt ? (
                <img className="npDjLike__art" src={playingArt} alt="" />
              ) : (
                <span className="npDjLike__art npDjLike__art--blank" aria-hidden>
                  <Radio size={18} />
                </span>
              )}
              <span className="npDjLike__text">
                <span className="npDjLike__title">
                  {t('booth.moreLikeTitle', { title: playing.title })}
                </span>
                <span className="npDjLike__blurb">
                  {t('booth.artistsNextDoor', { artist: playing.artist })}
                </span>
              </span>
              <span className="npDjLike__go" aria-hidden>
                <Play size={14} fill="currentColor" />
              </span>
            </button>
          </Section>
        )}

        {/* 3. Moods: six ways to steer, each its own colour and its own glyph. */}
        <Section label={t('booth.deckMoods')}>
          <div className="npDjMoods">
            {MOODS.map((mood) => {
              const label = moodLabel(mood, t);
              const hint = t(mood.hintKey);
              return (
                <button
                  key={mood.seed}
                  type="button"
                  className="npDjCard npDjMood"
                  style={{ '--mood-hue': mood.hue } as CSSProperties}
                  aria-label={t('booth.playMoodSet', { label, hint })}
                  disabled={busy || following}
                  onClick={() => void start({ seed: mood.seed, name: label })}
                >
                  <span className="npDjMood__icon" aria-hidden>
                    <mood.Icon size={18} />
                  </span>
                  <span className="npDjMood__text">
                    <span className="npDjMood__label">{label}</span>
                    <span className="npDjMood__hint">{hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        {/* 4. Your stations: the rest of the hub's dial, in the hour's order. */}
        {rest.length > 0 && (
          <Section label={t('booth.deckStations')}>
            <EdgeScrollRow className="npDjStations">
              {rest.map((st) => {
                const art = stationArt.get(st.id);
                return (
                  <button
                    key={st.id}
                    type="button"
                    className="npDjCard npDjStation"
                    aria-label={
                      st.blurb
                        ? t('booth.playStation', { name: st.name, blurb: st.blurb })
                        : t('booth.playStationPlain', { name: st.name })
                    }
                    disabled={busy || following}
                    onClick={() => void start({ seed: st.seed, filter: st.filter, name: st.name })}
                  >
                    <span className="npDjStation__head">
                      {art ? (
                        <img className="npDjStation__art" src={art} alt="" loading="lazy" />
                      ) : (
                        <span className="npDjStation__art npDjStation__art--blank" aria-hidden>
                          <Radio size={16} />
                        </span>
                      )}
                      {st.flavor === 'ai' && (
                        <span className="npDjStation__ai" title={t('booth.namedByDj')} aria-hidden>
                          <Sparkles size={12} />
                        </span>
                      )}
                    </span>
                    <span className="npDjStation__name">{st.name}</span>
                    {st.blurb && <span className="npDjStation__blurb">{st.blurb}</span>}
                  </button>
                );
              })}
            </EdgeScrollRow>
          </Section>
        )}

        {/* 5. Recent asks: the listener's last three briefs, one tap again. */}
        {asks.length > 0 && (
          <Section label={t('booth.deckRecentAsks')}>
            <div className="npDjAsks">
              {asks.map((ask) => (
                <button
                  key={ask}
                  type="button"
                  className="npDjCard npDjAsk"
                  aria-label={t('booth.askAgain', { ask })}
                  disabled={busy || following}
                  onClick={() => void start({ seed: ask, name: ask })}
                >
                  <History size={14} aria-hidden />
                  <span>{ask}</span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* 6. Talk: the conversation, and its microphone. This popover was the
            only DJ door outside the developer-mode Booth, and for a while it
            could start a set but never talk. */}
        {canTalk && (
          <button
            type="button"
            className="npDjCard npDjTalk"
            aria-label={t('booth.talkToDjAria')}
            disabled={busy}
            onClick={() => {
              setOpen(false);
              openDj();
            }}
          >
            <span className="npDjTalk__glyphs" aria-hidden>
              <MessageCircle size={18} />
              <Mic size={18} />
            </span>
            <span className="npDjTalk__label">{t('booth.talkToDj')}</span>
          </button>
        )}

        {note && (
          <Text size="xs" tone="muted">
            {note}
          </Text>
        )}
      </div>
    </Popover>
  );
}
