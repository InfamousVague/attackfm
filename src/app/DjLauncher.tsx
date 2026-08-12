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

import { Spinner } from '@glacier/react';
import { X } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerSession } from './serverSession.tsx';
import { useLibrary } from './library.tsx';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { fetchDj, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';
import djMascot from '../assets/dj-mascot.png';

/** How long a line hangs around uninvited. Long enough to read twice; the X
 *  is for everyone who read it once. */
const TOAST_MS = 12_000;

/**
 * One line from the booth, floating: the mascot saying it, an X to wave it
 * off, gone by itself after a while. Portalled to the body so no header row
 * gets to squeeze it - being readable is the entire reason it exists.
 */
function DjToast({ line, onDismiss }: { line: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [line, onDismiss]);
  return createPortal(
    <div className="djToast" role="status" aria-live="polite">
      <img className="djToast__face" src={djMascot} alt="" aria-hidden />
      <p className="djToast__line">{line}</p>
      <button type="button" className="djToast__close" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}

/** A running set: which paths belong to it, and the line each run opens with,
 *  keyed by the path of the run's first track. */
interface DjSet {
  paths: Set<string>;
  lineAt: Map<string, string>;
}

export function DjLauncher({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const { track: playing } = useNowPlayingMotion();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [set, setSet] = useState<DjSet | null>(null);

  // Lines fire on ENTERING a run, not on every render inside one - and a set
  // is abandoned the moment playback wanders somewhere the DJ did not choose.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (!set || !playing) return;
    const path = playing.path;
    if (path === lastPath.current) return;
    lastPath.current = path;
    if (!set.paths.has(path)) {
      // The listener changed the music: the set is over, no more talking.
      setSet(null);
      return;
    }
    const line = set.lineAt.get(path);
    if (line) setToast(line);
  }, [playing, set]);

  // The DJ reads a server library and a listening history; without either there
  // is nothing for it to spin.
  if (!session || tracks.length === 0) return null;

  const start = async () => {
    setBusy(true);
    setToast(null);
    try {
      const reply = await fetchDj(session);
      // The set comes back as track ids; resolve them against the library and
      // flatten every run into one queue, in the order the DJ chose.
      const byId = new Map<number, Track>();
      for (const t of tracks) {
        const id = trackIdFromPath(t.path);
        if (id != null) byId.set(id, t);
      }
      const queue: Track[] = [];
      const paths = new Set<string>();
      const lineAt = new Map<string, string>();
      for (const block of reply.blocks) {
        let first = true;
        for (const id of block.trackIds) {
          const t = byId.get(id);
          if (!t) continue;
          queue.push(t);
          paths.add(t.path);
          if (first && block.say.trim()) lineAt.set(t.path, block.say.trim());
          first = false;
        }
      }
      const opener = queue[0];
      if (!opener) {
        setToast('The DJ came up empty. Play a few things first so it learns your taste.');
        return;
      }
      // The first line shows immediately rather than waiting for the motion
      // publish to loop back - the set should speak as it starts.
      lastPath.current = opener.path;
      setSet({ paths, lineAt });
      const firstLine = lineAt.get(opener.path) ?? reply.blocks.find((b) => b.say.trim())?.say ?? null;
      if (firstLine) setToast(firstLine);
      onPlay(opener, queue);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'The DJ could not start.');
    } finally {
      setBusy(false);
    }
  };

  // The chip: the DJ standing beside Liked and All songs, in their row and
  // their clothes - the same gradient face and name-over-line the library's
  // other two whole-collection doors wear. Pressing it IS the brief.
  return (
    <>
      <button
        type="button"
        className="libChip libChip--dj"
        onClick={() => void start()}
        disabled={busy}
        aria-label="Start the DJ"
      >
        <img className="libChip__art" src={djMascot} alt="" loading="lazy" />
        <span className="libChip__name">DJ</span>
        <span className="libChip__count">
          {busy ? <Spinner size="sm" aria-label="Cueing" /> : 'A live set, from your taste'}
        </span>
      </button>
      {toast && <DjToast line={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}
