//! The hi-fi chain: parameterized, ordered audio nodes, compiled here.
//!
//! The original rack (stream.rs EFFECTS) is a fixed menu: names in, filters
//! out, order decided by the desk. This is the other instrument: the client
//! describes a CHAIN - which nodes, with which settings, in which order - and
//! this module turns it into the `-af` string the encoder runs.
//!
//! The invariant is inherited from the rack and matters more here, not less:
//! **no request composes ffmpeg syntax.** The client sends typed parameters;
//! every number lands in a clamp before it lands in a format string, every
//! string is a tag matched against the registry below, and an unknown node is
//! dropped rather than passed through. The attack surface of `fx2` is exactly
//! the attack surface of `fx`: none, just wider vocabulary.
//!
//! Two lessons from the first rack are load-bearing:
//!  - Order is the user's. A set has no opinion about whether the compressor
//!    comes before the EQ, but the ear does, and this time the whole point is
//!    letting the listener decide. Nodes compile in the order they arrive.
//!  - The limiter is not optional. Any chain of boosts can push past full
//!    scale, and clipping is never one of the effects anybody asked for.

use crate::auth;
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// One node as the wire carries it: a tag plus flat numeric params. Unknown
/// tags fail THIS node's parse, not the whole chain - the caller skips them.
#[derive(Deserialize)]
#[serde(tag = "t")]
enum Node {
    /// Input trim, in dB. The knob you reach for before anything else.
    #[serde(rename = "pre")]
    Pre { g: f64 },
    /// One parametric bell: centre frequency, gain, and how narrow.
    #[serde(rename = "peq")]
    Peq { f: f64, g: f64, q: Option<f64> },
    /// Low shelf - the bass knob.
    #[serde(rename = "bass")]
    Bass { g: f64, f: Option<f64> },
    /// High shelf - the treble knob.
    #[serde(rename = "treble")]
    Treble { g: f64, f: Option<f64> },
    /// High-pass: everything below the corner goes.
    #[serde(rename = "hp")]
    Hp { f: f64 },
    /// Low-pass: everything above the corner goes.
    #[serde(rename = "lp")]
    Lp { f: f64 },
    /// Compressor, the four controls that matter plus makeup.
    #[serde(rename = "comp")]
    Comp {
        thr: Option<f64>,
        ratio: Option<f64>,
        att: Option<f64>,
        rel: Option<f64>,
        mk: Option<f64>,
    },
    /// Stereo width: side level. 1 is as recorded, under is narrower, over is
    /// wider, 0.05 is very nearly mono.
    #[serde(rename = "width")]
    Width { amt: f64 },
    /// Headphone crossfeed - a little of each channel into the other, the way
    /// speakers in a room do it for free.
    #[serde(rename = "xfeed")]
    Xfeed { amt: Option<f64> },
    /// The gentle leveler. No knobs on purpose: dynaudnorm has thirteen and
    /// the one thing anybody means by "even it out" is the default.
    #[serde(rename = "level")]
    Level {},

    // ── The pedalboard. Same instrument, scrappier voices. ──────────────
    //
    // Every pedal below is still just numbers into clamps into one format
    // string; the vocabulary got louder, the attack surface did not.
    /// Overdrive: push the signal into a tanh curve and it sings instead of
    /// snapping. Drive is how hard, tone rolls the fizz off the top, lvl
    /// brings the result back down to sit with the mix.
    #[serde(rename = "od")]
    Od { drive: f64, tone: Option<f64>, lvl: Option<f64> },
    /// Fuzz: the same push into a hard ceiling set low - square-ish, splatty,
    /// everything overdrive is too polite for.
    #[serde(rename = "fuzz")]
    Fuzz { drive: f64, tone: Option<f64>, lvl: Option<f64> },
    /// Bitcrusher: fewer bits, more grit. Mix keeps some of the clean signal
    /// underneath so it reads as texture rather than damage.
    #[serde(rename = "crush")]
    Crush { bits: f64, mix: Option<f64> },
    /// Chorus: two detuned copies shimmering against the dry signal. Rate in
    /// Hz, depth in ms; the second voice rides slightly off the first so the
    /// shimmer never locks into a cycle.
    #[serde(rename = "chorus")]
    ChorusFx { rate: f64, depth: Option<f64> },
    /// Flanger: the jet plane. Regen feeds the sweep back into itself.
    #[serde(rename = "flanger")]
    FlangerFx { rate: f64, depth: Option<f64>, regen: Option<f64> },
    /// Phaser: notches sweeping the spectrum, softer than a flanger.
    #[serde(rename = "phaser")]
    Phaser { rate: f64, depth: Option<f64> },
    /// Tremolo: loudness wobble.
    #[serde(rename = "trem")]
    Trem { rate: f64, depth: Option<f64> },
    /// Vibrato: pitch wobble.
    #[serde(rename = "vib")]
    Vib { rate: f64, depth: Option<f64> },
    /// Rotary: opposite loudness wobble per channel - the poor honest cousin
    /// of a Leslie cabinet.
    #[serde(rename = "rotary")]
    Rotary { rate: f64, width: Option<f64> },
    /// Echo: three taps with geometric decay standing in for feedback, which
    /// is how a tape delay actually behaves by tap three anyway.
    #[serde(rename = "echo")]
    Echo { time: f64, fb: Option<f64>, mix: Option<f64> },
    /// Spring: six close prime-spaced taps smeared into a small room. Size
    /// stretches the room, mix is how far into it you stand.
    #[serde(rename = "spring")]
    Spring { size: Option<f64>, mix: Option<f64> },
    /// Exciter: synthesized upper harmonics - presence you can't EQ in
    /// because it was never in the recording.
    #[serde(rename = "exciter")]
    Exciter { amt: f64, freq: Option<f64> },
    /// Sub: an octave of synthesized weight under the lows.
    #[serde(rename = "sub")]
    Sub { wet: f64, cutoff: Option<f64> },
    /// Sparkle: transient expansion - detail forward, haze back.
    #[serde(rename = "sparkle")]
    Sparkle { amt: f64 },
    /// Doubler: a few milliseconds of one-sided delay, heard as two takes.
    #[serde(rename = "doubler")]
    Doubler { amt: Option<f64> },

    // ── The second shelf. Forty more, same rules: numbers into clamps into
    //    one format string, and every one of them null-tested against a real
    //    ffmpeg (stereo AND mono) before it was allowed in here. An invalid
    //    filtergraph does not degrade - it kills the encode - so "it looks
    //    right" is not a standard this file gets to use.

    // Drive and saturation.
    /// Distortion: an arctan curve, harder-edged than overdrive's tanh.
    #[serde(rename = "dist")]
    Dist { drive: f64, tone: Option<f64>, lvl: Option<f64> },
    /// Tape saturation: a sine curve's soft knee, with the top gently tamed.
    #[serde(rename = "sat")]
    Sat { drive: f64, lvl: Option<f64> },
    /// Tube warmth: a cubic knee and a low lift, the way a small valve amp
    /// flatters everything you put through it.
    #[serde(rename = "tube")]
    Tube { drive: f64, warmth: Option<f64> },
    /// Psychoacoustic clipper: loudness that hides its own damage.
    #[serde(rename = "clip")]
    Clip { amt: f64, out: Option<f64> },
    /// Octave fuzz: full-wave rectification, which doubles the fundamental -
    /// the trick inside every octave-up box.
    #[serde(rename = "octafuzz")]
    Octafuzz { tone: Option<f64>, lvl: Option<f64> },
    /// Sizzle: presence lifted into a soft clip, for drive that stays bright.
    #[serde(rename = "sizzle")]
    Sizzle { amt: f64 },

    // Lo-fi.
    /// Cocked wah: a wah pedal held still. Sweeping it needs an LFO the
    /// encoder has no way to run, and a parked wah is a real sound anyway.
    #[serde(rename = "wah")]
    Wah { freq: f64, w: Option<f64> },
    /// Telephone: the band a phone line passes, and nothing else.
    #[serde(rename = "telephone")]
    Telephone { low: Option<f64>, high: Option<f64> },
    /// AM radio: narrower than the phone, with a little quantisation dirt.
    #[serde(rename = "radio")]
    Radio { grit: Option<f64> },
    /// Megaphone: a midrange horn, driven.
    #[serde(rename = "megaphone")]
    Megaphone { freq: Option<f64>, drive: Option<f64> },
    /// Vinyl: the CD de-emphasis curve, band-limited, lightly quantised.
    #[serde(rename = "vinyl")]
    Vinyl { grit: Option<f64> },
    /// Cassette: bandwidth, wow, and a soft top end.
    #[serde(rename = "cassette")]
    Cassette { wow: Option<f64>, tone: Option<f64> },

    // Filter and EQ.
    /// Notch: take one frequency out and leave the rest.
    #[serde(rename = "notch")]
    Notch { f: f64, w: Option<f64> },
    /// Band filter: keep a band, drop the rest.
    #[serde(rename = "bandfilter")]
    BandFilter { f: f64, w: Option<f64> },
    /// Tilt: the whole spectrum on a seesaw about one pivot.
    #[serde(rename = "tilt")]
    Tilt { slope: f64, f: Option<f64> },
    /// Sub cut: a steep wall under the lows, for speakers that flap.
    #[serde(rename = "subcut")]
    SubCut { f: f64 },
    /// Presence: a high shelf where a voice sits forward.
    #[serde(rename = "presence")]
    Presence { g: f64, f: Option<f64> },
    /// Air: the shelf above everything, where the room lives.
    #[serde(rename = "air")]
    Air { g: f64 },
    /// Mud cut: the dip at 250Hz that every mix wants and no mix admits to.
    #[serde(rename = "mudcut")]
    MudCut { g: Option<f64>, f: Option<f64> },

    // Modulation.
    /// Frequency shifter: every partial moved by the same NUMBER of hertz,
    /// which is what makes it clang instead of transpose.
    #[serde(rename = "ring")]
    Ring { shift: f64 },
    /// Auto-pan: a triangle walking the image left and right.
    #[serde(rename = "autopan")]
    AutoPan { rate: f64, width: Option<f64> },
    /// Chop: a square gate, the helicopter stutter.
    #[serde(rename = "chop")]
    Chop { rate: f64, width: Option<f64> },
    /// Phase spin: one channel rotated against the other.
    #[serde(rename = "phasespin")]
    PhaseSpin { amt: f64 },

    // Time.
    /// Slapback: one short repeat, rockabilly's whole rhythm section.
    #[serde(rename = "slap")]
    Slap { time: f64, mix: Option<f64> },
    /// Ping-pong: one side delayed against the other, then repeats.
    #[serde(rename = "pingpong")]
    PingPong { time: f64, mix: Option<f64> },
    /// Plate: dense early taps, bright, the sound of a sheet of steel.
    #[serde(rename = "plate")]
    Plate { size: Option<f64>, mix: Option<f64> },
    /// Hall: the same trick, further apart and longer.
    #[serde(rename = "hall")]
    Hall { size: Option<f64>, mix: Option<f64> },
    /// Room: close walls, short taps.
    #[serde(rename = "room")]
    Room { size: Option<f64>, mix: Option<f64> },
    /// Gated reverb: the tail cut off square. The eighties in one box.
    #[serde(rename = "gatedverb")]
    GatedVerb { size: Option<f64>, thr: Option<f64> },
    /// Tape delay: repeats that lose their top end as they go.
    #[serde(rename = "tapedelay")]
    TapeDelay { time: f64, fb: Option<f64>, tone: Option<f64> },

    // Space.
    /// Widen: a delayed, fed-back side signal.
    #[serde(rename = "widen")]
    Widen { amt: f64 },
    /// Extra stereo: the difference between the channels, amplified.
    #[serde(rename = "extra")]
    Extra { amt: f64 },
    /// Mono: both channels summed. The oldest test in the book.
    #[serde(rename = "mono")]
    Mono {},
    /// Earwax: a headphone spatialiser, so a stereo mix stops happening
    /// strictly inside your skull.
    #[serde(rename = "earwax")]
    Earwax {},
    /// Virtual bass: harmonics that imply the fundamental a small speaker
    /// cannot actually produce.
    #[serde(rename = "vbass")]
    VBass { amt: f64, cutoff: Option<f64> },
    /// Decorrelate: the channels nudged out of lockstep.
    #[serde(rename = "decorr")]
    Decorr { amt: Option<f64> },

    // Dynamics.
    /// Noise gate: below the threshold, silence.
    #[serde(rename = "gate")]
    Gate { thr: f64, ratio: Option<f64>, rel: Option<f64> },
    /// De-esser: the sibilance tamer.
    #[serde(rename = "deess")]
    DeEss { amt: f64 },
    /// Punch: contrast, which is to dynamics what a sharpen filter is to a
    /// photograph.
    #[serde(rename = "punch")]
    Punch { amt: f64 },
    /// Glue: a slow compander across the whole mix.
    #[serde(rename = "glue")]
    Glue { amt: f64 },

    // Rate. The only two nodes that change how LONG the song is, which is why
    // the client has to be told about them as well - see chainRate() in
    // fxChain.ts and timelineDuration() in deckShared.ts. Everything else in
    // this file colours the sound and leaves the timeline alone.
    /// Speed: play faster or slower, pitch rising and falling with it. The
    /// turntable, and the sound "slowed" and "nightcore" are both named after.
    #[serde(rename = "speed")]
    Speed { rate: f64 },
    /// Tempo: faster or slower at the ORIGINAL pitch. The same knob a DJ uses
    /// to beat-match without the singer changing voice.
    #[serde(rename = "tempo")]
    Tempo { rate: f64 },
}

/// The tap-and-decay pattern the reverbs share.
///
/// Not a real reverb - there is no convolution or feedback network in an `-af`
/// chain - but a spread of early reflections is what the ear reads as a room,
/// and prime-ish spacings keep the taps from stacking into an audible pitch.
fn reverb_taps(taps: &[f64], size: f64, mix: f64, falloff: f64) -> String {
    let stretch = 0.6 + size * 1.4;
    let delays = taps
        .iter()
        .map(|t| format!("{:.0}", (t * stretch).max(1.0)))
        .collect::<Vec<_>>()
        .join("|");
    let decays = (0..taps.len())
        .map(|i| format!("{:.2}", (mix * falloff.powi(i as i32)).max(0.01)))
        .collect::<Vec<_>>()
        .join("|");
    format!("aecho=1.0:{:.2}:{}:{}", (0.5 + mix * 0.4).min(0.9), delays, decays)
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        // A NaN cannot come out of JSON, but an Infinity can ("1e999" parses
        // to it) - and Infinity.clamp() would hand it straight through.
        (lo + hi) / 2.0
    }
}

impl Node {
    /// The one place params meet ffmpeg syntax. Every number is clamped on
    /// this line or the line above it; nothing else in the file formats.
    fn compile(&self) -> String {
        match self {
            Node::Pre { g } => format!("volume={:.2}dB", clamp(*g, -12.0, 12.0)),
            Node::Peq { f, g, q } => format!(
                "equalizer=f={:.1}:t=q:w={:.2}:g={:.2}",
                clamp(*f, 20.0, 20000.0),
                clamp(q.unwrap_or(1.0), 0.1, 10.0),
                clamp(*g, -18.0, 18.0),
            ),
            Node::Bass { g, f } => format!(
                "bass=g={:.2}:f={:.1}",
                clamp(*g, -18.0, 18.0),
                clamp(f.unwrap_or(100.0), 40.0, 500.0),
            ),
            Node::Treble { g, f } => format!(
                "treble=g={:.2}:f={:.1}",
                clamp(*g, -18.0, 18.0),
                clamp(f.unwrap_or(8000.0), 1000.0, 16000.0),
            ),
            Node::Hp { f } => format!("highpass=f={:.1}", clamp(*f, 20.0, 2000.0)),
            Node::Lp { f } => format!("lowpass=f={:.1}", clamp(*f, 1000.0, 20000.0)),
            Node::Comp { thr, ratio, att, rel, mk } => format!(
                // acompressor takes threshold as an amplitude or dB string;
                // attack/release in ms. Makeup below 1 is rejected by some
                // builds, so it is expressed in dB the same as threshold.
                "acompressor=threshold={:.1}dB:ratio={:.1}:attack={:.0}:release={:.0}:makeup={:.1}dB",
                clamp(thr.unwrap_or(-18.0), -60.0, 0.0),
                clamp(ratio.unwrap_or(3.0), 1.0, 20.0),
                clamp(att.unwrap_or(20.0), 1.0, 500.0),
                clamp(rel.unwrap_or(250.0), 20.0, 2000.0),
                clamp(mk.unwrap_or(0.0), 0.0, 24.0),
            ),
            Node::Width { amt } => {
                format!("stereotools=slev={:.3}", clamp(*amt, 0.05, 2.5))
            }
            Node::Xfeed { amt } => {
                format!("crossfeed=strength={:.2}", clamp(amt.unwrap_or(0.5), 0.0, 1.0))
            }
            Node::Level {} => "dynaudnorm=p=0.95:m=10".to_string(),
            Node::Od { drive, tone, lvl } => format!(
                "volume={:.2}dB,asoftclip=type=tanh:threshold=0.6,lowpass=f={:.1},volume={:.2}dB",
                clamp(*drive, 0.0, 24.0),
                clamp(tone.unwrap_or(6000.0), 1000.0, 12000.0),
                clamp(lvl.unwrap_or(-3.0), -18.0, 6.0),
            ),
            Node::Fuzz { drive, tone, lvl } => format!(
                "volume={:.2}dB,asoftclip=type=hard:threshold=0.35,lowpass=f={:.1},volume={:.2}dB",
                clamp(*drive, 6.0, 30.0),
                clamp(tone.unwrap_or(4500.0), 1000.0, 10000.0),
                clamp(lvl.unwrap_or(-6.0), -18.0, 6.0),
            ),
            Node::Crush { bits, mix } => format!(
                "acrusher=bits={:.1}:mode=log:aa=1:mix={:.2}",
                clamp(*bits, 2.0, 16.0),
                clamp(mix.unwrap_or(0.7), 0.0, 1.0),
            ),
            Node::ChorusFx { rate, depth } => {
                let r = clamp(*rate, 0.1, 4.0);
                let d = clamp(depth.unwrap_or(4.0), 1.0, 8.0);
                format!(
                    "chorus=0.6:0.9:50|62:0.35|0.28:{:.2}|{:.2}:{:.2}|{:.2}",
                    r,
                    r * 1.15,
                    d,
                    d * 0.8,
                )
            }
            Node::FlangerFx { rate, depth, regen } => format!(
                "flanger=speed={:.2}:depth={:.2}:regen={:.1}",
                clamp(*rate, 0.1, 5.0),
                clamp(depth.unwrap_or(4.0), 0.5, 10.0),
                clamp(regen.unwrap_or(20.0), -90.0, 90.0),
            ),
            Node::Phaser { rate, depth } => format!(
                // aphaser's own ceiling for speed is 2.0, not 4.0. Clamping to
                // 4 handed ffmpeg an out-of-range argument and killed the
                // encode for anyone who turned the knob past halfway.
                "aphaser=type=t:speed={:.2}:decay={:.2}",
                clamp(*rate, 0.1, 2.0),
                clamp(depth.unwrap_or(0.5), 0.1, 0.9),
            ),
            Node::Trem { rate, depth } => format!(
                "tremolo=f={:.2}:d={:.2}",
                clamp(*rate, 0.3, 15.0),
                clamp(depth.unwrap_or(0.6), 0.05, 1.0),
            ),
            Node::Vib { rate, depth } => format!(
                "vibrato=f={:.2}:d={:.2}",
                clamp(*rate, 0.3, 12.0),
                clamp(depth.unwrap_or(0.4), 0.05, 1.0),
            ),
            Node::Rotary { rate, width } => format!(
                "apulsator=mode=sine:hz={:.2}:width={:.2}",
                clamp(*rate, 0.05, 8.0),
                clamp(width.unwrap_or(1.0), 0.0, 2.0),
            ),
            Node::Echo { time, fb, mix } => {
                let t = clamp(*time, 60.0, 1500.0);
                let f = clamp(fb.unwrap_or(0.35), 0.05, 0.8);
                let m = clamp(mix.unwrap_or(0.7), 0.05, 1.0);
                // Three taps, geometrically quieter: what feedback sounds
                // like without ever wiring an actual loop into the encoder.
                // Each decay is floored: aecho's range is (0, 1], and at the
                // lowest feedback the third tap rounds to 0.00 at two decimal
                // places, which ffmpeg refuses outright. A refused filter is a
                // dead encode, not a quiet tap.
                format!(
                    "aecho=1.0:{:.2}:{:.0}|{:.0}|{:.0}:{:.2}|{:.2}|{:.2}",
                    m,
                    t,
                    (t * 2.0).min(90000.0),
                    (t * 3.0).min(90000.0),
                    f.max(0.01),
                    (f * f).max(0.01),
                    (f * f * f).max(0.01),
                )
            }
            Node::Spring { size, mix } => {
                let sz = clamp(size.unwrap_or(0.5), 0.0, 1.0);
                let m = clamp(mix.unwrap_or(0.4), 0.05, 1.0);
                let stretch = 0.6 + sz * 1.4;
                let taps: [f64; 6] = [23.0, 37.0, 53.0, 79.0, 113.0, 167.0];
                let delays = taps
                    .iter()
                    .map(|t| format!("{:.0}", t * stretch))
                    .collect::<Vec<_>>()
                    .join("|");
                let decays = (0..6)
                    .map(|i| format!("{:.2}", (m * 0.8_f64.powi(i)).max(0.01)))
                    .collect::<Vec<_>>()
                    .join("|");
                format!("aecho=1.0:{:.2}:{}:{}", (0.5 + m * 0.4).min(0.9), delays, decays)
            }
            Node::Exciter { amt, freq } => format!(
                "aexciter=amount={:.2}:freq={:.1}",
                clamp(*amt, 0.5, 10.0),
                clamp(freq.unwrap_or(7500.0), 2000.0, 12000.0),
            ),
            Node::Sub { wet, cutoff } => format!(
                "asubboost=dry=1.0:wet={:.2}:cutoff={:.1}",
                clamp(*wet, 0.1, 1.0),
                clamp(cutoff.unwrap_or(100.0), 50.0, 200.0),
            ),
            Node::Sparkle { amt } => {
                format!("crystalizer=i={:.2}", clamp(*amt, 0.5, 8.0))
            }
            Node::Doubler { amt } => format!(
                "haas=side_gain={:.2}",
                clamp(amt.unwrap_or(1.0), 0.1, 2.0),
            ),

            // ── The second shelf ──────────────────────────────────────────
            Node::Dist { drive, tone, lvl } => format!(
                "volume={:.2}dB,asoftclip=type=atan:threshold=0.45,lowpass=f={:.1},volume={:.2}dB",
                clamp(*drive, 0.0, 30.0),
                clamp(tone.unwrap_or(5000.0), 800.0, 12000.0),
                clamp(lvl.unwrap_or(-6.0), -24.0, 6.0),
            ),
            Node::Sat { drive, lvl } => format!(
                "volume={:.2}dB,asoftclip=type=sin:threshold=0.8,highshelf=g=-2:f=9000,volume={:.2}dB",
                clamp(*drive, 0.0, 18.0),
                clamp(lvl.unwrap_or(-2.0), -18.0, 6.0),
            ),
            Node::Tube { drive, warmth } => format!(
                "volume={:.2}dB,asoftclip=type=cubic:threshold=0.7,bass=g={:.2}:f=120,volume=-3.00dB",
                clamp(*drive, 0.0, 18.0),
                clamp(warmth.unwrap_or(2.0), 0.0, 8.0),
            ),
            Node::Clip { amt, out } => format!(
                "apsyclip=level_in={:.2}:level_out={:.2}:clip=0.9",
                clamp(*amt, 1.0, 4.0),
                clamp(out.unwrap_or(0.8), 0.1, 1.0),
            ),
            // aeval carries two channel expressions and NO c=same: with it,
            // ffmpeg counts the expressions against the output layout and
            // refuses. Without it the filter handles mono and stereo alike -
            // measured both ways.
            Node::Octafuzz { tone, lvl } => format!(
                "aeval=abs(val(0))|abs(val(1)),lowpass=f={:.1},volume={:.2}dB",
                clamp(tone.unwrap_or(3500.0), 800.0, 9000.0),
                clamp(lvl.unwrap_or(-8.0), -24.0, 0.0),
            ),
            Node::Sizzle { amt } => format!(
                "highshelf=g={:.2}:f=3500,asoftclip=type=tanh:threshold=0.7,volume=-3.00dB",
                clamp(*amt, 1.0, 12.0),
            ),

            Node::Wah { freq, w } => format!(
                "bandpass=f={:.1}:width_type=o:w={:.2},volume=3.00dB",
                clamp(*freq, 250.0, 3000.0),
                clamp(w.unwrap_or(1.2), 0.3, 3.0),
            ),
            Node::Telephone { low, high } => format!(
                "highpass=f={:.1},lowpass=f={:.1},volume=3.00dB",
                clamp(low.unwrap_or(300.0), 100.0, 900.0),
                clamp(high.unwrap_or(3400.0), 1500.0, 8000.0),
            ),
            Node::Radio { grit } => format!(
                "highpass=f=400,lowpass=f=2800,acrusher=bits=10:mode=log:aa=1:mix={:.2}",
                clamp(grit.unwrap_or(0.3), 0.0, 1.0),
            ),
            Node::Megaphone { freq, drive } => format!(
                "bandpass=f={:.1}:width_type=o:w=1.5,asoftclip=type=atan:threshold={:.2},volume=-3.00dB",
                clamp(freq.unwrap_or(1400.0), 500.0, 3000.0),
                // A LOWER threshold is more drive, so the knob is inverted here
                // to keep every "drive" control turning the same way.
                clamp(1.0 - drive.unwrap_or(0.5) * 0.7, 0.2, 1.0),
            ),
            Node::Vinyl { grit } => format!(
                "aemphasis=mode=reproduction:type=cd,highpass=f=60,lowpass=f=11000,acrusher=bits=12:mode=log:aa=1:mix={:.2}",
                clamp(grit.unwrap_or(0.15), 0.0, 1.0),
            ),
            Node::Cassette { wow, tone } => format!(
                "lowpass=f={:.1},vibrato=f=0.6:d={:.2},asoftclip=type=sin:threshold=0.85,highshelf=g=-3:f=8000",
                clamp(tone.unwrap_or(12000.0), 4000.0, 16000.0),
                clamp(wow.unwrap_or(0.08), 0.0, 0.4),
            ),

            Node::Notch { f, w } => format!(
                "bandreject=f={:.1}:width_type=o:w={:.2}",
                clamp(*f, 40.0, 16000.0),
                clamp(w.unwrap_or(1.0), 0.1, 4.0),
            ),
            Node::BandFilter { f, w } => format!(
                "bandpass=f={:.1}:width_type=o:w={:.2}",
                clamp(*f, 60.0, 12000.0),
                clamp(w.unwrap_or(2.0), 0.2, 5.0),
            ),
            Node::Tilt { slope, f } => format!(
                "atilt=freq={:.1}:slope={:.2}",
                clamp(f.unwrap_or(1000.0), 100.0, 10000.0),
                clamp(*slope, -1.0, 1.0),
            ),
            Node::SubCut { f } => format!(
                "asubcut=cutoff={:.1}:order=10",
                clamp(*f, 2.0, 200.0),
            ),
            Node::Presence { g, f } => format!(
                "highshelf=g={:.2}:f={:.1}",
                clamp(*g, -12.0, 12.0),
                clamp(f.unwrap_or(4000.0), 1500.0, 9000.0),
            ),
            Node::Air { g } => format!("highshelf=g={:.2}:f=12000", clamp(*g, -12.0, 12.0)),
            Node::MudCut { g, f } => format!(
                "equalizer=f={:.1}:t=q:w=1.2:g={:.2}",
                clamp(f.unwrap_or(250.0), 120.0, 600.0),
                // Always a cut: a "mud cut" that boosts is a different pedal.
                -clamp(g.unwrap_or(4.0), 0.0, 12.0),
            ),

            Node::Ring { shift } => format!(
                "afreqshift=shift={:.1}",
                clamp(*shift, -500.0, 500.0),
            ),
            Node::AutoPan { rate, width } => format!(
                "apulsator=mode=triangle:hz={:.2}:width={:.2}",
                clamp(*rate, 0.05, 8.0),
                clamp(width.unwrap_or(1.6), 0.0, 2.0),
            ),
            Node::Chop { rate, width } => format!(
                "apulsator=mode=square:hz={:.2}:width={:.2}",
                clamp(*rate, 0.5, 16.0),
                clamp(width.unwrap_or(1.0), 0.0, 2.0),
            ),
            Node::PhaseSpin { amt } => format!(
                "aphaseshift=shift={:.2}",
                clamp(*amt, -1.0, 1.0),
            ),

            Node::Slap { time, mix } => format!(
                "aecho=1.0:{:.2}:{:.0}:0.35",
                clamp(mix.unwrap_or(0.6), 0.05, 1.0),
                clamp(*time, 40.0, 300.0),
            ),
            Node::PingPong { time, mix } => {
                let t = clamp(*time, 60.0, 800.0);
                format!(
                    "adelay={:.0}|0:all=0,aecho=1.0:{:.2}:{:.0}:0.3",
                    t / 2.0,
                    clamp(mix.unwrap_or(0.5), 0.05, 1.0),
                    t,
                )
            }
            Node::Plate { size, mix } => reverb_taps(
                &[29.0, 41.0, 59.0, 83.0, 127.0, 181.0],
                clamp(size.unwrap_or(0.5), 0.0, 1.0),
                clamp(mix.unwrap_or(0.5), 0.05, 1.0),
                0.8,
            ),
            Node::Hall { size, mix } => reverb_taps(
                &[71.0, 113.0, 173.0, 239.0, 331.0, 449.0],
                clamp(size.unwrap_or(0.5), 0.0, 1.0),
                clamp(mix.unwrap_or(0.5), 0.05, 1.0),
                0.82,
            ),
            Node::Room { size, mix } => reverb_taps(
                &[11.0, 17.0, 23.0, 31.0, 43.0, 61.0],
                clamp(size.unwrap_or(0.5), 0.0, 1.0),
                clamp(mix.unwrap_or(0.45), 0.05, 1.0),
                0.78,
            ),
            Node::GatedVerb { size, thr } => {
                let sz = clamp(size.unwrap_or(0.5), 0.0, 1.0);
                let stretch = 0.6 + sz * 1.4;
                let delays = [37.0, 53.0, 79.0, 107.0]
                    .iter()
                    .map(|t| format!("{:.0}", t * stretch))
                    .collect::<Vec<_>>()
                    .join("|");
                format!(
                    "aecho=1.0:0.7:{}:0.6|0.5|0.4|0.3,agate=threshold={:.3}:ratio=4:attack=5:release=60",
                    delays,
                    clamp(thr.unwrap_or(0.05), 0.001, 0.5),
                )
            }
            Node::TapeDelay { time, fb, tone } => {
                let t = clamp(*time, 80.0, 1200.0);
                let f = clamp(fb.unwrap_or(0.45), 0.05, 0.8);
                format!(
                    "aecho=1.0:0.6:{:.0}|{:.0}|{:.0}:{:.2}|{:.2}|{:.2},lowpass=f={:.1}",
                    t,
                    (t * 2.0).min(90000.0),
                    (t * 3.0).min(90000.0),
                    f.max(0.01),
                    (f * f).max(0.01),
                    (f * f * f).max(0.01),
                    clamp(tone.unwrap_or(6000.0), 1500.0, 12000.0),
                )
            }

            Node::Widen { amt } => format!(
                "stereowiden=delay=20:feedback=0.3:crossfeed=0.3:drymix={:.2}",
                // More "amount" means less dry, so the one knob reads forwards.
                clamp(1.0 - *amt * 0.4, 0.2, 1.0),
            ),
            Node::Extra { amt } => format!("extrastereo=m={:.2}", clamp(*amt, 0.0, 4.0)),
            // stereotools cannot reach a true mono (slev bottoms out above 0),
            // so the sum is done with an explicit channel matrix instead.
            Node::Mono {} => "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1".to_string(),
            Node::Earwax {} => "earwax".to_string(),
            Node::VBass { amt, cutoff } => format!(
                "virtualbass=cutoff={:.1}:strength={:.2}",
                clamp(cutoff.unwrap_or(250.0), 100.0, 500.0),
                clamp(*amt, 0.5, 3.0),
            ),
            Node::Decorr { amt } => format!(
                "adecorrelate=stages={:.0}",
                clamp(amt.unwrap_or(4.0), 1.0, 16.0),
            ),

            Node::Gate { thr, ratio, rel } => format!(
                "agate=threshold={:.4}:ratio={:.1}:attack=10:release={:.0}",
                clamp(*thr, 0.0, 0.5),
                clamp(ratio.unwrap_or(3.0), 1.0, 9000.0),
                clamp(rel.unwrap_or(200.0), 10.0, 2000.0),
            ),
            Node::DeEss { amt } => format!(
                "deesser=i={:.2}:m=0.5:f=0.5",
                clamp(*amt, 0.0, 1.0),
            ),
            Node::Punch { amt } => format!("acontrast=contrast={:.1}", clamp(*amt, 0.0, 100.0)),
            Node::Glue { amt } => format!(
                "compand=attacks=0.05:decays=0.5:points=-80/-80|-30/{:.0}|0/-6",
                // One knob walks the middle point: more amount, more squeeze.
                -30.0 + clamp(*amt, 0.0, 1.0) * 15.0,
            ),
            // Normalise to a known sample rate FIRST, then set the rate against
            // it. asetrate takes a number, not an expression, so without the
            // leading aresample the maths would depend on whatever rate the
            // source happens to be and a 44.1k file and a 48k file would play at
            // different speeds from the same knob. The trailing aresample puts
            // the stream back where the encoder expects it.
            Node::Speed { rate } => {
                let r = clamp(*rate, 0.5, 2.0);
                format!(
                    "aresample=44100,asetrate={:.0},aresample=44100",
                    44100.0 * r
                )
            }
            // atempo holds pitch. Its own accepted range starts at 0.5, which is
            // exactly where this clamps, so one instance is always enough.
            Node::Tempo { rate } => format!("atempo={:.4}", clamp(*rate, 0.5, 2.0)),
        }
    }
}

/// Longest chain honoured. Sixteen is more boxes than any desk, and the cap
/// is what keeps a hostile URL from stacking a thousand compressors.
const MAX_NODES: usize = 16;
/// The raw JSON is length-capped before it is even parsed, for the same
/// reason the node count is.
const MAX_WIRE: usize = 4096;

/// Turns the `fx2` query value - a URL-encoded JSON array of nodes - into one
/// `-af` chain, or None when nothing in it survives. Unknown node types and
/// unparseable entries are dropped one by one rather than failing the chain:
/// a newer client against an older server loses the node the server has not
/// heard of, not its whole sound.
pub fn chain_from_wire(fx2: Option<&String>) -> Option<String> {
    let raw = fx2?;
    if raw.is_empty() || raw.len() > MAX_WIRE {
        return None;
    }
    let items: Vec<Value> = serde_json::from_str(raw).ok()?;
    let mut filters: Vec<String> = Vec::new();
    for item in items.into_iter().take(MAX_NODES) {
        if let Ok(node) = serde_json::from_value::<Node>(item) {
            filters.push(node.compile());
        }
    }
    if filters.is_empty() {
        return None;
    }
    // The safety net every chain of boosts earns.
    filters.push("alimiter=limit=0.95".to_string());
    Some(filters.join(","))
}

/// Part 1 of the published vocabulary.
///
/// The catalogue is split across four functions for a mechanical reason: one
/// `json!` literal holding all sixty-five entries exceeds the macro's
/// recursion limit and fails to compile. Four smaller arrays are the same
/// data with none of that.
fn nodes_part1() -> Vec<Value> {
    match json!([
        { "t": "pre",    "params": { "g": { "min": -12, "max": 12, "default": 0 } } },
        { "t": "peq",    "params": { "f": { "min": 20, "max": 20000, "default": 1000 },
                                          "g": { "min": -18, "max": 18, "default": 0 },
                                          "q": { "min": 0.1, "max": 10, "default": 1.0 } } },
        { "t": "bass",   "params": { "g": { "min": -18, "max": 18, "default": 0 },
                                          "f": { "min": 40, "max": 500, "default": 100 } } },
        { "t": "treble", "params": { "g": { "min": -18, "max": 18, "default": 0 },
                                          "f": { "min": 1000, "max": 16000, "default": 8000 } } },
        { "t": "hp",     "params": { "f": { "min": 20, "max": 2000, "default": 30 } } },
        { "t": "lp",     "params": { "f": { "min": 1000, "max": 20000, "default": 18000 } } },
        { "t": "comp",   "params": { "thr": { "min": -60, "max": 0, "default": -18 },
                                          "ratio": { "min": 1, "max": 20, "default": 3 },
                                          "att": { "min": 1, "max": 500, "default": 20 },
                                          "rel": { "min": 20, "max": 2000, "default": 250 },
                                          "mk": { "min": 0, "max": 24, "default": 0 } } },
        { "t": "width",  "params": { "amt": { "min": 0.05, "max": 2.5, "default": 1.0 } } },
        { "t": "xfeed",  "params": { "amt": { "min": 0, "max": 1, "default": 0.5 } } },
        { "t": "level",  "params": {} },
        { "t": "od",      "params": { "drive": { "min": 0, "max": 24, "default": 10 },
                                           "tone": { "min": 1000, "max": 12000, "default": 6000 },
                                           "lvl": { "min": -18, "max": 6, "default": -3 } } },
        { "t": "fuzz",    "params": { "drive": { "min": 6, "max": 30, "default": 16 },
                                           "tone": { "min": 1000, "max": 10000, "default": 4500 },
                                           "lvl": { "min": -18, "max": 6, "default": -6 } } },
        { "t": "crush",   "params": { "bits": { "min": 2, "max": 16, "default": 8 },
                                           "mix": { "min": 0, "max": 1, "default": 0.7 } } },
        { "t": "chorus",  "params": { "rate": { "min": 0.1, "max": 4, "default": 0.9 },
                                           "depth": { "min": 1, "max": 8, "default": 4 } } },
        { "t": "flanger", "params": { "rate": { "min": 0.1, "max": 5, "default": 0.5 },
                                           "depth": { "min": 0.5, "max": 10, "default": 4 },
                                           "regen": { "min": -90, "max": 90, "default": 20 } } },
        { "t": "phaser",  "params": { "rate": { "min": 0.1, "max": 2, "default": 0.6 },
                                           "depth": { "min": 0.1, "max": 0.9, "default": 0.5 } } },
        { "t": "trem",    "params": { "rate": { "min": 0.3, "max": 15, "default": 5 },
                                           "depth": { "min": 0.05, "max": 1, "default": 0.6 } } }
    ]) {
        Value::Array(v) => v,
        // json!([..]) is an array by construction; this arm cannot run.
        _ => Vec::new(),
    }
}

/// Part 2 of the published vocabulary.
///
/// The catalogue is split across four functions for a mechanical reason: one
/// `json!` literal holding all sixty-five entries exceeds the macro's
/// recursion limit and fails to compile. Four smaller arrays are the same
/// data with none of that.
fn nodes_part2() -> Vec<Value> {
    match json!([
        { "t": "vib",     "params": { "rate": { "min": 0.3, "max": 12, "default": 4 },
                                           "depth": { "min": 0.05, "max": 1, "default": 0.4 } } },
        { "t": "rotary",  "params": { "rate": { "min": 0.05, "max": 8, "default": 1.2 },
                                           "width": { "min": 0, "max": 2, "default": 1 } } },
        { "t": "echo",    "params": { "time": { "min": 60, "max": 1500, "default": 350 },
                                           "fb": { "min": 0.05, "max": 0.8, "default": 0.35 },
                                           "mix": { "min": 0.05, "max": 1, "default": 0.7 } } },
        { "t": "spring",  "params": { "size": { "min": 0, "max": 1, "default": 0.5 },
                                           "mix": { "min": 0.05, "max": 1, "default": 0.4 } } },
        { "t": "exciter", "params": { "amt": { "min": 0.5, "max": 10, "default": 2.5 },
                                           "freq": { "min": 2000, "max": 12000, "default": 7500 } } },
        { "t": "sub",     "params": { "wet": { "min": 0.1, "max": 1, "default": 0.6 },
                                           "cutoff": { "min": 50, "max": 200, "default": 100 } } },
        { "t": "sparkle", "params": { "amt": { "min": 0.5, "max": 8, "default": 2 } } },
        { "t": "doubler", "params": { "amt": { "min": 0.1, "max": 2, "default": 1 } } },
        { "t": "dist",      "params": { "drive": { "min": 0, "max": 30, "default": 14 },
                                             "tone": { "min": 800, "max": 12000, "default": 5000 },
                                             "lvl": { "min": -24, "max": 6, "default": -6 } } },
        { "t": "sat",       "params": { "drive": { "min": 0, "max": 18, "default": 6 },
                                             "lvl": { "min": -18, "max": 6, "default": -2 } } },
        { "t": "tube",      "params": { "drive": { "min": 0, "max": 18, "default": 5 },
                                             "warmth": { "min": 0, "max": 8, "default": 2 } } },
        { "t": "clip",      "params": { "amt": { "min": 1, "max": 4, "default": 1.5 },
                                             "out": { "min": 0.1, "max": 1, "default": 0.8 } } },
        { "t": "octafuzz",  "params": { "tone": { "min": 800, "max": 9000, "default": 3500 },
                                             "lvl": { "min": -24, "max": 0, "default": -8 } } },
        { "t": "sizzle",    "params": { "amt": { "min": 1, "max": 12, "default": 4 } } },
        { "t": "wah",       "params": { "freq": { "min": 250, "max": 3000, "default": 900 },
                                             "w": { "min": 0.3, "max": 3, "default": 1.2 } } },
        { "t": "telephone", "params": { "low": { "min": 100, "max": 900, "default": 300 },
                                             "high": { "min": 1500, "max": 8000, "default": 3400 } } },
        { "t": "radio",     "params": { "grit": { "min": 0, "max": 1, "default": 0.3 } } }
    ]) {
        Value::Array(v) => v,
        // json!([..]) is an array by construction; this arm cannot run.
        _ => Vec::new(),
    }
}

/// Part 3 of the published vocabulary.
///
/// The catalogue is split across four functions for a mechanical reason: one
/// `json!` literal holding all sixty-five entries exceeds the macro's
/// recursion limit and fails to compile. Four smaller arrays are the same
/// data with none of that.
fn nodes_part3() -> Vec<Value> {
    match json!([
        { "t": "megaphone", "params": { "freq": { "min": 500, "max": 3000, "default": 1400 },
                                             "drive": { "min": 0, "max": 1, "default": 0.5 } } },
        { "t": "vinyl",     "params": { "grit": { "min": 0, "max": 1, "default": 0.15 } } },
        { "t": "cassette",  "params": { "wow": { "min": 0, "max": 0.4, "default": 0.08 },
                                             "tone": { "min": 4000, "max": 16000, "default": 12000 } } },
        { "t": "notch",     "params": { "f": { "min": 40, "max": 16000, "default": 1000 },
                                             "w": { "min": 0.1, "max": 4, "default": 1 } } },
        { "t": "bandfilter","params": { "f": { "min": 60, "max": 12000, "default": 1200 },
                                             "w": { "min": 0.2, "max": 5, "default": 2 } } },
        { "t": "tilt",      "params": { "slope": { "min": -1, "max": 1, "default": 0.3 },
                                             "f": { "min": 100, "max": 10000, "default": 1000 } } },
        { "t": "subcut",    "params": { "f": { "min": 2, "max": 200, "default": 40 } } },
        { "t": "presence",  "params": { "g": { "min": -12, "max": 12, "default": 4 },
                                             "f": { "min": 1500, "max": 9000, "default": 4000 } } },
        { "t": "air",       "params": { "g": { "min": -12, "max": 12, "default": 4 } } },
        { "t": "mudcut",    "params": { "g": { "min": 0, "max": 12, "default": 4 },
                                             "f": { "min": 120, "max": 600, "default": 250 } } },
        { "t": "ring",      "params": { "shift": { "min": -500, "max": 500, "default": 120 } } },
        { "t": "autopan",   "params": { "rate": { "min": 0.05, "max": 8, "default": 0.8 },
                                             "width": { "min": 0, "max": 2, "default": 1.6 } } },
        { "t": "chop",      "params": { "rate": { "min": 0.5, "max": 16, "default": 4 },
                                             "width": { "min": 0, "max": 2, "default": 1 } } },
        { "t": "phasespin", "params": { "amt": { "min": -1, "max": 1, "default": 0.35 } } },
        { "t": "slap",      "params": { "time": { "min": 40, "max": 300, "default": 120 },
                                             "mix": { "min": 0.05, "max": 1, "default": 0.6 } } },
        { "t": "pingpong",  "params": { "time": { "min": 60, "max": 800, "default": 360 },
                                             "mix": { "min": 0.05, "max": 1, "default": 0.5 } } }
    ]) {
        Value::Array(v) => v,
        // json!([..]) is an array by construction; this arm cannot run.
        _ => Vec::new(),
    }
}

/// Part 4 of the published vocabulary.
///
/// The catalogue is split across four functions for a mechanical reason: one
/// `json!` literal holding all sixty-five entries exceeds the macro's
/// recursion limit and fails to compile. Four smaller arrays are the same
/// data with none of that.
fn nodes_part4() -> Vec<Value> {
    match json!([
        { "t": "plate",     "params": { "size": { "min": 0, "max": 1, "default": 0.5 },
                                             "mix": { "min": 0.05, "max": 1, "default": 0.5 } } },
        { "t": "hall",      "params": { "size": { "min": 0, "max": 1, "default": 0.5 },
                                             "mix": { "min": 0.05, "max": 1, "default": 0.5 } } },
        { "t": "room",      "params": { "size": { "min": 0, "max": 1, "default": 0.5 },
                                             "mix": { "min": 0.05, "max": 1, "default": 0.45 } } },
        { "t": "gatedverb", "params": { "size": { "min": 0, "max": 1, "default": 0.5 },
                                             "thr": { "min": 0.001, "max": 0.5, "default": 0.05 } } },
        { "t": "tapedelay", "params": { "time": { "min": 80, "max": 1200, "default": 300 },
                                             "fb": { "min": 0.05, "max": 0.8, "default": 0.45 },
                                             "tone": { "min": 1500, "max": 12000, "default": 6000 } } },
        { "t": "widen",     "params": { "amt": { "min": 0, "max": 2, "default": 1 } } },
        { "t": "extra",     "params": { "amt": { "min": 0, "max": 4, "default": 1.8 } } },
        { "t": "mono",      "params": {} },
        { "t": "earwax",    "params": {} },
        { "t": "vbass",     "params": { "amt": { "min": 0.5, "max": 3, "default": 2 },
                                             "cutoff": { "min": 100, "max": 500, "default": 250 } } },
        { "t": "decorr",    "params": { "amt": { "min": 1, "max": 16, "default": 4 } } },
        { "t": "gate",      "params": { "thr": { "min": 0, "max": 0.5, "default": 0.02 },
                                             "ratio": { "min": 1, "max": 20, "default": 3 },
                                             "rel": { "min": 10, "max": 2000, "default": 200 } } },
        { "t": "deess",     "params": { "amt": { "min": 0, "max": 1, "default": 0.4 } } },
        { "t": "punch",     "params": { "amt": { "min": 0, "max": 100, "default": 45 } } },
        { "t": "glue",      "params": { "amt": { "min": 0, "max": 1, "default": 0.5 } } },
        // Rate. Published like any other node so a client can DISCOVER whether
        // this server can change speed at all - which is the whole point of the
        // endpoint: a node the encoder does not know applies silently and does
        // nothing, and speed doing nothing is indistinguishable from a slow
        // connection. 0.5..2.0 on both, which is also atempo's own floor.
        { "t": "speed",     "params": { "rate": { "min": 0.5, "max": 2, "default": 0.8 } } },
        { "t": "tempo",     "params": { "rate": { "min": 0.5, "max": 2, "default": 1.0 } } }
    ]) {
        Value::Array(v) => v,
        // json!([..]) is an array by construction; this arm cannot run.
        _ => Vec::new(),
    }
}

/// `GET /api/fx/nodes` - the vocabulary, as data.
///
/// The plugin ships its own catalogue (it has to render offline), but the
/// server publishing what it actually honours - with the real clamp ranges -
/// is what lets a future UI grey out a node an older box would silently drop.
pub async fn nodes() -> Json<Value> {
    let mut nodes: Vec<Value> = Vec::new();
    nodes.extend(nodes_part1());
    nodes.extend(nodes_part2());
    nodes.extend(nodes_part3());
    nodes.extend(nodes_part4());
    Json(json!({ "api": 1, "nodes": nodes }))
}

// --- presets ----------------------------------------------------------------

#[derive(Deserialize)]
pub struct PresetBody {
    pub name: String,
    /// The chain as the wire carries it - a JSON array of nodes.
    pub chain: Value,
}

type ApiResult = Result<Json<Value>, (StatusCode, String)>;

/// `GET /api/fx/presets` - this listener's saved chains.
pub async fn presets(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let rows = state.db.fx_presets(caller.id);
    Ok(Json(json!({ "presets": rows.into_iter().map(|(id, name, chain, updated)| {
        json!({
            "id": id,
            "name": name,
            // Stored canonical (it was validated on the way in), parsed here
            // so the client gets an array, not a string of an array.
            "chain": serde_json::from_str::<Value>(&chain).unwrap_or(Value::Array(vec![])),
            "updatedAt": updated,
        })
    }).collect::<Vec<_>>() })))
}

/// `POST /api/fx/presets` - save a chain under a name. Same name replaces:
/// "save" from the rack means "make this the one called Warm Nights", and two
/// rows with one name would make the picker a lottery.
pub async fn save_preset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PresetBody>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let name = body.name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err((StatusCode::BAD_REQUEST, "a preset needs a name under 60 characters".into()));
    }
    // Validated exactly like the stream would: parse, drop what does not
    // survive, and refuse a preset that compiles to nothing - saving silence
    // under a name is a support ticket later.
    let wire = body.chain.to_string();
    if chain_from_wire(Some(&wire)).is_none() {
        return Err((StatusCode::BAD_REQUEST, "that chain has no nodes this server knows".into()));
    }
    let id = state
        .db
        .fx_preset_save(caller.id, name, &wire)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true, "id": id })))
}

/// `DELETE /api/fx/presets/{id}` - mine only; someone else's id is a 404, not
/// a 403, so ids cannot be probed for existence.
pub async fn delete_preset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult {
    let caller = auth::require_caller(&state.db, &headers)
        .map_err(|s| (s, "sign in first".to_string()))?;
    let gone = state
        .db
        .fx_preset_delete(caller.id, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !gone {
        return Err((StatusCode::NOT_FOUND, "no such preset".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(s: &str) -> Option<String> {
        chain_from_wire(Some(&s.to_string()))
    }

    #[test]
    fn compiles_in_user_order() {
        let chain = wire(r#"[{"t":"lp","f":8000},{"t":"pre","g":3}]"#).unwrap();
        // lp FIRST because the user put it first - the old rack would have
        // reordered these, and not reordering is this rack's whole point.
        assert!(chain.starts_with("lowpass=f=8000.0,volume=3.00dB"));
        assert!(chain.ends_with("alimiter=limit=0.95"));
    }

    #[test]
    fn clamps_and_survives_hostility() {
        // Out-of-range numbers pinned, an unknown node between two real ones
        // dropped, neighbours kept. (An Infinity cannot arrive at all:
        // serde_json refuses 1e999 at parse - measured, not assumed - so the
        // clamp's non-finite arm is belt-and-braces for non-JSON callers.)
        let chain = wire(
            r#"[{"t":"pre","g":900},{"t":"evil","cmd":"x"},{"t":"hp","f":1e308}]"#,
        )
        .unwrap();
        assert!(chain.contains("volume=12.00dB"));
        assert!(chain.contains("highpass=f=2000.0"));
        assert!(!chain.contains("evil"));
        // And the whole-array refusal for a true out-of-range float:
        assert!(wire(r#"[{"t":"pre","g":1e999}]"#).is_none());
    }

    #[test]
    fn no_syntax_can_ride_a_string() {
        // The only strings in the wire format are the tags; a tag that is not
        // in the registry kills its node. Nothing else is ever interpolated.
        assert!(wire(r#"[{"t":"pre,volume=0:x","g":0}]"#).is_none());
        assert!(wire(r#"[{"t":"lavfi"}]"#).is_none());
    }

    #[test]
    fn pedals_compile_with_clamps() {
        // A pedal is several filters in one node: the drive sandwich.
        let chain = wire(r#"[{"t":"od","drive":10}]"#).unwrap();
        assert!(chain.starts_with("volume=10.00dB,asoftclip=type=tanh"));
        assert!(chain.contains("lowpass=f=6000.0"));
        assert!(chain.ends_with("alimiter=limit=0.95"));
        // Echo's fake feedback decays geometrically across its three taps.
        let echo = wire(r#"[{"t":"echo","time":400,"fb":0.5,"mix":0.8}]"#).unwrap();
        assert!(echo.contains("400|800|1200"));
        assert!(echo.contains("0.50|0.25|0.12"));
        // Hostile drive pins to the ceiling instead of leaving the range.
        let hot = wire(r#"[{"t":"fuzz","drive":9000}]"#).unwrap();
        assert!(hot.contains("volume=30.00dB"));
    }


    /// Prints every node compiled at its OWN published defaults, one per line.
    ///
    /// This exists to be piped into ffmpeg (see the null-test in the repo's
    /// notes): a filter string that does not parse does not degrade the sound,
    /// it kills the encode, so "it compiles in Rust" is not enough. Driving it
    /// from the published catalogue also means the defaults the client is told
    /// about are the exact ones proved to work.
    /// Speed normalises the sample rate before setting it.
    ///
    /// asetrate takes a NUMBER, not an expression, so without the leading
    /// aresample the multiplier would be applied against whatever rate the
    /// source happens to carry: the same 0.8 knob would slow a 44.1k file to
    /// 0.8x and a 48k file to 0.735x. This pins the normalise-set-restore shape
    /// and the arithmetic, which is the part that is silently wrong rather than
    /// broken if it regresses.
    #[test]
    fn speed_is_independent_of_the_source_sample_rate() {
        let chain = chain_from_wire(Some(&r#"[{"t":"speed","rate":0.8}]"#.to_string())).expect("compiles");
        assert!(
            chain.starts_with("aresample=44100,asetrate=35280,aresample=44100"),
            "unexpected speed filter: {chain}"
        );

        // Its own range is the clamp, so a wild value cannot reach ffmpeg.
        let fast = chain_from_wire(Some(&r#"[{"t":"speed","rate":9}]"#.to_string())).expect("compiles");
        assert!(fast.contains("asetrate=88200"), "rate not clamped to 2.0: {fast}");
        let slow = chain_from_wire(Some(&r#"[{"t":"speed","rate":0.01}]"#.to_string())).expect("compiles");
        assert!(slow.contains("asetrate=22050"), "rate not clamped to 0.5: {slow}");
    }

    /// Tempo holds pitch, and stays inside atempo's own accepted range so one
    /// instance is always enough - chaining two would be needed beyond it.
    #[test]
    fn tempo_stays_within_atempos_range() {
        let chain = chain_from_wire(Some(&r#"[{"t":"tempo","rate":1.25}]"#.to_string())).expect("compiles");
        assert!(chain.starts_with("atempo=1.2500"), "unexpected tempo filter: {chain}");
        for (asked, want) in [(9.0, "atempo=2.0000"), (0.1, "atempo=0.5000")] {
            let c = chain_from_wire(Some(&format!(r#"[{{"t":"tempo","rate":{asked}}}]"#))).expect("compiles");
            assert!(c.contains(want), "rate {asked} not clamped: {c}");
        }
    }

    #[test]
    fn dump_every_node_at_its_defaults() {
        let mut all: Vec<Value> = Vec::new();
        all.extend(nodes_part1());
        all.extend(nodes_part2());
        all.extend(nodes_part3());
        all.extend(nodes_part4());
        assert_eq!(all.len(), 67, "catalogue size changed; update this count");

        for entry in all {
            let t = entry["t"].as_str().expect("every entry has a tag");
            let mut node = serde_json::Map::new();
            node.insert("t".into(), Value::String(t.to_string()));
            if let Some(params) = entry["params"].as_object() {
                for (key, spec) in params {
                    node.insert(key.clone(), spec["default"].clone());
                }
            }
            let wire = Value::Array(vec![Value::Object(node)]).to_string();
            let compiled = chain_from_wire(Some(&wire))
                .unwrap_or_else(|| panic!("{t} compiled to nothing at its own defaults"));
            // Strip the limiter the chain always appends; the harness adds it.
            let filters = compiled
                .strip_suffix(",alimiter=limit=0.95")
                .unwrap_or(&compiled);
            println!("FXNODE\t{t}\t{filters}");
        }
    }


    /// The same sweep at the EDGES, plus values far outside the published
    /// range so the clamps are proved to land somewhere ffmpeg accepts.
    ///
    /// Defaults are the case least likely to break. A knob at its limit, or a
    /// hostile number pinned by a clamp, is where a filter argument goes out
    /// of range - and that is a dead encode, not a quiet one.
    #[test]
    fn dump_every_node_at_its_extremes() {
        let mut all: Vec<Value> = Vec::new();
        all.extend(nodes_part1());
        all.extend(nodes_part2());
        all.extend(nodes_part3());
        all.extend(nodes_part4());

        // "min"/"max" walk the published range; the last two ignore it
        // entirely, which is what a hostile or simply older client sends.
        for pass in ["min", "max", "under", "over"] {
            for entry in &all {
                let t = entry["t"].as_str().unwrap();
                let mut node = serde_json::Map::new();
                node.insert("t".into(), Value::String(t.to_string()));
                if let Some(params) = entry["params"].as_object() {
                    for (key, spec) in params {
                        let v = match pass {
                            "min" => spec["min"].clone(),
                            "max" => spec["max"].clone(),
                            "under" => json!(-1.0e6),
                            _ => json!(1.0e6),
                        };
                        node.insert(key.clone(), v);
                    }
                }
                let wire = Value::Array(vec![Value::Object(node)]).to_string();
                let compiled = chain_from_wire(Some(&wire))
                    .unwrap_or_else(|| panic!("{t} compiled to nothing at {pass}"));
                let filters = compiled
                    .strip_suffix(",alimiter=limit=0.95")
                    .unwrap_or(&compiled);
                println!("FXEDGE\t{t}:{pass}\t{filters}");
            }
        }
    }


    /// Three filter arguments that ffmpeg REFUSES, all found by sweeping the
    /// knobs to their limits rather than trusting the defaults.
    ///
    /// Each one killed the encode outright rather than sounding wrong, and two
    /// of them were shipped: `echo` at its lowest feedback and `phaser` above
    /// rate 2 would both have taken the stream down for anyone who turned the
    /// knob there.
    #[test]
    fn edge_arguments_stay_inside_what_ffmpeg_accepts() {
        // aecho's decay range is (0, 1] - exclusive of zero. The third tap is
        // feedback cubed, which at the minimum rounds to 0.00 at two decimals.
        let echo = wire(r#"[{"t":"echo","time":350,"fb":0.05,"mix":0.7}]"#).unwrap();
        assert!(!echo.contains("0.00"), "a decay rounded to zero: {echo}");
        let tape = wire(r#"[{"t":"tapedelay","time":300,"fb":0.05}]"#).unwrap();
        assert!(!tape.contains(":0.00"), "a decay rounded to zero: {tape}");

        // aphaser's speed ceiling is 2.0; the clamp used to allow 4.0.
        let fast = wire(r#"[{"t":"phaser","rate":9000}]"#).unwrap();
        assert!(fast.contains("speed=2.00"), "phaser above its ceiling: {fast}");
    }


    /// The published catalogue, as one JSON line.
    ///
    /// Exists so the client's copy of the vocabulary can be diffed against the
    /// server's in CI or by hand. The server is the authority - it clamps
    /// regardless - but a drifted client is a knob that stops early or, worse,
    /// offers a value the server will pin somewhere the user did not ask for.
    #[test]
    fn dump_catalogue_json() {
        let mut all: Vec<Value> = Vec::new();
        all.extend(nodes_part1());
        all.extend(nodes_part2());
        all.extend(nodes_part3());
        all.extend(nodes_part4());
        println!("FXCATALOGUE\t{}", Value::Array(all));
    }

    #[test]
    fn caps_hold() {
        let many = format!(
            "[{}]",
            std::iter::repeat(r#"{"t":"pre","g":1}"#).take(50).collect::<Vec<_>>().join(",")
        );
        let chain = wire(&many).unwrap();
        // 16 nodes + the limiter.
        assert_eq!(chain.matches("volume=").count(), 16);
        let huge = format!(r#"[{{"t":"pre","g":{} }}]"#, "1".repeat(5000));
        assert!(wire(&huge).is_none());
    }
}
