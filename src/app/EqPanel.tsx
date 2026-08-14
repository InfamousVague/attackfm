import { AudioEqualizer, Select } from '@glacier/react';
import {
  EQ_BANDS_NARROW,
  EQ_PRESETS,
  EQ_PRESETS_NARROW,
  expandNarrowGains,
  narrowEqGains,
  useEqualizer,
} from './equalizer.tsx';

/**
 * The equalizer as it is shown everywhere: a preset dropdown over the sliders.
 *
 * The presets used to ride the kit's own row above the bands, which works for
 * the four it shipped with and falls apart at eighteen - a wrapping field of
 * chips that pushes the sliders off a phone screen. A list that long is what a
 * select is FOR: one line, the current choice always readable, and the whole
 * catalogue one tap away without the panel changing size.
 *
 * `hidePresets` on the kit component is what makes that safe: the sliders keep
 * their preset-aware behaviour (picking one fills them in), the row is simply
 * not drawn twice.
 *
 * One component for all three places the equalizer appears - the Now Playing
 * sheet, the desktop strip's popover and the EQ-rack plugin - so a preset added
 * to the list shows up in each without being wired three times.
 */
export function EqPanel({ narrow = false }: { narrow?: boolean }) {
  const { gains, setGains, preset, setPreset } = useEqualizer();

  /** Picking a preset draws its whole curve, hidden bands included. */
  const choose = (id: string) => {
    setPreset(id);
    const found = EQ_PRESETS.find((p) => p.id === id);
    if (found) setGains([...found.gains]);
  };

  return (
    <div className="eqPanel">
      <Select
        aria-label="Equalizer preset"
        fullWidth
        // A hand-moved curve matches no preset, and the field says so rather
        // than keeping the last name and quietly lying about what you hear.
        value={preset ?? 'custom'}
        onValueChange={choose}
        options={[
          ...(preset ? [] : [{ value: 'custom', label: 'Custom' }]),
          ...EQ_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        ]}
      />
      {narrow ? (
        <AudioEqualizer
          size="sm"
          hidePresets
          bands={EQ_BANDS_NARROW}
          presets={EQ_PRESETS_NARROW}
          value={narrowEqGains(gains)}
          onValueChange={(g) => setGains(expandNarrowGains(g, gains))}
          preset={preset}
          onPresetChange={(id) => id && choose(id)}
        />
      ) : (
        <AudioEqualizer
          hidePresets
          value={gains}
          onValueChange={setGains}
          preset={preset}
          onPresetChange={(id) => id && choose(id)}
        />
      )}

    </div>
  );
}
