import { useMemo, useState, type CSSProperties } from 'react';
import { Button, Slider, Switch, Text } from '@glacier/react';
import { ArrowDown, ArrowUp, Plus, X, Zap } from '@glacier/icons';
import {
  FX_NODES,
  setFxChain,
  setFxChainOn,
  useFxChain,
  type FxNode,
  type FxNodeSpec,
} from '@attackfm/app/fxChain';
import { useServerSession } from '@attackfm/app/serverSession';

/**
 * The board.
 *
 * One design decision carries this page: the pedals live in the SAME chain
 * HiFi Lab edits, because there is only one signal path into the encoder and
 * pretending otherwise would make two switches fight over one sound. So this
 * page shows only the chain's pedals (group 'pedal'), leaves any rack boxes
 * exactly where they sit, and appends new pedals to the end of the whole
 * chain - a pedal after the rack's EQ is a legitimate order somebody chose.
 *
 * Everything else follows HiFi Lab's idioms: nodes are edited through
 * setFxChain (the store sanitizes and persists), the master switch is the
 * shared kill switch the player strip also shows, and the server does all
 * rendering with its limiter always last.
 */

/** Chain-node identity for this page's edits. */
function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newNode(spec: FxNodeSpec): FxNode {
  const params: Record<string, number> = {};
  for (const p of spec.params) params[p.key] = p.default;
  return { t: spec.t, on: true, params, key: freshKey() };
}

/**
 * A stable, deliberate colour per pedal family - the one liberty this page
 * takes over the rack's uniform boxes, because a floor of identical pedals
 * reads as a spreadsheet and a real board never looks like that.
 */
const HUES: Record<string, number> = {
  od: 28, fuzz: 8, crush: 348,
  chorus: 200, flanger: 220, phaser: 250, trem: 180, vib: 165, rotary: 140,
  echo: 46, spring: 70,
  exciter: 300, sub: 265, sparkle: 320, doubler: 95,
};

const board: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const pedalCard = (hue: number, on: boolean): CSSProperties => ({
  borderRadius: 14,
  border: '1px solid var(--glacier-border)',
  background: `linear-gradient(135deg, hsl(${hue} 42% ${on ? 30 : 18}% / ${on ? 0.55 : 0.3}), var(--glacier-bg-surface))`,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  transition: 'background 200ms ease',
});
const cardHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const knobRow: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr', gap: 6 };
const knobLine: CSSProperties = { display: 'grid', gridTemplateColumns: '84px 1fr 56px', gap: 10, alignItems: 'center' };
const shelfGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: 8,
};
const shelfBtn = (hue: number): CSSProperties => ({
  borderRadius: 12,
  border: '1px solid var(--glacier-border)',
  background: `linear-gradient(135deg, hsl(${hue} 40% 24% / 0.4), var(--glacier-bg-surface))`,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  cursor: 'pointer',
  textAlign: 'left',
});

export function PedalsPage() {
  const chain = useFxChain();
  const { session } = useServerSession();
  const [shelfOpen, setShelfOpen] = useState(true);

  const specs = useMemo(() => FX_NODES.filter((s) => s.group === 'pedal'), []);
  const specOf = (t: string) => specs.find((s) => s.t === t);

  /** The chain's pedals, with their positions in the FULL chain remembered,
   *  so edits land on the right node even with rack boxes interleaved. */
  const pedalsOnBoard = chain.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => specOf(node.t) !== undefined);

  const edit = (nodes: FxNode[], on = chain.on || nodes.some((n) => n.on)) => {
    setFxChain(nodes, on);
  };

  const add = (spec: FxNodeSpec) => {
    edit([...chain.nodes, newNode(spec)], true);
  };

  const remove = (key: string) => edit(chain.nodes.filter((n) => n.key !== key));

  const patch = (key: string, params: Record<string, number>) =>
    edit(chain.nodes.map((n) => (n.key === key ? { ...n, params } : n)));

  const toggle = (key: string, on: boolean) =>
    edit(chain.nodes.map((n) => (n.key === key ? { ...n, on } : n)));

  /** One step through the FULL chain - a pedal may hop over a rack box, which
   *  is exactly what dragging it past one should mean. */
  const move = (fullIndex: number, dir: -1 | 1) => {
    const next = [...chain.nodes];
    const to = fullIndex + dir;
    if (to < 0 || to >= next.length) return;
    const [n] = next.splice(fullIndex, 1);
    next.splice(to, 0, n!);
    edit(next);
  };

  return (
    <div className="homePage">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'var(--glacier-space-4)', maxWidth: 720 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Zap size={22} aria-hidden />
          <div style={{ flex: 1 }}>
            <Text weight="bold" size="lg">Pedals</Text>
            <Text tone="muted" size="sm">
              Stomp order is signal order. Your server renders the sound; the limiter is always on.
            </Text>
          </div>
          {/* The shared kill switch: the same one the player strip shows. */}
          <Switch
            aria-label="Pedalboard on"
            checked={chain.on}
            onCheckedChange={(v: boolean) => setFxChainOn(v)}
          />
        </header>

        {!session && (
          <Text tone="muted" size="sm">
            Pedals colour the stream your server encodes — sign in to a server to hear them.
          </Text>
        )}

        <section style={board} aria-label="The board">
          {pedalsOnBoard.length === 0 && (
            <Text tone="muted" size="sm">
              Nothing on the board. Take a pedal off the shelf below.
            </Text>
          )}
          {pedalsOnBoard.map(({ node, index }, i) => {
            const spec = specOf(node.t)!;
            const hue = HUES[node.t] ?? 0;
            return (
              <article key={node.key} style={pedalCard(hue, node.on && chain.on)}>
                <div style={cardHead}>
                  <Switch
                    aria-label={`${spec.label} on`}
                    checked={node.on}
                    onCheckedChange={(v: boolean) => toggle(node.key, v)}
                  />
                  <div style={{ flex: 1 }}>
                    <Text weight="bold">{spec.label}</Text>
                    <Text tone="muted" size="xs">{spec.blurb}</Text>
                  </div>
                  <Button variant="ghost" size="sm" aria-label="Earlier in the chain" disabled={i === 0} onClick={() => move(index, -1)}>
                    <ArrowUp size={15} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Later in the chain" disabled={i === pedalsOnBoard.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown size={15} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${spec.label}`} onClick={() => remove(node.key)}>
                    <X size={15} />
                  </Button>
                </div>
                <div style={knobRow}>
                  {spec.params.map((p) => (
                    <label key={p.key} style={knobLine}>
                      <Text tone="muted" size="xs">{p.label}</Text>
                      <Slider
                        aria-label={`${spec.label} ${p.label}`}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        value={node.params[p.key] ?? p.default}
                        onValueChange={(v: number) => patch(node.key, { ...node.params, [p.key]: v })}
                      />
                      <Text size="xs" style={{ textAlign: 'right' }}>
                        {(node.params[p.key] ?? p.default).toFixed(p.step < 1 ? 1 : 0)}
                        {p.unit ? ` ${p.unit}` : ''}
                      </Text>
                    </label>
                  ))}
                </div>
              </article>
            );
          })}
        </section>

        <section aria-label="The shelf" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={() => setShelfOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <Plus size={14} aria-hidden />
            <Text weight="bold" size="sm">The shelf</Text>
            <Text tone="muted" size="xs">{shelfOpen ? 'hide' : `${specs.length} pedals`}</Text>
          </button>
          {shelfOpen && (
            <div style={shelfGrid}>
              {specs.map((spec) => (
                <button key={spec.t} type="button" style={shelfBtn(HUES[spec.t] ?? 0)} onClick={() => add(spec)}>
                  <Text weight="bold" size="sm">{spec.label}</Text>
                  <Text tone="muted" size="xs">{spec.blurb}</Text>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
