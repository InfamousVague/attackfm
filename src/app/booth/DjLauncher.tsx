//! The DJ, on the client: one button, no brief. The server hands back a
//! continuous set drawn from what the listener actually plays, with a spoken
//! line opening each run; this turns that into playback - the whole set
//! becomes the queue, and the lines FLOAT: each one arrives as a dismissable
//! card when its run begins, the way a radio DJ talks over the intro, rather
//! than as a strip of small italic text wedged into the library header.
//!
//! There was a vibe field here. It asked the listener to have an idea before
//! they could hear anything, which is the opposite of what a DJ button is for:
//! the point is to press it and be played to. The server's own taste model is a
//! better answer than most people's first typed word, and it already mixes the
//! less-played corners of a library in rather than looping the same favourites.
//!
//! Draws on the server library and the listener's play history, so it only
//! offers itself when signed into a server with something to play.

import { Button, Spinner } from '@glacier/react';
import { Flame, Lightbulb, Mic, MoonStar, Play, Sparkles, Square, TrendingUp, Waves } from '@glacier/icons';
import { useEffect, useState, type CSSProperties } from 'react';
import { useTalkToDj } from './useTalkToDj.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { startDjRun } from './djSession.ts';
import { DjToast } from './DjSetBridge.tsx';
import { LibChipMosaic, LibChipStat } from '../library/LibChipFace.tsx';
import type { Track } from '../core/tauri.ts';
import djMascot from '../../assets/dj-mascot.webp';

/** The Booth's steering row: each chip is a whole brief, one tap from sound.
 *  The seeds mirror the server's own mood-mix recipes, so the chip and the
 *  curated shelf speak the same dialect.
 *
 *  The words are keys rather than words because this table is built when the
 *  module loads, long before there is a language to build it in: a literal
 *  here is whatever language the app booted in, for the rest of the session,
 *  and the picker in Settings would move six chips not at all. */
export type Mood = {
  seed: string;
  Icon: typeof Waves;
  /** Three words under the label, where a card has room for them (the Now
   *  Playing deck): what the mood sounds like, not what it is called. */
  hintKey: string;
  /** The mood's own colour, as a hue the card tints its glyph with - six
   *  moods, six hues, so the deck reads as six things and not six pills. */
  hue: number;
} & (
  /** A mood the listener reads in their own language... */
  | { labelKey: string; label?: never }
  /** ...or one whose word is a NAME: `Charts` and `New music` are the hub's
   *  own shelf and folder names, matched on elsewhere, and a chip that says
   *  something the shelf does not is a door onto nothing. */
  | { label: string; labelKey?: never }
);

export const MOODS: Mood[] = [
  { labelKey: 'booth.moodChill', seed: 'something chill and unhurried', Icon: Waves, hintKey: 'booth.moodChillHint', hue: 196 },
  { labelKey: 'booth.moodEnergy', seed: 'high energy, turn it up', Icon: Flame, hintKey: 'booth.moodEnergyHint', hue: 18 },
  { labelKey: 'booth.moodLateNight', seed: 'late night, low lights', Icon: MoonStar, hintKey: 'booth.moodLateNightHint', hue: 262 },
  { labelKey: 'booth.moodFocus', seed: 'steady focus, no distractions', Icon: Lightbulb, hintKey: 'booth.moodFocusHint', hue: 44 },
  // The charts: what everyone is playing, from what is already on the box -
  // owned hits plus the collector's pre-downloaded chart auditions. The seed
  // string is the server's vibe contract (vibes.rs), verbatim.
  { label: 'Charts', seed: 'the charts right now', Icon: TrendingUp, hintKey: 'booth.moodChartsHint', hue: 334 },
  // New music: the dates waiting to meet you and the arrivals you have not
  // heard, dates leading. Same contract discipline - the seed IS the key.
  { label: 'New music', seed: 'the new music waiting for me', Icon: Sparkles, hintKey: 'booth.moodNewHint', hue: 150 },
];

/** Both doors onto the moods - the Booth's chip row and the Now Playing deck -
 *  need the same fallback, and a chip that says one thing in the Booth and
 *  another on the deck is a bug you would only ever see in German. */
export function moodLabel(mood: Mood, t: (key: string) => string): string {
  return mood.labelKey === undefined ? mood.label : t(mood.labelKey);
}

export function DjLauncher({
  onPlay,
  variant = 'chip',
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  /** 'chip' is the Library's whole-collection door; 'hero' is the Booth's
   *  drop-the-needle card with the mood chips underneath. */
  variant?: 'chip' | 'hero';
}) {
  const t = useT();
  const { session } = useServerSession();
  const { tracks, forYou } = useLibrary();
  // Which brief is in flight: '' is the seedless hero press, null is idle.
  const [busySeed, setBusySeed] = useState<string | null>(null);
  const [aiSet, setAiSet] = useState(false);
  // Errors only: the set's own lines toast from DjSetBridge, app-wide, so
  // they keep arriving after this page (and this component) are gone.
  const [toast, setToast] = useState<string | null>(null);
  const busy = busySeed !== null;
  // The mic's state lives up here with the other hooks - the early return
  // below fires while the library is still loading, and a hook declared after
  // it would change the hook order the moment tracks arrive. It said that
  // before the hook actually moved: `useTalkToDj` sat under the bail, so the
  // render in which a library arrived called one more hook than the one
  // before it and React tore the app down. `useTalkToDj` takes a null session
  // by design and guards every path with it, so asking early costs nothing.

  /*
   * THE LAST OPTION IN THE ROW: your own sentence.
   *
   * Every chip above is somebody else's words. This one records yours, sends
   * the clip to the hub (whisper turns it into text there - the same install
   * read-along uses, so no speech engine ships in the app), and then does two
   * things with what you said: feeds it into the ordinary DJ door as a seed,
   * so a set steered by your words starts within seconds - and hands it to
   * the collector, which starts downloading whatever you asked for that the
   * library does not hold. Those land as auditions over the next minutes,
   * exactly like the collector's own finds.
   *
   * Tap to talk, tap again to send. A hard twenty-second stop matches the
   * server's own cap, and the stream is released the moment recording ends -
   * a page holding the mic open is how the orange dot outlives the feature.
   */
  // Tap to talk, tap again to send - the recorder is shared with the DJ
  // conversation's composer (useTalkToDj); here what the hub heard becomes
  // the set's brief, through the SAME start() the chips use, so the patter,
  // the voice beats and the bridge all come along.
  const { canTalk, recording, hearing, talk } = useTalkToDj(
    session,
    async ({ heard, fetching }) => {
      if (fetching.length > 0) {
        // One entry, not four fragments: the count decides the noun's form,
        // and where it sits in the sentence is the translator's business.
        setToast(t('booth.heardFetching', { heard, count: fetching.length }));
      }
      await start(heard);
    },
    (message) => setToast(message),
  );

  // The DJ reads a server library and a listening history; without either there
  // is nothing for it to spin.
  if (!session || tracks.length === 0) return null;

  // A function DECLARATION, not a const arrow, and deliberately: the
  // recorder's callback above (useTalkToDj) closes over `start` and can fire
  // on a render that bailed at the guard, where a `const` would still sit in
  // its temporal dead zone and throw. A declaration hoists.
  async function start(seed = '') {
    // Hoisting cost the guard's narrowing, so the guard is restated here -
    // and it is not ceremony: this is exactly the render where the recorder's
    // callback can still reach `start` after the session has gone.
    if (!session) return;
    setBusySeed(seed);
    setToast(null);
    try {
      // Auditions ride along: a Charts set may deal the collector's
      // pre-downloaded hits, which live outside `tracks` on purpose.
      const { queue, ai } = await startDjRun(session, [...tracks, ...forYou], seed);
      setAiSet(ai);
      const opener = queue[0];
      if (!opener) {
        setToast('The DJ came up empty. Play a few things first so it learns your taste.');
        return;
      }
      // The run is already published; the bridge toasts the opener's line and
      // speaks its beats the moment this lands as the playing track.
      onPlay(opener, queue);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'The DJ could not start.');
    } finally {
      setBusySeed(null);
    }
  }


  // The Booth's face: one hero that IS the brief, and a row of moods that
  // steer it - every chip a whole request, no field to fill first.
  if (variant === 'hero') {
    return (
      <>
        <Button
          type="button"
          variant="gradient"
          fullWidth
          className="boothHero"
          onClick={() => void start()}
          disabled={busy}
          aria-label={t('booth.startFromTaste')}
        >
          <span className="boothHero__disc" aria-hidden="true">
            {busySeed === '' ? (
              <Spinner size="sm" aria-label={t('booth.cueing')} />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </span>
          <span className="boothHero__text">
            <span className="boothHero__title">
              {t('booth.dropTheNeedle')}
              {aiSet && <Sparkles size={14} className="boothHero__spark" aria-hidden="true" />}
            </span>
            <span className="boothHero__caption">{t('booth.tasteStationBlurb')}</span>
          </span>
        </Button>
        <div className="boothChips" role="group" aria-label={t('booth.setTheMood')}>
          {MOODS.map((mood) => (
            <Button
              key={mood.seed}
              type="button"
              variant={busySeed === mood.seed ? 'solid' : 'outline'}
              size="sm"
              className="boothChip"
              data-on={busySeed === mood.seed || undefined}
              disabled={busy}
              onClick={() => void start(mood.seed)}
            >
              {busySeed === mood.seed ? (
                <Spinner size="sm" aria-label={t('booth.cueing')} />
              ) : (
                <mood.Icon size={14} />
              )}
              {moodLabel(mood, t)}
            </Button>
          ))}
          {canTalk && (
            <Button
              type="button"
              variant={recording ? 'solid' : 'outline'}
              size="sm"
              className="boothChip boothChip--talk"
              data-on={recording || undefined}
              disabled={busy || hearing}
              onClick={() => void talk()}
              aria-label={recording ? t('booth.stopAndSend') : t('booth.tellTheDj')}
            >
              {hearing ? (
                <Spinner size="sm" aria-label={t('booth.listeningBack')} />
              ) : recording ? (
                <Square size={14} fill="currentColor" />
              ) : (
                <Mic size={14} />
              )}
              {hearing ? t('booth.hearing') : recording ? t('booth.sendIt') : t('booth.tellMe')}
            </Button>
          )}
        </div>
        {toast && <DjToast line={toast} onDismiss={() => setToast(null)} />}
      </>
    );
  }

  // The chip: the DJ standing beside Liked and All songs, in their row and
  // their clothes - the same gradient face and name-over-line the library's
  // other two whole-collection doors wear. Pressing it IS the brief.
  return (
    <>
      <Button
        type="button"
        variant="gradient"
        className="libChip libChip--dj"
        style={{ '--libChipHue': 265, '--libChipHue2': 315, '--art': `url("${djMascot}")` } as CSSProperties}
        onClick={() => void start()}
        disabled={busy}
        aria-label={t('booth.startTheDj')}
      >
        <img className="libChip__art" src={djMascot} alt="" loading="lazy" />
        {/* The DJ has no fixed collection - it wears the whole library's
            sleeves for Real covers, and an infinity for Numbers first, because
            the set it spins is never the same twice. */}
        <LibChipMosaic covers={tracks.map((t) => t.artwork).filter((a): a is string => !!a)} />
        <LibChipStat value="∞" glyph />
        <span className="libChip__name">DJ</span>
        <span className="libChip__count">
          {busy ? <Spinner size="sm" aria-label={t('booth.cueing')} /> : t('booth.chipBlurb')}
        </span>
      </Button>
      {toast && <DjToast line={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}
