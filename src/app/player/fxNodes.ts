/**
 * The FX vocabulary: every node the server's fx.rs can compile, its
 * parameters and their clamps, plus the pure lookups over the set. Split out
 * of fxChain.ts, which had grown to 800 lines by being two things glued -
 * ~520 lines of static spec table and a persisted store. This half is data:
 * it imports nothing and holds no state, which is also what lets the console
 * rooms read specs without touching the store's subscription machinery.
 * fxChain.ts re-exports everything here, so no consumer moved.
 */

export interface FxParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

/** The shelf's drawers, in the order the segmented control shows them. */
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

export interface FxNodeSpec {
  /** The wire tag - the contract with server/src/fx.rs. */
  t: string;
  label: string;
  /** What it does, in the words someone would use to want it. */
  blurb: string;
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
}

/**
 * The vocabulary, mirrored from the server's registry. The server is the
 * authority - it clamps to its own ranges regardless - so a drifted copy
 * here degrades to a knob that stops early, never to a wrong sound.
 */
export const FX_NODES: FxNodeSpec[] = [
  {
    t: 'pre', label: 'Preamp', blurb: 'Trim the level into the chain', group: 'utility',
    repeatable: false,
    params: [{ key: 'g', label: 'Gain', min: -12, max: 12, step: 0.5, default: 0, unit: 'dB' }],
  },
  {
    t: 'peq', label: 'EQ band', blurb: 'One bell: pick a frequency, lift or cut it', group: 'tone',
    repeatable: true,
    params: [
      { key: 'f', label: 'Frequency', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz' },
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'q', label: 'Width (Q)', min: 0.1, max: 10, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'bass', label: 'Bass shelf', blurb: 'Everything below the corner, together', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', label: 'Corner', min: 40, max: 500, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'treble', label: 'Treble shelf', blurb: 'Everything above the corner, together', group: 'tone',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -18, max: 18, step: 0.5, default: 0, unit: 'dB' },
      { key: 'f', label: 'Corner', min: 1000, max: 16000, step: 100, default: 8000, unit: 'Hz' },
    ],
  },
  {
    t: 'hp', label: 'High-pass', blurb: 'Cut rumble below the corner', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', label: 'Corner', min: 20, max: 2000, step: 5, default: 30, unit: 'Hz' }],
  },
  {
    t: 'lp', label: 'Low-pass', blurb: 'Roll off everything above the corner', group: 'tone',
    repeatable: false,
    params: [{ key: 'f', label: 'Corner', min: 1000, max: 20000, step: 100, default: 18000, unit: 'Hz' }],
  },
  {
    t: 'comp', label: 'Compressor', blurb: 'Even out loud and quiet', group: 'dynamics',
    repeatable: false,
    params: [
      { key: 'thr', label: 'Threshold', min: -60, max: 0, step: 1, default: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, default: 3 },
      { key: 'att', label: 'Attack', min: 1, max: 500, step: 1, default: 20, unit: 'ms' },
      { key: 'rel', label: 'Release', min: 20, max: 2000, step: 10, default: 250, unit: 'ms' },
      { key: 'mk', label: 'Makeup', min: 0, max: 24, step: 0.5, default: 0, unit: 'dB' },
    ],
  },
  {
    t: 'width', label: 'Stereo width', blurb: 'Narrow it to mono or open it out', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', label: 'Width', min: 0.05, max: 2.5, step: 0.05, default: 1 }],
  },
  {
    t: 'xfeed', label: 'Crossfeed', blurb: 'Headphones, but like speakers in a room', group: 'space',
    repeatable: false,
    params: [{ key: 'amt', label: 'Strength', min: 0, max: 1, step: 0.05, default: 0.5 }],
  },
  {
    t: 'level', label: 'Leveler', blurb: 'Quiet songs up, loud songs down', group: 'dynamics',
    repeatable: false,
    params: [],
  },
  // ── The pedalboard (the Pedals plugin's shelf). Same wire, same server,
  //    same limiter - scrappier voices. Grouped 'pedal' so the hi-fi rack
  //    and the pedalboard each draw their own vocabulary.
  {
    t: 'od', label: 'Overdrive', blurb: 'Push the signal until it sings', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 24, step: 0.5, default: 10, unit: 'dB' },
      { key: 'tone', label: 'Tone', min: 1000, max: 12000, step: 100, default: 6000, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -18, max: 6, step: 0.5, default: -3, unit: 'dB' },
    ],
  },
  {
    t: 'fuzz', label: 'Fuzz', blurb: 'Square it off; everything overdrive is too polite for', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 6, max: 30, step: 0.5, default: 16, unit: 'dB' },
      { key: 'tone', label: 'Tone', min: 1000, max: 10000, step: 100, default: 4500, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -18, max: 6, step: 0.5, default: -6, unit: 'dB' },
    ],
  },
  {
    t: 'crush', label: 'Bitcrusher', blurb: 'Fewer bits, more grit', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'bits', label: 'Bits', min: 2, max: 16, step: 0.5, default: 8 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'chorus', label: 'Chorus', blurb: 'Two detuned copies shimmering against the dry', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 4, step: 0.1, default: 0.9, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 1, max: 8, step: 0.5, default: 4, unit: 'ms' },
    ],
  },
  {
    t: 'flanger', label: 'Flanger', blurb: 'The jet plane', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 5, step: 0.1, default: 0.5, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.5, max: 10, step: 0.5, default: 4, unit: 'ms' },
      { key: 'regen', label: 'Regen', min: -90, max: 90, step: 5, default: 20 },
    ],
  },
  {
    t: 'phaser', label: 'Phaser', blurb: 'Notches sweeping the spectrum, softer than a flanger', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      // aphaser refuses a speed above 2; the server clamps there too.
      { key: 'rate', label: 'Rate', min: 0.1, max: 2, step: 0.1, default: 0.6, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.1, max: 0.9, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'trem', label: 'Tremolo', blurb: 'Loudness wobble', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.3, max: 15, step: 0.1, default: 5, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.05, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    t: 'vib', label: 'Vibrato', blurb: 'Pitch wobble', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.3, max: 12, step: 0.1, default: 4, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'rotary', label: 'Rotary', blurb: 'The poor honest cousin of a Leslie cabinet', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Speed', min: 0.05, max: 8, step: 0.05, default: 1.2, unit: 'Hz' },
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'echo', label: 'Echo', blurb: 'Three tape taps, each quieter than the last', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', label: 'Time', min: 60, max: 1500, step: 10, default: 350, unit: 'ms' },
      { key: 'fb', label: 'Feedback', min: 0.05, max: 0.8, step: 0.05, default: 0.35 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.7 },
    ],
  },
  {
    t: 'spring', label: 'Spring', blurb: 'A small room on a coil of wire', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'exciter', label: 'Exciter', blurb: 'Harmonics the recording never had', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0.5, max: 10, step: 0.25, default: 2.5 },
      { key: 'freq', label: 'From', min: 2000, max: 12000, step: 100, default: 7500, unit: 'Hz' },
    ],
  },
  {
    t: 'sub', label: 'Sub', blurb: 'An octave of synthesized weight under the lows', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'wet', label: 'Amount', min: 0.1, max: 1, step: 0.05, default: 0.6 },
      { key: 'cutoff', label: 'Below', min: 50, max: 200, step: 5, default: 100, unit: 'Hz' },
    ],
  },
  {
    t: 'sparkle', label: 'Sparkle', blurb: 'Detail forward, haze back', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [{ key: 'amt', label: 'Amount', min: 0.5, max: 8, step: 0.25, default: 2 }],
  },
  {
    t: 'doubler', label: 'Doubler', blurb: 'A few milliseconds apart, heard as two takes', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [{ key: 'amt', label: 'Spread', min: 0.1, max: 2, step: 0.1, default: 1 }],
  },

  // ── The second shelf: forty more, every filter string null-tested
  //    against a real ffmpeg at its defaults AND at both ends of every knob.
  {
    t: 'dist', label: 'Distortion', blurb: 'Harder-edged than overdrive, and less forgiving', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 30, step: 0.5, default: 14, unit: 'dB' },
      { key: 'tone', label: 'Tone', min: 800, max: 12000, step: 100, default: 5000, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -24, max: 6, step: 0.5, default: -6, unit: 'dB' },
    ],
  },
  {
    t: 'sat', label: 'Tape saturation', blurb: 'The soft knee tape gives you for free', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 18, step: 0.5, default: 6, unit: 'dB' },
      { key: 'lvl', label: 'Level', min: -18, max: 6, step: 0.5, default: -2, unit: 'dB' },
    ],
  },
  {
    t: 'tube', label: 'Tube warmth', blurb: 'A small valve amp flattering everything', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 18, step: 0.5, default: 5, unit: 'dB' },
      { key: 'warmth', label: 'Warmth', min: 0, max: 8, step: 0.5, default: 2, unit: 'dB' },
    ],
  },
  {
    t: 'clip', label: 'Clipper', blurb: 'Loudness that hides its own damage', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 1, max: 4, step: 0.1, default: 1.5 },
      { key: 'out', label: 'Output', min: 0.1, max: 1, step: 0.05, default: 0.8 },
    ],
  },
  {
    t: 'octafuzz', label: 'Octave fuzz', blurb: 'Rectified, so the fundamental doubles', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'tone', label: 'Tone', min: 800, max: 9000, step: 100, default: 3500, unit: 'Hz' },
      { key: 'lvl', label: 'Level', min: -24, max: 0, step: 0.5, default: -8, unit: 'dB' },
    ],
  },
  {
    t: 'sizzle', label: 'Sizzle', blurb: 'Drive that stays bright', group: 'pedal', family: 'Drive',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 1, max: 12, step: 0.5, default: 4, unit: 'dB' },
    ],
  },
  {
    t: 'wah', label: 'Cocked wah', blurb: 'A wah pedal held still', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'freq', label: 'Frequency', min: 250, max: 3000, step: 10, default: 900, unit: 'Hz' },
      { key: 'w', label: 'Width', min: 0.3, max: 3, step: 0.1, default: 1.2 },
    ],
  },
  {
    t: 'telephone', label: 'Telephone', blurb: 'The band a phone line passes, and nothing else', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'low', label: 'Low cut', min: 100, max: 900, step: 10, default: 300, unit: 'Hz' },
      { key: 'high', label: 'High cut', min: 1500, max: 8000, step: 100, default: 3400, unit: 'Hz' },
    ],
  },
  {
    t: 'radio', label: 'AM radio', blurb: 'Narrower than the phone, with dirt', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'grit', label: 'Grit', min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    t: 'megaphone', label: 'Megaphone', blurb: 'A midrange horn, driven', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'freq', label: 'Frequency', min: 500, max: 3000, step: 10, default: 1400, unit: 'Hz' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'vinyl', label: 'Vinyl', blurb: 'Band-limited and lightly quantised', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'grit', label: 'Grit', min: 0, max: 1, step: 0.05, default: 0.15 },
    ],
  },
  {
    t: 'cassette', label: 'Cassette', blurb: 'Bandwidth, wow, and a soft top end', group: 'pedal', family: 'Lo-fi',
    repeatable: false,
    params: [
      { key: 'wow', label: 'Wow', min: 0, max: 0.4, step: 0.01, default: 0.08 },
      { key: 'tone', label: 'Tone', min: 4000, max: 16000, step: 100, default: 12000, unit: 'Hz' },
    ],
  },
  {
    t: 'notch', label: 'Notch', blurb: 'Take one frequency out, leave the rest', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', label: 'Frequency', min: 40, max: 16000, step: 10, default: 1000, unit: 'Hz' },
      { key: 'w', label: 'Width', min: 0.1, max: 4, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'bandfilter', label: 'Band filter', blurb: 'Keep a band, drop everything else', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', label: 'Frequency', min: 60, max: 12000, step: 10, default: 1200, unit: 'Hz' },
      { key: 'w', label: 'Width', min: 0.2, max: 5, step: 0.1, default: 2 },
    ],
  },
  {
    t: 'tilt', label: 'Tilt', blurb: 'The spectrum on a seesaw', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'slope', label: 'Slope', min: -1, max: 1, step: 0.05, default: 0.3 },
      { key: 'f', label: 'Pivot', min: 100, max: 10000, step: 50, default: 1000, unit: 'Hz' },
    ],
  },
  {
    t: 'subcut', label: 'Sub cut', blurb: 'A steep wall under the lows', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'f', label: 'Corner', min: 2, max: 200, step: 1, default: 40, unit: 'Hz' },
    ],
  },
  {
    t: 'presence', label: 'Presence', blurb: 'Where a voice sits forward', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -12, max: 12, step: 0.5, default: 4, unit: 'dB' },
      { key: 'f', label: 'Corner', min: 1500, max: 9000, step: 100, default: 4000, unit: 'Hz' },
    ],
  },
  {
    t: 'air', label: 'Air', blurb: 'The shelf above everything', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', label: 'Gain', min: -12, max: 12, step: 0.5, default: 4, unit: 'dB' },
    ],
  },
  {
    t: 'mudcut', label: 'Mud cut', blurb: 'The dip every mix wants and none admits to', group: 'pedal', family: 'Filter',
    repeatable: false,
    params: [
      { key: 'g', label: 'Depth', min: 0, max: 12, step: 0.5, default: 4, unit: 'dB' },
      { key: 'f', label: 'Frequency', min: 120, max: 600, step: 10, default: 250, unit: 'Hz' },
    ],
  },
  {
    t: 'ring', label: 'Ring mod', blurb: 'Every partial moved the same number of hertz', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'shift', label: 'Shift', min: -500, max: 500, step: 5, default: 120, unit: 'Hz' },
    ],
  },
  {
    t: 'autopan', label: 'Auto-pan', blurb: 'Walking the image left and right', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, step: 0.05, default: 0.8, unit: 'Hz' },
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.1, default: 1.6 },
    ],
  },
  {
    t: 'chop', label: 'Chop', blurb: 'The helicopter stutter', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Rate', min: 0.5, max: 16, step: 0.5, default: 4, unit: 'Hz' },
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.1, default: 1 },
    ],
  },
  {
    t: 'phasespin', label: 'Phase spin', blurb: 'One channel rotated against the other', group: 'pedal', family: 'Modulation',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: -1, max: 1, step: 0.05, default: 0.35 },
    ],
  },
  {
    t: 'slap', label: 'Slapback', blurb: 'One short repeat', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', label: 'Time', min: 40, max: 300, step: 5, default: 120, unit: 'ms' },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    t: 'pingpong', label: 'Ping-pong', blurb: 'One side against the other, then repeats', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', label: 'Time', min: 60, max: 800, step: 10, default: 360, unit: 'ms' },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'plate', label: 'Plate', blurb: 'A sheet of steel, bright and dense', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'hall', label: 'Hall', blurb: 'Further apart, and longer', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    t: 'room', label: 'Room', blurb: 'Close walls', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'mix', label: 'Mix', min: 0.05, max: 1, step: 0.05, default: 0.45 },
    ],
  },
  {
    t: 'gatedverb', label: 'Gated reverb', blurb: 'The tail cut off square', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'thr', label: 'Gate', min: 0.001, max: 0.5, step: 0.001, default: 0.05 },
    ],
  },
  {
    t: 'tapedelay', label: 'Tape delay', blurb: 'Repeats that lose their top end', group: 'pedal', family: 'Time',
    repeatable: false,
    params: [
      { key: 'time', label: 'Time', min: 80, max: 1200, step: 10, default: 300, unit: 'ms' },
      { key: 'fb', label: 'Feedback', min: 0.05, max: 0.8, step: 0.05, default: 0.45 },
      { key: 'tone', label: 'Tone', min: 1500, max: 12000, step: 100, default: 6000, unit: 'Hz' },
    ],
  },
  {
    t: 'widen', label: 'Widen', blurb: 'A delayed, fed-back side signal', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  },
  {
    t: 'extra', label: 'Extra stereo', blurb: 'The difference between the channels, amplified', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0, max: 4, step: 0.1, default: 1.8 },
    ],
  },
  {
    t: 'mono', label: 'Mono', blurb: 'Both channels summed', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [],
  },
  {
    t: 'earwax', label: 'Headphones', blurb: 'So a mix stops happening inside your skull', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [],
  },
  {
    t: 'vbass', label: 'Virtual bass', blurb: 'Harmonics that imply the note a small speaker cannot make', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Strength', min: 0.5, max: 3, step: 0.1, default: 2 },
      { key: 'cutoff', label: 'Below', min: 100, max: 500, step: 10, default: 250, unit: 'Hz' },
    ],
  },
  {
    t: 'decorr', label: 'Decorrelate', blurb: 'The channels nudged out of lockstep', group: 'pedal', family: 'Space',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Stages', min: 1, max: 16, step: 1, default: 4 },
    ],
  },
  {
    t: 'gate', label: 'Noise gate', blurb: 'Below the threshold, silence', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'thr', label: 'Threshold', min: 0, max: 0.5, step: 0.005, default: 0.02 },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, default: 3 },
      { key: 'rel', label: 'Release', min: 10, max: 2000, step: 10, default: 200, unit: 'ms' },
    ],
  },
  {
    t: 'deess', label: 'De-esser', blurb: 'The sibilance tamer', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    t: 'punch', label: 'Punch', blurb: 'Sharpen, but for dynamics', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0, max: 100, step: 1, default: 45 },
    ],
  },
  {
    t: 'glue', label: 'Glue', blurb: 'A slow squeeze across the whole mix', group: 'pedal', family: 'Dynamics',
    repeatable: false,
    params: [
      { key: 'amt', label: 'Amount', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },

  // Rate. The only two nodes here that change how LONG the song is, which is
  // why chainRate() below exists and why the player has to ask for it: the
  // library's stored duration describes the file, not what you are hearing.
  {
    t: 'speed', label: 'Speed', blurb: 'Faster or slower, pitch going with it', group: 'utility',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Speed', min: 0.5, max: 2, step: 0.01, default: 0.8, unit: 'x' },
    ],
  },
  {
    t: 'tempo', label: 'Tempo', blurb: 'Faster or slower at the original pitch', group: 'utility',
    repeatable: false,
    params: [
      { key: 'rate', label: 'Tempo', min: 0.5, max: 2, step: 0.01, default: 1, unit: 'x' },
    ],
  },
];

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
