import { useMemo } from 'react';
import { Button, SeekBar, Switch, Text, useBeat, useLiveLevels } from '@glacier/react';
import { AudioWaveform, Drum, Guitar, Mic, Piano, Waves } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { trackIdFromPath } from '../server.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { clearStemDrop, setStemDropped, useStemDrop } from './stemDrop.ts';
import { useStems } from './stemsReady.ts';

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
  const { session } = useServerSession();
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

  const dropped = drop.trackId === id ? drop.parts : [];
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
            {PARTS.filter((p) => available.includes(p.id)).map(({ id: part, label, Icon }) => {
              const on = !dropped.includes(part);
              return (
                <li key={part} className="stemsRoom__part" data-on={on ? 'true' : undefined}>
                  <span className="stemsRoom__glyph">
                    <Icon size={16} />
                  </span>
                  <span className="stemsRoom__name">
                    <Text size="sm">{label}</Text>
                  </span>
                  <Switch
                    aria-label={label}
                    checked={on}
                    onCheckedChange={(want: boolean) => setStemDropped(id, part, !want)}
                  />
                  {/* `inert` rather than a bare `aria-hidden`: this bar is a
                      picture of the song, not a second transport, and hiding
                      it from a screen reader while leaving a slider in the tab
                      order is the worst of both. Inert takes it out of both at
                      once. The row's control is the switch; the seek that
                      matters is the one on the sheet behind this panel. */}
                  <span className="stemsRoom__pulse" inert>
                    <SeekBar
                      aria-label={label}
                      duration={duration}
                      value={position}
                      size="sm"
                      shape="wave"
                      fill="tonal"
                      rail="contrast"
                      tone={on ? 'accent' : 'neutral'}
                      levels={levels}
                      beat={beat}
                      // 0 is the kit's own way to say "hold still" without the
                      // caller tearing its meter down - so a part that is out
                      // of the song simply stops moving, in place.
                      intensity={on ? 1 : 0}
                    />
                  </span>
                </li>
              );
            })}
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
  return id !== null && drop.trackId === id ? drop.parts.length : 0;
}
