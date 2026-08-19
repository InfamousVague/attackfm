import {
  Activity,
  FastForward,
  Gauge,
  Hourglass,
  Rabbit,
  Snowflake,
  Turtle,
  AudioWaveform,
  Binary,
  Church,
  Cloud,
  Copy,
  Disc,
  Disc3,
  Droplets,
  Fan,
  Flame,
  Headphones,
  Megaphone,
  Mic,
  Moon,
  Mountain,
  MoveHorizontal,
  Music4,
  Phone,
  Plane,
  Radio,
  Rewind,
  Speaker,
  Sun,
  Users,
  Waves,
  Waypoints,
  Wind,
  Zap,
  type LucideIcon,
} from '@glacier/icons';

/**
 * The filter recipes.
 *
 * A filter is a whole sound in one tap, where a pedalboard is a sound you
 * build. It lives in the core player rather than in a plugin because the
 * console's Filters room IS this shelf now - the page it used to have added
 * nothing the popover cannot hold, and a sound you can turn on should not be
 * behind a plugin you have to know to install. Same machinery underneath - every recipe is ordinary fx-chain nodes,
 * rendered by the server's encoder with its limiter last - but the unit of
 * choice is the finished look rather than the parts.
 *
 * HARD CONSTRAINT: only node kinds the SERVER actually renders may appear here.
 * A recipe naming a kind the encoder does not implement applies silently and
 * does nothing at all - the worst possible failure, because it reads as a
 * filter that simply is not very strong.
 *
 * When this was written the reference server implemented 25 of the client's
 * kinds and the recipes were cut to fit. It answers with all 67 as of
 * 2026-08-19, so nothing here is currently gated - but the check is not
 * therefore obsolete: other people's hubs run older builds, which is exactly
 * who the "Needs a newer server" row in the Filters room is for. Verify with
 * `npm run filters:check`, or read `GET /api/fx/nodes` off the box itself.
 *
 * Values are inside each parameter's real range, also from that endpoint; the
 * server clamps anyway, but a clamped value is a recipe that does not sound the
 * way it reads.
 */

/** One node in a recipe. Keys and defaults are filled in when it is applied. */
export interface FilterNode {
  t: string;
  params: Record<string, number>;
}

export interface Filter {
  id: string;
  name: string;
  blurb: string;
  family: string;
  icon: LucideIcon;
  /** Signal order, first to last. */
  nodes: FilterNode[];
}

export const FAMILIES = ['Speed', 'Tape & lofi', 'Broadcast', 'Rooms', 'Colour', 'Stereo', 'Movement'] as const;

export const FILTERS: Filter[] = [
  // --- Speed ----------------------------------------------------------------
  // These are the only recipes that change how LONG the song is. `speed` moves
  // pitch with the tempo, the way a turntable does, which is the sound "slowed"
  // and "nightcore" are named after; `tempo` holds pitch instead. The player
  // reads the rate back out of the chain to keep the seek bar honest - see
  // chainRate() in fxChain.ts.
  {
    id: 'slowed',
    name: 'Slowed',
    blurb: 'Dragged below speed, pitch falling with it',
    family: 'Speed',
    icon: Turtle,
    nodes: [{ t: 'speed', params: { rate: 0.85 } }],
  },
  {
    id: 'slowedverb',
    name: 'Slowed + reverb',
    blurb: 'Slowed, with the room turned up',
    family: 'Speed',
    icon: Snowflake,
    nodes: [
      { t: 'speed', params: { rate: 0.82 } },
      { t: 'bass', params: { f: 100, g: 3 } },
      { t: 'lp', params: { f: 14000 } },
      { t: 'spring', params: { mix: 0.45, size: 0.8 } },
    ],
  },
  {
    id: 'spedup',
    name: 'Sped up',
    blurb: 'Pushed above speed, pitch rising with it',
    family: 'Speed',
    icon: Rabbit,
    nodes: [{ t: 'speed', params: { rate: 1.25 } }],
  },
  {
    id: 'nightcore',
    name: 'Nightcore',
    blurb: 'Faster and higher, with the top end lifted',
    family: 'Speed',
    icon: FastForward,
    nodes: [
      { t: 'speed', params: { rate: 1.35 } },
      { t: 'treble', params: { f: 9000, g: 2 } },
      { t: 'comp', params: { thr: -16, ratio: 3, att: 20, rel: 200, mk: 2 } },
    ],
  },
  {
    id: 'halfspeed',
    name: 'Half speed',
    blurb: 'An octave down, at half the pace',
    family: 'Speed',
    icon: Hourglass,
    nodes: [{ t: 'speed', params: { rate: 0.5 } }],
  },
  {
    id: 'quick',
    name: 'Faster, same pitch',
    blurb: 'Quicker without the chipmunk',
    family: 'Speed',
    icon: Gauge,
    nodes: [{ t: 'tempo', params: { rate: 1.25 } }],
  },

  // --- Tape & lofi ----------------------------------------------------------
  {
    id: 'lofi',
    name: 'Lofi',
    blurb: 'Soft top end, a little grit, tape wobble',
    family: 'Tape & lofi',
    icon: Disc3,
    nodes: [
      { t: 'lp', params: { f: 3200 } },
      { t: 'crush', params: { bits: 10, mix: 0.5 } },
      { t: 'bass', params: { f: 120, g: 4 } },
      { t: 'treble', params: { f: 9000, g: -6 } },
      // A slow, shallow pitch wobble is what reads as "tape" more than any
      // amount of filtering does.
      { t: 'vib', params: { depth: 0.12, rate: 0.8 } },
    ],
  },
  {
    id: 'tape',
    name: 'Tape',
    blurb: 'Gentle saturation and a rolled-off top',
    family: 'Tape & lofi',
    icon: Rewind,
    nodes: [
      { t: 'od', params: { drive: 4, lvl: -2, tone: 6000 } },
      { t: 'lp', params: { f: 12000 } },
      { t: 'bass', params: { f: 120, g: 2 } },
      { t: 'vib', params: { depth: 0.08, rate: 1.2 } },
    ],
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    blurb: 'Rumble cut, warm mids, a room behind it',
    family: 'Tape & lofi',
    icon: Disc,
    nodes: [
      { t: 'hp', params: { f: 60 } },
      { t: 'lp', params: { f: 9000 } },
      { t: 'crush', params: { bits: 12, mix: 0.3 } },
      { t: 'spring', params: { mix: 0.12, size: 0.3 } },
      { t: 'vib', params: { depth: 0.06, rate: 0.6 } },
    ],
  },
  {
    id: 'cassette',
    name: 'Cassette',
    blurb: 'Dull, bassy and slightly seasick',
    family: 'Tape & lofi',
    icon: Music4,
    nodes: [
      { t: 'lp', params: { f: 8000 } },
      { t: 'bass', params: { f: 110, g: 3 } },
      { t: 'treble', params: { f: 8000, g: -4 } },
      { t: 'crush', params: { bits: 11, mix: 0.35 } },
      { t: 'vib', params: { depth: 0.15, rate: 1.6 } },
    ],
  },
  {
    id: 'bit',
    name: '8-bit',
    blurb: 'Crushed to a handful of bits',
    family: 'Tape & lofi',
    icon: Binary,
    nodes: [
      { t: 'crush', params: { bits: 4, mix: 1 } },
      { t: 'lp', params: { f: 6000 } },
      { t: 'comp', params: { thr: -20, ratio: 4, att: 10, rel: 150, mk: 2 } },
    ],
  },

  // --- Broadcast ------------------------------------------------------------
  {
    id: 'am',
    name: 'AM radio',
    blurb: 'Narrow band, squashed flat',
    family: 'Broadcast',
    icon: Radio,
    nodes: [
      { t: 'hp', params: { f: 350 } },
      { t: 'lp', params: { f: 3400 } },
      { t: 'comp', params: { thr: -22, ratio: 6, att: 5, rel: 120, mk: 4 } },
    ],
  },
  {
    id: 'phone',
    name: 'Telephone',
    blurb: 'The voice band and nothing else',
    family: 'Broadcast',
    icon: Phone,
    nodes: [
      { t: 'hp', params: { f: 400 } },
      { t: 'lp', params: { f: 3000 } },
      { t: 'comp', params: { thr: -20, ratio: 8, att: 5, rel: 100, mk: 4 } },
    ],
  },
  {
    id: 'mega',
    name: 'Megaphone',
    blurb: 'Shouted through a cone',
    family: 'Broadcast',
    icon: Megaphone,
    nodes: [
      { t: 'hp', params: { f: 500 } },
      { t: 'lp', params: { f: 4000 } },
      { t: 'od', params: { drive: 12, lvl: -4, tone: 4000 } },
      { t: 'comp', params: { thr: -18, ratio: 8, att: 5, rel: 120, mk: 3 } },
    ],
  },

  // --- Rooms ----------------------------------------------------------------
  {
    id: 'under',
    name: 'Underwater',
    blurb: 'Muffled and swaying',
    family: 'Rooms',
    icon: Droplets,
    nodes: [
      // The low-pass floor is 1000Hz, so the muffling cannot come from cutoff
      // alone - asking for 700 just gets clamped and sounds half-hearted. A
      // hard treble shelf on top of the floor gets there honestly.
      { t: 'lp', params: { f: 1000 } },
      { t: 'treble', params: { f: 2000, g: -14 } },
      { t: 'chorus', params: { depth: 6, rate: 0.4 } },
      { t: 'spring', params: { mix: 0.4, size: 0.8 } },
    ],
  },
  {
    id: 'cathedral',
    name: 'Cathedral',
    blurb: 'Long stone reverb',
    family: 'Rooms',
    icon: Church,
    nodes: [
      { t: 'spring', params: { mix: 0.8, size: 1 } },
      { t: 'lp', params: { f: 11000 } },
      { t: 'treble', params: { f: 9000, g: -2 } },
    ],
  },
  {
    id: 'stadium',
    name: 'Stadium',
    blurb: 'Big room, slap off the far wall',
    family: 'Rooms',
    icon: Users,
    nodes: [
      { t: 'echo', params: { time: 420, fb: 0.35, mix: 0.35 } },
      { t: 'spring', params: { mix: 0.45, size: 0.8 } },
      { t: 'width', params: { amt: 1.4 } },
    ],
  },
  {
    id: 'cave',
    name: 'Cave',
    blurb: 'Dark, and it keeps answering',
    family: 'Rooms',
    icon: Mountain,
    nodes: [
      { t: 'echo', params: { time: 700, fb: 0.55, mix: 0.5 } },
      { t: 'spring', params: { mix: 0.6, size: 0.9 } },
      { t: 'lp', params: { f: 8000 } },
    ],
  },
  {
    id: 'dream',
    name: 'Dream',
    blurb: 'Soft, wide and a little unreal',
    family: 'Rooms',
    icon: Cloud,
    nodes: [
      { t: 'chorus', params: { depth: 3, rate: 0.5 } },
      { t: 'spring', params: { mix: 0.5, size: 0.7 } },
      { t: 'sparkle', params: { amt: 3 } },
      { t: 'width', params: { amt: 1.3 } },
    ],
  },
  {
    id: 'night',
    name: 'Night drive',
    blurb: 'Low end, soft top, room around it',
    family: 'Rooms',
    icon: Moon,
    nodes: [
      { t: 'bass', params: { f: 90, g: 5 } },
      { t: 'lp', params: { f: 13000 } },
      { t: 'spring', params: { mix: 0.25, size: 0.5 } },
      { t: 'width', params: { amt: 1.3 } },
    ],
  },

  // --- Colour ---------------------------------------------------------------
  {
    id: 'bass',
    name: 'Bass boost',
    blurb: 'Weight, held steady',
    family: 'Colour',
    icon: Speaker,
    nodes: [
      { t: 'bass', params: { f: 90, g: 8 } },
      { t: 'sub', params: { cutoff: 90, wet: 0.5 } },
      { t: 'comp', params: { thr: -14, ratio: 3, att: 20, rel: 250, mk: 2 } },
    ],
  },
  {
    id: 'sub',
    name: 'Sub',
    blurb: 'An octave under the bass line',
    family: 'Colour',
    icon: Waves,
    nodes: [
      { t: 'sub', params: { cutoff: 110, wet: 0.8 } },
      { t: 'bass', params: { f: 80, g: 4 } },
    ],
  },
  {
    id: 'crisp',
    name: 'Crisp',
    blurb: 'Detail lifted at the top',
    family: 'Colour',
    icon: Sun,
    nodes: [
      { t: 'treble', params: { f: 9000, g: 5 } },
      { t: 'exciter', params: { amt: 3, freq: 8000 } },
      { t: 'sparkle', params: { amt: 2 } },
    ],
  },
  {
    id: 'air',
    name: 'Air',
    blurb: 'Open, breathy top end',
    family: 'Colour',
    icon: Wind,
    nodes: [
      { t: 'sparkle', params: { amt: 4 } },
      { t: 'exciter', params: { amt: 4, freq: 10000 } },
      { t: 'treble', params: { f: 12000, g: 3 } },
    ],
  },
  {
    id: 'warm',
    name: 'Warm',
    blurb: 'Rounded and easy to sit with',
    family: 'Colour',
    icon: Flame,
    nodes: [
      { t: 'bass', params: { f: 140, g: 4 } },
      { t: 'treble', params: { f: 9000, g: -3 } },
      { t: 'od', params: { drive: 3, lvl: -2, tone: 7000 } },
    ],
  },
  {
    id: 'vocal',
    name: 'Vocal focus',
    blurb: 'The voice pulled forward',
    family: 'Colour',
    icon: Mic,
    nodes: [
      { t: 'hp', params: { f: 120 } },
      { t: 'peq', params: { f: 2500, g: 4, q: 1.2 } },
      { t: 'comp', params: { thr: -18, ratio: 3, att: 20, rel: 250, mk: 3 } },
    ],
  },
  {
    id: 'crunch',
    name: 'Crunch',
    blurb: 'Driven, with the edges held',
    family: 'Colour',
    icon: Zap,
    nodes: [
      { t: 'od', params: { drive: 16, lvl: -4, tone: 5000 } },
      { t: 'comp', params: { thr: -16, ratio: 4, att: 10, rel: 200, mk: 2 } },
      { t: 'treble', params: { f: 8000, g: -2 } },
    ],
  },
  {
    id: 'fuzz',
    name: 'Fuzz',
    blurb: 'Torn apart on purpose',
    family: 'Colour',
    icon: Activity,
    nodes: [
      { t: 'fuzz', params: { drive: 20, lvl: -6, tone: 4000 } },
      { t: 'comp', params: { thr: -18, ratio: 5, att: 5, rel: 150, mk: 2 } },
    ],
  },

  // --- Stereo ---------------------------------------------------------------
  {
    id: 'wide',
    name: 'Wide',
    blurb: 'Pushed out past the speakers',
    family: 'Stereo',
    icon: MoveHorizontal,
    nodes: [
      { t: 'width', params: { amt: 2 } },
      { t: 'xfeed', params: { amt: 0.3 } },
    ],
  },
  {
    id: 'phones',
    name: 'Headphones',
    blurb: 'Crossfeed, so hard-panned parts stop splitting',
    family: 'Stereo',
    icon: Headphones,
    nodes: [
      { t: 'xfeed', params: { amt: 0.7 } },
      { t: 'width', params: { amt: 1.1 } },
    ],
  },
  {
    id: 'double',
    name: 'Doubled',
    blurb: 'A second take, a hair behind',
    family: 'Stereo',
    icon: Copy,
    nodes: [
      { t: 'doubler', params: { amt: 1.2 } },
      { t: 'width', params: { amt: 1.2 } },
    ],
  },

  // --- Movement -------------------------------------------------------------
  {
    id: 'leslie',
    name: 'Leslie',
    blurb: 'A speaker going round',
    family: 'Movement',
    icon: Fan,
    nodes: [
      { t: 'rotary', params: { rate: 2.2, width: 1.3 } },
      { t: 'spring', params: { mix: 0.2, size: 0.4 } },
    ],
  },
  {
    id: 'wobble',
    name: 'Wobble',
    blurb: 'Volume pulsing in time',
    family: 'Movement',
    icon: AudioWaveform,
    nodes: [{ t: 'trem', params: { depth: 0.5, rate: 4.5 } }],
  },
  {
    id: 'jet',
    name: 'Jet',
    blurb: 'A flanger sweep overhead',
    family: 'Movement',
    icon: Plane,
    nodes: [{ t: 'flanger', params: { depth: 5, rate: 0.4, regen: 45 } }],
  },
  {
    id: 'sweep',
    name: 'Sweep',
    blurb: 'Slow phase, drifting',
    family: 'Movement',
    icon: Waypoints,
    nodes: [{ t: 'phaser', params: { depth: 0.7, rate: 0.35 } }],
  },
];

/**
 * Node kinds a recipe needs, for the availability check on the page.
 *
 * A server that does not implement a kind applies it cleanly and does nothing,
 * so a filter has to be able to say "this box cannot do me" rather than just
 * sounding weak. Speed is the live case: it landed in the encoder long after
 * the deployed hubs were built.
 */
export function kindsUsed(filter: Filter): string[] {
  return [...new Set(filter.nodes.map((n) => n.t))];
}


/** A recipe's fingerprint, for spotting which filter the chain currently is. */
export function signature(nodes: { t: string; params: Record<string, number> }[]): string {
  return nodes
    .map((n) => `${n.t}:${Object.keys(n.params).sort().map((k) => `${k}=${n.params[k]}`).join(',')}`)
    .join('|');
}
