//! The Booth: the room where the listener meets the machine that has been
//! listening to them.
//!
//! Everything here is a straight projection of a live seam - nothing invented,
//! nothing decorative. The header's pill is the curator loop's actual phase;
//! the hero is one tap into a set drawn from real play history; the platter
//! card is the trait analysis of the song playing RIGHT NOW, with an honest
//! byline about whether a model heard it or a heuristic read it; the brain
//! tile is three counters the enrichment stack already keeps; and every mix
//! in the grid opens into the trait mixer that rebuilt it. The intelligence
//! is not narrated - it is instrumented.
//!
//! Everything degrades: an older server that 404s /api/features/status or
//! /api/curator/pulls simply loses that line, never the page.

import { Modal, Spinner, Text } from '@glacier/react';
import {
  AudioLines,
  AudioWaveform,
  BrainCircuit,
  CalendarClock,
  CalendarHeart,
  ChevronRight,
  Disc3,
  Ear,
  Feather,
  Flame,
  Guitar,
  HardDrive,
  ListMusic,
  MicVocal,
  NotebookPen,
  Piano,
  Settings2,
  SlidersHorizontal,
  Sparkle,
  Sparkles,
  Users,
  Waves,
} from '@glacier/icons';
import { useEffect, useState } from 'react';
import { DjLauncher } from './DjLauncher.tsx';
import { DjTraitSheet, DjCollectionTraitSheet } from './DjTraitSheet.tsx';
import { CuratorShelves } from '../library/HomePage.tsx';
import { CuratorSettings } from '../settings/CuratorSettings.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useNowPlayingMotion } from '../player/nowPlayingMotion.tsx';
import { useDjChat, DJ_AUTHOR } from './djChat.tsx';
import {
  analyzeDjTrack,
  fetchCollectorStatus,
  fetchCurator,
  fetchFeaturesStatus,
  trackIdFromPath,
  type CollectorStatus,
  type CuratorFeed,
  type DjTraitAnalysis,
  type FeaturesStatus,
} from '../server.ts';
import type { Track } from '../core/tauri.ts';
import djMascot from '../../assets/dj-mascot.png';

/** A glyph for each trait category the analyzer can emit - the icon system
 *  that lets a trait chip say what KIND of observation it is at a glance. */
const TRAIT_GLYPH: Record<string, typeof Waves> = {
  sonic: AudioWaveform,
  energy: Flame,
  genre_style: Guitar,
  vocals: MicVocal,
  era: CalendarClock,
  mood: Sparkle,
  production: SlidersHorizontal,
  lyrical_theme: Feather,
  instrumentation: Piano,
  scene_culture: Users,
};

/** Bytes as a short human size for the collector line. */
function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(bytes >= 10_737_418_240 ? 0 : 1)} GB`;
}

/** The pill's one line: the curator loop's phase, in its own voice. */
function pulseLine(feed: CuratorFeed | null): { Icon: typeof Ear; text: string } {
  if (feed) {
    const { status, progress } = feed;
    if (status.phase === 'enriching' && progress.total > 0) {
      return { Icon: Ear, text: `Reading your library · ${progress.checked} of ${progress.total}` };
    }
    if (status.phase === 'curating') return { Icon: Sparkles, text: 'Building your next mixes' };
    if (status.lastCurated > 0) {
      const hours = Math.max(1, Math.round((Date.now() / 1000 - status.lastCurated) / 3600));
      return {
        Icon: Sparkles,
        text: hours < 24 ? `Mixes freshened ${hours === 1 ? 'an hour' : `${hours} hours`} ago` : 'Mixes ready · more as you listen',
      };
    }
  }
  return { Icon: Sparkles, text: 'Your taste, at the decks' };
}

export function BoothPage({
  onPlay,
  onOpenArtist,
  onOpenDate,
  onOpenDj,
}: {
  onPlay: (track: Track, queue?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens Music Date's fullscreen layer; App hosts it above all chrome. */
  onOpenDate: () => void;
  /** Opens the DJ conversation's fullscreen layer - hosted by App too, for
   *  the same reason: a fixed layer inside the swipe host's transform is
   *  trapped under the app's chrome. */
  onOpenDj: () => void;
}) {
  const { session } = useServerSession();
  const { track: playing } = useNowPlayingMotion();
  const chat = useDjChat();

  const [feed, setFeed] = useState<CuratorFeed | null>(null);
  const [feats, setFeats] = useState<FeaturesStatus | null>(null);
  const [pulls, setPulls] = useState<CollectorStatus | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // The three instruments, each on its own wire: a box that lacks one
  // endpoint (older server, review build) loses that line and nothing else.
  useEffect(() => {
    if (!session) {
      setFeed(null);
      setFeats(null);
      setPulls(null);
      return;
    }
    const ctrl = new AbortController();
    void fetchCurator(session, ctrl.signal).then(setFeed).catch(() => {});
    void fetchFeaturesStatus(session, ctrl.signal).then(setFeats).catch(() => {});
    void fetchCollectorStatus(session, ctrl.signal).then(setPulls).catch(() => {});
    return () => ctrl.abort();
  }, [session]);

  // On the platter: the song playing right now, as the DJ hears it. The
  // analysis is server-cached for a week, so following the listener from
  // song to song costs one small request each - still debounced, so a
  // skip-spree does not fire one per skip.
  const [platter, setPlatter] = useState<{ path: string; analysis: DjTraitAnalysis } | null>(null);
  const [platterBusy, setPlatterBusy] = useState(false);
  const [sheetTrack, setSheetTrack] = useState<Track | null>(null);
  useEffect(() => {
    if (!session || !playing) {
      setPlatter(null);
      return;
    }
    const id = trackIdFromPath(playing.path);
    if (id === null) {
      setPlatter(null);
      return;
    }
    const path = playing.path;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      setPlatterBusy(true);
      void analyzeDjTrack(session, id, ctrl.signal)
        .then((analysis) => setPlatter({ path, analysis }))
        .catch(() => {
          // 422 (nothing useful to say), an old server, or an aborted skip:
          // the card simply is not there for this song.
          if (!ctrl.signal.aborted) setPlatter(null);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setPlatterBusy(false);
        });
    }, 600);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [session, playing?.path]);

  // Tune a mix: any curated crate opens into the trait mixer that built it.
  const [tuneMix, setTuneMix] = useState<{ title: string; tracks: Track[] } | null>(null);

  const pulse = pulseLine(feed);
  const waiting = pulls?.recent?.filter((r) => r.state === 'landed').length ?? 0;
  const lastDjLine =
    chat?.messages.filter((m) => m.authorId === DJ_AUTHOR && m.text).at(-1)?.text ?? null;

  const analysis = platter && playing && platter.path === playing.path ? platter.analysis : null;
  const topTraits = analysis
    ? [...analysis.traits]
        .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
        .slice(0, 3)
    : [];

  return (
    <div className="boothPage">
      <header className="boothHead">
        <h1 className="boothHead__title">The Booth</h1>
        {/* The pill is the loop's real phase; tapping it opens the brain's
            preferences. Model health lives in the brain card below, where it
            gets words - two bare dots up here read as stray punctuation. */}
        <button
          type="button"
          className="boothPulse"
          onClick={() => setPrefsOpen(true)}
          aria-label="Curator status and preferences"
        >
          <pulse.Icon size={13} aria-hidden="true" />
          <span className="boothPulse__text">{pulse.text}</span>
        </button>
      </header>

      {/* Music Date: the invitation stays on top, by request. */}
      {session && (
        <button type="button" className="boothDate" onClick={onOpenDate}>
          <span className="boothDate__mark" aria-hidden="true">
            <CalendarHeart size={18} />
          </span>
          <span className="boothDate__text">
            <span className="boothDate__title">Music Date</span>
            <span className="boothDate__caption">
              {waiting > 0
                ? `${waiting} new ${waiting === 1 ? 'find' : 'finds'} waiting — art and sound, no names`
                : 'Meet what the collector found — art and sound, no names'}
            </span>
          </span>
          <ChevronRight size={18} className="boothDate__chevron" aria-hidden="true" />
        </button>
      )}

      {/* Drop the needle: the page's one hero, and the moods that steer it. */}
      {session && <DjLauncher variant="hero" onPlay={onPlay} />}

      {/* On the platter: the playing song as the DJ hears it - summary, its
          three loudest traits glyphed by kind, and an honest byline: this
          endpoint's ai flag is the only one in the stack that proves a model
          actually answered, so "heard by the model" is never a guess. */}
      {session && playing && (analysis || platterBusy) && (
        <button
          type="button"
          className="boothPlatter"
          onClick={() => setSheetTrack(playing)}
          aria-label={`How the DJ hears ${playing.title}`}
        >
          <span className="boothPlatter__head">
            <Disc3 size={15} className="boothPlatter__disc" aria-hidden="true" />
            <span className="boothPlatter__label">On the platter</span>
            {analysis && (
              <span className="boothPlatter__byline" data-ai={analysis.ai || undefined}>
                {analysis.ai ? <Sparkles size={11} /> : <AudioLines size={11} />}
                {analysis.ai ? 'heard by the model' : 'read by ear'}
              </span>
            )}
          </span>
          <span className="boothPlatter__song">
            {playing.title} <span className="boothPlatter__artist">— {playing.artist}</span>
          </span>
          {analysis ? (
            <>
              {analysis.summary && (
                <span className="boothPlatter__summary">{analysis.summary}</span>
              )}
              <span className="boothPlatter__traits">
                {topTraits.map((t) => {
                  const Glyph = TRAIT_GLYPH[t.category] ?? Waves;
                  return (
                    <span key={t.id} className="boothTrait" title={t.description}>
                      <Glyph size={12} aria-hidden="true" />
                      {t.label}
                    </span>
                  );
                })}
              </span>
              {analysis.djNote && (
                <span className="boothPlatter__note">
                  <NotebookPen size={12} aria-hidden="true" />
                  {analysis.djNote}
                </span>
              )}
            </>
          ) : (
            <span className="boothPlatter__summary boothPlatter__summary--busy">
              <Spinner size="sm" aria-label="" /> The DJ is listening…
            </span>
          )}
        </button>
      )}

      {/* The DJ's door: his last line as the caption, the whole conversation
          behind it - fullscreen, since a composer deserves a viewport. */}
      <button type="button" className="boothDate boothDoor--dj" onClick={onOpenDj}>
        <span className="boothDate__mark boothDoor__face" aria-hidden="true">
          <img src={djMascot} alt="" />
        </span>
        <span className="boothDate__text">
          <span className="boothDate__title">Ask the DJ</span>
          <span className="boothDate__caption">
            {chat?.busy ? 'Going through the crates…' : (lastDjLine ?? "Tell him what you're after")}
          </span>
        </span>
        {chat?.busy ? (
          <Spinner size="sm" aria-label="The DJ is thinking" />
        ) : (
          <ChevronRight size={18} className="boothDate__chevron" aria-hidden="true" />
        )}
      </button>

      {/* The brain: three counters the stack already keeps, and the door to
          its preferences. Each line exists only if its endpoint answered. */}
      {session && (feed || feats || pulls) && (
        <button type="button" className="boothBrain" onClick={() => setPrefsOpen(true)}>
          <span className="boothBrain__head">
            <span className="boothBrain__glyph" aria-hidden="true">
              <BrainCircuit size={15} />
            </span>
            <span className="boothBrain__title">The curator&rsquo;s brain</span>
            <Settings2 size={14} className="boothBrain__gear" aria-hidden="true" />
          </span>
          {feed && (
            <span className="boothBrain__row">
              <span className="boothBrain__icon" data-tint="purple" aria-hidden="true">
                <Ear size={13} />
              </span>
              Read {feed.progress.checked} of {feed.progress.total} · {feed.progress.withTempo}{' '}
              tempo · {feed.progress.withLyrics} lyrics
            </span>
          )}
          {feats && (
            <span className="boothBrain__row">
              <span className="boothBrain__icon" data-tint="blue" aria-hidden="true">
                <AudioLines size={13} />
              </span>
              Fingerprinted {feats.fingerprinted} of {feats.total}
              {!feats.ffmpeg && <span className="boothBrain__tag">analysis off — no ffmpeg</span>}
            </span>
          )}
          {pulls && pulls.capBytes > 0 && (
            <span className="boothBrain__row">
              <span className="boothBrain__icon" data-tint="green" aria-hidden="true">
                <HardDrive size={13} />
              </span>
              Collector holds {gb(pulls.ledgerBytes)} of {gb(pulls.capBytes)}
              {pulls.halted === 'cap' && <span className="boothBrain__tag">paused — budget spent</span>}
            </span>
          )}
        </button>
      )}

      {/* The crates: every mix the pipeline produced, as a grid - and every
          card carries the tune door into the trait mixer that built it. */}
      <section className="boothMixes">
        <span className="boothMixes__head">
          <span className="boothBrain__glyph" aria-hidden="true">
            <ListMusic size={15} />
          </span>
          <span className="boothBrain__title">Made from your library</span>
        </span>
        <CuratorShelves onPlay={onPlay} onOpenArtist={onOpenArtist} onTune={setTuneMix} />
      </section>

      {sheetTrack && (
        <DjTraitSheet track={sheetTrack} open onClose={() => setSheetTrack(null)} />
      )}
      {tuneMix && (
        <DjCollectionTraitSheet
          source="playlist"
          name={tuneMix.title}
          seedTracks={tuneMix.tracks}
          open
          onClose={() => setTuneMix(null)}
        />
      )}

      <Modal open={prefsOpen} onClose={() => setPrefsOpen(false)} title="Booth preferences" size="md">
        <CuratorSettings />
      </Modal>
    </div>
  );
}
