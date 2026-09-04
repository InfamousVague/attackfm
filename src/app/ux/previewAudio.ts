import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * One catalogue clip at a time, on one element, for the whole app.
 *
 * This was NewMusicShelf's own `usePreview`, hoisted the day a second shelf
 * needed it (the trending rails preview the same thirty-second catalogue
 * URLs). It is a module singleton rather than a hook-local element on purpose:
 * two shelves each holding their own <audio> could speak over one another,
 * and a preview started on one rail should stop the moment another rail's
 * card is tapped - which only works if every rail reads one `playing`.
 *
 * Deliberately NOT the Date deck's warm pool. That pool lives inside
 * DatePage: a map of pre-seeked elements feeding one analyser, built around
 * a deck that advances inside the gesture - a different job. This plays a
 * remote URL from the top and nothing else, and it never touches the Player:
 * whatever is on keeps playing underneath, and the preview is a second voice
 * over it rather than an interruption.
 */

let el: HTMLAudioElement | null = null;
let playing: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setPlaying(id: string | null): void {
  if (playing === id) return;
  playing = id;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function read(): string | null {
  return playing;
}

/** Stop whatever clip is on. Safe to call with nothing playing. */
export function stopPreview(): void {
  el?.pause();
  setPlaying(null);
}

/** Start `url` under `id`, or stop it if `id` is the one already speaking. */
export function togglePreview(id: string, url: string): void {
  if (!url) return;
  if (!el) {
    el = new Audio();
    el.addEventListener('ended', () => setPlaying(null));
  }
  const audio = el;
  if (playing === id) {
    audio.pause();
    setPlaying(null);
    return;
  }
  audio.src = url;
  setPlaying(id);
  // A refused play leaves the button lit with nothing behind it, which reads
  // as broken; the catch puts it back.
  void audio.play().catch(() => {
    if (playing === id) setPlaying(null);
  });
}

/**
 * The shared preview, as a hook: which id is speaking, and the two verbs.
 * `stopOnUnmount` (the default) silences the clip when the surface that
 * started it goes away - a modal closing, a page leaving.
 */
export function usePreview(stopOnUnmount = true): {
  playing: string | null;
  toggle: (id: string, url: string) => void;
  stop: () => void;
} {
  const current = useSyncExternalStore(subscribe, read, read);
  const toggle = useCallback((id: string, url: string) => togglePreview(id, url), []);
  const stop = useCallback(() => stopPreview(), []);
  useEffect(() => {
    if (!stopOnUnmount) return;
    return stop;
  }, [stop, stopOnUnmount]);
  return { playing: current, toggle, stop };
}
