import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * The hi-fi chain: ordered, parameterized nodes, compiled on the SERVER.
 *
 * Same physics as the effects rack (effects.ts): there is no seam for a
 * filter graph in the client - the kit's analyser owns the one
 * MediaElementSourceNode WebAudio allows, and the phone plays through the
 * native backend besides - so the encoder that already runs per stream is
 * the only place a chain can live. This module holds the CHOICE; the server's
 * fx.rs holds the sound. The wire (`fx2`) carries typed parameters that the
 * server clamps and compiles; a filter string never leaves the client because
 * the client never has one.
 *
 * Unlike the rack this state PERSISTS. The rack's purge-at-boot exists
 * because its UI vanished and an invisible switch must not keep re-encoding
 * playback forever. The chain earns persistence differently: a corrective
 * curve for your headphones is exactly the kind of thing that should survive
 * a relaunch - but the same trap waits if the HiFi Lab plugin is removed
 * while its chain plays on. So the CORE surfaces the state too: the player's
 * overflow shows a "HiFi chain" row with a kill switch whenever the chain is
 * live (PlayerStrip), plugin installed or not. The state is never invisible,
 * which is the actual rule the rack's purge was protecting.
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
];

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

export interface FxChainState {
  on: boolean;
  nodes: FxNode[];
}

const KEY = 'attackfm-fxchain-v1';
const MAX_NODES = 16;

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sane(state: unknown): FxChainState {
  if (!state || typeof state !== 'object') return { on: false, nodes: [] };
  const s = state as Partial<FxChainState>;
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  const kept: FxNode[] = [];
  for (const n of nodes.slice(0, MAX_NODES)) {
    if (!n || typeof n !== 'object') continue;
    const spec = nodeSpec((n as FxNode).t);
    if (!spec) continue; // a node type retired later must not haunt storage
    const params: Record<string, number> = {};
    for (const p of spec.params) {
      const v = (n as FxNode).params?.[p.key];
      params[p.key] = typeof v === 'number' && Number.isFinite(v)
        ? Math.min(p.max, Math.max(p.min, v))
        : p.default;
    }
    kept.push({ t: spec.t, on: (n as FxNode).on !== false, params, key: (n as FxNode).key || freshKey() });
  }
  return { on: s.on === true && kept.length > 0, nodes: kept };
}

function read(): FxChainState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sane(JSON.parse(raw)) : { on: false, nodes: [] };
  } catch {
    return { on: false, nodes: [] };
  }
}

let state: FxChainState = read();
const listeners = new Set<() => void>();

function commit(next: FxChainState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // The chain still applies for this run.
  }
  for (const l of listeners) l();
}

export function fxChain(): FxChainState {
  return state;
}

export function setFxChain(nodes: FxNode[], on: boolean): void {
  commit(sane({ on, nodes }));
}

/** The core kill switch: everything off, nothing forgotten. */
export function setFxChainOn(on: boolean): void {
  commit({ ...state, on: on && state.nodes.length > 0 });
}

export function fxChainOn(): boolean {
  return state.on && state.nodes.some((n) => n.on);
}

/**
 * The `fx2` query value: enabled nodes only, in chain order, as the compact
 * JSON the server parses. Null when the chain contributes nothing - which
 * keeps the URL byte-identical to a chainless one, and the direct-stream
 * path available.
 */
export function fxChainParam(): string | null {
  if (!state.on) return null;
  const live = state.nodes.filter((n) => n.on);
  if (live.length === 0) return null;
  return JSON.stringify(live.map((n) => ({ t: n.t, ...n.params })));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The chain, live everywhere it is shown. */
export function useFxChain(): FxChainState {
  return useSyncExternalStore(subscribe, fxChain, () => state);
}

// --- what the connected server actually implements -------------------------

/**
 * The node tags a given server compiles, from `GET /api/fx/nodes`.
 *
 * This exists because of a failure mode nastier than a crash: a node the
 * encoder does not know is DROPPED silently (chain_from_wire skips unknown
 * tags rather than failing the chain), so the pedal applies cleanly, changes
 * nothing, and reads as a weak effect rather than a broken one. The vocabulary
 * lives in the server binary, so a hub that has not been updated offers exactly
 * that experience for every pedal newer than it.
 *
 * "In the chain" and "in the audio" are therefore different claims, and this is
 * what lets the interface tell them apart. Unauthenticated on purpose - the
 * endpoint is public, and a listener who is signed out still deserves an honest
 * shelf.
 *
 * Null means "not known yet" (still loading, or the server could not be
 * reached) and MUST be read as "assume supported": greying out the whole shelf
 * because a fetch failed would be a worse lie than the one this prevents.
 */
const supportCache = new Map<string, Set<string>>();

export function serverFxNodes(url: string): Set<string> | null {
  return supportCache.get(url) ?? null;
}

export function useServerFxNodes(url: string | null | undefined): Set<string> | null {
  const [tags, setTags] = useState<Set<string> | null>(() =>
    url ? (supportCache.get(url) ?? null) : null,
  );

  useEffect(() => {
    if (!url) {
      setTags(null);
      return;
    }
    const cached = supportCache.get(url);
    if (cached) {
      setTags(cached);
      return;
    }
    const controller = new AbortController();
    fetch(`${url}/api/fx/nodes`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { nodes?: { t?: string }[] }) => {
        const set = new Set(
          (body.nodes ?? []).map((n) => n.t).filter((t): t is string => typeof t === 'string'),
        );
        // An empty answer is not evidence of an empty vocabulary; treat it as
        // unknown rather than marking every pedal dead.
        if (set.size === 0) return;
        supportCache.set(url, set);
        setTags(set);
      })
      .catch(() => {
        /* Unknown stays unknown, which reads as supported. */
      });
    return () => controller.abort();
  }, [url]);

  return tags;
}
