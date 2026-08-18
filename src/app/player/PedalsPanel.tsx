import { Slider, Switch, Text } from '@glacier/react';
import {
  FX_NODES,
  setFxChain,
  setFxChainOn,
  useFxChain,
  type FxNode,
} from './fxChain.ts';

/**
 * The pedalboard, simplified, for the Now Playing screen.
 *
 * This is a PLAYING surface, not an editing one. Adding, removing and
 * reordering pedals stays on the Pedals page, where there is room to think;
 * what belongs over the artwork is the two things you reach for mid-song:
 * whether a pedal is in, and its one headline knob.
 *
 * It lives in the core player rather than in the plugin for the same reason
 * the HiFi chain row does: the chain colours the stream whether or not the
 * plugin that built it is still installed, and a switch you cannot see is a
 * switch you cannot turn off. The pedal vocabulary is core (fxChain), so this
 * renders correctly even on a device that never installed the plugin.
 */

/** Every pedal's first parameter is its headline knob, by construction of the
 *  catalogue: drive before tone, rate before depth, time before mix. */
function headlineParam(t: string) {
  return FX_NODES.find((s) => s.t === t)?.params[0];
}

function label(t: string): string {
  return FX_NODES.find((s) => s.t === t)?.label ?? t;
}

export function PedalsPanel() {
  const chain = useFxChain();

  // Only pedals: a rack EQ band has no business on this panel, and the HiFi
  // chain row beside it already speaks for the rack.
  const pedals = chain.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => FX_NODES.find((s) => s.t === node.t)?.group === 'pedal');

  const live = pedals.filter(({ node }) => node.on).length;

  const write = (nodes: FxNode[]) => setFxChain(nodes, chain.on || nodes.some((n) => n.on));

  const toggle = (key: string, on: boolean) =>
    write(chain.nodes.map((n) => (n.key === key ? { ...n, on } : n)));

  const patch = (key: string, paramKey: string, value: number) =>
    write(
      chain.nodes.map((n) =>
        n.key === key ? { ...n, params: { ...n.params, [paramKey]: value } } : n,
      ),
    );

  return (
    <div className="pedalsPanel">
      <div className="pedalsPanel__head">
        <Text weight="bold" size="sm">
          Pedals
        </Text>
        <Text tone="muted" size="xs">
          {pedals.length === 0
            ? 'board empty'
            : chain.on && live > 0
              ? `${live} of ${pedals.length} in`
              : 'off'}
        </Text>
        <Switch
          aria-label="Pedalboard on"
          checked={chain.on && live > 0}
          onCheckedChange={(v: boolean) => setFxChainOn(v)}
        />
      </div>

      {pedals.length === 0 ? (
        <Text tone="muted" size="xs">
          Nothing on the board yet. Build one on the Pedals page.
        </Text>
      ) : (
        <ul className="pedalsPanel__list">
          {pedals.map(({ node }) => {
            const knob = headlineParam(node.t);
            const value = knob ? (node.params[knob.key] ?? knob.default) : 0;
            return (
              <li key={node.key} className="pedalsPanel__row">
                <Switch
                  aria-label={`${label(node.t)} on`}
                  checked={node.on}
                  onCheckedChange={(v: boolean) => toggle(node.key, v)}
                />
                <span className="pedalsPanel__name">{label(node.t)}</span>
                {knob ? (
                  <>
                    <Slider
                      aria-label={`${label(node.t)} ${knob.label}`}
                      min={knob.min}
                      max={knob.max}
                      step={knob.step}
                      value={value}
                      // A bypassed pedal's knob does nothing audible, so it
                      // reads as disabled rather than pretending otherwise.
                      disabled={!node.on}
                      onValueChange={(v: number) => patch(node.key, knob.key, v)}
                    />
                    <span className="pedalsPanel__value">
                      {value.toFixed(knob.step < 1 ? 1 : 0)}
                      {knob.unit ? ` ${knob.unit}` : ''}
                    </span>
                  </>
                ) : (
                  // A pedal with no knobs at all (Mono, Headphones) still gets
                  // its switch; the grid keeps its columns so rows stay aligned.
                  <>
                    <span className="pedalsPanel__noKnob" aria-hidden="true" />
                    <span className="pedalsPanel__value" />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
