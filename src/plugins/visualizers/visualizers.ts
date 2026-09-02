/**
 * Thirteen ways to draw the sound - vector scopes, particles, fractals and
 * attractors, all in plain Canvas 2D.
 *
 * NO LIBRARY, on purpose: the app ships as one self-contained OTA bundle
 * (app.js + app.css and nothing else may be emitted, see scripts/ship-update),
 * and a visualizer engine is a few hundred kilobytes that would mostly go
 * unused. Every algorithm here is a classic - the demoscene plasma, the
 * escape-time Julia set, the Lorenz butterfly, the Lissajous figure, the
 * Winamp-era starfield - written small.
 *
 * Each visualizer is a `VizDef`: static identity (id, name, note - for the
 * picker grid and the tap-to-cycle label) plus `create()`, which builds the
 * per-instance state and returns a draw closure. The frame handed to it every
 * tick carries everything: the canvas, the clock, the smoothed spectrum and
 * loudness, a beat pulse, and the app's accent hue with a colour helper - so a
 * visualizer never touches the DOM, the audio graph, or the theme itself.
 *
 * Colour comes from the app's dynamic accent (the album-art tint, see
 * player/artTint.ts): every visualizer paints in the accent hue and its
 * neighbours, so the picture changes key with the record.
 */

export interface VizFrame {
  ctx: CanvasRenderingContext2D;
  /** Canvas pixel size (already scaled by devicePixelRatio). */
  w: number;
  h: number;
  /** Seconds since this visualizer was mounted, and since the last frame. */
  t: number;
  dt: number;
  /** Loudness 0..1, smoothed - rises fast, falls slow. */
  level: number;
  /** Log-spaced spectrum bands 0..1, low to high, smoothed the same way. */
  bands: number[];
  /** Band groups, each 0..1. */
  bass: number;
  mid: number;
  treble: number;
  /** A pulse: jumps to 1 on an onset (a level spike over its running average),
   *  then decays. What "on the beat" means to everything below. */
  beat: number;
  /** The accent hue, degrees. */
  hue: number;
  /** hsla() in the accent family: alpha, lightness %, and a hue shift in
   *  degrees off the accent. */
  color: (alpha?: number, light?: number, shift?: number) => string;
}

export interface VizDef {
  id: string;
  name: string;
  /** One line for the picker. */
  note: string;
  /** Builds fresh state and returns the per-frame draw. */
  create: () => (f: VizFrame) => void;
}

const TAU = Math.PI * 2;

/** HSL to 0..255 RGB, for the visualizers that write pixels directly. */
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A cheap smooth pseudo-noise in 0..1 - a sum of sines, enough for a field
 *  that drifts rather than jitters, without shipping a Perlin table. */
function noise2(x: number, y: number, t: number): number {
  return (
    (Math.sin(x * 1.7 + t) +
      Math.sin(y * 2.3 - t * 0.8) +
      Math.sin((x + y) * 1.1 + t * 0.5) +
      Math.sin(Math.hypot(x, y) * 2.1 - t)) *
      0.125 +
    0.5
  );
}

/** The hue of a CSS colour string - hsl(), rgb(), #hex - or null. */
function hueOf(css: string): number | null {
  const s = css.trim();
  const hsl = /hsla?\(\s*([\d.]+)/.exec(s);
  if (hsl) return parseFloat(hsl[1] ?? '0');
  let r = -1;
  let g = -1;
  let b = -1;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const v = hex[1] ?? '';
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
    if (!rgb) return null;
    r = parseFloat(rgb[1] ?? '0');
    g = parseFloat(rgb[2] ?? '0');
    b = parseFloat(rgb[3] ?? '0');
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/** The app's accent hue right now, read off the dynamic accent token. The
 *  brand pink when the token cannot be read (a server render, a test). */
export function accentHue(): number {
  try {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--glacier-accent-solid');
    return hueOf(css) ?? 330;
  } catch {
    return 330;
  }
}

/** The frame's colour helper for one hue. */
export function makeColor(hue: number): VizFrame['color'] {
  return (alpha = 1, light = 60, shift = 0) =>
    `hsla(${(((hue + shift) % 360) + 360) % 360}, 85%, ${light}%, ${alpha})`;
}

/** Wipe with a translucent floor - what leaves trails behind moving light. */
function fade(f: VizFrame, alpha: number): void {
  f.ctx.fillStyle = `rgba(6, 6, 8, ${alpha})`;
  f.ctx.fillRect(0, 0, f.w, f.h);
}

// ---------------------------------------------------------------------------

/** Spectrum bars radiating from a ring that breathes with the bass, mirrored
 *  so the shape reads as a halo rather than a bar chart bent round. */
const halo: VizDef = {
  id: 'halo',
  name: 'Halo',
  note: 'Spectrum bars around a breathing ring.',
  create: () => {
    let rot = 0;
    return (f) => {
      const { ctx, w, h, bands } = f;
      const n = bands.length;
      const S = Math.min(w, h);
      rot += f.dt * (0.15 + f.level * 0.6);
      const R = S * (0.2 + f.bass * 0.05);
      fade(f, 0.28);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rot);
      ctx.lineCap = 'round';
      const total = n * 2;
      ctx.lineWidth = Math.max(2, ((TAU * R) / total) * 0.55);
      for (let i = 0; i < total; i += 1) {
        const b = bands[i < n ? i : total - 1 - i] ?? 0;
        const a = (i / total) * TAU;
        const len = R * 0.12 + b * S * 0.27;
        ctx.strokeStyle = f.color(0.92, 52 + b * 22, (i / total) * 70 - 35);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.lineTo(Math.cos(a) * (R + len), Math.sin(a) * (R + len));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.9, 0, TAU);
      ctx.strokeStyle = f.color(0.35 + f.beat * 0.55, 72);
      ctx.lineWidth = 2 + f.beat * 6;
      ctx.stroke();
      ctx.restore();
    };
  },
};

/** A vector oscilloscope, bent into a ring. The graph hands out spectrum, not
 *  a waveform, so the trace is synthesised: one sine per band at its own
 *  harmonic, weighted by that band's energy - a wave that has the song's
 *  shape without being its samples. */
const scope: VizDef = {
  id: 'scope',
  name: 'Scope',
  note: 'A vector oscilloscope ring, drawn from the spectrum.',
  create: () => {
    let phase = 0;
    return (f) => {
      const { ctx, w, h, bands } = f;
      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.29;
      phase += f.dt * (2 + f.level * 6);
      fade(f, 0.22);
      const N = 360;
      const used = Math.max(1, Math.floor(bands.length / 3));
      ctx.beginPath();
      for (let i = 0; i <= N; i += 1) {
        const th = (i / N) * TAU;
        let v = 0;
        for (let k = 0; k < bands.length; k += 3) {
          v += (bands[k] ?? 0) * Math.sin(th * (k / 3 + 2) + phase * (1 + k * 0.05));
        }
        v /= used;
        const r = base * (1 + v * 0.55 + f.bass * 0.15);
        const x = cx + Math.cos(th) * r;
        const y = cy + Math.sin(th) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = f.color(0.95, 66);
      ctx.lineWidth = 2.2;
      ctx.shadowColor = f.color(0.9, 60);
      ctx.shadowBlur = 14 + f.beat * 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
  },
};

/** The X-Y figure of two sines, the frequency ratio picked by the bands - the
 *  shape an oscilloscope in X-Y mode draws from a stereo signal. */
const lissajous: VizDef = {
  id: 'lissajous',
  name: 'Lissajous',
  note: 'X-Y curves whose ratio the bands bend.',
  create: () => {
    let t = 0;
    return (f) => {
      const { ctx, w, h } = f;
      const cx = w / 2;
      const cy = h / 2;
      const A = Math.min(w, h) * 0.36;
      t += f.dt * (0.6 + f.level * 1.5);
      fade(f, 0.18);
      const a = 2 + Math.round(f.bass * 3);
      const b = 3 + Math.round(f.treble * 4);
      const d = t * 0.7;
      ctx.beginPath();
      const N = 700;
      for (let i = 0; i <= N; i += 1) {
        const s = (i / N) * TAU;
        const x = cx + A * Math.sin(a * s + d) * (1 + f.mid * 0.15);
        const y = cy + A * Math.sin(b * s);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = f.color(0.9, 62, (t * 20) % 60);
      ctx.lineWidth = 1.6 + f.beat * 2;
      ctx.shadowColor = f.color(0.8);
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
  },
};

/** Particles burst from the centre on the beat and drift out in additive glow. */
const nebula: VizDef = {
  id: 'nebula',
  name: 'Nebula',
  note: 'Particles burst on the beat and drift in the glow.',
  create: () => {
    interface P {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      max: number;
      hs: number;
      size: number;
    }
    const ps: P[] = [];
    let acc = 0;
    return (f) => {
      const { ctx, w, h } = f;
      const cx = w / 2;
      const cy = h / 2;
      const S = Math.min(w, h);
      fade(f, 0.16);
      acc += f.dt * (20 + f.level * 160) + f.beat * 40 * f.dt * 60;
      while (acc > 1 && ps.length < 420) {
        acc -= 1;
        const ang = Math.random() * TAU;
        const sp = S * (0.05 + Math.random() * 0.25) * (0.5 + f.level + f.beat);
        ps.push({
          x: cx,
          y: cy,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0,
          max: 1.2 + Math.random() * 1.8,
          hs: (Math.random() - 0.5) * 70,
          size: 1 + Math.random() * 2.5,
        });
      }
      ctx.globalCompositeOperation = 'lighter';
      for (let i = ps.length - 1; i >= 0; i -= 1) {
        const p = ps[i];
        if (!p) continue;
        p.life += f.dt;
        if (p.life > p.max) {
          ps.splice(i, 1);
          continue;
        }
        p.x += p.vx * f.dt;
        p.y += p.vy * f.dt;
        p.vx *= 0.985;
        p.vy *= 0.985;
        const k = 1 - p.life / p.max;
        ctx.fillStyle = f.color(k * 0.8, 60 + k * 15, p.hs);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + f.bass) * (0.4 + k), 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  },
};

/** The escape-time Julia set, drawn small and scaled up. Its seed `c` walks a
 *  circle whose radius the bass sets and whose angle the loudness spins, so the
 *  fractal folds and unfolds with the song. */
const julia: VizDef = {
  id: 'julia',
  name: 'Julia',
  note: 'A Julia set whose seed orbits with the music.',
  create: () => {
    const R = 96;
    let off: HTMLCanvasElement | null = null;
    let img: ImageData | null = null;
    let ang = 0;
    return (f) => {
      const { ctx, w, h } = f;
      if (!off || !img) {
        off = document.createElement('canvas');
        off.width = R;
        off.height = R;
        const oc = off.getContext('2d');
        if (!oc) return;
        img = oc.createImageData(R, R);
      }
      const oc = off.getContext('2d');
      if (!oc) return;
      ang += f.dt * (0.25 + f.level * 0.9);
      const rad = 0.7 + f.bass * 0.14;
      const cr = rad * Math.cos(ang);
      const ci = rad * Math.sin(ang * 0.7);
      const data = img.data;
      const maxIt = 26 + Math.round(f.treble * 22);
      for (let y = 0; y < R; y += 1) {
        for (let x = 0; x < R; x += 1) {
          let zr = (x / R - 0.5) * 3;
          let zi = (y / R - 0.5) * 3;
          let it = 0;
          while (it < maxIt && zr * zr + zi * zi < 4) {
            const nr = zr * zr - zi * zi + cr;
            zi = 2 * zr * zi + ci;
            zr = nr;
            it += 1;
          }
          const p = (y * R + x) * 4;
          if (it >= maxIt) {
            data[p] = 6;
            data[p + 1] = 6;
            data[p + 2] = 8;
          } else {
            const k = it / maxIt;
            const [r, g, b] = hsl2rgb(f.hue + k * 120, 0.85, 0.22 + k * 0.5);
            data[p] = r;
            data[p + 1] = g;
            data[p + 2] = b;
          }
          data[p + 3] = 255;
        }
      }
      oc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w, h);
    };
  },
};

/** The demoscene plasma: four sines summed over the plane, the bass zooming
 *  it and the treble pushing its colour round the wheel. */
const plasma: VizDef = {
  id: 'plasma',
  name: 'Plasma',
  note: 'The old demoscene plasma, breathing with the bass.',
  create: () => {
    const R = 80;
    let off: HTMLCanvasElement | null = null;
    let img: ImageData | null = null;
    return (f) => {
      const { ctx, w, h } = f;
      if (!off || !img) {
        off = document.createElement('canvas');
        off.width = R;
        off.height = R;
        const oc = off.getContext('2d');
        if (!oc) return;
        img = oc.createImageData(R, R);
      }
      const oc = off.getContext('2d');
      if (!oc) return;
      const t = f.t * (0.8 + f.level * 1.5);
      const d = img.data;
      const z = 1 + f.bass * 0.8;
      for (let y = 0; y < R; y += 1) {
        for (let x = 0; x < R; x += 1) {
          const X = (x / R) * 8 * z;
          const Y = (y / R) * 8 * z;
          const v =
            Math.sin(X + t) +
            Math.sin((Y + t) * 0.8) +
            Math.sin((X + Y + t * 0.7) * 0.5) +
            Math.sin(Math.sqrt(X * X + Y * Y) * 1.2 - t * 1.3);
          const k = (v + 4) / 8;
          const [r, g, b] = hsl2rgb(f.hue + k * 90 + f.treble * 40, 0.85, 0.28 + k * 0.42);
          const p = (y * R + x) * 4;
          d[p] = r;
          d[p + 1] = g;
          d[p + 2] = b;
          d[p + 3] = 255;
        }
      }
      oc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w, h);
    };
  },
};

/** Streamlines through a drifting noise field; the loudness sets the wind. */
const flow: VizDef = {
  id: 'flow',
  name: 'Flow',
  note: 'Streamlines through a drifting noise field.',
  create: () => {
    interface P {
      x: number;
      y: number;
      hs: number;
    }
    const ps: P[] = [];
    let seeded = false;
    return (f) => {
      const { ctx, w, h } = f;
      if (!seeded) {
        for (let i = 0; i < 260; i += 1) {
          ps.push({ x: Math.random() * w, y: Math.random() * h, hs: (Math.random() - 0.5) * 80 });
        }
        seeded = true;
      }
      fade(f, 0.07);
      const S = Math.min(w, h);
      const sp = S * (0.15 + f.level * 1.2) * f.dt;
      const t = f.t * 0.35;
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.4 + f.beat * 1.5;
      for (const p of ps) {
        const a = noise2((p.x / w) * 3, (p.y / h) * 3, t) * TAU * 2 + f.bass * 2;
        const nx = p.x + Math.cos(a) * sp;
        const ny = p.y + Math.sin(a) * sp;
        ctx.strokeStyle = f.color(0.55, 60, p.hs);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        p.x = nx;
        p.y = ny;
        if (p.x < 0 || p.x > w || p.y < 0 || p.y > h || Math.random() < 0.004) {
          p.x = Math.random() * w;
          p.y = Math.random() * h;
        }
      }
    };
  },
};

/** One wedge of spectrum, mirrored eight ways round the centre. */
const kaleido: VizDef = {
  id: 'kaleido',
  name: 'Kaleido',
  note: 'One spectrum wedge, mirrored eight ways.',
  create: () => {
    let rot = 0;
    return (f) => {
      const { ctx, w, h, bands } = f;
      const S = Math.min(w, h);
      const seg = 8;
      rot += f.dt * (0.2 + f.level * 0.8);
      fade(f, 0.25);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.lineWidth = 2 + f.beat * 2;
      ctx.lineJoin = 'round';
      for (let s = 0; s < seg; s += 1) {
        ctx.save();
        ctx.rotate((s / seg) * TAU + rot);
        if (s % 2) ctx.scale(1, -1);
        ctx.beginPath();
        for (let i = 0; i < bands.length; i += 1) {
          const r = S * 0.08 + (i / bands.length) * S * 0.42;
          const a = (bands[i] ?? 0) * 0.9 * (TAU / seg) * 0.5;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = f.color(0.85, 60, s * 12);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    };
  },
};

/** The starfield warp: stars fly out from the centre, the bass and the beat
 *  on the throttle, each one a streak as long as it is fast. */
const warp: VizDef = {
  id: 'warp',
  name: 'Warp',
  note: 'A starfield that throws itself at you on the beat.',
  create: () => {
    interface Star {
      x: number;
      y: number;
      z: number;
      hs: number;
    }
    const stars: Star[] = [];
    for (let i = 0; i < 220; i += 1) {
      stars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random(), hs: (Math.random() - 0.5) * 50 });
    }
    return (f) => {
      const { ctx, w, h } = f;
      const cx = w / 2;
      const cy = h / 2;
      const S = Math.min(w, h);
      fade(f, 0.3);
      const speed = (0.25 + f.bass * 1.2 + f.beat * 1.5) * f.dt;
      ctx.lineCap = 'round';
      for (const s of stars) {
        const pz = s.z;
        s.z -= speed;
        if (s.z <= 0.02) {
          s.x = Math.random() * 2 - 1;
          s.y = Math.random() * 2 - 1;
          s.z = 1;
          continue;
        }
        const k = 0.5 / s.z;
        const pk = 0.5 / pz;
        // A floor on the alpha so the far field reads as a starfield, not a
        // void - only the streaks close in were showing at all.
        ctx.strokeStyle = f.color(Math.min(1, 0.25 + (1 - s.z) * 1.1), 72, s.hs);
        ctx.lineWidth = (1 - s.z) * 3 + 0.7;
        ctx.beginPath();
        ctx.moveTo(cx + s.x * S * pk, cy + s.y * S * pk);
        ctx.lineTo(cx + s.x * S * k, cy + s.y * S * k);
        ctx.stroke();
      }
    };
  },
};

/** Three logarithmic spiral arms, each dot lit by its band. */
const galaxy: VizDef = {
  id: 'galaxy',
  name: 'Galaxy',
  note: 'Spiral arms, lit band by band.',
  create: () => {
    let rot = 0;
    return (f) => {
      const { ctx, w, h, bands } = f;
      const cx = w / 2;
      const cy = h / 2;
      const S = Math.min(w, h);
      const arms = 3;
      rot += f.dt * (0.12 + f.level * 0.35);
      fade(f, 0.2);
      ctx.globalCompositeOperation = 'lighter';
      for (let a = 0; a < arms; a += 1) {
        const off = (a / arms) * TAU + rot;
        for (let i = 0; i < 140; i += 1) {
          const th = i * 0.09;
          const r = S * 0.03 * Math.exp(0.22 * th);
          if (r > S * 0.5) break;
          const b = bands[Math.floor((i / 140) * bands.length)] ?? 0;
          ctx.fillStyle = f.color(0.15 + b * 0.8, 55 + b * 20, a * 25 + (i / 140) * 40);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(th + off) * r, cy + Math.sin(th + off) * r, 1.2 + b * 4 + f.beat * 1.5, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  },
};

/** The Lorenz attractor - the butterfly - integrated live, its rho stirred by
 *  the bass so the wings widen on a drop, projected and slowly turned. */
const lorenz: VizDef = {
  id: 'lorenz',
  name: 'Lorenz',
  note: 'The butterfly attractor, stirred by the music.',
  create: () => {
    let x = 0.1;
    let y = 0;
    let z = 0;
    let rot = 0;
    const pts: { x: number; y: number; z: number }[] = [];
    return (f) => {
      const { ctx, w, h } = f;
      const cx = w / 2;
      const cy = h / 2;
      const S = Math.min(w, h);
      const sig = 10;
      const rho = 28 + f.bass * 12;
      const beta = 8 / 3;
      const steps = 6 + Math.round(f.level * 10);
      const hdt = 0.008;
      for (let i = 0; i < steps; i += 1) {
        const dx = sig * (y - x);
        const dy = x * (rho - z) - y;
        const dz = x * y - beta * z;
        x += dx * hdt;
        y += dy * hdt;
        z += dz * hdt;
        pts.push({ x, y, z });
        if (pts.length > 900) pts.shift();
      }
      rot += f.dt * 0.3;
      fade(f, 0.12);
      const sc = S / 70;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      ctx.beginPath();
      let first = true;
      for (const p of pts) {
        const X = p.x * cr - p.y * sr;
        const sx = cx + X * sc;
        const sy = cy - (p.z - 27) * sc;
        if (first) {
          ctx.moveTo(sx, sy);
          first = false;
        } else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = f.color(0.85, 62, (f.t * 15) % 50);
      ctx.lineWidth = 1.4 + f.beat * 1.5;
      ctx.stroke();
    };
  },
};

/** Rings dropped on every beat, crossing as they grow. */
const ripples: VizDef = {
  id: 'ripples',
  name: 'Ripples',
  note: 'Rings dropped on every beat, crossing as they grow.',
  create: () => {
    interface Ring {
      x: number;
      y: number;
      r: number;
      hs: number;
      a: number;
    }
    const rings: Ring[] = [];
    let cool = 0;
    return (f) => {
      const { ctx, w, h } = f;
      const cx = w / 2;
      const cy = h / 2;
      const S = Math.min(w, h);
      cool -= f.dt;
      if (f.beat > 0.6 && cool <= 0) {
        cool = 0.12;
        const jit = S * 0.18;
        rings.push({
          x: cx + (Math.random() - 0.5) * jit,
          y: cy + (Math.random() - 0.5) * jit,
          r: 2,
          hs: (Math.random() - 0.5) * 60,
          a: 1,
        });
      }
      // A quiet passage still drops the odd ring, so the square never goes dead.
      if (rings.length === 0 && Math.random() < f.dt * 1.5) rings.push({ x: cx, y: cy, r: 2, hs: 0, a: 0.6 });
      fade(f, 0.2);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = rings.length - 1; i >= 0; i -= 1) {
        const q = rings[i];
        if (!q) continue;
        q.r += S * (0.25 + f.level * 0.5) * f.dt;
        q.a -= f.dt * 0.55;
        if (q.a <= 0 || q.r > S) {
          rings.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = f.color(q.a * 0.9, 60, q.hs);
        ctx.lineWidth = 2 + (1 - q.a) * 4;
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.r, 0, TAU);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  },
};

/** A rose curve, r = cos(k*theta): the treble picks the petal count, the bass
 *  opens the bloom. */
const rose: VizDef = {
  id: 'rose',
  name: 'Rose',
  note: 'A rose curve whose petals follow the treble.',
  create: () => {
    let rot = 0;
    return (f) => {
      const { ctx, w, h } = f;
      const A = Math.min(w, h) * 0.4;
      rot += f.dt * (0.3 + f.level * 0.9);
      fade(f, 0.15);
      const k = 3 + Math.round(f.treble * 4) + (f.bass > 0.5 ? 1 : 0);
      const N = 800;
      const turns = k % 2 === 0 ? 2 : 1;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rot);
      ctx.beginPath();
      for (let i = 0; i <= N; i += 1) {
        const th = (i / N) * TAU * turns;
        const r = A * Math.cos(k * th) * (0.85 + f.bass * 0.3);
        const x = Math.cos(th) * r;
        const y = Math.sin(th) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = f.color(0.9, 64, (f.t * 25) % 60);
      ctx.lineWidth = 1.8 + f.beat * 2;
      ctx.shadowColor = f.color(0.8);
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    };
  },
};

/** Every visualizer, in the order the tap cycles them and the picker lists
 *  them. Adding one is adding a line. */
export const VISUALIZERS: readonly VizDef[] = [
  halo,
  scope,
  lissajous,
  nebula,
  julia,
  plasma,
  flow,
  kaleido,
  warp,
  galaxy,
  lorenz,
  ripples,
  rose,
];
