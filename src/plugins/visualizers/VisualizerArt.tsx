import { useEffect, useRef, useState } from 'react';
import { useNowPlayingMotion } from '../../app/player/nowPlayingMotion.tsx';
import { VISUALIZERS, accentHue, makeColor, type VizFrame } from './visualizers.ts';
import { VIZ_EVENT, readVizIndex, writeVizIndex } from './vizPref.ts';

/** Spectrum bands asked of the graph each frame - log-spaced, low to high. */
const BANDS = 32;
const EMPTY: number[] = [];
/**
 * A press held this long is a hold, not a tap. The chrome wraps the square in
 * the kit's ContextMenu, which opens the Artwork style menu 500ms into a touch
 * and leaves the pointerup alone - so THE RELEASE STILL CLICKS (see
 * src/app/ux/holdToMenu.ts). Without a guard the finger that summoned the menu
 * also cycled the visualizer under it, every time. Under both the kit's 500ms
 * and the app's own 450ms hold.
 */
const TAP_MS = 400;
/**
 * A frame closer than this to the last is skipped: a 120Hz display draws at
 * 60. Nothing here reads better twice as often, and the per-pixel visualizers
 * (the Julia set, the plasma) cost the same per frame whatever the rate.
 */
const FRAME_MS = 14;
/**
 * Quiet frames before a silent loop parks itself - about a second and a half
 * at 60fps, long enough for the slowest fade to finish so the square settles
 * rather than freezing mid-trail. A paused player under an open sheet used to
 * keep the full draw running at display rate for nothing.
 */
const PARK_AFTER = 90;

function mean(xs: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i += 1) s += xs[i] ?? 0;
  return s / Math.max(1, to - from);
}

/**
 * How far a meter settles toward its target in one step of `s` seconds, for a
 * time constant of `tau` seconds. Time constants rather than per-frame
 * factors, so the shape is the same on a 60Hz phone, a 120Hz one and the
 * reduced-motion tick alike.
 */
function settle(s: number, tau: number): number {
  return 1 - Math.exp(-s / tau);
}

function prefersStill(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The visualizers plugin's face for the Now Playing art square.
 *
 * One canvas, one draw a frame, no React in the loop: the audio is read
 * straight off the graph (useNowPlayingMotion hands out the same analyser the
 * disc's wobble and the seek bar's wave read), smoothed here into the frame
 * every visualizer receives, and the chosen visualizer paints. A tap cycles to
 * the next one and shows its name for a moment; the settings pane's pick lands
 * here through the same stored choice.
 *
 * The frame's numbers are shaped the way meters have always been shaped -
 * rising fast, falling slow - so a peak is seen arriving and a silence fades
 * rather than snaps. The beat is an onset: a level clearly over its own
 * running average, fired as a pulse with a short refractory so a sustained
 * loud passage reads as energy, not as one endless beat.
 *
 * In silence the loop parks itself, like the disc does when it stops turning,
 * and sound returning wakes it.
 */
export function VisualizerArt() {
  const { analyser, audible } = useNowPlayingMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [index, setIndex] = useState(readVizIndex);
  const [showName, setShowName] = useState(false);
  // Reduced motion, read live: it decides the loop's whole shape.
  const [still, setStill] = useState(prefersStill);
  // The loop reads the live graph through a ref so a change of analyser or
  // audibility never restarts the animation.
  const live = useRef({ analyser, audible });
  live.current = { analyser, audible };
  // The press that will end in the next click: when it began (0 for a
  // keyboard click, which always counts as a tap), and whether a kit menu was
  // already up - then the tap is that menu's dismissal, not a pick.
  const press = useRef({ at: 0, menuOpen: false });
  // Wakes a loop that parked itself in silence; null while none is parked.
  const kick = useRef<(() => void) | null>(null);

  // Follow a pick made in Settings.
  useEffect(() => {
    const on = () => setIndex(readVizIndex());
    window.addEventListener(VIZ_EVENT, on);
    return () => window.removeEventListener(VIZ_EVENT, on);
  }, []);

  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mql) return;
    const on = () => setStill(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);

  const def = VISUALIZERS[index % VISUALIZERS.length] ?? VISUALIZERS[0];

  const next = () => {
    const n = (index + 1) % VISUALIZERS.length;
    setIndex(n);
    writeVizIndex(n);
    setShowName(true);
  };
  useEffect(() => {
    if (!showName) return;
    const t = window.setTimeout(() => setShowName(false), 1400);
    return () => window.clearTimeout(t);
  }, [showName, index]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const draw = def.create();
    let stopped = false;
    let parked = false;
    let raf = 0;
    let timer = 0;
    let last = performance.now();
    const start = last;
    const bands: number[] = new Array(BANDS).fill(0);
    let level = 0;
    let avg = 0;
    let beat = 0;
    let hue = accentHue();
    let tick = 0;
    let quiet = 0;
    // The LAYOUT box, never the painted one: the chrome scales this face in
    // at every mount, and a bounding rect follows that scale - which
    // re-allocated (and wiped) the bitmap on every frame of the entrance.
    // Seeded now because the first frame runs before the observer's first
    // word; css px, with the dpr applied in the loop so a monitor change is
    // still followed.
    const box = { w: canvas.clientWidth, h: canvas.clientHeight };
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const e = entries[0];
            if (!e) return;
            box.w = e.contentRect.width;
            box.h = e.contentRect.height;
          });
    ro?.observe(canvas);

    const step = (now: number) => {
      if (stopped) return;
      // The real gap is what the meters settle by; the visualizers get a
      // capped one, so a tab back from the background does not leap.
      const elapsed = Math.max(0.001, (now - last) / 1000);
      const dt = Math.min(0.05, elapsed);
      const s = Math.min(1, elapsed);
      last = now;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(box.w * dpr));
      const h = Math.max(1, Math.round(box.h * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = '#060608';
        ctx.fillRect(0, 0, w, h);
      }
      const { analyser: an, audible: aud } = live.current;
      const raw = an && aud ? an.spectrum(BANDS) : EMPTY;
      const lv = an && aud ? an.meter() : 0;
      const fall = settle(s, 0.085);
      for (let i = 0; i < BANDS; i += 1) {
        const target = raw[i] ?? 0;
        const prev = bands[i] ?? 0;
        bands[i] = target > prev ? target : prev + (target - prev) * fall;
      }
      level += (lv - level) * settle(s, lv > level ? 0.024 : 0.13);
      avg += (level - avg) * settle(s, 0.325);
      // The floor is the one the app's own onset detector keeps on this same
      // meter (-40 dBFS); the ratio to the running average is what keeps
      // silence quiet. Any higher and a soft record never beats at all.
      const onset = level > 0.01 && level > avg * 1.35 && beat < 0.35;
      beat = onset ? 1 : Math.max(0, beat - s * 5);
      tick += 1;
      // Retint every half second of frames - or every tick, when the ticks
      // are themselves half a second apart.
      if (tick % 30 === 0 || elapsed >= 0.4) hue = accentHue();
      const f: VizFrame = {
        ctx,
        w,
        h,
        t: (now - start) / 1000,
        dt,
        level,
        bands,
        bass: mean(bands, 0, 6),
        mid: mean(bands, 6, 18),
        treble: mean(bands, 18, BANDS),
        beat,
        hue,
        color: makeColor(hue),
      };
      draw(f);
      quiet = aud ? 0 : quiet + 1;
    };
    const loop = (now: number) => {
      if (stopped) return;
      if (now - last < FRAME_MS) {
        raf = requestAnimationFrame(loop);
        return;
      }
      step(now);
      // Silence, settled: the loop ends rather than idling at full rate under
      // a paused player. Sound returning kicks it (below).
      if (quiet > PARK_AFTER) {
        parked = true;
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (still) {
      // Stillness asked for is stillness given: a frame every half second is
      // a picture that changes, not one that moves.
      step(performance.now());
      timer = window.setInterval(() => step(performance.now()), 500);
    } else {
      raf = requestAnimationFrame(loop);
      kick.current = () => {
        if (stopped || !parked) return;
        parked = false;
        quiet = 0;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      };
    }
    return () => {
      stopped = true;
      kick.current = null;
      ro?.disconnect();
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [def, still]);

  // Sound returning is exactly what a parked loop is waiting for.
  useEffect(() => {
    if (audible) kick.current?.();
  }, [audible]);

  return (
    <div
      className="vizArt"
      data-show-name={showName || undefined}
      onPointerDown={() => {
        press.current = {
          at: performance.now(),
          menuOpen: document.querySelector('[data-menu-stack]') !== null,
        };
      }}
      onClick={() => {
        // The tail of a hold is not a tap: the menu the hold opened is up,
        // and the picture under it should be the one that was held. Nor is
        // the tap that puts that menu away.
        const { at, menuOpen } = press.current;
        press.current = { at: 0, menuOpen: false };
        const held = at > 0 && performance.now() - at > TAP_MS;
        if (held || menuOpen) return;
        next();
      }}
      role="button"
      aria-label={`Visualizer: ${def?.name ?? ''}. Tap for the next one.`}
    >
      <canvas ref={canvasRef} className="vizArt__canvas" />
      <span className="vizArt__name">{def?.name}</span>
    </div>
  );
}
