import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Input, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from '@glacier/icons';
import { nodeSpec, silenceFxChain, useServerFxNodes, type FxNodeSpec } from './fxChain.ts';
import {
  ALL_DRAWERS,
  FRESH_MS,
  drawers,
  fmtParam,
  hueOf,
  iconOf,
  scrollOwner,
  shelfFor,
  summary,
  useChainEdit,
} from './fxEditing.tsx';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The HiFi room: the whole signal path, and the rack you add to it from.
 *
 * This replaces the HiFi Lab plugin PAGE, which existed only because the
 * popover used to be a playing surface with no room to build anything. That
 * page was never page-sized: a single narrow column of switches and sliders
 * that happened to be hosted at a route, and the cost of the route was real -
 * the controls for the sound you are hearing lived two navigations away from
 * the thing playing it, behind a plugin you had to know to install.
 *
 * THE LIST AND THE SHELF ARE NOT THE SAME VOCABULARY, and that asymmetry is
 * the whole design:
 *
 *   - The shelf offers the rack only - twelve boxes. Fifty-five stompboxes in
 *     a popover is a wall you scroll past on the way to a volume slider, so
 *     the board keeps its own page in the Pedals plugin.
 *   - The list shows EVERY node in the chain, pedals included. It has to.
 *     Pedals arrive here without the plugin: two thirds of the Filters recipes
 *     are built from them, and a filter is one tap away in the next tab. A
 *     chain that quietly held a reverb this room refused to draw would be the
 *     exact trap the core player exists to prevent - a switch you cannot see
 *     is a switch you cannot turn off.
 *
 * So a pedal you never installed anything to get is still yours to bypass,
 * re-dial, reorder or throw away; you just cannot go shopping for another one
 * from in here.
 */
export function FxRoom() {
  const { chain, patch, toggle, remove, move, add, full } = useChainEdit();
  const { session } = useServerSession();
  // A box this server cannot compile is dropped from the audio silently, so
  // saying so is the difference between "off" and "broken". Null means the
  // server has not told us yet, which reads as supported - never grey out a
  // box because a fetch has not landed.
  const known = useServerFxNodes(session?.url);
  const unsupported = (t: string) => known !== null && !known.has(t);

  const [open, setOpen] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const live = chain.nodes.filter((n) => n.on).length;

  useEffect(() => {
    if (!landed) return;
    const t = window.setTimeout(() => setLanded(null), FRESH_MS);
    return () => window.clearTimeout(t);
  }, [landed]);

  const put = (spec: FxNodeSpec) => {
    const key = add(spec);
    if (!key) return;
    setLanded(key);
    // Back to the top, where the box just landed. The shelf is long by design
    // and adding from the bottom of it would otherwise leave you looking at
    // the shelf you have finished with.
    scrollOwner(root.current)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="fxRoom" ref={root}>
      <div className="fxRoom__head">
        <Text weight="bold" size="sm">
          HiFi chain
        </Text>
        <Text tone="muted" size="xs">
          {chain.nodes.length === 0
            ? 'empty'
            : live > 0
              ? `${live} of ${chain.nodes.length} in`
              : 'all out'}
        </Text>
        {/* No master switch. There was one, and a rack could sit with every
            box lit and the whole room greyed out from a single control at the
            top - which reads as broken, not as off. A box is in or it is out;
            that is the only state there is. This is the convenience the switch
            was standing in for, and it says what it does. */}
        {live > 0 && (
          <button type="button" className="fxRoom__allOff" onClick={silenceFxChain}>
            All out
          </button>
        )}
      </div>

      {!session && (
        <Text tone="muted" size="xs">
          The chain is rendered by your server, so sign in to hear it. You can
          still build one here — it will be waiting.
        </Text>
      )}

      {chain.nodes.length === 0 ? (
        <Text tone="muted" size="xs">
          Nothing in the chain. Add a box below and it goes straight into the
          signal path.
        </Text>
      ) : (
        <ul className="fxRoom__chain">
          {chain.nodes.map((node, index) => {
            const spec = nodeSpec(node.t);
            const expanded = open === node.key;
            // Pedals carry a hue and rack boxes do not, which is also how you
            // can tell at a glance that something arrived from a filter or
            // from the board rather than off the shelf below.
            const hue = hueOf(node.t);
            const Icon = iconOf(node.t);
            const dead = unsupported(node.t);
            return (
              <li key={node.key}>
                <div
                  className="fxRoom__box"
                  data-on={node.on ? 'true' : undefined}
                  data-fresh={landed === node.key ? 'true' : undefined}
                  style={hue === null ? undefined : tint(hue, node.on)}
                >
                  <div className="fxRoom__boxHead">
                    <Switch
                      aria-label={`${spec?.label ?? node.t} in`}
                      checked={node.on}
                      onCheckedChange={(v: boolean) => toggle(node.key, v)}
                    />
                    <button
                      type="button"
                      className="fxRoom__open"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : node.key)}
                    >
                      <span className="fxRoom__icon" style={hue === null ? undefined : glyph(hue)}>
                        <Icon size={15} />
                      </span>
                      <span className="fxRoom__label">
                        <span className="fxRoom__name" data-unsupported={dead ? 'true' : undefined}>
                          {spec?.label ?? node.t}
                        </span>
                        <span className="fxRoom__summary">
                          {dead ? 'your server does not have this one' : summary(node)}
                        </span>
                      </span>
                      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>

                  {expanded && (
                    <div className="fxRoom__body">
                      {spec && spec.params.length > 0 ? (
                        spec.params.map((p) => {
                          const value = node.params[p.key] ?? p.default;
                          return (
                            <label key={p.key} className="fxRoom__knob">
                              <Text tone="muted" size="xs">
                                {p.label}
                              </Text>
                              <Slider
                                aria-label={`${spec.label} ${p.label}`}
                                min={p.min}
                                max={p.max}
                                step={p.step}
                                value={value}
                                // A bypassed box's knob does nothing audible,
                                // so it reads as disabled rather than
                                // pretending otherwise.
                                disabled={!node.on}
                                onValueChange={(v: number) => patch(node.key, p.key, v)}
                              />
                              <Text size="xs" mono className="fxRoom__value">
                                {fmtParam(p, value)}
                              </Text>
                            </label>
                          );
                        })
                      ) : (
                        <Text tone="muted" size="xs">
                          No controls — it does one thing.
                        </Text>
                      )}

                      <div className="fxRoom__boxTools">
                        {/* Order is the whole point of a chain, so the
                            position is stated rather than left to be counted. */}
                        <Text tone="muted" size="xs">
                          {index + 1} of {chain.nodes.length}
                        </Text>
                        <span className="fxRoom__spacer" />
                        <button
                          type="button"
                          className="fxRoom__tool"
                          aria-label="Move earlier"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ChevronUp size={15} />
                        </button>
                        <button
                          type="button"
                          className="fxRoom__tool"
                          aria-label="Move later"
                          disabled={index === chain.nodes.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ChevronDown size={15} />
                        </button>
                        <button
                          type="button"
                          className="fxRoom__tool"
                          aria-label={`Remove ${spec?.label ?? node.t}`}
                          onClick={() => {
                            if (open === node.key) setOpen(null);
                            remove(node.key);
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Shelf full={full} onAdd={put} unsupported={unsupported} />
    </div>
  );
}

/**
 * The rack, as one scrolling list.
 *
 * A list rather than a grid of tiles: at a popover's width `auto-fill` gives
 * two columns of near-squares whose blurbs have nowhere to go, and the blurb
 * is the half that tells you what the box is FOR.
 */
function Shelf({
  full,
  onAdd,
  unsupported,
}: {
  full: boolean;
  onAdd: (spec: FxNodeSpec) => void;
  unsupported: (t: string) => boolean;
}) {
  const { chain } = useChainEdit();
  const [drawer, setDrawer] = useState<string>(ALL_DRAWERS);
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const all = drawers('rack');
    const total = all.reduce((n, d) => n + d.count, 0);
    return [
      { value: ALL_DRAWERS, label: `All ${total}` },
      ...all.map((d) => ({ value: d.value, label: d.label })),
    ];
  }, []);

  const shelf = useMemo(() => shelfFor('rack', drawer, query), [drawer, query]);
  const searching = query.trim().length > 0;

  return (
    <div className="fxShelf">
      <div className="fxShelf__filters">
        <div className="fxShelf__search">
          <Search size={14} />
          <Input
            aria-label="Search the rack"
            placeholder="Search the rack"
            value={query}
            size="sm"
            onChange={(e: { target: { value: string } }) => setQuery(e.target.value)}
          />
          {searching && (
            <button
              type="button"
              className="fxShelf__clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {/* Hidden while searching, because a query already ignores it - a
            drawer that visibly does nothing is worse than no drawer. */}
        {!searching && (
          <div className="fxShelf__rail">
            <SegmentedControl
              aria-label="Kind"
              size="sm"
              value={drawer}
              options={options}
              onValueChange={setDrawer}
            />
          </div>
        )}
      </div>

      {full && (
        <Text tone="muted" size="xs">
          Sixteen boxes is the whole chain. Remove one to add another.
        </Text>
      )}

      {shelf.length === 0 ? (
        <Text tone="muted" size="xs">
          Nothing here matches “{query.trim()}”.
        </Text>
      ) : (
        <ul className="fxShelf__list">
          {shelf.map((spec) => {
            const Icon = iconOf(spec.t);
            // A box that may only appear once, already in the chain.
            const taken = !spec.repeatable && chain.nodes.some((n) => n.t === spec.t);
            const dead = unsupported(spec.t);
            return (
              <li key={spec.t}>
                <button
                  type="button"
                  className="fxShelf__item"
                  disabled={taken || full}
                  onClick={() => onAdd(spec)}
                >
                  <span className="fxShelf__icon">
                    <Icon size={16} />
                  </span>
                  <span className="fxShelf__text">
                    <span className="fxShelf__name" data-unsupported={dead ? 'true' : undefined}>
                      {spec.label}
                      {taken && <span className="fxShelf__taken"> · in the chain</span>}
                    </span>
                    <span className="fxShelf__blurb">{spec.blurb}</span>
                  </span>
                  <Plus size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A pedal's card, tinted by its hue: brighter when it is in the path. Rack
 *  boxes have no hue and stay uniform, which is what makes a pedal in this
 *  list legible as something that came from somewhere else. */
function tint(hue: number, on: boolean): CSSProperties {
  return {
    background: `linear-gradient(160deg, hsl(${hue} 45% ${on ? 30 : 18}% / ${on ? 0.55 : 0.3}) 0%, transparent 85%)`,
    borderColor: `hsl(${hue} 40% ${on ? 45 : 30}% / ${on ? 0.5 : 0.25})`,
  };
}

function glyph(hue: number): CSSProperties {
  return { color: `hsl(${hue} 70% 68%)`, background: `hsl(${hue} 50% 40% / 0.22)` };
}
