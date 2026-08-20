import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SeekBar, Switch, Text, useBeat, useLiveLevels } from '@glacier/react';
import { AudioWaveform, Drum, Guitar, Mic, Piano, Waves } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { trackIdFromPath } from '../server.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { clearStemDrop, noteStemsFor, setStemDropped, useStemDrop } from './stemDrop.ts';
import { useStems } from './stemsReady.ts';
import { chainRate, useFxChain } from './fxChain.ts';
import { ENV_HZ, envelopeMeter, loadStemEnvelopes, type StemEnvelopes } from './stemLevels.ts';
import { autoDownloadAllowed } from '../settings/behaviourPrefs.ts';

/**
 * The part's own shape across the whole song, thinned to something a bar can
 * paint.
 *
 * Mean rather than peak. Peak was the first attempt and the reason I first
 * gave for dropping it - that it saturates - turned out to be false when
 * measured: a decaying hit leaves the bucket near silent between strikes, so
 * the peak does track how hard a section was played. The real failure is
 * narrower and worse. Ninety-six buckets over four minutes is two and a half
 * seconds each, and peak cannot tell a part that HITS in that stretch from one
 * that SOUNDS THROUGHOUT it, because both touch the same height: measured
 * side by side, sparse hits and a continuous part of equal loudness draw the
 * identical full slab. That is precisely the distinction this row exists to
 * make - drums against strings - so the average is the right reading. It says
 * how much of the stretch the part was sounding, which also makes a verse the
 * drums sit out read as a dip.
 */
function levelsFrom(env: Float32Array | undefined, buckets = 96): number[] | undefined {
  if (!env || env.length === 0) return undefined;
  const per = env.length / buckets;
  const out: number[] = [];
  let top = 0;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * per);
    const end = Math.min(env.length, Math.floor((i + 1) * per));
    let sum = 0;
    for (let j = start; j < end; j++) sum += env[j]!;
    const mean = sum / Math.max(1, end - start);
    out.push(mean);
    if (mean > top) top = mean;
  }
  // Back up to the bar's full height, or a part that is merely quiet would be
  // drawn as a part that is barely there.
  return top > 0 ? out.map((v) => v / top) : out;
}

/**
 * One part, and the line under it.
 *
 * Its own component purely so it can hold its own `useBeat` - six rows means
 * six meters, and a hook cannot be called from inside a map over a list whose
 * length changes with how many parts a track was separated into.
 */
function StemPart({
  part,
  label,
  Icon,
  on,
  env,
  fileNow,
  mixBeat,
  mixLevels,
  playing,
  duration,
  position,
  onToggle,
}: {
  part: string;
  label: string;
  Icon: (props: { size?: number }) => React.ReactNode;
  on: boolean;
  env: Float32Array | undefined;
  fileNow: () => number;
  mixBeat: Parameters<typeof SeekBar>[0]['beat'];
  mixLevels: number[];
  playing: boolean;
  duration: number;
  position: number;
  onToggle: (want: boolean) => void;
}) {
  const meter = useMemo(() => envelopeMeter(env, fileNow), [env, fileNow]);
  // A part that is out of the song is not sounding, so it does not move -
  // which is the row's whole job, and the one thing a shared meter could
  // never show.
  const own = useBeat({
    meter: meter ?? null,
    active: !!meter && on && playing,
    // Where the hits land along the bar. Zero here put every ripple at the
    // start of the row, which reads as a bar that twitches at its left edge
    // rather than one deforming under the playhead.
    at: duration > 0 ? Math.min(1, position / duration) : 0,
  });
  const beat = meter ? own : mixBeat;
  const levels = levelsFrom(env) ?? mixLevels;
  return (
    <li className="stemsRoom__part" data-on={on ? 'true' : undefined}>
      <span className="stemsRoom__glyph">
        <Icon size={16} />
      </span>
      <span className="stemsRoom__name">
        <Text size="sm">{label}</Text>
      </span>
      <Switch aria-label={label} checked={on} onCheckedChange={onToggle} />
      {/* `inert` rather than a bare `aria-hidden`: this bar is a picture of
          the part, not a second transport, and hiding it from a screen reader
          while leaving a slider in the tab order is the worst of both. */}
      <span className="stemsRoom__pulse" inert>
        <SeekBar
          aria-label={label}
          duration={duration}
          value={position}
          size="sm"
          // The same clothes the bar on the Now Playing screen wears, because
          // it is the same instrument at a smaller size: the swell carries an
          // attack where the plain wave only undulated, and the tracer is what
          // makes a hit read as a hit rather than as a wobble.
          shape="swell"
          fill="solid"
          rail="contrast"
          tracer
          tone={on ? 'accent' : 'neutral'}
          levels={levels}
          beat={beat}
          intensity={on ? 2 : 0}
        />
      </span>
    </li>
  );
}

/**
 * Stems: the song you are listening to, with parts taken out.
 *
 * It lives here, beside the EQ and the rack, because that is what it IS - a
 * change to the sound of what is playing. It began life as a modal with its own
 * deck and its own transport, which meant the seek bar on the screen behind it
 * belonged to a paused song while a different one played through the panel, and
 * nothing you changed could be heard unless you were standing in it. Muting a
 * part is not a second kind of playback.
 *
 * So a part comes out through the same door every other effect uses: the name
 * rides the stream URL, the server hands the encoder the parts that are left,
 * and the player reloads where it stands. The transport never learns about it.
 */

const PARTS = [
  { id: 'vocals', label: 'Vocals', Icon: Mic },
  { id: 'drums', label: 'Drums', Icon: Drum },
  { id: 'bass', label: 'Bass', Icon: Waves },
  { id: 'guitar', label: 'Guitar', Icon: Guitar },
  { id: 'piano', label: 'Keys', Icon: Piano },
  { id: 'other', label: 'Strings & horns', Icon: AudioWaveform },
] as const;

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'working'; phase: string; percent: number | null; filed: number; seconds: number }
  | { kind: 'ready'; parts: string[] }
  | { kind: 'problem'; why: string };

export function StemsRoom() {
  const { session, settings } = useServerSession();
  const { track, meter, audible, position } = useNowPlayingMotion();
  const drop = useStemDrop();
  const id = track ? trackIdFromPath(track.path) : null;

  /**
   * Asking, waiting and describing the wait all live in stemsReady now.
   *
   * This room used to do it here, and built its POST as `/api/stems/{id}/` -
   * with a trailing slash, which axum does not normalise, so the request that
   * was meant to START a separation answered 404 and this panel printed the
   * words "not found". The button never worked. Sharing the client is what
   * makes that unrepeatable rather than merely fixed.
   *
   * `make: false` because opening a tab must not commit the machine to half a
   * minute of demucs; the button below is the commitment.
   */
  const stems = useStems(track?.path ?? null, { make: false });
  const separate = stems.make;

  const state: State = useMemo(() => {
    switch (stems.state) {
      case 'checking':
        return { kind: 'checking' };
      case 'making':
        return {
          kind: 'working',
          phase: stems.progress?.phase ?? 'queued',
          percent: stems.progress?.fraction === null || stems.progress === null
            ? null
            : Math.round(stems.progress.fraction * 100),
          filed: stems.progress?.filed ?? 0,
          seconds: stems.progress?.seconds ?? 0,
        };
      case 'ready':
        return { kind: 'ready', parts: stems.stems };
      case 'problem':
        return { kind: 'problem', why: stems.problem };
      default:
        return { kind: 'none' };
    }
  }, [stems.state, stems.progress, stems.stems, stems.problem]);

  /*
   * Hand what this room learned to the drop store.
   *
   * The room has just asked whether this song has parts; the player asks the
   * same question on every track change while a drop is set. Telling the store
   * here means separating a song makes the drop apply to it immediately, rather
   * than on the next visit after a second round trip - and it is the one path
   * where the answer flips from no to yes while somebody is watching.
   */
  useEffect(() => {
    // Only once the view is about THIS song. On the render where the track
    // changes, `id` is already the new one and `state` still holds the last
    // one's answer - recording then files one song's answer under another's.
    if (id === null || stems.for !== id) return;
    if (state.kind === 'ready') noteStemsFor(id, true);
    else if (state.kind === 'none') noteStemsFor(id, false);
  }, [id, state.kind, stems.for]);

  /**
   * A line under each part that moves with the song.
   *
   * One meter, one beat, one playhead - shared by every row, because that is
   * the truth: the parts you kept are mixed down to a SINGLE stream before it
   * leaves the server, so this device never hears them apart and could not
   * meter them apart if it wanted to. What honestly differs row to row is
   * whether that part is in what you are hearing at all, and that is what the
   * rows show: a part in the mix rides the beat, a part taken out holds still.
   * Anything more per-row would be six copies of one signal wearing different
   * hats, which is a picture of data that does not exist.
   *
   * The playhead itself steps at the motion source's ~4Hz, not at frame rate.
   * That is deliberate and unnoticeable here: what the eye follows on a bar
   * this small is the beat deforming it, which does run every frame.
   *
   * Both hooks idle while nothing is audible or no parts exist yet, so the
   * other rooms of the console cost nothing for this.
   */
  const ready = state.kind === 'ready';
  const moving = ready && audible;
  const duration = Math.max(1, track?.duration ?? 0);
  const progress = Math.min(1, position / duration);
  const beat = useBeat({ meter, active: moving, at: progress });
  const levels = useLiveLevels({ meter, progress, active: moving });

  /**
   * The parts, measured one at a time, so each row can move to its own part.
   *
   * Gated rather than eager: it is nine megabytes for a whole song (see
   * stemLevels.ts) and it buys a picture, so it is only spent on a track that
   * has actually been separated, while this room is open, on a connection
   * nobody has told us to be careful with. Everything that does not arrive
   * simply falls back to the mix's beat, which is what every row used before.
   */
  const [envelopes, setEnvelopes] = useState<StemEnvelopes>(() => new Map());
  const measured = useRef<string | null>(null);
  const partsKey = ready ? state.parts.join(',') : '';
  useEffect(() => {
    const path = track?.path ?? null;
    // Lofi is a standing "spend less of my data", and nine megabytes to draw
    // six lines is not what somebody who asked for that had in mind.
    if (!ready || !path || !session || settings.quality === 'transcode') return;
    const key = `${path}|${partsKey}`;
    if (measured.current === key) return;
    measured.current = key;
    setEnvelopes(new Map());
    const stop = new AbortController();
    void (async () => {
      // The one rule, asked where it lives now rather than rebuilt here.
      // Opening a panel is not a request to spend nine megabytes of somebody's
      // mobile data, and "only download on Wi-Fi" plainly covers a
      // nine-megabyte download. This composed the same test from the same two
      // primitives when it was written, which was correct and is now merely a
      // second copy - and a second copy of a policy is one the next person to
      // change the policy will miss.
      if (!(await autoDownloadAllowed())) return;
      if (stop.signal.aborted) return;
      const got = await loadStemEnvelopes(track!, session, partsKey.split(','), stop.signal);
      if (!stop.signal.aborted && got.size > 0) setEnvelopes(got);
    })();
    return () => stop.abort();
  }, [ready, track?.path, partsKey, session, settings.quality]);

  /**
   * Where the song is, in the FILE's seconds, at frame rate.
   *
   * Two corrections on one line. The motion source publishes about four times
   * a second, which is a staircase next to a bar redrawing every frame, so the
   * gap is carried forward from the last reading. And the envelopes were
   * measured from the file while `position` counts the bar, which are the same
   * number only until a speed pedal is on - the trap the scratch tape fell
   * into, kept out of this one by converting here.
   */
  const rate = chainRate(useFxChain());
  const clock = useRef({ at: 0, stamp: 0, running: false, rate: 1 });
  useEffect(() => {
    clock.current = {
      at: position,
      stamp: performance.now(),
      running: audible,
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    };
  }, [position, audible, rate]);
  const fileNow = useMemo(
    () => () => {
      const c = clock.current;
      const ahead = c.running ? (performance.now() - c.stamp) / 1000 : 0;
      return (c.at + ahead) * c.rate;
    },
    [],
  );

  if (!session) {
    return (
      <Text tone="muted" size="sm">
        Taking a song apart happens on your server. Sign in to one to use this.
      </Text>
    );
  }
  if (id === null) {
    return (
      <Text tone="muted" size="sm">
        Play a song from your server and its parts turn up here.
      </Text>
    );
  }

  const dropped = drop.parts;
  const available = state.kind === 'ready' ? state.parts : [];

  return (
    <div className="stemsRoom">
      {state.kind === 'checking' && (
        <Text tone="muted" size="sm">
          Looking for this song's parts…
        </Text>
      )}

      {state.kind === 'none' && (
        <div className="stemsRoom__ask">
          <Text size="sm">
            This song has not been taken apart yet. Your server does it once, and it is instant
            every time after.
          </Text>
          <Button variant="solid" size="sm" onClick={() => void separate()}>
            Take it apart
          </Button>
        </div>
      )}

      {state.kind === 'working' && (
        <div className="stemsRoom__ask">
          <div className="stemsRoom__rail">
            <span
              className="stemsRoom__railFill"
              data-unknown={state.percent === null ? 'true' : undefined}
              style={state.percent === null ? undefined : { width: `${state.percent}%` }}
            />
          </div>
          <Text tone="muted" size="xs">
            {state.phase === 'packing'
              ? `Writing the parts · ${state.filed} of 6`
              : state.phase === 'queued'
                ? `Waiting for the separator · ${state.seconds}s`
                : `Taking the song apart${state.percent === null ? '' : ` · ${state.percent}%`} · ${state.seconds}s`}
          </Text>
        </div>
      )}

      {state.kind === 'problem' && (
        <div className="stemsRoom__ask">
          <Text tone="muted" size="sm">
            {state.why}
          </Text>
          <Button variant="ghost" size="sm" onClick={() => void separate()}>
            Try again
          </Button>
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <ul className="stemsRoom__parts">
            {PARTS.filter((p) => available.includes(p.id)).map(({ id: part, label, Icon }) => (
              <StemPart
                key={part}
                part={part}
                label={label}
                Icon={Icon}
                on={!dropped.includes(part)}
                env={envelopes.get(part)}
                fileNow={fileNow}
                mixBeat={beat}
                mixLevels={levels}
                playing={audible}
                duration={duration}
                position={position}
                onToggle={(want: boolean) => setStemDropped(part, !want)}
              />
            ))}
          </ul>
          <div className="stemsRoom__foot">
            <Text tone="muted" size="xs">
              {dropped.length === 0
                ? 'Turn a part off and the song plays without it.'
                : `${dropped.length} part${dropped.length === 1 ? '' : 's'} out · the song reloads where it is`}
            </Text>
            {dropped.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearStemDrop}>
                Put them all back
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The dot on the tab: whether anything is out of the song right now. */
export function useStemsOut(): number {
  const drop = useStemDrop();
  const { track } = useNowPlayingMotion();
  const id = track ? trackIdFromPath(track.path) : null;
  return drop.parts.length;
}
