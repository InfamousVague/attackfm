import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

/**
 * The path of the song playing right now, for any list that wants to mark it.
 *
 * The current track lives in App as local state - set by the deck, mirrored
 * from Connect - and everything that needs the WHOLE track (the player, the
 * sheet) is handed it down a prop path. A song row deep in a table wants only
 * one bit of it: "is this me?" Threading the track through every list, cell and
 * shelf for that one comparison is a lot of prop to carry, and re-renders the
 * world each time the song changes. So App pushes just the identity here, once,
 * and a row subscribes to it the way the door seams work beside it.
 *
 * The IDENTITY is the path, because a row's own id is its path and that is what
 * a queue is built from: play a song out of a list and the playing track is
 * that row, same path. A song reached through a different origin has a
 * different path and will not light - which is the honest answer, since it is
 * not the row you are looking at.
 */

let current: string | null = null;
const listeners = new Set<() => void>();

/** Point the store at the playing song, or null when nothing is. Idempotent -
 *  the same path again wakes nobody, so the deck can call it freely. */
export function setNowPlayingPath(path: string | null): void {
  if (path === current) return;
  current = path;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): string | null {
  return current;
}

/** The playing song's path, or null. Re-renders the caller when it changes. */
export function useNowPlayingPath(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Bring the playing song's row into view inside `rootRef` when the song
 * CHANGES - a skip, or autoplay moving on - if that song is a row in here.
 *
 * `selector` finds the current row's marked element within the container (the
 * one carrying `data-nowplaying` / `data-current`); scrolling it into view
 * scrolls its row in with it.
 *
 * Deliberately quiet in two ways. It never scrolls on the first render, so
 * opening a list does not yank it to the current song - only a change after
 * you are already looking does. And `block: 'nearest'` means a row already on
 * screen - the next one down, most skips - does not move the list at all; only
 * a song scrolled off the edge is fetched back, by the least amount. A list
 * that does not hold the song finds no marker and stays put.
 */
export function useFollowNowPlaying(
  rootRef: RefObject<HTMLElement | null>,
  selector: string,
): void {
  const nowPlaying = useNowPlayingPath();
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = last.current;
    last.current = nowPlaying;
    if (prev === undefined || !nowPlaying || nowPlaying === prev) return;
    const root = rootRef.current;
    if (!root) return;
    // Synchronous, no requestAnimationFrame: the row's marker is already in the
    // DOM by the time this effect runs (React commits the row's data-current in
    // the same pass that changed the playing path, before effects fire), and
    // rAF is PAUSED while the page is hidden - which is exactly when the app
    // keeps running for background playback, so an rAF here would strand the
    // scroll until the next time you looked.
    //
    // NOT `behavior: 'smooth'`: WebKit silently refuses a smooth scrollIntoView
    // on a nested overflow container (measured - the scroller does not move at
    // all), and this app's scrollers are exactly that. An instant jump is
    // reliable, and `block: 'nearest'` only moves a row that is off-screen in
    // the first place, so there is nothing on screen for smooth to soften.
    root.querySelector(selector)?.scrollIntoView({ block: 'nearest' });
  }, [nowPlaying, rootRef, selector]);
}
