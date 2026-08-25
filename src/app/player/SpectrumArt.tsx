import { useEffect, useRef } from 'react';
import type { AnalyserMeter } from '@glacier/react';

/**
 * A real analyser, in the art slot.
 *
 * EVERY visual in this app has been driven from one number. `meter` reads how
 * loud the signal is right now, and the disc's wobble, the seek bar's wave and
 * the header's pulse all breathe to that single scalar - which is why they move
 * as one, and why a bass drop and a cymbal look identical. The audio graph has
 * carried `spectrum(count)` the whole time, log-spaced bands from low to high,
 * with no callers anywhere in the app.
 *
 * This is the first thing to read it: bass on the left, treble on the right,
 * each band its own height.
 *
 * CANVAS, not elements. Sixty-four bars at 60fps is 3,840 style writes a second
 * through React, and the one thing this must not do is cost the audio thread its
 * frames. One canvas, one draw call per frame, no reconciliation.
 */
export function SpectrumArt({
  analyser,
  audible,
}: {
  analyser: AnalyserMeter | null;
  audible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Held across frames so bars fall smoothly instead of snapping to silence. */
  const heights = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let stopped = false;

    const draw = () => {
      if (stopped) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      /*
       * Band count follows the WIDTH. A phone showing sixty-four bars gives each
       * one about two pixels, which reads as noise rather than as a spectrum;
       * a desktop with sixteen wastes the room it has.
       */
      const bands = Math.max(12, Math.min(48, Math.round(rect.width / 9)));
      const live = analyser && audible ? analyser.spectrum(bands) : [];

      if (heights.current.length !== bands) heights.current = new Array(bands).fill(0);
      const hs = heights.current;
      for (let i = 0; i < bands; i += 1) {
        const target = live[i] ?? 0;
        // Rises fast, falls slow - the shape a level meter has always had,
        // because a peak you cannot see arrive is a peak you cannot read.
        const prev = hs[i] ?? 0;
        hs[i] = still ? target : target > prev ? target : prev + (target - prev) * 0.16;
      }

      ctx.clearRect(0, 0, w, h);
      const gap = Math.max(1, w / bands / 6);
      const barW = (w - gap * (bands - 1)) / bands;
      const accent = getComputedStyle(canvas).getPropertyValue('color') || '#fff';
      ctx.fillStyle = accent.trim() || '#fff';
      for (let i = 0; i < bands; i += 1) {
        // A floor, so a silent band is still a line rather than nothing: an
        // analyser that vanishes between beats reads as broken.
        const v = Math.max(0.015, hs[i] ?? 0);
        const barH = v * h;
        const x = i * (barW + gap);
        const r = Math.min(barW / 2, barH / 2);
        ctx.beginPath();
        ctx.roundRect(x, h - barH, barW, barH, r);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [analyser, audible]);

  return (
    <div className="npSpectrum">
      <canvas ref={canvasRef} className="npSpectrum__canvas" aria-hidden />
    </div>
  );
}
