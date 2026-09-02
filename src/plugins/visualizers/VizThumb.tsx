import { useEffect, useRef } from 'react';
import { accentHue, makeColor, type VizDef, type VizFrame } from './visualizers.ts';

const SIZE = 128;
const FRAMES = 28;

/**
 * Finished stills, one per visualizer, in the accent hue they were painted
 * with. Opening the pane again is thirteen blits rather than thirteen renders;
 * a new hue (the record changed) throws the lot away.
 */
const stills = new Map<string, HTMLCanvasElement>();
let stillsHue = Number.NaN;

/**
 * Renders wait their turn off the commit, one per animation frame. Thirteen of
 * them at twenty-eight frames each, run synchronously in the effects of a
 * single commit, held the pane's slide-in until the last one was done - the
 * pane opened late rather than mid-hitch. This way it paints first and the
 * pictures fill in over the next dozen frames.
 */
const queue: (() => void)[] = [];
let draining = 0;
function drain(): void {
  draining = 0;
  queue.shift()?.();
  if (queue.length > 0) draining = requestAnimationFrame(drain);
}
function enqueue(job: () => void): () => void {
  queue.push(job);
  if (!draining) draining = requestAnimationFrame(drain);
  return () => {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
  };
}

/**
 * The real draw run for a couple of dozen frames against a made-up spectrum,
 * so trails, particles and rings have had time to appear. Not animated - a
 * grid of thirteen live canvases would cost more than the pane is worth, and a
 * still is enough to tell a plasma from a rose.
 */
function renderStill(def: VizDef, hue: number): HTMLCanvasElement | null {
  const off = document.createElement('canvas');
  off.width = SIZE;
  off.height = SIZE;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#060608';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const draw = def.create();
  // A plausible spectrum - loud low end, a lively middle, tailing off.
  const bands = Array.from(
    { length: 32 },
    (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7 + 1)) * (1 - i / 48),
  );
  const f: VizFrame = {
    ctx,
    w: SIZE,
    h: SIZE,
    t: 0,
    dt: 1 / 60,
    level: 0.6,
    bands,
    bass: 0.7,
    mid: 0.5,
    treble: 0.45,
    beat: 0.8,
    hue,
    color: makeColor(hue),
  };
  for (let i = 0; i < FRAMES; i += 1) {
    f.t = i / 30;
    // The first frame is the beat; after it, the pulse decays as it would live.
    f.beat = i === 0 ? 1 : Math.max(0, 1 - i / 12);
    draw(f);
  }
  return off;
}

function stillOf(def: VizDef, hue: number): HTMLCanvasElement | null {
  if (hue !== stillsHue) {
    stills.clear();
    stillsHue = hue;
  }
  const hit = stills.get(def.id);
  if (hit) return hit;
  const made = renderStill(def, hue);
  if (made) stills.set(def.id, made);
  return made;
}

/** One still of a visualizer, for the settings pane's picker. */
export function VizThumb({ def }: { def: VizDef }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const hue = accentHue();
    const blit = () => {
      const still = stillOf(def, hue);
      if (still) ctx.drawImage(still, 0, 0);
    };
    // A still already made is painted now - a blit costs nothing. A fresh
    // render waits its turn behind the pane's own entrance.
    if (hue === stillsHue && stills.has(def.id)) {
      blit();
      return;
    }
    return enqueue(blit);
  }, [def]);
  return <canvas ref={ref} className="vizThumb" aria-hidden="true" />;
}
