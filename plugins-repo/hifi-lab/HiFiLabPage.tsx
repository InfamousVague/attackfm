import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button, IconButton, Input, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Plus,
  Save,
  Trash2,
  X,
} from '@glacier/icons';
import {
  FX_NODES,
  nodeSpec,
  setFxChain,
  setFxChainOn,
  useFxChain,
  type FxNode,
  type FxNodeSpec,
} from '@attackfm/app/fxChain';
import { useServerSession } from '@attackfm/app/serverSession';

/**
 * The chain editor. One column, built for a thumb: the signal path reads
 * top to bottom the way it flows, every box expands in place to its knobs,
 * and reordering is two arrows rather than a drag a scrolling page would
 * fight over.
 */

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const card: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: '10px 12px',
};
/** The wire between boxes: a short vertical stroke, the chain made visible. */
const wire: CSSProperties = {
  inlineSize: 2,
  blockSize: 14,
  marginInlineStart: 22,
  background: 'var(--glacier-border)',
  borderRadius: 1,
};
const endcap: CSSProperties = {
  ...card,
  padding: '6px 12px',
  color: 'var(--glacier-text-subtle)',
  fontSize: 'var(--glacier-font-size-xs)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fmtHz(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`;
}

/** The one-line story of a box while it is folded. */
function summary(node: FxNode): string {
  const p = node.params;
  switch (node.t) {
    case 'pre':
      return `${p.g > 0 ? '+' : ''}${p.g} dB`;
    case 'peq':
      return `${fmtHz(p.f)} · ${p.g > 0 ? '+' : ''}${p.g} dB · Q ${p.q}`;
    case 'bass':
    case 'treble':
      return `${p.g > 0 ? '+' : ''}${p.g} dB at ${fmtHz(p.f)}`;
    case 'hp':
    case 'lp':
      return `corner ${fmtHz(p.f)}`;
    case 'comp':
      return `${p.thr} dB · ${p.ratio}:1`;
    case 'width':
      return `${p.amt.toFixed(2)}×`;
    case 'xfeed':
      return `${Math.round(p.amt * 100)}%`;
    default:
      return 'automatic';
  }
}

function defaultsFor(spec: FxNodeSpec): FxNode {
  const params: Record<string, number> = {};
  for (const p of spec.params) params[p.key] = p.default;
  return { t: spec.t, on: true, params, key: freshKey() };
}

// --- presets over the wire ---------------------------------------------------

interface ServerPreset {
  id: number;
  name: string;
  chain: { t: string; [k: string]: unknown }[];
}

interface Session {
  url: string;
  token: string;
}

async function api<T>(session: Session, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${session.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));
  return (await res.json()) as T;
}

/** A saved chain comes back as wire nodes; rebuild editor nodes from them. */
function fromWire(chain: ServerPreset['chain']): FxNode[] {
  const out: FxNode[] = [];
  for (const item of chain) {
    const spec = nodeSpec(item.t);
    if (!spec) continue;
    const params: Record<string, number> = {};
    for (const p of spec.params) {
      const v = item[p.key];
      params[p.key] =
        typeof v === 'number' && Number.isFinite(v)
          ? Math.min(p.max, Math.max(p.min, v))
          : p.default;
    }
    out.push({ t: spec.t, on: true, params, key: freshKey() });
  }
  return out;
}

const AB_KEY = 'attackfm-hifi-lab-ab';

export function HiFiLabPage() {
  const chain = useFxChain();
  const { session } = useServerSession();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [presets, setPresets] = useState<ServerPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [slot, setSlot] = useState<'A' | 'B'>(() => {
    try {
      return (JSON.parse(localStorage.getItem(AB_KEY) ?? '{}') as { slot?: 'A' | 'B' }).slot === 'B'
        ? 'B'
        : 'A';
    } catch {
      return 'A';
    }
  });

  const live = chain.nodes.filter((n) => n.on).length;

  useEffect(() => {
    if (!session) return;
    let alive = true;
    void api<{ presets: ServerPreset[] }>(session, '/api/fx/presets')
      .then((r) => alive && setPresets(r.presets))
      .catch(() => {
        // Unreachable right now; the rack still edits and plays.
      });
    return () => {
      alive = false;
    };
  }, [session]);

  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 3500);
  };

  const edit = (nodes: FxNode[], on = chain.on || nodes.some((n) => n.on)) => {
    setFxChain(nodes, on);
  };

  const patch = (key: string, params: Record<string, number>) =>
    edit(chain.nodes.map((n) => (n.key === key ? { ...n, params } : n)));

  const move = (index: number, dir: -1 | 1) => {
    const next = [...chain.nodes];
    const to = index + dir;
    if (to < 0 || to >= next.length) return;
    const [n] = next.splice(index, 1);
    next.splice(to, 0, n!);
    edit(next);
  };

  const flipSlot = (to: 'A' | 'B') => {
    if (to === slot) return;
    // The leaving slot keeps what is on the desk; the arriving one takes over.
    try {
      const raw = JSON.parse(localStorage.getItem(AB_KEY) ?? '{}') as Record<string, unknown>;
      raw[slot] = chain.nodes;
      raw.slot = to;
      localStorage.setItem(AB_KEY, JSON.stringify(raw));
      const incoming = Array.isArray(raw[to]) ? (raw[to] as FxNode[]) : [];
      setSlot(to);
      edit(incoming, incoming.length > 0 ? chain.on : false);
    } catch {
      setSlot(to);
    }
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!session || !name || chain.nodes.length === 0) return;
    const wireChain = chain.nodes.filter((n) => n.on).map((n) => ({ t: n.t, ...n.params }));
    void api<{ id: number }>(session, '/api/fx/presets', {
      method: 'POST',
      body: JSON.stringify({ name, chain: wireChain }),
    })
      .then(({ id }) => {
        setPresets((prev) => [
          { id, name, chain: wireChain },
          ...prev.filter((p) => p.name !== name),
        ]);
        setPresetName('');
        say(`Saved “${name}”.`);
      })
      .catch(() => say('Could not save — is the server reachable?'));
  };

  const catalogue = useMemo(() => {
    const groups: { label: string; items: FxNodeSpec[] }[] = [
      { label: 'Tone', items: [] },
      { label: 'Dynamics', items: [] },
      { label: 'Space', items: [] },
      { label: 'Utility', items: [] },
    ];
    for (const spec of FX_NODES) {
      const bucket =
        spec.group === 'tone' ? 0 : spec.group === 'dynamics' ? 1 : spec.group === 'space' ? 2 : 3;
      groups[bucket]!.items.push(spec);
    }
    return groups;
  }, []);

  return (
    <div style={{ ...stack(14), padding: 16, maxInlineSize: 560, marginInline: 'auto' }}>
      {/* The masthead: what this is, and the one switch that rules it. */}
      <div style={row(10)}>
        <AudioLines size={20} />
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <Text weight="semibold">HiFi Lab</Text>
          <Text tone="muted" size="xs">
            {live > 0
              ? `${live} box${live === 1 ? '' : 'es'} in the path`
              : 'The path is empty — add a box below'}
          </Text>
        </div>
        <SegmentedControl
          size="sm"
          aria-label="A/B"
          value={slot}
          onValueChange={(v: string) => flipSlot(v === 'B' ? 'B' : 'A')}
          options={[
            { value: 'A', label: 'A' },
            { value: 'B', label: 'B' },
          ]}
        />
        <Switch
          checked={chain.on && live > 0}
          onCheckedChange={(v: boolean) => setFxChainOn(v)}
          aria-label="Chain on"
        />
      </div>

      {!session && (
        <Text tone="muted" size="sm">
          The chain is rendered by your server’s encoder, so it needs a server connection —
          without one the song plays untouched.
        </Text>
      )}
      {note && (
        <Text tone="muted" size="sm">
          {note}
        </Text>
      )}

      {/* The signal path. */}
      <div style={stack(0)}>
        <div style={endcap}>
          <span>Source</span>
          <span style={{ marginInlineStart: 'auto' }}>your song, untouched</span>
        </div>

        {chain.nodes.map((node, index) => {
          const spec = nodeSpec(node.t);
          if (!spec) return null;
          const expanded = open === node.key;
          return (
            <div key={node.key} style={stack(0)}>
              <div style={wire} />
              <div style={{ ...card, opacity: node.on ? 1 : 0.55 }}>
                <div style={row(10)}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : node.key)}
                    style={{
                      ...row(10),
                      flex: 1,
                      minInlineSize: 0,
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'start',
                    }}
                  >
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <div style={{ minInlineSize: 0 }}>
                      <Text weight="medium">{spec.label}</Text>
                      <Text tone="muted" size="xs">
                        {summary(node)}
                      </Text>
                    </div>
                  </button>
                  <Switch
                    checked={node.on}
                    onCheckedChange={(v: boolean) =>
                      edit(chain.nodes.map((n) => (n.key === node.key ? { ...n, on: v } : n)))
                    }
                    aria-label={`${spec.label} on`}
                  />
                </div>

                {expanded && (
                  <div style={{ ...stack(10), marginBlockStart: 12 }}>
                    {spec.params.map((p) => (
                      <div key={p.key} style={stack(4)}>
                        <div style={{ ...row(8), justifyContent: 'space-between' }}>
                          <Text tone="muted" size="xs">
                            {p.label}
                          </Text>
                          <Text size="xs">
                            {node.params[p.key]}
                            {p.unit ? ` ${p.unit}` : ''}
                          </Text>
                        </div>
                        <Slider
                          min={p.min}
                          max={p.max}
                          step={p.step}
                          value={node.params[p.key] ?? p.default}
                          onValueChange={(v: number) =>
                            patch(node.key, { ...node.params, [p.key]: v })
                          }
                          aria-label={`${spec.label} ${p.label}`}
                        />
                      </div>
                    ))}
                    <div style={{ ...row(6), justifyContent: 'flex-end' }}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ChevronUp size={15} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Move down"
                        disabled={index === chain.nodes.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronDown size={15} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Remove"
                        onClick={() => edit(chain.nodes.filter((n) => n.key !== node.key))}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div style={wire} />
        <div style={endcap}>
          <span>Limiter</span>
          <span style={{ marginInlineStart: 'auto' }}>always on — clipping is not an effect</span>
        </div>
      </div>

      {/* Add a box. */}
      {adding ? (
        <div style={{ ...card, ...stack(10) }}>
          <div style={{ ...row(8), justifyContent: 'space-between' }}>
            <Text weight="medium">Add a box</Text>
            <IconButton variant="ghost" size="sm" aria-label="Close" onClick={() => setAdding(false)}>
              <X size={15} />
            </IconButton>
          </div>
          {catalogue.map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.label} style={stack(6)}>
                <Text tone="muted" size="xs">
                  {group.label}
                </Text>
                {group.items.map((spec) => {
                  const taken = !spec.repeatable && chain.nodes.some((n) => n.t === spec.t);
                  return (
                    <button
                      key={spec.t}
                      type="button"
                      disabled={taken || chain.nodes.length >= 16}
                      onClick={() => {
                        edit([...chain.nodes, defaultsFor(spec)], true);
                        setAdding(false);
                        setOpen(null);
                      }}
                      style={{
                        ...row(10),
                        padding: '8px 10px',
                        borderRadius: 'var(--glacier-radius-md)',
                        border: '1px solid var(--glacier-border-subtle)',
                        background: 'var(--glacier-glass-thin)',
                        color: 'inherit',
                        font: 'inherit',
                        textAlign: 'start',
                        opacity: taken ? 0.45 : 1,
                      }}
                    >
                      <div style={{ flex: 1, minInlineSize: 0 }}>
                        <Text size="sm" weight="medium">
                          {spec.label}
                        </Text>
                        <Text tone="muted" size="xs">
                          {taken ? 'Already in the path' : spec.blurb}
                        </Text>
                      </div>
                      <Plus size={15} />
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
      ) : (
        <Button variant="soft" size="sm" onClick={() => setAdding(true)}>
          <Plus size={15} />
          <span>Add a box</span>
        </Button>
      )}

      {/* Racks: saved chains on the server, so they follow the account. */}
      {session && (
        <div style={{ ...card, ...stack(10) }}>
          <Text weight="medium">Saved racks</Text>
          <div style={row(8)}>
            <Input
              placeholder="Name this rack"
              value={presetName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPresetName(e.target.value)}
            />
            <Button
              variant="soft"
              size="sm"
              disabled={!presetName.trim() || live === 0}
              onClick={savePreset}
            >
              <Save size={15} />
              <span>Save</span>
            </Button>
          </div>
          {presets.length === 0 ? (
            <Text tone="muted" size="xs">
              Nothing saved yet — a rack you name here follows your account to every device.
            </Text>
          ) : (
            presets.map((p) => (
              <div key={p.id} style={{ ...row(8), justifyContent: 'space-between' }}>
                <button
                  type="button"
                  onClick={() => {
                    edit(fromWire(p.chain), true);
                    setOpen(null);
                    say(`Loaded “${p.name}”.`);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'start',
                    flex: 1,
                    minInlineSize: 0,
                  }}
                >
                  <Text size="sm">{p.name}</Text>
                  <Text tone="muted" size="xs">
                    {p.chain.length} box{p.chain.length === 1 ? '' : 'es'}
                  </Text>
                </button>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${p.name}`}
                  onClick={() =>
                    void api(session, `/api/fx/presets/${p.id}`, { method: 'DELETE' })
                      .then(() => setPresets((prev) => prev.filter((x) => x.id !== p.id)))
                      .catch(() => say('Could not delete it just now.'))
                  }
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
