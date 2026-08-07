/**
 * The dock icon: the station mark, drawn once and handed to the Dock at
 * boot. A dev binary has no bundle icon behind it - without this macOS shows
 * the generic executable tile - so the mark is rendered on a canvas from the
 * same silhouette the in-app wave uses and shipped over the bridge as PNG
 * bytes for AppKit to wear.
 *
 * This used to be a live meter that streamed spectrum-driven frames while
 * music played; the frames could never sit close enough to the beat to feel
 * synced, so the icon is still again.
 *
 * Everything here no-ops outside the Tauri webview.
 */

import { isTauri } from './tauri.ts';
import { sampleWave, WAVE_MID_Y, WAVE_SHADOW_DROP } from './BeatWave.tsx';

/** Rendered icon edge, in px. The Dock displays ~64-128; retina-friendly. */
const ICON_SIZE = 256;

/** The asset's stroke, as a share of its width, scaled to the canvas. */
const STROKE = 4.6 * (ICON_SIZE / 100);

/** The mark's two lines, straight off the asset. */
const WAVE_COLOR = '#ffffff';
const TRACER_COLOR = '#8a8a8a';

let sentStill = false;

/** The brand mark on black: the grey shadow line under the white wave. */
function drawStill(): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  const scale = ICON_SIZE / 100;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STROKE;

  const base = sampleWave(1);
  const stroke = (drop: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    base.forEach(([x, dy], index) => {
      const px = x * scale;
      const py = (WAVE_MID_Y + drop + dy) * scale;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  };

  stroke(WAVE_SHADOW_DROP, TRACER_COLOR);
  stroke(0, WAVE_COLOR);

  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return resolve(null);
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

/** Renders and ships the brand frame. Called once at boot. */
export async function initDockWave(): Promise<void> {
  if (!isTauri() || sentStill) return;
  sentStill = true;
  const still = await drawStill();
  if (!still) {
    sentStill = false;
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('dock_wave_still', { still: Array.from(still) });
  } catch {
    // A dock left generic is not worth failing boot over.
  }
}
