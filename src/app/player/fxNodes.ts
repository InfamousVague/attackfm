import { translate } from '../i18n/translate.ts';

/**
 * The FX vocabulary: every node the server's fx.rs can compile, its
 * parameters and their clamps, plus the pure lookups over the set. Split out
 * of fxChain.ts, which had grown to 800 lines by being two things glued -
 * ~520 lines of static spec table and a persisted store. This half is data
 * and holds no state, which is what lets the console rooms read specs without
 * touching the store's subscription machinery. fxChain.ts re-exports
 * everything here, so no consumer moved.
 *
 * The table names its words rather than spelling them. Every spec below is
 * built once, at import, which is before any language is chosen and long
 * before the picker can change one: a table holding 'Overdrive' would hold it
 * for the life of the process, and switching to German would move every label
 * in the app except the sixty-seven in here. So the table carries CATALOGUE KEYS and
 * whoever draws a pedal resolves them with t() at render, which is the only
 * moment that knows what language this is.
 */

export interface FxParamSpec {
  key: string;
  /** What the knob is called, as a key - resolve with t() where it is drawn. */
  labelKey: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /**
   * @deprecated Read `labelKey` through t() instead.
   * Installed by the compatibility shim below, not written in the table -
   * see the comment there for who still reads it and why.
   */
  readonly label: string;
}

/**
 * The shelf's drawers, in the order the segmented control shows them.
 *
 * These stay English because they are not only read: a drawer name is the
 * `family` on a spec, the value of the segmented control, and what the shelf
 * filters by with `===`, so a translated one would empty every drawer in that
 * language. The words a user sees come from FAMILY_LABEL_KEYS below instead.
 */
export const PEDAL_FAMILIES = [
  'Drive',
  'Lo-fi',
  'Filter',
  'Modulation',
  'Time',
  'Space',
  'Dynamics',
] as const;

export type PedalFamily = (typeof PEDAL_FAMILIES)[number];

/** The drawer names as they are SHOWN - the translatable half of the pair. */
export const FAMILY_LABEL_KEYS: Record<PedalFamily, string> = {
  Drive: 'player.fxFamilyDrive',
  'Lo-fi': 'player.fxFamilyLofi',
  Filter: 'player.fxFamilyFilter',
  Modulation: 'player.fxFamilyModulation',
  Time: 'player.fxFamilyTime',
  Space: 'player.fxFamilySpace',
  Dynamics: 'player.fxFamilyDynamics',
};

export interface FxNodeSpec {
  /** The wire tag - the contract with server/src/fx.rs. */
  t: string;
  /** What the box is called, as a key - resolve with t() where it is drawn. */
  labelKey: string;
  /** What it does, in the words someone would use to want it. Also a key. */
  blurbKey: string;
  group: 'tone' | 'dynamics' | 'space' | 'utility' | 'pedal';
  /**
   * Which drawer of the shelf a pedal lives in. Only 'pedal' nodes carry one:
   * the hi-fi rack's own vocabulary is short enough to read in one column,
   * while fifty-five pedals in one grid is a wall rather than a shelf.
   */
  family?: PedalFamily;
  params: FxParamSpec[];
  /** More than one of these in a chain is normal (EQ bands); false for the
   *  ones where a second copy is only ever a mistake. */
  repeatable: boolean;
  /** @deprecated Read `labelKey` through t() instead - the shim's doing. */
  readonly label: string;
  /** @deprecated Read `blurbKey` through t() instead - the shim's doing. */
  readonly blurb: string;
}

/**
 * The table's own shape: everything a spec has except the words, which are
 * not written down anywhere in here. Splitting the two is what lets the
 * literals below stay keys-only while every existing reader still sees a
 * spec with a `label` on it.
 */
type FxParamSource = Omit<FxParamSpec, 'label'>;
type FxNodeSource = Omit<FxNodeSpec, 'label' | 'blurb' | 'params'> & { params: FxParamSource[] };

/**
 * The vocabulary, mirrored from the server's registry. The server is the
 * authority - it clamps to its own ranges regardless - so a drifted copy
 * here degrades to a knob that stops early, never to a wrong sound.
 */
const FX_NODE_TABLE: FxNodeSource[] = [
  {
    t: 'pre', labelKey: 'player.fxNodePre', blurbKey: 'player.fxNodePreBlurb', group: 'utility',
    repeatable: false,
    params: [{ key: 'g', labelKey: 'player.fxKnobGain', min: -12, max: 12, step: 0.5, default: 0, unit: 'dB' }],
  },
  {
    t: 'peq', labelKey: 'player.fxNodePeq', blurbKey: 'player.fxNodePeqBlurb', group: 'tone',
    repeatable: true,
    params: [
      { key: 'f', labelKey: 'player.fxKnobFrequency', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz' },
      { key: 'g', labelKey: 'player.fxKnobGain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'q', labelKey: 'player.fxKnobQ', min: 0.1, max: 10, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'bass', labelKey: 'player.fxNodeBass', blurbKey: 'player.fxNodeBassBlurb', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', labelKey: 'player.fxKnobGain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', labelKey: 'player.fxKnobCorner', min: 40, max: 500, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'treble', labelKey: 'player.fxNodeTreble', blurbKey: 'player.fxNodeTrebleBlurb', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', labelKey: 'player.fxKnobGain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', labelKey: 'player.fxKnobCorner', min: 1000, max: 16000, step: 100, default: 8000, unit: 'Hz' },
    ],
  },
  {
    t: 'hp', labelKey: 'player.fxNodeHp', blurbKey: 'player.fxNodeHpBlurb', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', labelKey: 'player.fxKnobCorner', min: 20, max: 2000, step: 5, default: 30, unit: 'Hz' }],
  },
  {
    t: 'lp', labelKey: 'player.fxNodeLp', blurbKey: 'player.fxNodeLpBlurb', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', labelKey: 'player.fxKnobCorner', min: 1000, max: 20000, step: 100, default: 18000, unit: 'Hz' }],
  },
  {
    t: 'comp', labelKey: 'player.fxNodeComp', blurbKey: 'player.fxNodeCompBlurb', group: 'dynamics',
    repeatable: false,
    params: [
      { key: 'thr', labelKey: 'player.fxKnobThreshold', min: -60, max: 0, step: 1, default: -18, unit: 'dB' },
      { key: 'ratio', labelKey: 'player.fxKnobRatio', min: 1, max: 20, step: 0.5, default: 3 },
      { key: 'att', labelKey: 'player.fxKnobAttack', min: 1, max: 500, step: 1, default: 20, unit: 'ms' },
      { key: 'rel', labelKey: 'player.fxKnobRelease', min: 20, max: 2000, step: 10, default: 250, unit: 'ms' },
      { key: 'mk', labelKey: 'player.fxKnobMakeup', min: 0, max: 24, step: 0.5, default: 0, unit: 'dB' },
    ],
  },
  {
    t: 'width', labelKey: 'player.fxNodeWidth', blurbKey: 'player.fxNodeWidthBlurb', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', labelKey: 'player.fxKnobWidth', min: 0.05, max: 2.5, step: 0.05, default: 1 }],
  },
  {
    t: 'xfeed', labelKey: 'player.fxNodeXfeed', blurbKey: 'player.fxNodeXfeedBlurb', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', labelKey: 'player.fxKnobStrength', min: 0, max: 1, step: 0.05, default: 0.5 }],
  },
  {
    t: 'level', labelKey: 'player.fxNodeLevel', blurbKey: 'player.fxNodeLevelBlurb', group: 'dynamics',
    repeatable: false,
    params: [],
  },
  // ── The pedalboard (the Pedals plugin's shelf). Same wire, same server,
  //    same limiter - scrappier voices. Grouped 'pedal' so the hi-fi rack
  //    and the pedalboard each draw their own vocabulary.
  {
    t: 'od', labelKey: 'player.fxNodeOd', blurbKey: 'player.fxNodeOdBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 0, max: 24, step: 0.5, default: 10, unit: 'dB' },
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 1000, max: 12000, step: 100, default: 6000, unit: 'Hz' },
      { key: 'lvl', labelKey: 'player.fxKnobLevel', min: -18, max: 6, step: 0.5, default: -3, unit: 'dB' },
    ],
  },
  {
    t: 'fuzz', labelKey: 'player.fxNodeFuzz', blurbKey: 'player.fxNodeFuzzBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 6, max: 30, step: 0.5, default: 16, unit: 'dB' },
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 1000, max: 10000, step: 100, default: 4500, unit: 'Hz' },
      { key: 'lvl', labelKey: 'player.fxKnobLevel', min: -18, max: 6, step: 0.5, default: -6, unit: 'dB' },
    ],
  },
  {
    t: 'crush', labelKey: 'player.fxNodeCrush', blurbKey: 'player.fxNodeCrushBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'bits', labelKey: 'player.fxKnobBits', min: 2, max: 16, step: 0.5, default: 8 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'chorus', labelKey: 'player.fxNodeChorus', blurbKey: 'player.fxNodeChorusBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.1, max: 4, step: 0.1, default: 0.9, unit: 'Hz' },
      { key: 'depth', labelKey: 'player.fxKnobDepth', min: 1, max: 8, step: 0.5, default: 4, unit: 'ms' },
    ],
  },
  {
    t: 'flanger', labelKey: 'player.fxNodeFlanger', blurbKey: 'player.fxNodeFlangerBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.1, max: 5, step: 0.1, default: 0.5, unit: 'Hz' },
      { key: 'depth', labelKey: 'player.fxKnobDepth', min: 0.5, max: 10, step: 0.5, default: 4, unit: 'ms' },
      { key: 'regen', labelKey: 'player.fxKnobRegen', min: -90, max: 90, step: 5, default: 20 },
    ],
  },
  {
    t: 'phaser', labelKey: 'player.fxNodePhaser', blurbKey: 'player.fxNodePhaserBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      // aphaser refuses a speed above 2; the server clamps there too.
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.1, max: 2, step: 0.1, default: 0.6, unit: 'Hz' },
      { key: 'depth', labelKey: 'player.fxKnobDepth', min: 0.1, max: 0.9, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'trem', labelKey: 'player.fxNodeTrem', blurbKey: 'player.fxNodeTremBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.3, max: 15, step: 0.1, default: 5, unit: 'Hz' },
      { key: 'depth', labelKey: 'player.fxKnobDepth', min: 0.05, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    t: 'vib', labelKey: 'player.fxNodeVib', blurbKey: 'player.fxNodeVibBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.3, max: 12, step: 0.1, default: 4, unit: 'Hz' },
      { key: 'depth', labelKey: 'player.fxKnobDepth', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'rotary', labelKey: 'player.fxNodeRotary', blurbKey: 'player.fxNodeRotaryBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobSpeed', min: 0.05, max: 8, step: 0.05, default: 1.2, unit: 'Hz' },
      { key: 'width', labelKey: 'player.fxKnobWidth', min: 0, max: 2, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'echo', labelKey: 'player.fxNodeEcho', blurbKey: 'player.fxNodeEchoBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', labelKey: 'player.fxKnobTime', min: 60, max: 1500, step: 10, default: 350, unit: 'ms' },
      { key: 'fb', labelKey: 'player.fxKnobFeedback', min: 0.05, max: 0.8, step: 0.05, default: 0.35 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'spring', labelKey: 'player.fxNodeSpring', blurbKey: 'player.fxNodeSpringBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', labelKey: 'player.fxKnobSize', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'exciter', labelKey: 'player.fxNodeExciter', blurbKey: 'player.fxNodeExciterBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0.5, max: 10, step: 0.25, default: 2.5 },
      { key: 'freq', labelKey: 'player.fxKnobFrom', min: 2000, max: 12000, step: 100, default: 7500, unit: 'Hz' },
    ],
  },
  {
    t: 'sub', labelKey: 'player.fxNodeSub', blurbKey: 'player.fxNodeSubBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'wet', labelKey: 'player.fxKnobAmount', min: 0.1, max: 1, step: 0.05, default: 0.6 },
      { key: 'cutoff', labelKey: 'player.fxKnobBelow', min: 50, max: 200, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'sparkle', labelKey: 'player.fxNodeSparkle', blurbKey: 'player.fxNodeSparkleBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [{ key: 'amt', labelKey: 'player.fxKnobAmount', min: 0.5, max: 8, step: 0.25, default: 2 }],
  },
  {
    t: 'doubler', labelKey: 'player.fxNodeDoubler', blurbKey: 'player.fxNodeDoublerBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [{ key: 'amt', labelKey: 'player.fxKnobSpread', min: 0.1, max: 2, step: 0.1, default: 1 }],
  },

  // ── The second shelf: forty more, every filter string null-tested
  //    against a real ffmpeg at its defaults AND at both ends of every knob.
  {
    t: 'dist', labelKey: 'player.fxNodeDist', blurbKey: 'player.fxNodeDistBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 0, max: 30, step: 0.5, default: 14, unit: 'dB' },
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 800, max: 12000, step: 100, default: 5000, unit: 'Hz' },
      { key: 'lvl', labelKey: 'player.fxKnobLevel', min: -24, max: 6, step: 0.5, default: -6, unit: 'dB' },
    ],
  },
  {
    t: 'sat', labelKey: 'player.fxNodeSat', blurbKey: 'player.fxNodeSatBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 0, max: 18, step: 0.5, default: 6, unit: 'dB' },
      { key: 'lvl', labelKey: 'player.fxKnobLevel', min: -18, max: 6, step: 0.5, default: -2, unit: 'dB' },
    ],
  },
  {
    t: 'tube', labelKey: 'player.fxNodeTube', blurbKey: 'player.fxNodeTubeBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 0, max: 18, step: 0.5, default: 5, unit: 'dB' },
      { key: 'warmth', labelKey: 'player.fxKnobWarmth', min: 0, max: 8, step: 0.5, default: 2, unit: 'dB' },
    ],
  },
  {
    t: 'clip', labelKey: 'player.fxNodeClip', blurbKey: 'player.fxNodeClipBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 1, max: 4, step: 0.1, default: 1.5 },
      { key: 'out', labelKey: 'player.fxKnobOutput', min: 0.1, max: 1, step: 0.05, default: 0.8 },
    ],
  },
  {
    t: 'octafuzz', labelKey: 'player.fxNodeOctafuzz', blurbKey: 'player.fxNodeOctafuzzBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 800, max: 9000, step: 100, default: 3500, unit: 'Hz' },
      { key: 'lvl', labelKey: 'player.fxKnobLevel', min: -24, max: 0, step: 0.5, default: -8, unit: 'dB' },
    ],
  },
  {
    t: 'sizzle', labelKey: 'player.fxNodeSizzle', blurbKey: 'player.fxNodeSizzleBlurb', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 1, max: 12, step: 0.5, default: 4, unit: 'dB' },
    ],
  },
  {
    t: 'wah', labelKey: 'player.fxNodeWah', blurbKey: 'player.fxNodeWahBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'freq', labelKey: 'player.fxKnobFrequency', min: 250, max: 3000, step: 10, default: 900, unit: 'Hz' },
      { key: 'w', labelKey: 'player.fxKnobWidth', min: 0.3, max: 3, step: 0.1, default: 1.2 },
    ],
  },
  {
    t: 'telephone', labelKey: 'player.fxNodeTelephone', blurbKey: 'player.fxNodeTelephoneBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'low', labelKey: 'player.fxKnobLowCut', min: 100, max: 900, step: 10, default: 300, unit: 'Hz' },
      { key: 'high', labelKey: 'player.fxKnobHighCut', min: 1500, max: 8000, step: 100, default: 3400, unit: 'Hz' },
    ],
  },
  {
    t: 'radio', labelKey: 'player.fxNodeRadio', blurbKey: 'player.fxNodeRadioBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'grit', labelKey: 'player.fxKnobGrit', min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    t: 'megaphone', labelKey: 'player.fxNodeMegaphone', blurbKey: 'player.fxNodeMegaphoneBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'freq', labelKey: 'player.fxKnobFrequency', min: 500, max: 3000, step: 10, default: 1400, unit: 'Hz' },
      { key: 'drive', labelKey: 'player.fxKnobDrive', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'vinyl', labelKey: 'player.fxNodeVinyl', blurbKey: 'player.fxNodeVinylBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'grit', labelKey: 'player.fxKnobGrit', min: 0, max: 1, step: 0.05, default: 0.15 },
    ],
  },
  {
    t: 'cassette', labelKey: 'player.fxNodeCassette', blurbKey: 'player.fxNodeCassetteBlurb', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'wow', labelKey: 'player.fxKnobWow', min: 0, max: 0.4, step: 0.01, default: 0.08 },
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 4000, max: 16000, step: 100, default: 12000, unit: 'Hz' },
    ],
  },
  {
    t: 'notch', labelKey: 'player.fxNodeNotch', blurbKey: 'player.fxNodeNotchBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', labelKey: 'player.fxKnobFrequency', min: 40, max: 16000, step: 10, default: 1000, unit: 'Hz' },
      { key: 'w', labelKey: 'player.fxKnobWidth', min: 0.1, max: 4, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'bandfilter', labelKey: 'player.fxNodeBandfilter', blurbKey: 'player.fxNodeBandfilterBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', labelKey: 'player.fxKnobFrequency', min: 60, max: 12000, step: 10, default: 1200, unit: 'Hz' },
      { key: 'w', labelKey: 'player.fxKnobWidth', min: 0.2, max: 5, step: 0.1, default: 2 },
    ],
  },
  {
    t: 'tilt', labelKey: 'player.fxNodeTilt', blurbKey: 'player.fxNodeTiltBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'slope', labelKey: 'player.fxKnobSlope', min: -1, max: 1, step: 0.05, default: 0.3 },
      { key: 'f', labelKey: 'player.fxKnobPivot', min: 100, max: 10000, step: 50, default: 1000, unit: 'Hz' },
    ],
  },
  {
    t: 'subcut', labelKey: 'player.fxNodeSubcut', blurbKey: 'player.fxNodeSubcutBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', labelKey: 'player.fxKnobCorner', min: 2, max: 200, step: 1, default: 40, unit: 'Hz' },
    ],
  },
  {
    t: 'presence', labelKey: 'player.fxNodePresence', blurbKey: 'player.fxNodePresenceBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', labelKey: 'player.fxKnobGain', min: -12, max: 12, step: 0.5, default: 4, unit: 'dB' },
      { key: 'f', labelKey: 'player.fxKnobCorner', min: 1500, max: 9000, step: 100, default: 4000, unit: 'Hz' },
    ],
  },
  {
    t: 'air', labelKey: 'player.fxNodeAir', blurbKey: 'player.fxNodeAirBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', labelKey: 'player.fxKnobGain', min: -12, max: 12, step: 0.5, default: 4, unit: 'dB' },
    ],
  },
  {
    t: 'mudcut', labelKey: 'player.fxNodeMudcut', blurbKey: 'player.fxNodeMudcutBlurb', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', labelKey: 'player.fxKnobDepth', min: 0, max: 12, step: 0.5, default: 4, unit: 'dB' },
      { key: 'f', labelKey: 'player.fxKnobFrequency', min: 120, max: 600, step: 10, default: 250, unit: 'Hz' },
    ],
  },
  {
    t: 'ring', labelKey: 'player.fxNodeRing', blurbKey: 'player.fxNodeRingBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'shift', labelKey: 'player.fxKnobShift', min: -500, max: 500, step: 5, default: 120, unit: 'Hz' },
    ],
  },
  {
    t: 'autopan', labelKey: 'player.fxNodeAutopan', blurbKey: 'player.fxNodeAutopanBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.05, max: 8, step: 0.05, default: 0.8, unit: 'Hz' },
      { key: 'width', labelKey: 'player.fxKnobWidth', min: 0, max: 2, step: 0.1, default: 1.6 },
    ],
  },
  {
    t: 'chop', labelKey: 'player.fxNodeChop', blurbKey: 'player.fxNodeChopBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobRate', min: 0.5, max: 16, step: 0.5, default: 4, unit: 'Hz' },
      { key: 'width', labelKey: 'player.fxKnobWidth', min: 0, max: 2, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'phasespin', labelKey: 'player.fxNodePhasespin', blurbKey: 'player.fxNodePhasespinBlurb', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: -1, max: 1, step: 0.05, default: 0.35 },
    ],
  },
  {
    t: 'slap', labelKey: 'player.fxNodeSlap', blurbKey: 'player.fxNodeSlapBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', labelKey: 'player.fxKnobTime', min: 40, max: 300, step: 5, default: 120, unit: 'ms' },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    t: 'pingpong', labelKey: 'player.fxNodePingpong', blurbKey: 'player.fxNodePingpongBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', labelKey: 'player.fxKnobTime', min: 60, max: 800, step: 10, default: 360, unit: 'ms' },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'plate', labelKey: 'player.fxNodePlate', blurbKey: 'player.fxNodePlateBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', labelKey: 'player.fxKnobSize', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'hall', labelKey: 'player.fxNodeHall', blurbKey: 'player.fxNodeHallBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', labelKey: 'player.fxKnobSize', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'room', labelKey: 'player.fxNodeRoom', blurbKey: 'player.fxNodeRoomBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', labelKey: 'player.fxKnobSize', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', labelKey: 'player.fxKnobMix', min: 0.05, max: 1, step: 0.05, default: 0.45 },
    ],
  },
  {
    t: 'gatedverb', labelKey: 'player.fxNodeGatedverb', blurbKey: 'player.fxNodeGatedverbBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', labelKey: 'player.fxKnobSize', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'thr', labelKey: 'player.fxKnobGate', min: 0.001, max: 0.5, step: 0.001, default: 0.05 },
    ],
  },
  {
    t: 'tapedelay', labelKey: 'player.fxNodeTapedelay', blurbKey: 'player.fxNodeTapedelayBlurb', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', labelKey: 'player.fxKnobTime', min: 80, max: 1200, step: 10, default: 300, unit: 'ms' },
      { key: 'fb', labelKey: 'player.fxKnobFeedback', min: 0.05, max: 0.8, step: 0.05, default: 0.45 },
      { key: 'tone', labelKey: 'player.fxKnobTone', min: 1500, max: 12000, step: 100, default: 6000, unit: 'Hz' },
    ],
  },
  {
    t: 'widen', labelKey: 'player.fxNodeWiden', blurbKey: 'player.fxNodeWidenBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  },
  {
    t: 'extra', labelKey: 'player.fxNodeExtra', blurbKey: 'player.fxNodeExtraBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0, max: 4, step: 0.1, default: 1.8 },
    ],
  },
  {
    t: 'mono', labelKey: 'player.fxNodeMono', blurbKey: 'player.fxNodeMonoBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [],
  },
  {
    t: 'earwax', labelKey: 'player.fxNodeEarwax', blurbKey: 'player.fxNodeEarwaxBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [],
  },
  {
    t: 'vbass', labelKey: 'player.fxNodeVbass', blurbKey: 'player.fxNodeVbassBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobStrength', min: 0.5, max: 3, step: 0.1, default: 2 },
      { key: 'cutoff', labelKey: 'player.fxKnobBelow', min: 100, max: 500, step: 10, default: 250, unit: 'Hz' },
    ],
  },
  {
    t: 'decorr', labelKey: 'player.fxNodeDecorr', blurbKey: 'player.fxNodeDecorrBlurb', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobStages', min: 1, max: 16, step: 1, default: 4 },
    ],
  },
  {
    t: 'gate', labelKey: 'player.fxNodeGate', blurbKey: 'player.fxNodeGateBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'thr', labelKey: 'player.fxKnobThreshold', min: 0, max: 0.5, step: 0.005, default: 0.02 },
      { key: 'ratio', labelKey: 'player.fxKnobRatio', min: 1, max: 20, step: 0.5, default: 3 },
      { key: 'rel', labelKey: 'player.fxKnobRelease', min: 10, max: 2000, step: 10, default: 200, unit: 'ms' },
    ],
  },
  {
    t: 'deess', labelKey: 'player.fxNodeDeess', blurbKey: 'player.fxNodeDeessBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'punch', labelKey: 'player.fxNodePunch', blurbKey: 'player.fxNodePunchBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0, max: 100, step: 1, default: 45 },
    ],
  },
  {
    t: 'glue', labelKey: 'player.fxNodeGlue', blurbKey: 'player.fxNodeGlueBlurb', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', labelKey: 'player.fxKnobAmount', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },

  // Rate. The only two nodes here that change how LONG the song is, which is
  // why chainRate() below exists and why the player has to ask for it: the
  // library's stored duration describes the file, not what you are hearing.
  {
    t: 'speed', labelKey: 'player.fxNodeSpeed', blurbKey: 'player.fxNodeSpeedBlurb', group: 'utility',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobSpeed', min: 0.5, max: 2, step: 0.01, default: 0.8, unit: 'x' },
    ],
  },
  {
    t: 'tempo', labelKey: 'player.fxNodeTempo', blurbKey: 'player.fxNodeTempoBlurb', group: 'utility',
    repeatable: false,
    params: [
      { key: 'rate', labelKey: 'player.fxKnobTempo', min: 0.5, max: 2, step: 0.01, default: 1, unit: 'x' },
    ],
  },
];

/**
 * `spec.label`, `spec.blurb`, `param.label` - still there, on purpose.
 *
 * The Pedals plugin reads those three off this table through the host module
 * (`@attackfm/app/fxChain`), and it ships as a compiled bundle that can be
 * months behind this file on somebody's phone. Renaming the fields under it
 * would not fail a build anywhere; it would draw fifty-five nameless pedals.
 * So the old names keep working, as getters that ask the catalogue at the
 * moment they are read rather than words baked in at import - which is also
 * why an old bundle now follows the language picker instead of pinning the
 * shelf to English.
 *
 * They are deliberately absent from the table and only @deprecated on the
 * types: a getter cannot re-render anything, so the app's own screens must
 * keep resolving the keys with t(), where a language change does.
 */
function withLegacyText(target: object, labelKey: string, blurbKey?: string): void {
  // Non-enumerable so nothing that spreads or serialises a spec picks up a
  // snapshot of one language and carries it somewhere it cannot be updated.
  Object.defineProperty(target, 'label', {
    get: () => translate(labelKey),
    enumerable: false,
    configurable: true,
  });
  if (blurbKey === undefined) return;
  Object.defineProperty(target, 'blurb', {
    get: () => translate(blurbKey),
    enumerable: false,
    configurable: true,
  });
}

for (const spec of FX_NODE_TABLE) {
  withLegacyText(spec, spec.labelKey, spec.blurbKey);
  for (const param of spec.params) withLegacyText(param, param.labelKey);
}

/**
 * The vocabulary as everyone reads it. The cast is the shim's promise written
 * down: the loop above put `label` and `blurb` on every spec, and this is the
 * line where the types are told so.
 */
export const FX_NODES = FX_NODE_TABLE as FxNodeSpec[];

/** Node kinds that change playback rate, and so the length of the song. */
const RATE_NODES = new Set(['speed', 'tempo']);

/**
 * How much faster the chain is playing the song, 1 being untouched.
 *
 * The one thing the rest of the fx system never had to care about: every other
 * node colours the sound and leaves the timeline alone, so the library's stored
 * duration was always the truth. A speed node breaks that - a track slowed to
 * 0.8x runs a quarter longer than the number in the database - and nothing in
 * the media element can put it right, because a live encode reports a duration
 * of Infinity and has no addressable end.
 *
 * So the client works it out from the chain it asked for. Multiplied rather
 * than taken from the first match, because Speed and Tempo can be stacked (a
 * nightcore lift with the tempo pulled back is a real thing people build), and
 * because two of a kind would otherwise be silently ignored. Nodes switched off
 * do not count, since a bypassed node is not in the filter graph either.
 */
export function chainRate(chain: FxChainState): number {
  let rate = 1;
  for (const node of chain.nodes) {
    if (!node.on || !RATE_NODES.has(node.t)) continue;
    const asked = node.params.rate;
    if (typeof asked === 'number' && Number.isFinite(asked) && asked > 0) {
      // The same clamp the server applies, so the client's timeline matches
      // the audio rather than the request.
      rate *= Math.min(Math.max(asked, 0.5), 2);
    }
  }
  return rate;
}

export function nodeSpec(t: string): FxNodeSpec | undefined {
  return FX_NODES.find((n) => n.t === t);
}

/** One node as the chain holds it: the wire tag, its params, and whether it
 *  is currently in the signal path (bypassed nodes stay in the list). */
export interface FxNode {
  t: string;
  on: boolean;
  params: Record<string, number>;
  /** Client-side identity for list edits; never sent to the server. */
  key: string;
}

/**
 * The chain has no master switch.
 *
 * It had one, and it was a trap: a rack full of boxes could sit there switched
 * off at the top, every individual pedal lit, and the whole room greyed out
 * with no explanation on the control that was actually doing it. People read
 * that as the feature being broken rather than as one switch being down.
 *
 * A chain is on when something in it is on. That is the only rule now, and it
 * cannot disagree with what the boxes say. `on` survives on the STORED shape
 * only so an install that has one can be migrated (see `sane`); nothing reads
 * it after that.
 */
export interface FxChainState {
  nodes: FxNode[];
}
