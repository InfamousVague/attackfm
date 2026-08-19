import { useMemo } from 'react';
import { Button, Switch, Text } from '@glacier/react';
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
  const { track } = useNowPlayingMotion();
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
