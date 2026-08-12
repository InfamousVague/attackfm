import { useEffect, useState } from 'react';
import { artSized } from './server.ts';
import { useServerSession } from './serverSession.tsx';
import placeholderArt from '../assets/attack-wave.png';

/**
 * Art that ARRIVES rather than pops: the shared machinery behind every cover
 * in the app. A surface holds its skeleton shimmer while the image is still
 * on the wire, then reveals with the pulse animation - a purely visual pop,
 * no haptic (a tick per cover loading in felt like force feedback).
 *
 * Two pieces:
 *   - useArtLoad(src): one image. Returns the props an <img> needs to wear
 *     the skeleton (`data-loading`), pop in (`artPop` class), and report.
 *   - useTileArt(urls): a mosaic. Playlist tiles and mix covers draw up to
 *     four covers as ONE artwork - they skeleton and reveal as one, keyed on
 *     every image having answered, so a tile never shows three covers and a
 *     hole while the fourth loads.
 */

// --- one image ------------------------------------------------------------

/** How long a hung request may hold the skeleton before revealing anyway. */
const REVEAL_TIMEOUT_MS = 20_000;

export interface ArtLoadProps {
  /** Spread onto the <img>: the skeleton attribute, pop class, and handlers. */
  className: string;
  'data-loading': true | undefined;
  onLoad: () => void;
  onError: () => void;
}

/**
 * The single-cover version, for list thumbs and grid cells. Give it the
 * class the img already wears; it hands back that class plus the pop, the
 * `data-loading` attribute while the bytes are coming, and the handlers that
 * end the wait. A null/absent src (glyph fallbacks) is never "loading".
 */
export function useArtLoad(src: string | null | undefined, className: string): ArtLoadProps {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    if (!src) return;
    const timer = window.setTimeout(() => setLoaded(true), REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src]);
  const waiting = !!src && !loaded;
  return {
    className: `${className} artPop`,
    'data-loading': waiting || undefined,
    onLoad: () => setLoaded(true),
    // An error ends the skeleton too: whatever the img falls back to (its
    // alt, a glyph behind it) is the final answer, not a thing to shimmer at.
    onError: () => setLoaded(true),
  };
}

// --- a shelf card ---------------------------------------------------------

/**
 * The shelf-card version, moved here from LibraryView so HomePage and the
 * For-You shelf can share it without an import cycle. Adds to useArtLoad:
 * the placeholder swap on a dead URL, the token renewal that usually
 * explains one, and the loaded flag the card's text lines skeleton on.
 */
export function useCardArt(artwork: string | null): {
  src: string;
  loaded: boolean;
  onLoad: () => void;
  onError: () => void;
} {
  // Cards draw covers at a couple hundred CSS pixels; the 640 variant covers
  // 3x displays while costing a fraction of the original embedded picture
  // (often megabytes). Servers without variants serve the original unchanged.
  const wanted = artSized(artwork, 640) ?? placeholderArt;
  const [src, setSrc] = useState(wanted);
  const [loaded, setLoaded] = useState(false);
  const { renew } = useServerSession();
  useEffect(() => {
    setSrc(wanted);
    setLoaded(false);
    const timer = window.setTimeout(() => setLoaded(true), REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [wanted]);
  return {
    src,
    loaded,
    onLoad: () => setLoaded(true),
    // A dead cover URL swaps to the placeholder once (which then loads and
    // reveals); if the placeholder itself is what failed, just reveal. Server
    // art failing usually means the stream token in its URL has aged out, so
    // one renewal is asked for - latched to once a minute in the provider, a
    // wall of failing covers costs one /api/me, and the refreshed session
    // re-renders every card with working URLs.
    onError: () => {
      if (src === placeholderArt) setLoaded(true);
      else {
        if (artwork && /[?&]t=/.test(artwork)) void renew().catch(() => {});
        setSrc(placeholderArt);
      }
    },
  };
}

// --- a mosaic -------------------------------------------------------------

/**
 * All-or-nothing loading for a tile drawn from several covers. Preloads the
 * given URLs off-DOM (the rendered <img>s then paint from cache) and answers
 * false until every one has loaded or errored. The wrapper carries
 * `data-loading` from this, and its imgs stay hidden under the shimmer until
 * the tile reveals whole.
 */
export function useTileArt(urls: readonly (string | null)[]): {
  loaded: boolean;
  /** Attach to the tile's wrapper: preloading waits until it nears the
   *  viewport, so a shelf of fifty playlists does not fetch two hundred
   *  covers at mount - the laziness the plain imgs used to have, kept. */
  hostRef: (el: Element | null) => void;
} {
  const real = urls.filter((u): u is string => !!u);
  // Identity for the effect: the tile re-arms only when its art actually
  // changes, not when the caller rebuilds the array each render.
  const key = real.join('\n');
  const [loaded, setLoaded] = useState(real.length === 0);
  const [host, setHost] = useState<Element | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    // No host attached (a call site that forgot the ref) falls back to
    // eager after a beat - a tile that never loads is worse than one that
    // loads early.
    if (!host) {
      const t = window.setTimeout(() => setNear(true), 300);
      return () => window.clearTimeout(t);
    }
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '200px' },
    );
    io.observe(host);
    return () => io.disconnect();
  }, [host, near]);
  useEffect(() => {
    const wanted = key ? key.split('\n') : [];
    if (wanted.length === 0) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    if (!near) return;
    let live = true;
    let left = wanted.length;
    const done = () => {
      left -= 1;
      if (live && left <= 0) setLoaded(true);
    };
    const images = wanted.map((u) => {
      const img = new Image();
      img.onload = done;
      img.onerror = done;
      img.src = u;
      return img;
    });
    // A hung request reveals the tile anyway, same as the single-image path.
    const timer = window.setTimeout(() => {
      if (live) setLoaded(true);
    }, REVEAL_TIMEOUT_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      for (const img of images) {
        img.onload = null;
        img.onerror = null;
      }
    };
  }, [key, near]);
  return { loaded, hostRef: setHost };
}

/** The 640px variants of a track list's first distinct covers - what the
 *  mosaic hooks and tiles feed on. */
export function mosaicArts(artworks: readonly (string | null)[], take = 4): string[] {
  const out: string[] = [];
  for (const a of artworks) {
    const sized = artSized(a, 640);
    if (sized && !out.includes(sized)) out.push(sized);
    if (out.length >= take) break;
  }
  return out;
}
