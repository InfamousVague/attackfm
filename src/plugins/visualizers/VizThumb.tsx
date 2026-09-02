import { useEffect, useRef } from 'react';
import { accentHue, makeColor, type VizDef, type VizFrame } from './visualizers.ts';

/**
 * One still of a visualizer, for the settings pane's picker: the real draw
 * run for a couple of dozen frames against a made-up spectrum, so trails,
 * particles and rings have had time to appear. Not animated - a grid of
 * thirteen live canvases would cost more than the pane is worth, and a still
 * is enough to tell a plasma from a rose.
 */
export function VizThumb({ def }: { def: VizDef }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = 128;
    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, size, size);
    const draw = def.create();
    const hue = accentHue();
    // A plausible spectrum - loud low end, a lively middle, tailing off.
    const bands = Array.from({ length: 32 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7 + 1)) * (1 - i / 48));
    const f: VizFrame = {
      ctx,
      w: size,
      h: size,
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
    for (let i = 0; i < 28; i += 1) {
      f.t = i / 30;
      // The first frame is the beat; after it, the pulse decays as it would live.
      f.beat = i === 0 ? 1 : Math.max(0, 1 - i / 12);
      draw(f);
    }
  }, [def]);
  return <canvas ref={ref} className="vizThumb" aria-hidden="true" />;
}
