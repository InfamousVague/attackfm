import { useEffect, useRef, useState } from 'react';
import { useNowPlayingMotion } from '../../app/player/nowPlayingMotion.tsx';
import { VISUALIZERS, accentHue, makeColor, type VizFrame } from './visualizers.ts';
import { VIZ_EVENT, readVizIndex, writeVizIndex } from './vizPref.ts';

/** Spectrum bands asked of the graph each frame - log-spaced, low to high. */
const BANDS = 32;
const EMPTY: number[] = [];

function mean(xs: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i += 1) s += xs[i] ?? 0;
  return s / Math.max(1, to - from);
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
 */
export function VisualizerArt() {
  const { analyser, audible } = useNowPlayingMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [index, setIndex] = useState(readVizIndex);
  const [showName, setShowName] = useState(false);
  // The loop reads the live graph through a ref so a change of analyser or
  // audibility never restarts the animation.
  const live = useRef({ analyser, audible });
  live.current = { analyser, audible };

  // Follow a pick made in Settings.
  useEffect(() => {
    const on = () => setIndex(readVizIndex());
    window.addEventListener(VIZ_EVENT, on);
    return () => window.removeEventListener(VIZ_EVENT, on);
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
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let stopped = false;
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

    const step = (now: number) => {
      if (stopped) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = '#060608';
        ctx.fillRect(0, 0, w, h);
      }
      const { analyser: an, audible: aud } = live.current;
      const raw = an && aud ? an.spectrum(BANDS) : EMPTY;
      const lv = an && aud ? an.meter() : 0;
      for (let i = 0; i < BANDS; i += 1) {
        const target = raw[i] ?? 0;
        const prev = bands[i] ?? 0;
        bands[i] = target > prev ? target : prev + (target - prev) * 0.18;
      }
      level += (lv - level) * (lv > level ? 0.5 : 0.12);
      avg += (level - avg) * 0.05;
      const onset = level > 0.08 && level > avg * 1.35 && beat < 0.35;
      beat = onset ? 1 : Math.max(0, beat - dt * 5);
      tick += 1;
      if (tick % 30 === 0) hue = accentHue();
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
    };
    const loop = (now: number) => {
      step(now);
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
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [def]);

  return (
    <div
      className="vizArt"
      data-show-name={showName || undefined}
      onClick={next}
      role="button"
      aria-label={`Visualizer: ${def?.name ?? ''}. Tap for the next one.`}
    >
      <canvas ref={canvasRef} className="vizArt__canvas" />
      <span className="vizArt__name">{def?.name}</span>
    </div>
  );
}
