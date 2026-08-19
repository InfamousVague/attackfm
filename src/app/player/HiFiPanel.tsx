import { Slider, Switch, Text } from '@glacier/react';
import {
  FX_NODES,
  setFxChain,
  setFxChainOn,
  useFxChain,
  useServerFxNodes,
  type FxNode,
} from './fxChain.ts';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The hi-fi chain, over the artwork.
 *
 * The pedals panel beside this shows one headline knob per box, because a
 * stompbox is a thing you stamp on mid-song and its second parameter can wait
 * for the page that built it. A rack is the opposite: nobody reaches for a
 * compressor to nudge one control, and a shelf without its corner frequency
 * is half a shelf. So this draws EVERY parameter of every box in the chain.
 *
 * It lives in the core player rather than in the HiFi Lab plugin for the same
 * reason the pedals panel does: the chain colours the stream whether or not
 * the plugin that built it is still installed, and a switch you cannot see is
 * a switch you cannot turn off.
 */

function spec(t: string) {
  return FX_NODES.find((s) => s.t === t);
}

export function HiFiPanel() {
  const chain = useFxChain();
  const { session } = useServerSession();
  // A node this server cannot compile is dropped from the chain silently, so
  // the row says so rather than looking identical to one that works.
  const known = useServerFxNodes(session?.url);

  // Everything that is not a pedal: the rack proper - EQ bands, shelves,
  // filters, the compressor, width, crossfeed, the leveller.
  const rack = chain.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => {
      const group = spec(node.t)?.group;
      return group !== undefined && group !== 'pedal';
    });

  const live = rack.filter(({ node }) => node.on).length;

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
    <div className="hifiPanel">
      <div className="pedalsPanel__head">
        <Text weight="bold" size="sm">
          HiFi chain
        </Text>
        <Text tone="muted" size="xs">
          {rack.length === 0
            ? 'rack empty'
            : chain.on && live > 0
              ? `${live} of ${rack.length} in`
              : 'off'}
        </Text>
        <Switch
          aria-label="HiFi chain on"
          checked={chain.on && live > 0}
          onCheckedChange={(v: boolean) => setFxChainOn(v)}
        />
      </div>

      {rack.length === 0 ? (
        <Text tone="muted" size="xs">
          Nothing in the rack yet. Build one on the HiFi Lab page — EQ bands, shelves, filters,
          a compressor, width and crossfeed, in whatever order you want them.
        </Text>
      ) : (
        <ul className="hifiPanel__list">
          {rack.map(({ node }, position) => {
            const s = spec(node.t);
            const unsupported = known !== null && !known.has(node.t);
            return (
              <li key={node.key} className="hifiPanel__box">
                <div className="hifiPanel__boxHead">
                  <Switch
                    aria-label={`${s?.label ?? node.t} on`}
                    checked={node.on}
                    onCheckedChange={(v: boolean) => toggle(node.key, v)}
                  />
                  <span
                    className="hifiPanel__name"
                    data-unsupported={unsupported ? 'true' : undefined}
                    title={
                      unsupported
                        ? 'Your server does not have this box, so it is passing through silently'
                        : undefined
                    }
                  >
                    {s?.label ?? node.t}
                  </span>
                  {/* Order is the whole point of a chain, so it is stated
                      rather than merely implied by row position. */}
                  <Text tone="muted" size="xs">{position + 1}</Text>
                </div>
                {s && s.params.length > 0 && (
                  <div className="hifiPanel__knobs">
                    {s.params.map((p) => {
                      const value = node.params[p.key] ?? p.default;
                      return (
                        <label key={p.key} className="hifiPanel__knob">
                          <Text tone="muted" size="xs">{p.label}</Text>
                          <Slider
                            aria-label={`${s.label} ${p.label}`}
                            min={p.min}
                            max={p.max}
                            step={p.step}
                            value={value}
                            // A bypassed box's knob does nothing audible, so
                            // it reads as disabled rather than pretending.
                            disabled={!node.on || !chain.on}
                            onValueChange={(v: number) => patch(node.key, p.key, v)}
                          />
                          <Text size="xs" mono className="hifiPanel__value">
                            {p.step < 1 ? value.toFixed(1) : Math.round(value)}
                            {p.unit ? ` ${p.unit}` : ''}
                          </Text>
                        </label>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
