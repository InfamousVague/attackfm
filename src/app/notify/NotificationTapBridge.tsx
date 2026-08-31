import { useEffect, useRef } from 'react';
import { useOwnedTrack, usePlayNowOptional } from '../player/playNow.tsx';

/**
 * Tapping "New music" in the tray STARTS the music.
 *
 * The tray entry for a landed download used to do what every notification does
 * by default: open the app, on whatever screen it was left on, with the song
 * it just announced nowhere in sight. But a notification that names one song
 * is an offer to hear it - so the landing rides the entry's `extra` payload
 * (osNotify.ts), and this bridge turns the tap into playback.
 *
 * A COMPONENT, not a module effect, on purpose: playing needs the play verb
 * and the library index, both of which live in React context. It renders
 * nothing and mounts once, inside the providers (AppProviders), holding the
 * latest verb in refs so the one plugin listener - registered for the app's
 * whole life - never goes stale.
 *
 * The tap can beat the library. A cold-ish launch delivers `onAction` before
 * the first sync finishes, and the named song resolves to nothing for a few
 * seconds - so an unresolved tap is kept and retried briefly rather than
 * dropped. Not forever: a song that still cannot be found after the window is
 * genuinely not here (deleted between landing and tap), and doing nothing
 * beats playing a guess.
 */

/** How long a tap waits for the library to catch up. */
const RESOLVE_WINDOW_MS = 20_000;
const RETRY_MS = 1_000;

let registered = false;

export function NotificationTapBridge() {
  const play = usePlayNowOptional();
  const find = useOwnedTrack();

  // The listener outlives every render; the refs keep its hands current.
  const playRef = useRef(play);
  playRef.current = play;
  const findRef = useRef(find);
  findRef.current = find;

  useEffect(() => {
    // One registration for the app's life - the plugin listener has no
    // meaningful teardown moment before that, and re-registering per mount
    // would play the song once per remount of the provider tree.
    if (registered) return;
    registered = true;

    void (async () => {
      try {
        const api = await import('@tauri-apps/plugin-notification');
        await api.onAction((notification) => {
          const extra = (notification as { extra?: Record<string, unknown> }).extra;
          const title = typeof extra?.songTitle === 'string' ? extra.songTitle : '';
          const artist = typeof extra?.songArtist === 'string' ? extra.songArtist : '';
          if (!title) return; // a tap on news that names no song just opens the app

          const started = Date.now();
          const attempt = () => {
            const track = findRef.current(title, artist || undefined);
            if (track && playRef.current) {
              playRef.current(track);
              return;
            }
            if (Date.now() - started < RESOLVE_WINDOW_MS) {
              window.setTimeout(attempt, RETRY_MS);
            }
          };
          attempt();
        });
      } catch {
        // Desktop, a browser, or a shell built before the plugin: taps just
        // open the app, which is what they always did.
      }
    })();
  }, []);

  return null;
}
