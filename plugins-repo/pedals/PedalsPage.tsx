import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, SegmentedControl, Slider, Switch, Text } from '@glacier/react';
import {
  Activity,
  AlignJustify,
  ArrowDown,
  ArrowDownFromLine,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  AudioWaveform,
  Binary,
  Building2,
  ChevronsUp,
  Circle,
  CircleDot,
  Copy,
  CornerDownRight,
  Disc2,
  DoorClosed,
  DoorOpen,
  Droplets,
  Eraser,
  Expand,
  Fan,
  Filter,
  Flame,
  Focus,
  Hammer,
  Headphones,
  Layers,
  Lightbulb,
  Link2,
  Maximize2,
  Megaphone,
  MinusCircle,
  MoveHorizontal,
  Phone,
  Plus,
  Radio,
  RadioTower,
  Repeat,
  Rewind,
  RotateCw,
  Scissors,
  Shuffle,
  SlidersHorizontal,
  Sparkle,
  Sparkles,
  Speaker,
  SquareDashedBottom,
  Star,
  TrendingUp,
  Waves,
  Wind,
  X,
  Zap,
  type LucideIcon,
} from '@glacier/icons';
import {
  FX_NODES,
  PEDAL_FAMILIES,
  setFxChain,
  setFxChainOn,
  useFxChain,
  useServerFxNodes,
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
  // The second shelf, kept inside each family's range so a drawer reads as
  // one colour family rather than a bag of unrelated hues.
  dist: 18, sat: 36, tube: 42, clip: 4, octafuzz: 12, sizzle: 50,
  wah: 330, telephone: 338, radio: 344, megaphone: 352, vinyl: 358, cassette: 24,
  notch: 190, bandfilter: 196, tilt: 206, subcut: 212, presence: 226, air: 232, mudcut: 242,
  ring: 256, autopan: 262, chop: 270, phasespin: 276,
  slap: 56, pingpong: 62, plate: 76, hall: 84, room: 90, gatedverb: 100, tapedelay: 66,
  widen: 108, extra: 116, mono: 122, earwax: 130, vbass: 148, decorr: 156,
  gate: 286, deess: 294, punch: 308, glue: 314,
};

/**
 * A face per pedal, so the shelf can be read at a glance.
 *
 * Paired with HUES above: colour alone is a poor label - it says "these two are
 * related" but never which is which - and fifteen boxes of text is a menu, not
 * a shelf. The glyphs are chosen for what the pedal DOES to the sound rather
 * than for what the effect is called.
 */
const ICONS: Record<string, LucideIcon> = {
  od: Flame,          // drive, pushed hot
  fuzz: Zap,          // harder, spikier drive
  crush: Binary,      // bit crusher: the sound made of steps
  chorus: Layers,     // copies stacked slightly apart
  flanger: Wind,      // a sweep moving through it
  phaser: AudioWaveform,
  trem: Activity,     // amplitude going up and down
  vib: Waves,         // pitch doing the same
  rotary: Fan,        // a speaker that literally spins
  echo: Repeat,
  spring: Radio,      // the tank in an old amp
  exciter: Sparkles,
  sub: ArrowDownToLine,
  sparkle: Star,
  doubler: Copy,
  // The second shelf, in the same family order the segmented control uses.
  // Drive
  dist: Flame, sat: Waves, tube: Lightbulb, clip: Scissors, octafuzz: ChevronsUp, sizzle: Sparkle,
  // Lo-fi
  wah: Filter, telephone: Phone, radio: RadioTower, megaphone: Megaphone, vinyl: Disc2, cassette: Rewind,
  // Filter
  notch: MinusCircle, bandfilter: SlidersHorizontal, tilt: TrendingUp, subcut: ArrowDownFromLine, presence: Focus, air: Wind, mudcut: Droplets,
  // Modulation
  ring: CircleDot, autopan: MoveHorizontal, chop: AlignJustify, phasespin: RotateCw,
  // Time
  slap: CornerDownRight, pingpong: ArrowLeftRight, plate: Layers, hall: Building2, room: DoorClosed, gatedverb: SquareDashedBottom, tapedelay: Repeat,
  // Space
  widen: Maximize2, extra: Expand, mono: Circle, earwax: Headphones, vbass: Speaker, decorr: Shuffle,
  // Dynamics
  gate: DoorOpen, deess: Eraser, punch: Hammer, glue: Link2,
};

/**
 * How long the new pedal keeps blinking after it lands.
 *
 * Long enough to find it after the page has scrolled, short enough that it
 * stops being a thing flashing at you while you set the knobs. Read "for a
 * minute" as the figure of speech; if a literal minute is wanted, this is the
 * one number to change.
 */
const FRESH_MS = 6000;

/**
 * The blink.
 *
 * Inline styles cannot express keyframes and this plugin ships no stylesheet,
 * so the rule travels with the component. It animates only the ring, drawn with
 * box-shadow rather than border, so nothing reflows while it pulses and the
 * card does not jump the layout each cycle.
 */
const BLINK_CSS = `
@keyframes afmPedalLanded {
  0%, 100% { box-shadow: 0 0 0 0 hsl(0 0% 100% / 0); }
  50%      { box-shadow: 0 0 0 3px var(--glacier-accent-9), 0 0 18px -2px var(--glacier-accent-9); }
}
[data-fresh] { animation: afmPedalLanded 900ms ease-in-out 6; }
@media (prefers-reduced-motion: reduce) {
  /* Still say which one is new, just without the flashing. */
  [data-fresh] { animation: none; box-shadow: 0 0 0 2px var(--glacier-accent-9); }
}
`;

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
/* The family picker's rail.
   Nothing here sets a min-width, and nothing needs to: the control is
   inline-level, so inside an overflow-x scroller it takes its max-content
   width and the rail scrolls under it. Measured on a 390px phone - control
   504px, rail 354px, and the page itself does not slide.
   Worth knowing before anyone widens this: the kit's SegmentedControl is an
   inline-grid with `grid-auto-columns: 1fr`, which equalises every segment to
   the widest label ONLY while the control fits its container. These eight
   overflow, so `fr` resolves to max-content per column and the segments keep
   their natural widths - measured identical, to the decimal, to the
   inline-flex the kit used before. Give the rail room and the same eight jump
   to 8x86.4px. Either is fine here; a squeeze is not, which is why this is a
   scroller and not `fullWidth`. */
const familyScroller: CSSProperties = {
  overflowX: 'auto',
  overflowY: 'hidden',
  paddingBottom: 2,
  scrollbarWidth: 'none',
  WebkitOverflowScrolling: 'touch',
};

const shelfGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: 8,
};
const shelfBtn = (hue: number, dim = false): CSSProperties => ({
  opacity: dim ? 0.55 : 1,
  borderRadius: 12,
  border: '1px solid var(--glacier-border)',
  background: `linear-gradient(135deg, hsl(${hue} 40% 24% / 0.4), var(--glacier-bg-surface))`,
  padding: '10px 12px',
  // Row, not column: the icon holds the left edge and the words sit beside it,
  // so a column of shelf buttons scans down a single line of glyphs.
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  cursor: 'pointer',
  textAlign: 'left',
});

/** The icon's own tile, tinted with the pedal's hue. */
const shelfIcon = (hue: number): CSSProperties => ({
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  width: 30,
  height: 30,
  borderRadius: 9,
  background: `hsl(${hue} 45% 45% / 0.22)`,
  color: `hsl(${hue} 70% 72%)`,
});

export function PedalsPage() {
  const chain = useFxChain();
  const { session } = useServerSession();
  const [shelfOpen, setShelfOpen] = useState(true);
  /** The pedal added most recently, while it is still blinking. */
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // One timer, restarted by each add, so adding a second pedal moves the blink
  // rather than leaving two of them going at once.
  useEffect(() => {
    if (!freshKey) return;
    const timer = window.setTimeout(() => setFreshKey(null), FRESH_MS);
    return () => window.clearTimeout(timer);
  }, [freshKey]);

  const specs = useMemo(() => FX_NODES.filter((s) => s.group === 'pedal'), []);

  /**
   * What this server actually compiles. A pedal it has never heard of is
   * dropped silently rather than refused, so without this the shelf offers
   * boxes that go in, look identical, and do nothing. Null means unknown,
   * which is read as supported - see useServerFxNodes.
   */
  const known = useServerFxNodes(session?.url);
  const unsupported = (t: string) => known !== null && !known.has(t);

  /**
   * Which drawer of the shelf is open. Fifty-five pedals in one grid is a wall,
   * not a shelf: 'All' is still there for anyone who would rather scroll, but
   * it is not the default, because the default should be a list you can read.
   */
  const [family, setFamily] = useState<string>(PEDAL_FAMILIES[0]);
  const shelf = useMemo(
    () => (family === 'All' ? specs : specs.filter((s) => s.family === family)),
    [specs, family],
  );

  /** Only offer a drawer that has something in it. */
  const familyOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const spec of specs) {
      if (spec.family) counts.set(spec.family, (counts.get(spec.family) ?? 0) + 1);
    }
    return [
      ...PEDAL_FAMILIES.filter((f) => counts.has(f)).map((f) => ({
        value: f,
        label: f,
      })),
      { value: 'All', label: `All ${specs.length}` },
    ];
  }, [specs]);
  const specOf = (t: string) => specs.find((s) => s.t === t);

  /** The chain's pedals, with their positions in the FULL chain remembered,
   *  so edits land on the right node even with rack boxes interleaved. */
  const pedalsOnBoard = chain.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => specOf(node.t) !== undefined);

  const edit = (nodes: FxNode[], on = chain.on || nodes.some((n) => n.on)) => {
    setFxChain(nodes, on);
  };

  /**
   * Take a pedal off the shelf.
   *
   * The shelf sits below the board, so by the time you click one the board is
   * usually off the top of the screen and the only feedback was a number
   * quietly changing somewhere you were not looking. So: scroll back up to the
   * board, and blink the pedal that just landed so it is obvious which of them
   * is new. It goes on the END of the chain (a pedal after the rack's EQ is a
   * real choice), which is why it has to announce itself rather than rely on
   * being where you are looking.
   */
  const add = (spec: FxNodeSpec) => {
    const node = newNode(spec);
    edit([...chain.nodes, node], true);
    setFreshKey(node.key);

    // The page scrolls inside .homePage, not the window, so ask the board's own
    // scroll container. scrollIntoView on the header would fight a sticky nav.
    const scroller = pageRef.current?.closest('.homePage') ?? pageRef.current;
    scroller?.scrollTo?.({ top: 0, behavior: 'smooth' });
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
      <style>{BLINK_CSS}</style>
      <div
        ref={pageRef}
        style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'var(--glacier-space-4)', maxWidth: 720 }}
      >
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
              <article
                key={node.key}
                style={pedalCard(hue, node.on && chain.on)}
                data-fresh={node.key === freshKey || undefined}
              >
                <div style={cardHead}>
                  <Switch
                    aria-label={`${spec.label} on`}
                    checked={node.on}
                    onCheckedChange={(v: boolean) => toggle(node.key, v)}
                  />
                  <div style={{ flex: 1 }}>
                    <Text weight="bold">{spec.label}</Text>
                    <Text tone="muted" size="xs">
                      {unsupported(node.t)
                        ? 'Your server does not have this pedal, so it is passing through silently'
                        : spec.blurb}
                    </Text>
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
            /* Eight segments do not fit a phone: fullWidth divides the width
               evenly and the labels run into each other ("FilterModulationTime").
               Natural widths in a scroller keeps every label readable, and the
               overflow is horizontal so the page itself never slides. */
            <div style={familyScroller}>
              <SegmentedControl
                aria-label="Pedal family"
                options={familyOptions}
                value={family}
                onValueChange={setFamily}
                size="sm"
              />
            </div>
          )}
          {shelfOpen && (
            <div style={shelfGrid}>
              {shelf.map((spec) => {
                const hue = HUES[spec.t] ?? 0;
                const Icon = ICONS[spec.t] ?? Zap;
                return (
                  <button
                    key={spec.t}
                    type="button"
                    style={shelfBtn(hue, unsupported(spec.t))}
                    onClick={() => add(spec)}
                    // Still addable: the box is real, and the server it needs
                    // may be one update away. The label carries the caveat.
                    title={unsupported(spec.t) ? 'Your server is too old for this pedal' : undefined}
                  >
                    <span style={shelfIcon(hue)} aria-hidden>
                      <Icon size={16} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <Text weight="bold" size="sm">{spec.label}</Text>
                      <Text tone="muted" size="xs">
                        {unsupported(spec.t) ? 'Needs a newer server' : spec.blurb}
                      </Text>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
