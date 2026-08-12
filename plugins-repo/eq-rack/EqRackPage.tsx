import { useState, type CSSProperties } from 'react';
import { Button, IconButton, Input, Text } from '@glacier/react';
import { ArrowLeftRight, Check, Plus, SlidersHorizontal, Trash2 } from '@glacier/icons';
import { EQ_BANDS, EQ_PRESETS, useEqualizer } from '@attackfm/app/equalizer';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 14,
};

interface SavedPreset {
  id: string;
  name: string;
  gains: number[];
}

const KEY = 'attackfm-eq-rack';
const AB_KEY = 'attackfm-eq-rack-ab';

function readSaved(): SavedPreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? (parsed as SavedPreset[]).filter((p) => p && Array.isArray(p.gains))
      : [];
  } catch {
    return [];
  }
}

function writeSaved(presets: SavedPreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    // Session-only, then.
  }
}

function readAb(): { a: number[] | null; b: number[] | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem(AB_KEY) ?? 'null') as {
      a?: number[];
      b?: number[];
    } | null;
    return { a: parsed?.a ?? null, b: parsed?.b ?? null };
  } catch {
    return { a: null, b: null };
  }
}

const same = (x: readonly number[], y: readonly number[]) =>
  x.length === y.length && x.every((v, i) => Math.abs(v - (y[i] ?? 0)) < 0.01);

/** The tiny curve a preset row wears: one bar per band, zero at midline. */
function Curve({ gains }: { gains: readonly number[] }) {
  return (
    <span style={{ ...row(2), height: 26, alignItems: 'center' }} aria-hidden>
      {gains.map((g, i) => {
        const h = Math.min(12, Math.abs(g) * 1.6) + 2;
        return (
          <span
            key={i}
            style={{
              width: 4,
              height: h,
              borderRadius: 2,
              background: 'var(--glacier-accent-solid)',
              opacity: 0.4 + Math.min(0.6, Math.abs(g) / 8),
              transform: `translateY(${g >= 0 ? -h / 2 + 1 : h / 2 - 1}px)`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * The rack. Built-ins first, the user's shelf under them, the A/B pair at
 * the top. Everything applies through the host's setGains, so the Player's
 * own equalizer panel always agrees with what is heard.
 */
export function EqRackPage() {
  const { gains, setGains, setPreset } = useEqualizer();
  const [saved, setSaved] = useState<SavedPreset[]>(() => readSaved());
  const [ab, setAb] = useState(() => readAb());
  const [naming, setNaming] = useState<string | null>(null);

  const apply = (next: readonly number[], presetId?: string) => {
    setGains([...next]);
    setPreset(presetId);
  };

  const storeAb = (next: { a: number[] | null; b: number[] | null }) => {
    setAb(next);
    try {
      localStorage.setItem(AB_KEY, JSON.stringify(next));
    } catch {
      // Session-only.
    }
  };

  const slot = (which: 'a' | 'b') => {
    const held = ab[which];
    const active = held !== null && same(held, gains);
    return (
      <Button
        key={which}
        variant={active ? 'solid' : 'outline'}
        size="sm"
        onClick={() => {
          if (held === null || active) {
            storeAb({ ...ab, [which]: [...gains] });
          } else {
            apply(held);
          }
        }}
      >
        {which.toUpperCase()}
        {held === null ? ' · hold this' : active ? ' · held' : ''}
      </Button>
    );
  };

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 720, margin: '0 auto' }}>
      <div style={row(10)}>
        <SlidersHorizontal size={20} />
        <div style={{ ...stack(2), flex: 1 }}>
          <Text as="h1" size="lg" weight="bold">
            EQ rack
          </Text>
          <Text tone="muted" size="sm">
            The same equalizer the player runs - saved, named, and one tap away.
          </Text>
        </div>
      </div>

      <div style={{ ...panel, ...row(10) }}>
        <ArrowLeftRight size={16} />
        <Text size="sm" style={{ flex: 1 }}>
          A/B — hold a curve in each, flip to hear the difference
        </Text>
        {slot('a')}
        {slot('b')}
      </div>

      <div style={{ ...panel, ...stack(10) }}>
        <div style={row(10)}>
          <Text weight="semibold" style={{ flex: 1 }}>
            Now playing through
          </Text>
          <Curve gains={gains} />
          {naming === null ? (
            <Button variant="outline" size="sm" onClick={() => setNaming('')}>
              <Plus size={14} /> Save this curve
            </Button>
          ) : null}
        </div>
        {naming !== null && (
          <div style={row(8)}>
            <Input
              value={naming}
              placeholder="Name the curve"
              aria-label="Preset name"
              onChange={(e) => setNaming(e.currentTarget.value)}
            />
            <Button
              variant="solid"
              size="sm"
              disabled={naming.trim() === ''}
              onClick={() => {
                const next = [
                  ...saved,
                  { id: `eq-${Date.now().toString(36)}`, name: naming.trim(), gains: [...gains] },
                ];
                setSaved(next);
                writeSaved(next);
                setNaming(null);
              }}
            >
              <Check size={14} /> Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setNaming(null)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <Text tone="muted" size="sm">
        Built in
      </Text>
      {EQ_PRESETS.map((p) => (
        <div key={p.id} style={{ ...panel, ...row(12) }}>
          <div style={{ ...stack(2), flex: 1 }}>
            <Text weight="semibold">{p.label}</Text>
          </div>
          <Curve gains={p.gains} />
          <Button
            variant={same(p.gains, gains) ? 'solid' : 'outline'}
            size="sm"
            onClick={() => apply(p.gains, p.id)}
          >
            {same(p.gains, gains) ? 'On' : 'Apply'}
          </Button>
        </div>
      ))}

      {saved.length > 0 && (
        <Text tone="muted" size="sm">
          Yours
        </Text>
      )}
      {saved.map((p) => (
        <div key={p.id} style={{ ...panel, ...row(12) }}>
          <div style={{ ...stack(2), flex: 1, minWidth: 0 }}>
            <Text weight="semibold">{p.name}</Text>
          </div>
          <Curve gains={p.gains} />
          <Button
            variant={same(p.gains, gains) ? 'solid' : 'outline'}
            size="sm"
            onClick={() => apply(p.gains)}
          >
            {same(p.gains, gains) ? 'On' : 'Apply'}
          </Button>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={`Delete preset ${p.name}`}
            onClick={() => {
              const next = saved.filter((x) => x.id !== p.id);
              setSaved(next);
              writeSaved(next);
            }}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}

      <Text tone="subtle" size="xs">
        Bands: {EQ_BANDS.map((b) => b.label).join(' · ')}
      </Text>
    </div>
  );
}
