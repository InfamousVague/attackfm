/**
 * The four answers that have to agree with each other.
 *
 * `cacheQuality.ts` says of itself that these are "consulted from three places
 * (the sweep, hand-pins, the files pane). Split them up and they drift." The
 * two that carry a documented production failure are the ones with the most
 * cases here:
 *
 *   - `wantedQuality`'s up-convert guard, which is also what stops requalify
 *     looping forever - re-fetch, still not `.aac256`, re-fetch, every sweep;
 *   - `estimateBytes`, whose absence made a 15 GB budget fill about 2 GB while
 *     the receipt insisted the songs "would not fit in the space allowed".
 */
import { describe, expect, it } from 'vitest';
import {
  estimateBytes,
  estimateSetBytes,
  extFor,
  qualityLabel,
  qualityOfPath,
  type QualitySource,
} from './cacheQuality.ts';
import { wantedQuality } from './cacheQuality.ts';

const flac: QualitySource = { codec: 'flac', lossless: true, duration: 240 };
const mp3At128: QualitySource = { codec: 'mpeg', lossless: false, bitrate: 128, duration: 240 };
const mp3At320: QualitySource = { codec: 'mpeg', lossless: false, bitrate: 320, duration: 240 };

describe('wantedQuality', () => {
  it('leaves everything alone when the setting is Lossless', () => {
    expect(wantedQuality(flac, 0)).toBe(0);
    expect(wantedQuality(mp3At320, 0)).toBe(0);
  });

  it('always transcodes a lossless source, because it always shrinks', () => {
    expect(wantedQuality(flac, 128)).toBe(128);
    expect(wantedQuality(flac, 256)).toBe(256);
  });

  it('REFUSES TO UP-CONVERT an already-lossy file', () => {
    /*
     * A 128k MP3 re-encoded to 256k AAC is bigger than the original and
     * audibly worse than it, having been through two lossy encoders. Quality 0
     * means "take the file as it is".
     */
    expect(wantedQuality(mp3At128, 256)).toBe(0);
    // At exactly the target it is also left alone - `<=`, not `<`. Re-encoding
    // 128 to 128 costs a whole download for a file that is measurably worse.
    expect(wantedQuality(mp3At128, 128)).toBe(0);
  });

  it('DOES transcode a lossy file down', () => {
    // The third case: the guard is not "never touch a lossy file". A 320k MP3
    // asked for at 128 really does shrink, so it really is re-encoded - and a
    // test suite that only proved the refusals would also pass against a
    // function that returned 0 for everything.
    expect(wantedQuality(mp3At320, 128)).toBe(128);
  });

  it('leaves a file alone when nobody can say what rate it runs at', () => {
    // "Re-encoding a file whose size nobody can account for is the one case
    // with no upside."
    expect(wantedQuality({ codec: 'mpeg' }, 128)).toBe(0);
    expect(wantedQuality({ codec: 'mpeg', bitrate: null, duration: null }, 128)).toBe(0);
    expect(wantedQuality({ codec: 'mpeg', bitrate: 0 }, 128)).toBe(0);
  });

  it('works out the rate from size and duration when no bitrate is stated', () => {
    /*
     * `Track` (the hand-pin path) has no `bitrate` field, only a size and a
     * duration - and those two ARE the bitrate. Without this the guard would
     * be weaker on exactly the path where somebody is watching one song.
     *
     * 240 s at 320 kbps is 9,600,000 bytes; asked for at 128 it transcodes,
     * and the same file asked for at 320 does not.
     */
    const sized: QualitySource = { codec: 'mpeg', sizeBytes: 9_600_000, duration: 240 };
    expect(wantedQuality(sized, 128)).toBe(128);
    expect(wantedQuality(sized, 320)).toBe(0);
  });

  it('cannot loop: what it asks for is stable across a second pass', () => {
    // The requalify loop the guard exists to prevent. Once a track is held at
    // quality 0 it must keep answering 0, or every sweep re-fetches it for good.
    const first = wantedQuality(mp3At128, 256);
    expect(first).toBe(0);
    expect(wantedQuality(mp3At128, 256)).toBe(first);
  });
});

describe('extFor and qualityOfPath', () => {
  it('round-trips a transcoded quality through the filename', () => {
    // The quality record IS the file, which is the only per-file record that
    // cannot desynchronise from it.
    for (const q of [96, 128, 192, 256]) {
      expect(qualityOfPath(`deadbeef.${extFor(flac, q)}`)).toBe(q);
    }
  });

  it('names an untranscoded file after its codec', () => {
    expect(extFor(flac, 0)).toBe('flac');
    expect(extFor({ codec: 'mp4' }, 0)).toBe('mp4');
  });

  it('strips anything that is not a letter or a digit out of a codec name', () => {
    // The extension has to survive `file_stem()`, which means exactly one dot.
    expect(extFor({ codec: 'x-flac/1' }, 0)).toBe('xflac1');
    expect(extFor({ codec: '' }, 0)).toBe('audio');
    expect(extFor({}, 0)).toBe('audio');
    expect(extFor({ codec: '///' }, 0)).toBe('audio');
  });

  it('puts the digits at the END, so a hex stem stays unambiguous', () => {
    // `<hex>.128.aac` WOULD break `entry_of`: the stem would be `<hex>.128`
    // and the file would vanish from `offline_list`.
    expect(extFor(flac, 128)).toBe('aac128');
    expect(extFor(flac, 128)).not.toContain('.');
  });

  it('reads every pre-existing file as lossless, with no migration', () => {
    // Every file already on disk is named for its codec - lofty's names, not
    // real extensions - and none of them match /\.aac(\d+)$/.
    expect(qualityOfPath('/vault/deadbeef.flac')).toBe(0);
    expect(qualityOfPath('/vault/deadbeef.mpeg')).toBe(0);
    expect(qualityOfPath('/vault/deadbeef.mp4')).toBe(0);
    // And a bare `.aac` with no number is not a quality claim either.
    expect(qualityOfPath('/vault/deadbeef.aac')).toBe(0);
  });

  it('only matches the extension, never a number in the path', () => {
    expect(qualityOfPath('/aac256/deadbeef.flac')).toBe(0);
  });
});

describe('estimateBytes', () => {
  it('uses the ORIGINAL size only when nothing is being transcoded', () => {
    expect(estimateBytes({ sizeBytes: 12345 }, 0, 999)).toBe(12345);
  });

  it('falls back to an average song when the index cannot size it', () => {
    expect(estimateBytes({}, 0, 42)).toBe(42);
  });

  it('SIZES THE TRANSCODE, not the source', () => {
    /*
     * The failure this prevents: at 128k the server's `sizeBytes` overstates
     * the cost by roughly seven times, so the planner fills about 2 GB of a
     * 15 GB budget and the shortfall line actively lies.
     *
     * 240 s at 128 kbps, plus 3% ADTS framing.
     */
    expect(estimateBytes(flac, 128, 0)).toBe(Math.ceil((128_000 / 8) * 240 * 1.03));
    // And it ignores the source size entirely on that path.
    expect(estimateBytes({ ...flac, sizeBytes: 50 * 1024 ** 2 }, 128, 0)).toBe(
      estimateBytes(flac, 128, 0),
    );
  });

  it('over-estimates rather than under-estimates', () => {
    // "A budget that holds slightly less than it could is the cheaper mistake."
    const exact = (128_000 / 8) * 240;
    expect(estimateBytes(flac, 128, 0)).toBeGreaterThan(exact);
  });

  it('assumes four minutes for a track with no duration', () => {
    expect(estimateBytes({ codec: 'flac', lossless: true }, 128, 0)).toBe(
      estimateBytes(flac, 128, 0),
    );
    expect(estimateBytes({ duration: 0 }, 128, 0)).toBe(estimateBytes({ duration: 240 }, 128, 0));
  });

  it('returns whole bytes', () => {
    expect(Number.isInteger(estimateBytes({ duration: 187 }, 192, 0))).toBe(true);
  });
});

describe('estimateSetBytes', () => {
  it('plans a set with the same two functions the sweep budgets with', () => {
    /*
     * The number a person reads and the number the cache plans against cannot
     * drift, because they are produced by the same pair. A lossless track is
     * sized as its transcode; an already-lossy one keeps its own size, because
     * `wantedQuality` refused to re-encode it.
     */
    const lossy: QualitySource = { ...mp3At128, sizeBytes: 3_840_000 };
    const total = estimateSetBytes([flac, lossy], 128, 0);
    expect(total).toBe(estimateBytes(flac, 128, 0) + 3_840_000);
  });

  it('does not discount what is already held', () => {
    // The question is what keeping this WOULD cost, which is the one a person
    // asks before deciding.
    expect(estimateSetBytes([flac, flac], 128, 0)).toBe(2 * estimateBytes(flac, 128, 0));
  });

  it('is zero for nothing', () => {
    expect(estimateSetBytes([], 128, 0)).toBe(0);
  });
});

describe('qualityLabel', () => {
  it('says "Original" rather than "Lossless" for a held file', () => {
    // Quality 0 means the file was taken as-is, which is lossless only when
    // the library's copy was - and a 128k MP3 is stored at quality 0 too.
    expect(qualityLabel(0)).toBe('Original');
    expect(qualityLabel(0)).not.toBe('Lossless');
  });

  it('names the rate otherwise', () => {
    expect(qualityLabel(128)).toBe('128k');
    expect(qualityLabel(256)).toBe('256k');
  });
});
