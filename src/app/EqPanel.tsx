import { AudioEqualizer, Button, MultiSelect, Select, Switch, Text } from '@glacier/react';
import {
  EQ_BANDS_NARROW,
  EQ_PRESETS,
  EQ_PRESETS_NARROW,
  expandNarrowGains,
  narrowEqGains,
  useEqualizer,
} from './equalizer.tsx';
import { EFFECTS, clearEffects, toggleEffect, useEffects } from './effects.ts';
import { usePlayback } from './playback.tsx';
import { useServerSession } from './serverSession.tsx';

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
  const playback = usePlayback();
  const rack = useEffects();
  const { session } = useServerSession();

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

      {/* ---- the rack ---------------------------------------------------
          Real effects, applied by the server as it encodes. The audio graph in
          the browser cannot host them - the kit's meter owns the one
          MediaElementSourceNode an element is permitted and exposes no
          insertion point - but the encoder already runs with a command line we
          control, so the filters live there. See effects.ts.

          A multi-select rather than a row of switches because thirteen
          switches is a wall, and because these are meant to STACK: the point
          is lofi in a room, slowed and driven, combinations nobody would have
          shipped as presets. The chosen ones stay visible as tags, which is
          the part a dropdown alone would lose. */}
      <div className="eqPanel__rack">
        <div className="eqPanel__rackHead">
          <Text size="sm" weight="medium">
            Effects
          </Text>
          {rack.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearEffects}>
              Clear
            </Button>
          )}
        </div>
        <MultiSelect
          aria-label="Audio effects"
          fullWidth
          placeholder={rack.length > 0 ? 'Add another…' : 'Lofi, low-pass, attack pedal…'}
          value={[...rack]}
          // Given the whole next set, not one change - so the store is told
          // what was ADDED or REMOVED and can enforce its own exclusions
          // (slowed and sped-up cannot both be true).
          onValueChange={(next) => {
            for (const e of EFFECTS) {
              const want = next.includes(e.id);
              if (want !== rack.includes(e.id)) toggleEffect(e.id, want);
            }
          }}
          options={EFFECTS.map((e) => ({
            value: e.id,
            label: e.label,
            description: e.blurb,
          }))}
        />
        {/* Said once, plainly, and only when it applies: without a server
            there is no encoder, and so nothing to apply an effect. Better here
            than as a switch that silently does nothing. */}
        {!session && (
          <Text size="xs" tone="muted">
            Effects are applied by your server, so they need one connected.
          </Text>
        )}
        {session && rack.length > 0 && (
          <Text size="xs" tone="muted">
            Songs are re-encoded as they play, so seeking takes a moment longer.
          </Text>
        )}
      </div>

      {/* The two the audio graph itself has. They were only ever reachable in
          Settings, under names ("Night mode", "Mono") that do not read as
          effects - so nobody looking for effects found them. Same switches,
          same state, put where you would look. */}
      <div className="eqPanel__fx">
        <Switch
          label="Even out loud and quiet"
          checked={playback.nightMode}
          onCheckedChange={(on) => playback.update({ nightMode: on })}
        />
        <Switch
          label="Mono"
          checked={playback.mono}
          onCheckedChange={(on) => playback.update({ mono: on })}
        />
      </div>
    </div>
  );
}
