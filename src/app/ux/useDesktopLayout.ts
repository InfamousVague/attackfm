import { useEffect, useState } from 'react';
import { isDesktopApp } from '../core/platform.ts';

/**
 * Whether to wear the DESKTOP SHAPE: the side rail, the top bar, the cover
 * washed in behind the content — as against the phone shape, with its bottom
 * tab bar and compact header.
 *
 * This is deliberately a different question from `isDesktopApp`, and keeping
 * the two apart is the whole point of this file. `isDesktopApp` asks "is this
 * a Tauri desktop window?", which is a question about CAPABILITY: whether
 * there is a frame to decorate, a traffic-light gutter to reserve, a drag
 * region that means anything, a local music folder to walk, a subprocess to
 * spawn. The answer is fixed for the life of the process.
 *
 * This asks "is there room and a cursor?", which is a question about SHAPE,
 * and on the web the answer changes while the app is running — a browser
 * window is resized, a laptop is docked to a monitor. So it is a hook that
 * tracks the media query rather than a constant read once at module load.
 *
 * Before attack.fm/listen existed the two questions had one answer, because
 * the only wide, cursor-driven surface WAS the Tauri window and every browser
 * was assumed to be a phone. The web build breaks that tie: a desktop browser
 * has all the room and all the pointer precision of the app, and none of the
 * window.
 *
 * `pointer: fine` rather than width alone is what keeps a tablet on the phone
 * shape. The rail's targets are small and its hovers carry meaning; a
 * thumb-driven screen wants the bar however wide it is.
 */
const DESKTOP_SHAPE = '(min-width: 60rem) and (pointer: fine)';

export function useDesktopLayout(): boolean {
  const [wide, setWide] = useState(
    () => isDesktopApp || (window.matchMedia?.(DESKTOP_SHAPE).matches ?? false),
  );
  useEffect(() => {
    // The app window never stops being desktop-shaped, so there is nothing to
    // watch: subscribing anyway would only add a listener that can never fire.
    if (isDesktopApp) return;
    const query = window.matchMedia?.(DESKTOP_SHAPE);
    if (!query) return;
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}
