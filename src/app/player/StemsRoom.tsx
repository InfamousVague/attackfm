import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Switch, Text } from '@glacier/react';
import { AudioWaveform, Drum, Guitar, Mic, Piano, Waves } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { trackIdFromPath } from '../server.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { clearStemDrop, setStemDropped, useStemDrop } from './stemDrop.ts';

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

interface Status {
  state: string;
  error?: string;
  available?: boolean;
  progress?: number | null;
  phase?: string | null;
  parts?: number;
  stems: { stem: string }[];
}

export function StemsRoom() {
  const { session } = useServerSession();
  const { track } = useNowPlayingMotion();
  const drop = useStemDrop();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const began = useRef(0);

  const id = track ? trackIdFromPath(track.path) : null;

  const ask = useCallback(
    async (path: string): Promise<Status | null> => {
      if (!session || id === null) return null;
      const res = await fetch(`${session.url}/api/stems/${id}${path}`, {
        method: path === '' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)));
      return (await res.json()) as Status;
    },
    [session, id],
  );

  /** What exists for this song, without asking for anything to be made. */
  useEffect(() => {
    if (!session || id === null) {
      setState({ kind: 'idle' });
      return;
    }
    let live = true;
    setState({ kind: 'checking' });
    void ask('')
      .then((s) => {
        if (!live || !s) return;
        setState(s.stems.length > 0 ? { kind: 'ready', parts: s.stems.map((x) => x.stem) } : { kind: 'none' });
      })
      .catch(() => live && setState({ kind: 'none' }));
    return () => {
      live = false;
    };
  }, [session, id, ask]);

  /**
   * Ask for the separation, and watch it.
   *
   * Polled once a second with the elapsed time always on show. A percentage is
   * not always available - an older server sends none - and a wait of minutes
   * with nothing moving on it is how a job that is working comes to look like
   * one that has died.
   */
  const separate = async () => {
    if (!session || id === null) return;
    began.current = Date.now();
    const since = () => Math.round((Date.now() - began.current) / 1000);
    setState({ kind: 'working', phase: 'queued', percent: null, filed: 0, seconds: 0 });
    try {
      let now = await ask('');
      if (now && now.stems.length === 0) await ask('/');
      for (;;) {
        now = await ask('');
        if (!now) return;
        if (now.stems.length > 0 && now.state !== 'running' && now.state !== 'queued') break;
        if (now.state === 'failed') {
          setState({ kind: 'problem', why: now.error || 'That one could not be separated.' });
          return;
        }
        if (now.stems.length > 0 && now.state === 'done') break;
        setState({
          kind: 'working',
          // A missing phase is not the same as queued: the JOB STATE knows, and
          // a server that cannot report a percentage is still working.
          phase: now.phase ?? (now.state === 'running' ? 'separating' : 'queued'),
          percent: typeof now.progress === 'number' ? Math.round(now.progress * 100) : null,
          filed: now.stems.length,
          seconds: since(),
        });
        await new Promise((r) => window.setTimeout(r, 1000));
      }
      const done = await ask('');
      setState(
        done && done.stems.length > 0
          ? { kind: 'ready', parts: done.stems.map((x) => x.stem) }
          : { kind: 'problem', why: 'Nothing came back for that song.' },
      );
    } catch (e) {
      setState({ kind: 'problem', why: e instanceof Error ? e.message : 'Your server did not answer.' });
    }
  };

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
