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

/**
 * The drawer a filter files itself under. An id rather than the drawer's own
 * name, because the rail compares this against the segment that is selected -
 * and a comparison against a word that changes with the language is a rail
 * that shows an empty shelf in French.
 */
export type FilterFamily = 'speed' | 'tape' | 'broadcast' | 'rooms' | 'colour' | 'stereo' | 'movement';

export interface Filter {
  id: string;
  /**
   * Catalogue keys, not the words. This whole table is evaluated at import,
   * long before a language has been chosen, so text sitting here would be
   * frozen in whatever the app booted in - see i18n/CONVENTIONS.md. The room
   * resolves both at render, which is also what lets the search box match
   * against the names somebody is actually reading.
   */
  nameKey: string;
  blurbKey: string;
  family: FilterFamily;
  icon: LucideIcon;
  /** Signal order, first to last. */
  nodes: FilterNode[];
}

/** The rail's drawers, in the order it lists them. */
export const FAMILIES: readonly { id: FilterFamily; labelKey: string }[] = [
  { id: 'speed', labelKey: 'player.filterFamilySpeed' },
  { id: 'tape', labelKey: 'player.filterFamilyTape' },
  { id: 'broadcast', labelKey: 'player.filterFamilyBroadcast' },
  { id: 'rooms', labelKey: 'player.filterFamilyRooms' },
  { id: 'colour', labelKey: 'player.filterFamilyColour' },
  { id: 'stereo', labelKey: 'player.filterFamilyStereo' },
  { id: 'movement', labelKey: 'player.filterFamilyMovement' },
];

export const FILTERS: Filter[] = [
  // --- Speed ----------------------------------------------------------------
  // These are the only recipes that change how LONG the song is. `speed` moves
  // pitch with the tempo, the way a turntable does, which is the sound "slowed"
  // and "nightcore" are named after; `tempo` holds pitch instead. The player
  // reads the rate back out of the chain to keep the seek bar honest - see
  // chainRate() in fxChain.ts.
  {
    id: 'slowed',
    nameKey: 'player.filterSlowed',
    blurbKey: 'player.filterSlowedBlurb',
    family: 'speed',
    icon: Turtle,
    nodes: [{ t: 'speed', params: { rate: 0.85 } }],
  },
  {
    id: 'slowedverb',
    nameKey: 'player.filterSlowedReverb',
    blurbKey: 'player.filterSlowedReverbBlurb',
    family: 'speed',
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
    nameKey: 'player.filterSpedUp',
    blurbKey: 'player.filterSpedUpBlurb',
    family: 'speed',
    icon: Rabbit,
    nodes: [{ t: 'speed', params: { rate: 1.25 } }],
  },
  {
    id: 'nightcore',
    nameKey: 'player.filterNightcore',
    blurbKey: 'player.filterNightcoreBlurb',
    family: 'speed',
    icon: FastForward,
    nodes: [
      { t: 'speed', params: { rate: 1.35 } },
      { t: 'treble', params: { f: 9000, g: 2 } },
      { t: 'comp', params: { thr: -16, ratio: 3, att: 20, rel: 200, mk: 2 } },
    ],
  },
  {
    id: 'halfspeed',
    nameKey: 'player.filterHalfSpeed',
    blurbKey: 'player.filterHalfSpeedBlurb',
    family: 'speed',
    icon: Hourglass,
    nodes: [{ t: 'speed', params: { rate: 0.5 } }],
  },
  {
    id: 'quick',
    nameKey: 'player.filterQuick',
    blurbKey: 'player.filterQuickBlurb',
    family: 'speed',
    icon: Gauge,
    nodes: [{ t: 'tempo', params: { rate: 1.25 } }],
  },

  // --- Tape & lofi ----------------------------------------------------------
  {
    id: 'lofi',
    nameKey: 'player.filterLofi',
    blurbKey: 'player.filterLofiBlurb',
    family: 'tape',
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
    nameKey: 'player.filterTape',
    blurbKey: 'player.filterTapeBlurb',
    family: 'tape',
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
    nameKey: 'player.filterVinyl',
    blurbKey: 'player.filterVinylBlurb',
    family: 'tape',
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
    nameKey: 'player.filterCassette',
    blurbKey: 'player.filterCassetteBlurb',
    family: 'tape',
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
    nameKey: 'player.filterEightBit',
    blurbKey: 'player.filterEightBitBlurb',
    family: 'tape',
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
    nameKey: 'player.filterAmRadio',
    blurbKey: 'player.filterAmRadioBlurb',
    family: 'broadcast',
    icon: Radio,
    nodes: [
      { t: 'hp', params: { f: 350 } },
      { t: 'lp', params: { f: 3400 } },
      { t: 'comp', params: { thr: -22, ratio: 6, att: 5, rel: 120, mk: 4 } },
    ],
  },
  {
    id: 'phone',
    nameKey: 'player.filterTelephone',
    blurbKey: 'player.filterTelephoneBlurb',
    family: 'broadcast',
    icon: Phone,
    nodes: [
      { t: 'hp', params: { f: 400 } },
      { t: 'lp', params: { f: 3000 } },
      { t: 'comp', params: { thr: -20, ratio: 8, att: 5, rel: 100, mk: 4 } },
    ],
  },
  {
    id: 'mega',
    nameKey: 'player.filterMegaphone',
    blurbKey: 'player.filterMegaphoneBlurb',
    family: 'broadcast',
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
    nameKey: 'player.filterUnderwater',
    blurbKey: 'player.filterUnderwaterBlurb',
    family: 'rooms',
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
    nameKey: 'player.filterCathedral',
    blurbKey: 'player.filterCathedralBlurb',
    family: 'rooms',
    icon: Church,
    nodes: [
      { t: 'spring', params: { mix: 0.8, size: 1 } },
      { t: 'lp', params: { f: 11000 } },
      { t: 'treble', params: { f: 9000, g: -2 } },
    ],
  },
  {
    id: 'stadium',
    nameKey: 'player.filterStadium',
    blurbKey: 'player.filterStadiumBlurb',
    family: 'rooms',
    icon: Users,
    nodes: [
      { t: 'echo', params: { time: 420, fb: 0.35, mix: 0.35 } },
      { t: 'spring', params: { mix: 0.45, size: 0.8 } },
      { t: 'width', params: { amt: 1.4 } },
    ],
  },
  {
    id: 'cave',
    nameKey: 'player.filterCave',
    blurbKey: 'player.filterCaveBlurb',
    family: 'rooms',
    icon: Mountain,
    nodes: [
      { t: 'echo', params: { time: 700, fb: 0.55, mix: 0.5 } },
      { t: 'spring', params: { mix: 0.6, size: 0.9 } },
      { t: 'lp', params: { f: 8000 } },
    ],
  },
  {
    id: 'dream',
    nameKey: 'player.filterDream',
    blurbKey: 'player.filterDreamBlurb',
    family: 'rooms',
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
    nameKey: 'player.filterNightDrive',
    blurbKey: 'player.filterNightDriveBlurb',
    family: 'rooms',
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
    nameKey: 'player.filterBassBoost',
    blurbKey: 'player.filterBassBoostBlurb',
    family: 'colour',
    icon: Speaker,
    nodes: [
      { t: 'bass', params: { f: 90, g: 8 } },
      { t: 'sub', params: { cutoff: 90, wet: 0.5 } },
      { t: 'comp', params: { thr: -14, ratio: 3, att: 20, rel: 250, mk: 2 } },
    ],
  },
  {
    id: 'sub',
    nameKey: 'player.filterSub',
    blurbKey: 'player.filterSubBlurb',
    family: 'colour',
    icon: Waves,
    nodes: [
      { t: 'sub', params: { cutoff: 110, wet: 0.8 } },
      { t: 'bass', params: { f: 80, g: 4 } },
    ],
  },
  {
    id: 'crisp',
    nameKey: 'player.filterCrisp',
    blurbKey: 'player.filterCrispBlurb',
    family: 'colour',
    icon: Sun,
    nodes: [
      { t: 'treble', params: { f: 9000, g: 5 } },
      { t: 'exciter', params: { amt: 3, freq: 8000 } },
      { t: 'sparkle', params: { amt: 2 } },
    ],
  },
  {
    id: 'air',
    nameKey: 'player.filterAir',
    blurbKey: 'player.filterAirBlurb',
    family: 'colour',
    icon: Wind,
    nodes: [
      { t: 'sparkle', params: { amt: 4 } },
      { t: 'exciter', params: { amt: 4, freq: 10000 } },
      { t: 'treble', params: { f: 12000, g: 3 } },
    ],
  },
  {
    id: 'warm',
    nameKey: 'player.filterWarm',
    blurbKey: 'player.filterWarmBlurb',
    family: 'colour',
    icon: Flame,
    nodes: [
      { t: 'bass', params: { f: 140, g: 4 } },
      { t: 'treble', params: { f: 9000, g: -3 } },
      { t: 'od', params: { drive: 3, lvl: -2, tone: 7000 } },
    ],
  },
  {
    id: 'vocal',
    nameKey: 'player.filterVocalFocus',
    blurbKey: 'player.filterVocalFocusBlurb',
    family: 'colour',
    icon: Mic,
    nodes: [
      { t: 'hp', params: { f: 120 } },
      { t: 'peq', params: { f: 2500, g: 4, q: 1.2 } },
      { t: 'comp', params: { thr: -18, ratio: 3, att: 20, rel: 250, mk: 3 } },
    ],
  },
  {
    id: 'crunch',
    nameKey: 'player.filterCrunch',
    blurbKey: 'player.filterCrunchBlurb',
    family: 'colour',
    icon: Zap,
    nodes: [
      { t: 'od', params: { drive: 16, lvl: -4, tone: 5000 } },
      { t: 'comp', params: { thr: -16, ratio: 4, att: 10, rel: 200, mk: 2 } },
      { t: 'treble', params: { f: 8000, g: -2 } },
    ],
  },
  {
    id: 'fuzz',
    nameKey: 'player.filterFuzz',
    blurbKey: 'player.filterFuzzBlurb',
    family: 'colour',
    icon: Activity,
    nodes: [
      { t: 'fuzz', params: { drive: 20, lvl: -6, tone: 4000 } },
      { t: 'comp', params: { thr: -18, ratio: 5, att: 5, rel: 150, mk: 2 } },
    ],
  },

  // --- Stereo ---------------------------------------------------------------
  {
    id: 'wide',
    nameKey: 'player.filterWide',
    blurbKey: 'player.filterWideBlurb',
    family: 'stereo',
    icon: MoveHorizontal,
    nodes: [
      { t: 'width', params: { amt: 2 } },
      { t: 'xfeed', params: { amt: 0.3 } },
    ],
  },
  {
    id: 'phones',
    nameKey: 'player.filterHeadphones',
    blurbKey: 'player.filterHeadphonesBlurb',
    family: 'stereo',
    icon: Headphones,
    nodes: [
      { t: 'xfeed', params: { amt: 0.7 } },
      { t: 'width', params: { amt: 1.1 } },
    ],
  },
  {
    id: 'double',
    nameKey: 'player.filterDoubled',
    blurbKey: 'player.filterDoubledBlurb',
    family: 'stereo',
    icon: Copy,
    nodes: [
      { t: 'doubler', params: { amt: 1.2 } },
      { t: 'width', params: { amt: 1.2 } },
    ],
  },

  // --- Movement -------------------------------------------------------------
  {
    id: 'leslie',
    nameKey: 'player.filterLeslie',
    blurbKey: 'player.filterLeslieBlurb',
    family: 'movement',
    icon: Fan,
    nodes: [
      { t: 'rotary', params: { rate: 2.2, width: 1.3 } },
      { t: 'spring', params: { mix: 0.2, size: 0.4 } },
    ],
  },
  {
    id: 'wobble',
    nameKey: 'player.filterWobble',
    blurbKey: 'player.filterWobbleBlurb',
    family: 'movement',
    icon: AudioWaveform,
    nodes: [{ t: 'trem', params: { depth: 0.5, rate: 4.5 } }],
  },
  {
    id: 'jet',
    nameKey: 'player.filterJet',
    blurbKey: 'player.filterJetBlurb',
    family: 'movement',
    icon: Plane,
    nodes: [{ t: 'flanger', params: { depth: 5, rate: 0.4, regen: 45 } }],
  },
  {
    id: 'sweep',
    nameKey: 'player.filterSweep',
    blurbKey: 'player.filterSweepBlurb',
    family: 'movement',
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
