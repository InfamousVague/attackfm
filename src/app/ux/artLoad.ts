import { useEffect, useRef, useState } from 'react';
import { serverSeemsDown } from '../api/reachability.ts';
import { artSized } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { artFallbackUrl } from '../servers/mirrors.ts';
import { cachedArt, rememberArt } from '../cache/artCache.ts';
import placeholderArt from '../../assets/attack-wave.png';

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
  onError: (e?: { currentTarget?: HTMLImageElement }) => void;
}

/**
 * The single-cover version, for list thumbs and grid cells. Give it the
 * class the img already wears; it hands back that class plus the pop, the
 * `data-loading` attribute while the bytes are coming, and the handlers that
 * end the wait. A null/absent src (glyph fallbacks) is never "loading".
 */
export function useArtLoad(src: string | null | undefined, className: string): ArtLoadProps {
  const [loaded, setLoaded] = useState(false);
  const recovered = useRef(false);
  useEffect(() => {
    setLoaded(false);
    recovered.current = false;
    if (!src) return;
    const timer = window.setTimeout(() => setLoaded(true), REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src]);
  const waiting = !!src && !loaded;
  return {
    className: `${className} artPop`,
    'data-loading': waiting || undefined,
    // Every cover this hook draws is kept, which is most of them: thumbs,
    // grid cells, hero images.
    onLoad: () => {
      setLoaded(true);
      if (src) void rememberArt(src);
    },
    /*
     * On error, the kept copy - served IMPERATIVELY through the event's own
     * element.
     *
     * This hook's callers all own their src (<img {...art} src={mine}>), so a
     * src in the returned props would be spread over and lost; the old answer
     * was to shrug ("whatever the img falls back to is the final answer"),
     * which meant every table thumb, queue row, album page and search tile
     * dropped its cover in airplane mode while the bytes sat in the art
     * cache. Writing the element's src directly sidesteps the ownership
     * problem for all seventeen call sites at once: the swap fires the img's
     * own onLoad, which ends the skeleton the ordinary way. Tried once per
     * src, so a cached copy that itself fails cannot loop.
     */
    onError: (e?: { currentTarget?: HTMLImageElement }) => {
      const img = e?.currentTarget;
      if (img && src && !recovered.current) {
        recovered.current = true;
        void cachedArt(src).then((url) => {
          if (url) img.src = url;
          else setLoaded(true);
        });
        return;
      }
      setLoaded(true);
    },
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
  const { renew, session } = useServerSession();
  useEffect(() => {
    setSrc(wanted);
    setLoaded(false);
    const timer = window.setTimeout(() => setLoaded(true), REVEAL_TIMEOUT_MS);
    /*
     * WITH THE HUB DARK, go to the held copy at once.
     *
     * The error ladder below already finds it, but only after the <img> has
     * tried the dead server and failed - and a request to a host that is simply
     * not answering does not fail promptly, it hangs until something times it
     * out. That is a shelf of grey rectangles for as long as that takes, on a
     * phone with every one of those covers already on disk.
     *
     * Not a replacement for the ladder: this is a guess about the network, and
     * the ladder is what answers when one particular cover genuinely fails.
     */
    let alive = true;
    if (serverSeemsDown() && wanted !== placeholderArt) {
      void cachedArt(wanted).then((held) => {
        if (alive && held) setSrc(held);
      });
    }
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [wanted]);
  return {
    src,
    loaded,
    onLoad: () => {
      setLoaded(true);
      // A cover that just drew is a cover worth keeping: the bytes are in the
      // engine's own cache at this moment, so the copy costs no real fetch.
      void rememberArt(src);
    },
    /*
     * The error ladder, one rung per failure.
     *
     * The device's own copy goes FIRST among the fallbacks, ahead of the
     * mirror it used to jump to: it needs no network at all, where a mirror
     * is another server that may be just as unreachable - and most phones
     * have no mirror configured, so that rung was usually a straight drop to
     * the placeholder. Only when nothing is held do we ask a mirror, then
     * give up to the placeholder.
     *
     * A failing server URL also asks for one token renewal - latched to once
     * a minute in the provider - since an aged stream token is the usual
     * benign explanation.
     */
    onError: () => {
      if (src === placeholderArt) setLoaded(true);
      else if (src === wanted) {
        if (artwork && /[?&]t=/.test(artwork)) void renew().catch(() => {});
        void cachedArt(wanted).then((held) => {
          if (held) {
            setSrc(held);
            return;
          }
          setSrc((session ? artFallbackUrl(session, wanted) : null) ?? placeholderArt);
        });
      } else {
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
  // (session is only read for the mirror fallback below)
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
  const { session } = useServerSession();
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
      // The kept copy first, then a mirror, then done. The device's own art
      // cache used to be missing from this ladder entirely - a mirror is
      // another server, and in airplane mode every server is equally gone,
      // so playlist mosaics went blank over bytes already on the device.
      img.onerror = () => {
        img.onerror = () => {
          const mirror = session ? artFallbackUrl(session, u) : null;
          if (mirror && img.src !== mirror) {
            img.onerror = done;
            img.src = mirror;
          } else {
            done();
          }
        };
        void cachedArt(u).then((kept) => {
          if (kept) {
            img.src = kept;
          } else if (img.onerror) {
            (img.onerror as () => void)();
          }
        });
      };
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
/**
 * One cover per ALBUM, in track order, up to `take`.
 *
 * The dedupe is by the art's identity rather than by the URL string, and that
 * distinction was silently doing nothing for years. A server art URL is
 * `/api/art/{sha}?t={streamToken}&track={trackId}` - the sha IS the album,
 * because the server content-addresses the image bytes, but the trailing
 * `track` differs for every song. Comparing whole URLs therefore never matched,
 * so four songs off one record produced four different strings for the same
 * picture and every mosaic in the app drew that one sleeve four times over: the
 * playlist faces, the search tiles, the artist page, the Booth's mixes. The
 * comment promising otherwise had been wrong since the token was added.
 *
 * Local files cannot be folded this way and are not: each track's cover is its
 * own `blob:` URL with no shared identity to compare, so a local album still
 * repeats. Fixing that needs the scanner to hash the picture, which is a bigger
 * job than this one.
 */
export function mosaicArts(
  artworks: readonly (string | null)[],
  take = 4,
  /**
   * Which variant to ask for. 640 is right for a mosaic tile you look AT; the
   * cover wall behind a header is blurred to nothing and wants 160, or it
   * fetches a dozen full-size covers to throw most of their pixels away.
   */
  px: 160 | 640 = 640,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of artworks) {
    const sized = artSized(a, px);
    if (!sized) continue;
    const id = artIdentity(sized);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(sized);
    if (out.length >= take) break;
  }
  return out;
}

/**
 * What makes two art URLs the same picture.
 *
 * Origin and path only: the query carries a stream token and an inert track id,
 * neither of which changes what is drawn. Anything unparseable - a `blob:`, a
 * data URI - is compared whole, which is the honest answer for a URL that
 * carries no shared identity.
 */
function artIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
