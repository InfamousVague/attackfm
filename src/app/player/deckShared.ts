/**
 * The deck's pure top layer, shared by the Player core and its extracted
 * surfaces (PlayerStrip, NowPlayingSheet): stateless constants and helpers
 * with no audio coupling.
 */
import type { Track } from '../core/tauri.ts';
import { VOLUME_UNITY } from './VolumeControl.tsx';

/** No artwork for the blank idle stand-in, and the neutral fallback anywhere a
 *  cover is missing. */
export const TRACK_ART: string | null = null;

/**
 * Android WebView reports `Infinity` for the duration of some streamed audio
 * responses.  That is a valid media-element sentinel (the stream looks live),
 * but it is not a usable player timeline: position / Infinity pins every
 * scrubber at zero while the elapsed clock continues to advance.  Prefer the
 * element's duration when it is real, otherwise keep the duration indexed in
 * the library for this track.
 */
export function timelineDuration(
  mediaDuration: number,
  trackDuration?: number | null,
  /**
   * How much faster the fx chain is playing the song, 1 being untouched.
   * See chainRate() in fxChain.ts.
   */
  rate = 1,
): number {
  // The element's own duration is already the duration of what is COMING OUT,
  // rate included, so it must never be scaled. Only the library's number needs
  // correcting: that describes the file on disk, and a track slowed to 0.8x
  // runs a quarter longer than it. Without this the bar fills while the song is
  // still playing and the remaining time counts to zero early.
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  if (trackDuration != null && Number.isFinite(trackDuration) && trackDuration > 0) {
    const scale = Number.isFinite(rate) && rate > 0 ? rate : 1;
    return trackDuration / scale;
  }
  return 0;
}

/**
 * A blank stand-in for the surfaces that need a non-null Track while nothing is
 * loaded - the deck visuals key off `.path`, and publish() wants a shape. It is
 * deliberately empty and unplayable: an idle device must advertise "nothing,"
 * not a demo song, and there is no URL here for a stray play to ever start.
 */
export const IDLE_TRACK: Track = {
  path: '',
  title: '',
  artist: '',
  album: '',
  duration: null,
  addedAt: 0,
  artwork: null,
  genre: '',
  lyrics: '',
};

/** Where the fader starts. The element opens at full, so it is told this too. */
/** Where a fresh install opens: unity, the same place the phone sits. Nothing
 *  is quieter than the file it is playing until somebody says so. */
export const INITIAL_VOLUME = VOLUME_UNITY;

/** The deck's remembered dials - shuffle, repeat, the fader - one key each so
 * a bad value spoils only its own dial. */
export function readDeckPref(name: string): string | null {
  try {
    return localStorage.getItem(`attackfm-deck-${name}`);
  } catch {
    return null;
  }
}

export function writeDeckPref(name: string, value: string): void {
  try {
    localStorage.setItem(`attackfm-deck-${name}`, value);
  } catch {
    // Storage refused: the dial just resets next launch, as it always did.
  }
}

/**
 * The fader's 0-100 read as a beat intensity. Loud lifts the bar higher, but the
 * response is floored well above zero so a quiet track still visibly moves - the
 * fader sets the ceiling, not whether the bar reacts at all. Muting, or a fader
 * on the floor, is the only thing that holds it still: nothing is coming out, so
 * nothing moves. The floor and ceiling both sit inside `SEEK_MAX_INTENSITY` (3).
 *
 * `system` is the phone's own hardware level (0-1), applied AFTER the app's
 * graph - so it, not the in-app fader, is what says how loud the room actually
 * is. It scales the result on the same curve, which means turning the volume
 * buttons down calms the bar and turning them up drives it, and the two faders
 * compound the way the ear hears them. It is 1 wherever there is no separate
 * system fader to read (desktop, the browser), leaving the old behaviour
 * exactly as it was. Silenced hardware holds the bar still for the same reason
 * a muted app does: nothing is coming out.
 */
export const beatIntensity = (volume: number, muted: boolean, system = 1) => {
  if (muted || volume <= 0 || system <= 0) return 0;
  // The app fader's own curve, untouched: ~1.76 wide open.
  const app = 0.28 * volume ** 0.398;
  // The device's own level, as a multiplier that sweeps nearly the whole way
  // down. An earlier pass floored this at 0.35, which left the bar swinging
  // between 1.75 and 0.90 across the entire hardware range - a difference you
  // have to measure rather than see. The small floor that remains keeps a bar
  // that is still audible from reading as dead; silence is handled above.
  // At system = 1 this is exactly 1, so anywhere without a separate hardware
  // fader (desktop, the browser) lands on the original number.
  const hardware = 0.12 + 0.88 * system ** 0.8;
  return app * hardware;
};

/**
 * The turntable ramp: how far the speed bends and how long the motor takes in
 * each direction. The floor sits at half speed - an octave is as far as a stop
 * needs to fall to read as one - and the rest of it is carried by a gain fade
 * on the audio clock, so the ear hears the pitch dive INTO silence.
 *
 * The bend is the graph's, not the element's: `playbackRate` is the media
 * engine's own resampler, re-tuned on every write and reset across a pause on
 * WebKit, which is why the deck used to glitch and then stop being audible at
 * all after the first stop. See `rampSpeed` in the kit's analyser meter.
 */
export const RATE_FLOOR = 0.5;
export const SPIN_UP_MS = 380;
export const SPIN_DOWN_MS = 320;
/**
 * The FADE pause style's own pair, beside the turntable's above: the audio's
 * ramp (Player) and the disc's brake (the strip, the sheet) share these the
 * same way the turntable style shares SPIN_UP/DOWN - the platter and the
 * sound share a motor, and five bare literals across three files was how
 * they were going to drift apart. The park lands FADE_DOWN_MS + a breath
 * after the fall, so a pause never clips the tail.
 */
export const FADE_UP_MS = 250;
export const FADE_DOWN_MS = 200;
/**
 * How fast the level comes back when the platter picks up. Short on purpose:
 * the music has to be simply there when the button is pressed, so that what is
 * heard afterwards is the pitch climbing rather than a fade-in. Matched to the
 * spin-up, the climb happens under a fade and neither the press nor the effect
 * lands - the button feels slow and the ramp cannot be heard at all.
 */
export const SPIN_UP_FADE_MS = 90;
/**
 * The blink of silence a play pressed mid-brake pays to drop the deck's
 * backlog before climbing (see the catch branch of setPlayingState). Long
 * enough for the gain to truly reach zero before the line is snapped, short
 * enough to read as the platter being caught rather than a stutter.
 */
export const CATCH_FLUSH_MS = 45;

/** How the artwork is worn: a turning CD, the flat cover, the chapter panel
 *  (a book's list laid over its own cover), the lyrics reading themselves the
 *  way a book's transcript does, or - on the big sheet - nothing at all,
 *  letting the canvas and the words have the room.
 *  The mini strip ignores 'hidden' AND 'chapters' and shows the cover: its
 *  square is also the tap target that lifts this sheet, and a hole (or a
 *  list at postage-stamp size) in the strip reads as a layout bug, not a
 *  preference. */
export type ArtView = 'cd' | 'cover' | 'chapters' | 'lyrics' | 'analyser' | 'hidden';

export const ART_VIEW_KEY = 'attackfm-art-view';

/** Books keep their own art-view clock: the chapter panel is the right
 *  default for a book and nonsense for a song, so one shared choice would
 *  have each kind fighting the other's preference. */
export const BOOK_ART_VIEW_KEY = 'attackfm-art-view-book';

// The stored choice, defaulting to the disc; anything unrecognised also lands
// there rather than blanking the square. 'chapters' is deliberately not
// accepted here - it is the BOOK clock's face, meaningless for music.
export function readArtView(): ArtView {
  try {
    const stored = localStorage.getItem(ART_VIEW_KEY);
    return stored === 'cover' || stored === 'hidden' || stored === 'analyser' || stored === 'lyrics'
      ? stored
      : 'cd';
  } catch {
    return 'cd';
  }
}

/**
 * How fast a book is read, and where that choice lives.
 *
 * The ELEMENT's own rate, not the effects rack's `atempo`, and the reason is
 * the book's timeline. An fx tempo re-encodes the stream, so the bar counts
 * seconds coming OUT of ffmpeg while chapter marks, the bookmark ledger and
 * every transcript word stamp count seconds of the FILE - the two clocks part
 * company the moment the pedal is on (which is what `chainRate` and
 * `timelineDuration` exist to reconcile for music). A media element played
 * faster still reports `currentTime` in file seconds, so a book at 1.5x keeps
 * its chapters, its place and its read-along exactly where they were. The
 * engine's own resampler holds pitch (`preservesPitch`), which is the whole
 * ask - and it costs the hub nothing, works on a downloaded book with no
 * server at all, and answers instantly instead of re-buffering.
 *
 * The house's warning about `playbackRate` (see the turntable ramp above)
 * is about BENDING it - re-writing it per frame, which glitches and gets
 * reset across a pause on WebKit. A setting written once per load is the
 * other thing entirely; it is re-applied on play and on the engine's own
 * ratechange, so a WebKit reset does not take the choice with it.
 */
export const BOOK_SPEED_KEY = 'attackfm-book-speed';

/** The speeds offered, and the only ones stored. */
export const BOOK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function readBookSpeed(): number {
  try {
    const n = Number(localStorage.getItem(BOOK_SPEED_KEY));
    return BOOK_SPEEDS.includes(n as (typeof BOOK_SPEEDS)[number]) ? n : 1;
  } catch {
    return 1;
  }
}

/** 1x reads as "normal" rather than as a number nobody chose. */
export function bookSpeedLabel(rate: number): string {
  return `${rate}×`;
}

/** The book clock, defaulting to the chapter panel. */
export function readBookArtView(): ArtView {
  try {
    const stored = localStorage.getItem(BOOK_ART_VIEW_KEY);
    return stored === 'cd' || stored === 'cover' || stored === 'hidden' ? stored : 'chapters';
  } catch {
    return 'chapters';
  }
}

/**
 * Which chapter a position sits in - THE shared finder. The second of grace
 * before a chapter's mark means a jump TO a chapter never lands "one short"
 * off a rounded seek; three copies of this loop already grew apart once.
 */
/** How long the sleep timer spends fading out before it pauses. Shared by
 *  the clock timer and the chapter one so sleep always arrives the same way. */
export const SLEEP_FADE_S = 5;

/**
 * Where the chapter you are in ENDS, in seconds - the next natural break AHEAD
 * of a position.
 *
 * `null` when the file's own end is the break: an unmarked file (one section
 * of a many-file book, or a song), or the last chapter of a marked one. Both
 * are already stopped at by the ended handler, so the caller has nothing to
 * arm and says so by getting nothing back.
 *
 * STRICTLY ahead, and deliberately NOT `chapterIndexAt`, whose second of
 * tolerance counts a mark you are about to reach as already behind you. That
 * tolerance is right for "which chapter am I in" - a bar handle a hair short
 * of the mark should read as the next chapter - and wrong for this, where it
 * would skip the very break being waited on and quietly aim a whole chapter
 * further on.
 */
export function chapterBreakAfter(
  chapters: readonly { startMs: number }[] | undefined,
  positionS: number,
): number | null {
  if (!chapters || chapters.length === 0) return null;
  const positionMs = positionS * 1000;
  const next = chapters.find((c) => c.startMs > positionMs);
  return next == null ? null : next.startMs / 1000;
}

export function chapterIndexAt(
  chapters: readonly { startMs: number }[],
  positionMs: number,
): number {
  let idx = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (positionMs >= chapters[i]!.startMs - 1000) idx = i;
    else break;
  }
  return idx;
}

/**
 * When the player folds its rails for touch. Kept beside the hook so the CSS
 * block in app.css quoting the same condition has one source to match.
 *
 * Coarse pointer is the real signal - a phone in any orientation, a tablet.
 * The width arm exists for browsers (previews included), and it stops at
 * 540px because the DESKTOP window can be as narrow as 560 (tauri.conf.json
 * minWidth): a squarish desktop window must never inherit the phone's bar.
 */
export const MOBILE_PLAYER_QUERY = '(pointer: coarse), (max-width: 540px)';

/** mm:ss for the Now Playing clock - the shared house formatter, re-exported
 *  from here so the player's own modules keep their one import site. */
export { formatClock } from '../ux/format.ts';
