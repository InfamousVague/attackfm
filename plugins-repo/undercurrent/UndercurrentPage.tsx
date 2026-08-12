import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Slider, Switch, Text } from '@glacier/react';
import { CloudRain, Disc3, Flame, Wind } from '@glacier/icons';
import { LAYERS, applyMix, readMix, stopAll, writeMix, type LayerId, type Mix } from './engine.ts';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 14,
};

const FACE: Record<LayerId, { label: string; blurb: string; icon: ReactNode }> = {
  rain: { label: 'Rain', blurb: 'On a roof, steady', icon: <CloudRain size={18} /> },
  crackle: { label: 'Crackle', blurb: 'A record between songs', icon: <Disc3 size={18} /> },
  fire: { label: 'Fire', blurb: 'Low, with the odd snap', icon: <Flame size={18} /> },
  wind: { label: 'Wind', blurb: 'Leaning on the window', icon: <Wind size={18} /> },
};

/**
 * The mixer. State is the stored mix; every change converges the audio graph
 * through applyMix. The page unmounting changes nothing - the weather is a
 * module-level tenant, and this is just its thermostat.
 */
export function UndercurrentPage() {
  const [mix, setMix] = useState<Mix>(() => readMix());

  // Converge on mount too: a relaunch with saved layers-on starts silent (the
  // context needs a gesture), so the first toggle wakes everything saved.
  useEffect(() => {
    applyMix(mix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (next: Mix) => {
    setMix(next);
    writeMix(next);
    applyMix(next);
  };

  const anyOn = LAYERS.some((id) => mix[id].on);

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 680, margin: '0 auto' }}>
      <div style={row(10)}>
        <CloudRain size={20} />
        <div style={{ ...stack(2), flex: 1 }}>
          <Text as="h1" size="lg" weight="bold">
            Undercurrent
          </Text>
          <Text tone="muted" size="sm">
            Ambience under the music. Synthesized here, playing until you say stop.
          </Text>
        </div>
        {anyOn && (
          <Switch
            checked
            aria-label="Stop all layers"
            onCheckedChange={() => {
              stopAll();
              update({
                rain: { ...mix.rain, on: false },
                crackle: { ...mix.crackle, on: false },
                fire: { ...mix.fire, on: false },
                wind: { ...mix.wind, on: false },
              });
            }}
          />
        )}
      </div>

      {LAYERS.map((id) => {
        const layer = mix[id];
        const face = FACE[id];
        return (
          <div key={id} style={{ ...panel, ...row(14) }}>
            {face.icon}
            <div style={{ ...stack(2), width: 110 }}>
              <Text weight="semibold">{face.label}</Text>
              <Text tone="muted" size="xs">
                {face.blurb}
              </Text>
            </div>
            <div style={{ flex: 1 }}>
              <Slider
                aria-label={`${face.label} volume`}
                min={0}
                max={100}
                value={Math.round(layer.volume * 100)}
                onValueChange={(v) => update({ ...mix, [id]: { ...layer, volume: v / 100 } })}
                disabled={!layer.on}
              />
            </div>
            <Switch
              checked={layer.on}
              aria-label={`${face.label} on`}
              onCheckedChange={(on) => update({ ...mix, [id]: { ...layer, on } })}
            />
          </div>
        );
      })}

      <Text tone="subtle" size="xs">
        Nothing is recorded or fetched - each bed is shaped noise, computed when you switch it on.
      </Text>
    </div>
  );
}
