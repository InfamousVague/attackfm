import { useEffect, useState } from 'react';
import { useSystemBack } from './systemBack.ts';

/**
 * Search, summoned: a pull down on any page (or ⌘K) drops the search over
 * whatever you were doing, and it retreats the same way - no tab, no lost
 * place. The pull gesture below sets `searchOpen`; so does the old 'search'
 * route. Extracted whole from App; `hostRef` is the content host the gesture
 * listens on (the same element the edge-swipe drags).
 */
export function useSearchSummon(hostRef: { current: HTMLElement | null }) {
  const [searchOpen, setSearchOpen] = useState(false);
  useSystemBack(searchOpen, () => setSearchOpen(false));

  // The pull that summons search: a mostly-vertical drag DOWN from the top of
  // whichever page is showing. Delegated from the content host the same way
  // the shelf pan and the top scrim are, so every page is covered by one
  // listener; armed only when the page's own scroller is already at its top,
  // so ordinary scrolling never fights it. The rubber band is ours to spend -
  // the root sets overscroll-behavior: none.
  const [pullHint, setPullHint] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let startY = 0;
    let startX = 0;
    let armed = false;
    let pulling = false;
    const pageOf = (target: EventTarget | null): HTMLElement | null => {
      let el = target instanceof HTMLElement ? target : null;
      while (el && el.parentElement !== host) el = el.parentElement;
      return el;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const page = pageOf(e.target);
      armed = !!page && page.scrollTop <= 0;
      pulling = false;
      startY = t.clientY;
      startX = t.clientX;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = Math.abs(t.clientX - startX);
      if (!pulling && dy > 28 && dy > dx * 1.5) {
        pulling = true;
        setPullHint(true);
      } else if (pulling && dy < 16) {
        pulling = false;
        setPullHint(false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (armed && pulling && t && t.clientY - startY >= 72) {
        setSearchOpen(true);
        try {
          localStorage.setItem('attackfm-summon-known', '1');
        } catch {
          // The hint just lingers a launch longer.
        }
      }
      armed = false;
      pulling = false;
      setPullHint(false);
    };
    host.addEventListener('touchstart', onStart, { passive: true });
    host.addEventListener('touchmove', onMove, { passive: true });
    host.addEventListener('touchend', onEnd, { passive: true });
    host.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onEnd);
    };
  }, []);
  // Until the pull has been used once, a small chip under the header says it
  // exists - the one cost of retiring the Search tab.
  const [summonHint, setSummonHint] = useState(() => {
    try {
      return localStorage.getItem('attackfm-summon-known') !== '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (searchOpen && summonHint) {
      setSummonHint(false);
      try {
        localStorage.setItem('attackfm-summon-known', '1');
      } catch {
        // Fine; it dismisses for this launch regardless.
      }
    }
  }, [searchOpen, summonHint]);

  // The chord the field advertises: Cmd/Ctrl+K summons search from anywhere,
  // and Escape sends it home (the overlay is not a kit Modal, so it minds its
  // own key).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((v) => !v);
      } else if (event.key === 'Escape') {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { pullHint, summonHint, searchOpen, setSearchOpen };
}
