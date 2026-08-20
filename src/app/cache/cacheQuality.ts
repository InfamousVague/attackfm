//! What quality a cached file is, and how big it will be.
//!
//! One small module because these four answers have to agree with each other,
//! and they are consulted from three places (the sweep, hand-pins, the files
//! pane). Split them up and they drift.
//!
//! **The quality lives in the FILENAME**, as the extension: `<hex>.aac128`.
//! That sounds like a hack and is the opposite - it is the only per-file record
//! that cannot go out of sync with the file, because it IS the file. The
//! alternatives were a parallel ledger (which a restore, a wipe or an OS reclaim
//! can desynchronise - the sweep's own doc comment says the disk is the index)
//! or a re-probe of every file on every sweep.
//!
//! It also costs nothing to adopt, and is retroactive: every file already on
//! disk is named for its codec (`.flac`, `.mpeg`, `.mp4` - lofty's names, not
//! real extensions), none of which match `/\.aac(\d+)$/`, so they all read as
//! lossless without a migration.
//!
//! Two facts make the scheme safe, both verified rather than assumed:
//!   - `entry_of` recovers the key from `file_stem()`, and a hex stem contains
//!     no dot, so a multi-character extension is unambiguous. `<hex>.128.aac`
//!     WOULD break it - the stem would be `<hex>.128` and the file would vanish
//!     from `offline_list`. Hence one dot, digits at the end.
//!   - Nothing infers MIME from the extension. Tauri's URI fallback table has no
//!     audio types at all, so every held file - `.flac` today - is already
//!     served by content sniffing the magic bytes. `.aac128` is no more exotic
//!     to that path than `.mpeg` already is.

/**
 * What these functions need to know about a track.
 *
 * Structural rather than `RemoteTrack` because hand-pins go through `Track`,
 * which carries most of the same fields under the same names but has no
 * `bitrate`. Everything is optional so both satisfy it without a conversion.
 */
export interface QualitySource {
  codec?: string;
  lossless?: boolean;
  bitrate?: number | null;
  duration?: number | null;
  sizeBytes?: number;
}

/** A track nobody could size: four minutes, the length of most songs. */
const ASSUMED_SECONDS = 240;

/**
 * What this file already runs at, in kbps, or null if it cannot be worked out.
 *
 * `RemoteTrack` states a bitrate outright. `Track` does not, but it carries the
 * size and the duration, and those two ARE the bitrate - so the guard below
 * works identically on both rather than being weaker on the hand-pin path,
 * which is the one place somebody is watching a specific song.
 */
function currentKbps(t: QualitySource): number | null {
  if (t.bitrate && t.bitrate > 0) return t.bitrate;
  if (t.sizeBytes && t.duration && t.duration > 0) {
    return (t.sizeBytes * 8) / t.duration / 1000;
  }
  return null;
}

/**
 * The quality this track should actually be fetched at.
 *
 * Not simply the setting: transcoding is only worth doing when it makes the
 * file SMALLER. A 128k MP3 re-encoded to 256k AAC is bigger than the original
 * and audibly worse than it, having been through two lossy encoders. So a track
 * already at or below the target keeps its original file.
 *
 * That guard is also what stops requalify looping forever. Without it the MP3
 * above is held as `.mpeg` (reading as lossless), wanted at 256, re-fetched,
 * still held as something that is not `.aac256`... every sweep, for good.
 */
export function wantedQuality(track: QualitySource, setting: number): number {
  if (setting === 0) return 0;
  // A lossless source always shrinks, so it always transcodes. Only an
  // already-lossy file can be made worse by this.
  if (track.lossless) return setting;
  const now = currentKbps(track);
  // Unknown rate and not known-lossless: leave it alone. Re-encoding a file
  // whose size nobody can account for is the one case with no upside.
  if (now === null) return 0;
  return now <= setting ? 0 : setting;
}

/** The extension to store this track under, which is also its quality record. */
export function extFor(track: QualitySource, quality: number): string {
  if (quality === 0) return (track.codec || '').replace(/[^a-z0-9]/gi, '') || 'audio';
  return `aac${quality}`;
}

/** The quality a file on disk is holding, read back out of its name. */
export function qualityOfPath(path: string): number {
  const m = /\.aac(\d+)$/.exec(path);
  return m ? Number(m[1]) : 0;
}

/**
 * How many bytes this track will take at this quality.
 *
 * The budget planner cannot use the server's `sizeBytes` once transcoding is on:
 * that is the ORIGINAL file's length, so at 128k it over-states the cost by
 * roughly seven times. Left alone, a 15GB budget would fill about 2GB and the
 * receipt would still say songs "would not fit in the space allowed" - the
 * shortfall line would be actively lying.
 *
 * The 1.03 is ADTS framing: a 7-byte header per 1024-sample frame is about
 * 2.4kbps at 44.1kHz. Rounded up rather than down on purpose - over-estimating
 * fills slightly less of the disk than allowed, which is the harmless direction.
 *
 * Measured against real encodes of 30s of pink noise, this lands within about a
 * percent at 96k (+0.2%), 128k (+0.9%) and 192k (+1.6%), and about 18% high at
 * 256k. The 256 case is not a bug in the arithmetic: ffmpeg's NATIVE `aac`
 * encoder saturates near 223kbps for 44.1kHz stereo, so it returns fewer bytes
 * than were asked for.
 *
 * Deliberately NOT corrected for. A ceiling fitted to that encoder would
 * under-estimate on a server built with libfdk_aac, which does reach 256 - and
 * under-estimating over-fills the disk, which is the direction that actually
 * hurts. A budget that holds slightly less than it could is the cheaper mistake.
 */
export function estimateBytes(track: QualitySource, quality: number, assumedBytes: number): number {
  if (quality === 0) return track.sizeBytes || assumedBytes;
  const seconds = track.duration && track.duration > 0 ? track.duration : ASSUMED_SECONDS;
  return Math.ceil(((quality * 1000) / 8) * seconds * 1.03);
}

/**
 * What to call a HELD FILE's quality in front of a person.
 *
 * "Original" rather than "Lossless" for quality 0, and the difference matters:
 * 0 means the file was taken as-is, which is lossless only when the library's
 * copy was. A 128k MP3 is stored at quality 0 too - the up-convert guard sends
 * every already-lossy track down that path on purpose - and labelling it
 * "Lossless" states something about the music that is simply untrue.
 *
 * The SETTING keeps the word Lossless, because there it describes the choice
 * being made - send the original, do not re-encode - rather than a file.
 */
export function qualityLabel(quality: number): string {
  if (quality === 0) return 'Original';
  return `${quality}k`;
}
