import type { CSSProperties } from 'react';
import { Text } from '@glacier/react';
import { AudioWaveform } from '@glacier/icons';
import { STEM_HUES, STEM_LABELS, STEM_ORDER } from './engine.ts';
import { STEM_ICONS } from './padStyles.ts';
import type { Preparing } from './openSong.ts';

/**
 * The wait, made legible.
 *
 * Separating a song is minutes of GPU, and this used to be a spinner - which
 * for a wait that long is indistinguishable from a hang, so people press the
 * button again, or leave. There is a real number available (demucs prints its
 * own percentage, and the server passes it on), and where there is not, there
 * is at least a phase worth naming.
 *
 * The six parts are drawn from the start, dim, and light up as they are
 * written. That is the last minute of the job made visible, and it is also the
 * screen you are about to be using - so arriving at the board is a change of
 * state rather than a change of scene.
 */

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const rail: CSSProperties = {
  position: 'relative',
  height: 6,
  borderRadius: 3,
  background: 'var(--glacier-border)',
  overflow: 'hidden',
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 8,
};

/** mm:ss, so a long wait reads as a duration rather than a big number. */
function elapsed(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * What is happening, in the fewest words that are still true.
 *
 * Every phase that can last carries the elapsed time, because a percentage is
 * not always available - an older server sends none at all - and a screen with
 * nothing moving on it is how a separation that is working came to look like
 * one that had died.
 */
function words(p: Preparing): string {
  switch (p.phase) {
    case 'asking':
      return 'Asking your server';
    case 'queued':
      // One worker, one song at a time - so the honest answer to "why is
      // nothing happening" is usually "because something else is".
      if (p.ahead && p.ahead > 0) {
        return `${p.ahead} song${p.ahead === 1 ? '' : 's'} ahead of this one · ${elapsed(p.seconds)}`;
      }
      return `Waiting for the separator · ${elapsed(p.seconds)}`;
    case 'separating':
      return p.fraction === null
        ? `Taking the song apart · ${elapsed(p.seconds)}`
        : `Taking the song apart · ${Math.round(p.fraction * 100)}% · ${elapsed(p.seconds)}`;
    case 'packing':
      return `Writing the parts · ${p.filed} of ${p.parts}`;
    case 'loading':
      return 'Cueing it up';
  }
}

export function PreparingView({ progress, compact = false }: { progress: Preparing; compact?: boolean }) {
  // Unknown is drawn as a sweep rather than a bar at zero: a determinate bar
  // that is not determinate is a worse lie than an honest indeterminate one.
  const known = progress.fraction !== null;
  const pct = known ? Math.round((progress.fraction ?? 0) * 100) : 0;

  return (
    <div style={wrap}>
      <div style={rail}>
        <span
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: known ? `${pct}%` : '35%',
            // Only meaningful while the sweep runs; a determinate bar has no
            // business being nudged around by an animation.
            background: 'var(--glacier-accent-solid)',
            borderRadius: 3,
            transition: known ? 'width 400ms linear' : 'none',
            animation: known ? undefined : 'afmPadsSweep 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <Text size="xs" tone="muted">
        {words(progress)} · this happens once per song
      </Text>

      <div style={grid} aria-hidden>
        {STEM_ORDER.map((stem, i) => {
          const Icon = STEM_ICONS[stem] ?? AudioWaveform;
          const done = i < progress.filed;
          const hue = STEM_HUES[stem] ?? 200;
          return (
            <div
              key={stem}
              style={{
                borderRadius: 12,
                border: '1px solid var(--glacier-border)',
                background: done
                  ? `linear-gradient(155deg, hsl(${hue} 45% 32%), hsl(${hue} 40% 20%))`
                  : 'var(--glacier-surface)',
                color: done ? '#fff' : 'var(--glacier-text-subtle)',
                opacity: done ? 1 : 0.45,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 4,
                padding: compact ? 10 : 12,
                minHeight: compact ? 62 : 78,
                transition: 'background 260ms ease, opacity 260ms ease, color 260ms ease',
              }}
            >
              <Icon size={compact ? 16 : 20} />
              <Text size="xs" weight="bold" style={{ lineHeight: 1.1 }}>
                {STEM_LABELS[stem] ?? stem}
              </Text>
            </div>
          );
        })}
      </div>

      <style>{`@keyframes afmPadsSweep{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}`}</style>
    </div>
  );
}
