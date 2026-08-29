import { useEffect, useState } from 'react';

/**
 * The album's colour, made wearable.
 *
 * The Now Playing sheet paints its chrome - the play circle, the seek bar,
 * the saved heart, the lit shuffle/repeat - in the kit accent, which is the
 * same colour whatever is playing. This asks the cover instead: pull the hue
 * the artwork is actually about, then dress it as a PASTEL - light and soft
 * by construction, because the sheet floors these tokens over a dark blurred
 * cover where a dark or shouty accent disappears or fights the art.
 *
 * Only the HUE is taken from the art. Saturation and lightness are pinned to
 * a pastel band rather than sampled, which is what "match the album but keep
 * it pastel and not too dark" cashes out to: a black-metal cover and a neon
 * one land in the same band, told apart by hue alone. Art with no hue to
 * speak of - greyscale covers, near-black photography - returns null and the
 * sheet keeps the kit accent, because a hue invented from noise dresses the
 * screen in a colour the album never was.
 *
 * The read itself rides the same fetch -> ImageBitmap -> canvas path the
 * lock-screen artwork uses (androidAudio.ts): bytes first, so the canvas is
 * never tainted whatever protocol served the cover (https, asset, blob).
 */

/**
 * The whole accent ramp, re-grounded in the album's hue, as CSS custom
 * properties ready to spread onto an element's style. The FULL ramp, not
 * just the three tokens the sheet's own CSS names: kit components on the
 * sheet (the SeekBar's accent tone, chips, borders) drink from the numbered
 * steps and the -soft/-contrast/-border aliases directly, and a partial
 * override would leave them kit-blue in a sea of pastel.
 */
export type ArtTint = Record<string, string>;

/** Enough covers to flip through an album run without refetching. */
const CACHE_CAP = 24;
const cache = new Map<string, ArtTint | null>();

/** 30-degree hue buckets: coarse enough to gather an album's family of
 * shades, fine enough that teal and blue do not vote as one. */
const BUCKETS = 12;

/**
 * Below this vote mass, the art has no opinion about hue and we decline to
 * invent one. Votes are saturation-cubed, so this is roughly "a couple of
 * dozen genuinely vivid pixels somewhere in a 40x40 read" - even moody
 * covers usually carry that, and the fallback is the kit accent, not grey.
 */
const MIN_VOTE = 1.5;

async function readTint(url: string): Promise<ArtTint | null> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const side = 40;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, side, side);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, side, side);

  /* One pass of hue voting. A pixel's vote is its saturation CUBED, damped
     by how far it sits from mid-lightness. Cubed is the whole answer to a
     real failure: with a linear weight the vote measures POPULATION, and a
     cover that is mostly skin tone and tan backdrop reads as peach even
     when the one thing your eye goes to is a saturated purple jacket - the
     muted acres outvote the vivid patch. Cubing collapses the muted mass
     (0.3 sat -> 0.027) while barely denting the vivid (0.9 -> 0.73), so
     the question the vote answers becomes "what is the most COLOURFUL
     thing here", which is the colour a person would name for the cover.
     Near-black and near-white pixels - whose hue channel is mostly
     quantisation noise - still barely whisper. */
  const votes = new Float32Array(BUCKETS);
  const sinSum = new Float32Array(BUCKETS);
  const cosSum = new Float32Array(BUCKETS);
  for (let i = 0; i < data.length; i += 4) {
    const r = (data[i] ?? 0) / 255;
    const g = (data[i + 1] ?? 0) / 255;
    const b = (data[i + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d < 0.04) continue;
    const sat = d / (1 - Math.abs(2 * l - 1) || 1);
    let h: number;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    const w = sat * sat * sat * (1 - Math.abs(l - 0.5) * 1.6);
    if (w <= 0) continue;
    const bucket = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
    votes[bucket] = (votes[bucket] ?? 0) + w;
    const rad = h * Math.PI * 2;
    sinSum[bucket] = (sinSum[bucket] ?? 0) + Math.sin(rad) * w;
    cosSum[bucket] = (cosSum[bucket] ?? 0) + Math.cos(rad) * w;
  }

  /* The winning bucket plus its two neighbours: a hue family, not a slice.
     Neighbours matter because a hue sitting on a bucket edge splits its own
     vote, and because circular means across the family keep an orange-red
     cover from snapping to whichever side of the boundary won. */
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < BUCKETS; i += 1) {
    const score =
      (votes[i] ?? 0) +
      (votes[(i + 1) % BUCKETS] ?? 0) * 0.5 +
      (votes[(i + BUCKETS - 1) % BUCKETS] ?? 0) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if ((votes[best] ?? 0) < MIN_VOTE) return null;

  let sy = 0;
  let cx = 0;
  for (const j of [best, (best + 1) % BUCKETS, (best + BUCKETS - 1) % BUCKETS]) {
    sy += sinSum[j] ?? 0;
    cx += cosSum[j] ?? 0;
  }
  const hue = ((Math.atan2(sy, cx) * 180) / Math.PI + 360) % 360;

  return ramp(hue);
}

/**
 * The tint band, spelled out as a dark-theme accent ramp. Only the HUE
 * varies per album; every lightness and saturation is pinned, which is what
 * keeps the promise: light and never murky, whatever the record. First cut
 * was a true pastel (58% sat, 76% light) and read as washed out on the
 * sheet, so the band now sits brighter-and-fuller - vivid, but still well
 * clear of dark. Steps follow the kit's dark-scale shape (1 darkest wash,
 * 9 the solid, 12 near white); `contrast` - the glyph ON the solid - is a
 * near-white whisper of the same hue, by request: light glyphs on the vivid
 * circle, the way the rest of the sheet's ink runs light.
 */
/**
 * Perceived brightness of the band's solid at this hue, 0..1. The solid's
 * HSL lightness is pinned at 64%, but 64%-yellow blazes while 64%-blue
 * broods - luma is what the eye actually gets, so it is what the ink on
 * the solid must answer to.
 */
function solidLuma(hue: number): number {
  const sat = 0.78;
  const light = 0.64;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return 0.299 * (r + m) + 0.587 * (g + m) + 0.114 * (b + m);
}

function ramp(hue: number): ArtTint {
  const h = hue.toFixed(0);
  const steps: Array<[number, number, number]> = [
    [1, 40, 10],
    [2, 38, 12],
    [3, 40, 16],
    [4, 42, 20],
    [5, 45, 24],
    [6, 48, 28],
    [7, 55, 36],
    [8, 62, 46],
    [9, 78, 64],
    [10, 80, 68],
    [11, 85, 72],
    [12, 75, 90],
  ];
  const vars: ArtTint = {};
  for (const [n, sat, light] of steps) {
    vars[`--glacier-accent-${n}`] = `hsl(${h} ${sat}% ${light}%)`;
  }
  vars['--glacier-accent-solid'] = `hsl(${h} 78% 64%)`;
  vars['--glacier-accent-text'] = `hsl(${h} 85% 72%)`;
  /* The ink ON the solid answers the solid's real brightness: light glyphs
     on the deep hues (the request that made them light), dark ink once the
     hue itself blazes - yellow, lime, cyan - where near-white ink washes
     out. The threshold sits just above orange (0.62), which was approved
     wearing light glyphs. */
  const ink = solidLuma(hue) > 0.65 ? `hsl(${h} 35% 12%)` : `hsl(${h} 45% 97%)`;
  vars['--glacier-accent-contrast'] = ink;
  vars['--glacier-on-accent'] = ink;
  vars['--glacier-accent-soft'] = `hsl(${h} 78% 64% / 0.2)`;
  vars['--glacier-accent-border'] = `hsl(${h} 60% 55% / 0.55)`;
  return vars;
}

/** The cover's ramp as React state: recomputed when the art changes, null
 * while disabled, absent, or unreadable. The Player feeds this the CURRENT
 * track's art, so the tint lives exactly as long as the song does. */
export function useArtTint(url: string | null, enabled: boolean): ArtTint | null {
  const [tint, setTint] = useState<ArtTint | null>(null);
  useEffect(() => {
    if (!url || !enabled) {
      setTint(null);
      return undefined;
    }
    let live = true;
    void artTint(url).then((t) => {
      if (live) setTint(t);
    });
    return () => {
      live = false;
    };
  }, [url, enabled]);
  return tint;
}

/** The cover's pastel, or null for "keep the kit accent". Cached per URL;
 * never throws - a cover that will not fetch or decode simply has no say. */
export async function artTint(url: string): Promise<ArtTint | null> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  let tint: ArtTint | null = null;
  try {
    tint = await readTint(url);
  } catch {
    tint = null;
  }
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, tint);
  return tint;
}
