import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@glacier/react';
import { X } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { useNowPlayingMotion } from '../player/nowPlayingMotion.tsx';
import { currentDjRun, publishDjRun, subscribeDjRun, type DjRun } from './djSession.ts';
import { djVoiceEnabled, speakBeats } from './djVoice.ts';
import djMascot from '../../assets/dj-mascot.webp';

/** How long a line hangs around uninvited. Long enough to read twice; the X
 *  is for everyone who read it once. */
const TOAST_MS = 12_000;

/**
 * One line from the booth, floating: the mascot saying it, an X to wave it
 * off, gone by itself after a while. Portalled to the body so no header row
 * gets to squeeze it - being readable is the entire reason it exists.
 */
export function DjToast({ line, onDismiss }: { line: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [line, onDismiss]);
  return createPortal(
    <div className="djToast" role="status" aria-live="polite">
      <img className="djToast__face" src={djMascot} alt="" aria-hidden />
      <p className="djToast__line">{line}</p>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        className="djToast__close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={14} />
      </IconButton>
    </div>,
    document.body,
  );
}

/**
 * The set's companion, mounted once at app level (like ListeningShareBridge):
 * whoever started the set and wherever they are now, this is what toasts each
 * run's line, speaks its beats, and calls the set over when playback leaves
 * it. Headless until there is something to say.
 */
export function DjSetBridge() {
  const { session } = useServerSession();
  const { track: playing } = useNowPlayingMotion();
  const [run, setRun] = useState<DjRun | null>(() => currentDjRun());
  const [toast, setToast] = useState<string | null>(null);
  const lastPath = useRef<string | null>(null);
  // A run only ARMS once its first track is actually heard: the publish lands
  // while the previous song is still playing, and that old path must read as
  // "not started yet", not as the listener walking out.
  const armed = useRef(false);
  useEffect(
    () =>
      subscribeDjRun(() => {
        lastPath.current = null;
        armed.current = false;
        setRun(currentDjRun());
      }),
    [],
  );

  useEffect(() => {
    if (!run || !playing) return;
    const path = playing.path;
    if (path === lastPath.current) return;
    lastPath.current = path;
    if (!run.paths.has(path)) {
      if (armed.current) {
        // The listener changed the music: the set is over, no more talking.
        publishDjRun(null);
        setToast(null);
      }
      return;
    }
    armed.current = true;
    // The run's beats where a run opens, then the song's own bit of lore -
    // by request, every track gets a short true thing, never a paragraph.
    const lore = run.loreAt.get(path);
    const beats = [...(run.voiceAt.get(path) ?? []), ...(lore?.voice ?? [])];
    const spoken = Boolean(beats.length > 0 && session && djVoiceEnabled());
    if (spoken) {
      void speakBeats(session!, beats);
    } else {
      // The card only shows when nothing will be HEARD - by request, a
      // talking DJ talks, and the screen answers with waves off the disc
      // instead of a caption. Text remains the whole story for a hub with
      // no voice, or a listener who switched it off.
      const line = [run.lineAt.get(path), lore?.line].filter(Boolean).join(' ');
      if (line) setToast(line);
    }
  }, [playing, run, session]);

  if (!toast) return null;
  return <DjToast line={toast} onDismiss={() => setToast(null)} />;
}
