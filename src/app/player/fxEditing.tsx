import {
  Activity,
  AlignJustify,
  ArrowDownFromLine,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ArrowUpToLine,
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
  FastForward,
  Filter,
  Flame,
  Focus,
  Gauge,
  Hammer,
  Headphones,
  Hourglass,
  Layers,
  Lightbulb,
  Link2,
  Maximize2,
  Megaphone,
  Minimize2,
  MinusCircle,
  MoveHorizontal,
  Phone,
  Radio,
  RadioTower,
  Repeat,
  Rewind,
  RotateCw,
  Scale,
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
  Zap,
  type LucideIcon,
} from '@glacier/icons';
import {
  FX_NODES,
  MAX_NODES,
  PEDAL_FAMILIES,
  nodeSpec,
  setFxChain,
  useFxChain,
  type FxChainState,
  type FxNode,
  type FxNodeSpec,
  type FxParamSpec,
} from './fxChain.ts';

/**
 * The furniture the sound console's chain rooms are built from.
 *
 * This is the core copy, and it exists so that building a chain does not
 * require a plugin: the HiFi Lab page it grew out of is retired, and the
 * console does the whole job itself.
 *
 * The Pedals plugin still carries its own copy of these helpers, and that is
 * not an oversight - a plugin bundle cannot import from here (the host's
 * module allow-list is deliberately small), so the alternative to a second
 * copy is widening that list for one page. Where the two differ, THIS one is
 * right: it caps `add` at MAX_NODES, which the board's copy never did, so a
 * seventeenth pedal there is still announced and then dropped by the store's
 * sanitiser on the way to storage.
 */

// ── Which half of the vocabulary ────────────────────────────────────────────

/**
 * The rack is everything that is not a pedal; together the two cover the
 * catalogue exactly once.
 *
 * This still splits the vocabulary even though only 'rack' is offered in the
 * console, because the split is about what you can ADD there, not about what
 * can be in the chain. The chain list draws every node whatever its kind - a
 * filter recipe or the Pedals plugin can put a stompbox in the signal path,
 * and a box the player refuses to draw is a box nobody can switch off.
 */
export type FxKind = 'rack' | 'pedal';

export function kindOf(spec: FxNodeSpec): FxKind {
  return spec.group === 'pedal' ? 'pedal' : 'rack';
}

// ── Colour and glyph ────────────────────────────────────────────────────────

/**
 * A stable, deliberate colour per pedal - the one liberty the board takes over
 * the rack's uniform boxes, because a floor of identical pedals reads as a
 * spreadsheet and a real board never looks like that.
 *
 * Rack boxes deliberately have NO entry here. That asymmetry is the point: a
 * rack is a row of matched units and a pedalboard is not, so the two rooms
 * read as different instruments the moment either one is on screen.
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

/** The hue for a pedal, or null for a rack box - which is not an absence to
 *  paper over with a default, but the rack's uniform look. */
export function hueOf(t: string): number | null {
  return HUES[t] ?? null;
}

/**
 * A face per box, so a list of fifty-five reads at a glance.
 *
 * Colour alone is a poor label - it says "these two are related" but never
 * which is which - and a column of text is a menu, not a shelf. The glyphs are
 * chosen for what the box DOES to the sound rather than for what it is called.
 */
const ICONS: Record<string, LucideIcon> = {
  // The rack. Signal-flow glyphs rather than the board's characterful ones:
  // these are instruments, and an instrument should look like what it measures.
  pre: Gauge, peq: SlidersHorizontal, bass: ArrowDownToLine, treble: ArrowUpToLine,
  hp: ArrowUpFromLine, lp: ArrowDownFromLine, comp: Minimize2, width: Maximize2,
  xfeed: Headphones, level: Scale,
  // The two that change how long the song is: `speed` drags pitch along with
  // the tempo the way a turntable does, `tempo` holds pitch still.
  speed: FastForward, tempo: Hourglass,
  // The board.
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
  dist: Flame, sat: Waves, tube: Lightbulb, clip: Scissors, octafuzz: ChevronsUp, sizzle: Sparkle,
  wah: Filter, telephone: Phone, radio: RadioTower, megaphone: Megaphone, vinyl: Disc2, cassette: Rewind,
  notch: MinusCircle, bandfilter: SlidersHorizontal, tilt: TrendingUp, subcut: ArrowDownFromLine,
  presence: Focus, air: Wind, mudcut: Droplets,
  ring: CircleDot, autopan: MoveHorizontal, chop: AlignJustify, phasespin: RotateCw,
  slap: CornerDownRight, pingpong: ArrowLeftRight, plate: Layers, hall: Building2,
  room: DoorClosed, gatedverb: SquareDashedBottom, tapedelay: Repeat,
  widen: Maximize2, extra: Expand, mono: Circle, earwax: Headphones, vbass: Speaker, decorr: Shuffle,
  gate: DoorOpen, deess: Eraser, punch: Hammer, glue: Link2,
};

export function iconOf(t: string): LucideIcon {
  return ICONS[t] ?? Zap;
}

// ── Reading a node ──────────────────────────────────────────────────────────

export function fmtHz(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`;
}

/** One parameter's reading, in the units the knob is labelled in. */
export function fmtParam(p: FxParamSpec, v: number): string {
  if (p.unit === 'Hz') return fmtHz(v);
  const n = p.step < 1 ? v.toFixed(p.step < 0.1 ? 2 : 1) : String(Math.round(v));
  return p.unit ? `${n} ${p.unit}` : n;
}

/**
 * The one-line story of a box while it is folded.
 *
 * Every box in the console folds, because sixteen of them with every knob open
 * is several screens of popover. That makes this line the only thing standing
 * between a collapsed chain and a list of names, so the rack's boxes - where
 * two or three numbers together are the setting - get a hand-written summary,
 * and everything else falls back to its headline parameter, which the
 * catalogue puts first by construction (drive before tone, rate before depth,
 * time before mix).
 */
export function summary(node: FxNode): string {
  const p = node.params;
  switch (node.t) {
    case 'pre':
      return `${(p.g ?? 0) > 0 ? '+' : ''}${p.g} dB`;
    case 'peq':
      return `${fmtHz(p.f ?? 0)} · ${(p.g ?? 0) > 0 ? '+' : ''}${p.g} dB · Q ${p.q}`;
    case 'bass':
    case 'treble':
      return `${(p.g ?? 0) > 0 ? '+' : ''}${p.g} dB at ${fmtHz(p.f ?? 0)}`;
    case 'hp':
    case 'lp':
      return `corner ${fmtHz(p.f ?? 0)}`;
    case 'comp':
      return `${p.thr} dB · ${p.ratio}:1`;
    case 'width':
      return `${(p.amt ?? 1).toFixed(2)}×`;
    case 'xfeed':
      return `${Math.round((p.amt ?? 0) * 100)}%`;
    default: {
      const spec = nodeSpec(node.t);
      const head = spec?.params[0];
      if (!head) return 'no controls';
      return `${head.label.toLowerCase()} ${fmtParam(head, node.params[head.key] ?? head.default)}`;
    }
  }
}

// ── Building and editing ────────────────────────────────────────────────────

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A new box at its catalogue defaults, switched in - nobody adds a box in
 *  order to hear nothing happen. */
export function freshNode(spec: FxNodeSpec): FxNode {
  const params: Record<string, number> = {};
  for (const p of spec.params) params[p.key] = p.default;
  return { t: spec.t, on: true, params, key: freshKey() };
}

export interface ChainEdit {
  chain: FxChainState;
  edit(nodes: FxNode[], on?: boolean): void;
  patch(key: string, param: string, value: number): void;
  toggle(key: string, on: boolean): void;
  remove(key: string): void;
  /** One step through the WHOLE chain, not just the room being looked at. */
  move(index: number, dir: -1 | 1): void;
  /**
   * Appends a box. Returns its key, or null when the chain is already full.
   *
   * The null matters: the store's sanitiser truncates to MAX_NODES, so an add
   * past the cap used to leave the board claiming it had added a pedal that
   * was thrown away on the way to storage.
   */
  add(spec: FxNodeSpec): string | null;
  full: boolean;
}

export function useChainEdit(): ChainEdit {
  const chain = useFxChain();

  // The default arms the chain the first time anything live goes in: a box
  // added to a chain nobody switched on is a control that does nothing, and
  // the master switch is two rooms away from wherever you just tapped.
  const edit = (nodes: FxNode[], on = chain.on || nodes.some((n) => n.on)) => setFxChain(nodes, on);

  return {
    chain,
    edit,
    patch: (key, param, value) =>
      edit(
        chain.nodes.map((n) => (n.key === key ? { ...n, params: { ...n.params, [param]: value } } : n)),
      ),
    toggle: (key, on) => edit(chain.nodes.map((n) => (n.key === key ? { ...n, on } : n))),
    remove: (key) => edit(chain.nodes.filter((n) => n.key !== key)),
    move: (index, dir) => {
      const to = index + dir;
      if (to < 0 || to >= chain.nodes.length) return;
      const next = [...chain.nodes];
      const [held] = next.splice(index, 1);
      if (held) next.splice(to, 0, held);
      edit(next);
    },
    add: (spec) => {
      if (chain.nodes.length >= MAX_NODES) return null;
      const node = freshNode(spec);
      edit([...chain.nodes, node], true);
      return node.key;
    },
    full: chain.nodes.length >= MAX_NODES,
  };
}

// ── The shelf's drawers ─────────────────────────────────────────────────────

/** The rack's own drawers, in signal order rather than alphabetical: you reach
 *  for tone before dynamics before space, and utility is where the rest lives. */
const RACK_DRAWERS = ['Tone', 'Dynamics', 'Space', 'Utility'] as const;

export function drawerOf(spec: FxNodeSpec): string {
  if (spec.group === 'pedal') return spec.family ?? 'Other';
  return spec.group.charAt(0).toUpperCase() + spec.group.slice(1);
}

/** Every box of one kind, in catalogue order. */
export function vocabulary(kind: FxKind): FxNodeSpec[] {
  return FX_NODES.filter((s) => kindOf(s) === kind);
}

/**
 * The drawers a room offers, in canonical order and only the ones with
 * something in them, each carrying its count.
 */
export function drawers(kind: FxKind): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const spec of vocabulary(kind)) {
    const d = drawerOf(spec);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const order: readonly string[] = kind === 'pedal' ? PEDAL_FAMILIES : RACK_DRAWERS;
  return order
    .filter((d) => counts.has(d))
    .map((d) => ({ value: d, label: d, count: counts.get(d) ?? 0 }));
}

/**
 * The shelf, filtered.
 *
 * A query beats the drawer rather than narrowing it. Searching inside one
 * drawer is how you get "no results" for a pedal that is sitting in the next
 * one along - the reason to type a name is that you do not know where it
 * lives.
 */
export function shelfFor(kind: FxKind, drawer: string, query: string): FxNodeSpec[] {
  const all = vocabulary(kind);
  const q = query.trim().toLowerCase();
  if (q) {
    return all.filter(
      (s) => s.label.toLowerCase().includes(q) || s.blurb.toLowerCase().includes(q),
    );
  }
  if (drawer === ALL_DRAWERS) return all;
  return all.filter((s) => drawerOf(s) === drawer);
}

/** The segment that means "do not filter". */
export const ALL_DRAWERS = ' all';

// ── Getting back to what you just added ─────────────────────────────────────

/**
 * The nearest ancestor that actually scrolls.
 *
 * The console is hosted in two different popovers, each of which owns the
 * scrolling itself, so neither the room nor the shelf can name its own
 * scroller by class - the old page hard-coded `.homePage` and would simply
 * find nothing here. Asking the layout which ancestor scrolls works in both
 * hosts and in whatever the third one turns out to be.
 */
export function scrollOwner(from: HTMLElement | null): HTMLElement | null {
  for (let n = from?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return null;
}

/** How long a newly added box keeps blinking: long enough to find it after the
 *  panel has scrolled, short enough to stop being a thing flashing at you
 *  while you set its knobs. */
export const FRESH_MS = 6000;
