/**
 * The generated library: silent audio, real tags.
 *
 * Both the marketing demo and the E2E harness need a folder of music that is
 * legally distributable and small enough to live in a run directory. The
 * answer, in this house since the demo fixtures were written, is ffmpeg's
 * `anullsrc`: 8 kHz mono silence encodes a four-minute track into about 19 kB
 * and is inaudible by construction.
 *
 * `scripts/make-demo-fixtures.mjs` and `e2e/global-setup.ts` share the
 * generator below rather than each carrying a copy of the ffmpeg incantation,
 * because the two were already drifting - the demo pinned `-b:a 6k` and the
 * E2E rig would have had to rediscover why.
 *
 * THE TAGS ARE THE POINT. The hub's scanner reads real tags (scan.rs ->
 * read_track), and album, artist and book grouping is what half the E2E suites
 * assert on. A folder of untagged silence groups into one nameless blob and
 * proves nothing. So every music file here is tagged the way a tagger would
 * tag it, and the one book here is deliberately NOT - an untagged split-MP3
 * book is the shape the scanner's folder-naming rule exists for.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What a tagger writes. Empty fields are simply not passed to ffmpeg. */
export interface Tags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  /** `n` or `n/total` - ffmpeg maps it to trkn, TRCK or TRACKNUMBER per container. */
  track?: string;
  year?: number;
  genre?: string;
}

export type Codec = 'aac' | 'mp3' | 'flac';

export interface SilenceOptions {
  /** Where to write. Parent directories are created. */
  out: string;
  seconds: number;
  /** Defaults to `aac`, which is what the demo fixtures have always used. */
  codec?: Codec;
  /**
   * Tags to write, or null for a file that carries none at all. Null also
   * strips ffmpeg's own encoder tag, so an "untagged" file really is one.
   */
  tags?: Tags | null;
  /**
   * A JPEG to embed as the cover, by path. Write one with `coverJpeg`.
   *
   * It has to be a FILE, not a `color=` filter graph: a lavfi colour source is
   * a stream with a length, and ffmpeg ends the whole output when it runs out
   * - which silently cut every fourteen-second track down to 0.9 s while the
   * tags still said fourteen. An image file is one frame and bounds nothing.
   */
  cover?: string | null;
}

/** True when ffmpeg is on PATH and runnable. */
export function ffmpegPresent(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Fails loudly and usefully, because a missing ffmpeg is a setup problem. */
export function ensureFfmpeg(what: string): void {
  if (ffmpegPresent()) return;
  throw new Error(
    `ffmpeg is required to build ${what} (it generates the silent audio every track plays).\n` +
      '  Install it (brew install ffmpeg / apt-get install ffmpeg) and re-run.',
  );
}

/** A 300x300 square of flat colour, for embedding as a sleeve. */
export function coverJpeg(out: string, colour: string): void {
  mkdirSync(dirname(out), { recursive: true });
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=300x300`, '-frames:v', '1', '-y', out],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed writing ${out}\n${run.stderr ?? ''}`);
}

/** One silent file, tagged. Throws on any ffmpeg failure - a half-built library is worse than none. */
export function silence(options: SilenceOptions): void {
  const { out, seconds, codec = 'aac', tags, cover } = options;
  mkdirSync(dirname(out), { recursive: true });

  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=8000:cl=mono`];
  if (cover) args.push('-i', cover);
  args.push('-t', String(seconds));
  if (cover) {
    args.push('-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  }

  if (codec === 'flac') args.push('-c:a', 'flac');
  else if (codec === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '8k');
  else args.push('-c:a', 'aac', '-b:a', '6k', '-movflags', '+faststart');

  if (tags === null) {
    // No tags at all, not even ffmpeg's own `encoder`. This is what makes a
    // fixture book untagged in the sense scan.rs cares about.
    args.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact');
  } else if (tags) {
    const pairs: Array<[string, string | number | undefined]> = [
      ['title', tags.title],
      ['artist', tags.artist],
      ['album_artist', tags.albumArtist],
      ['album', tags.album],
      ['track', tags.track],
      ['date', tags.year],
      ['genre', tags.genre],
    ];
    for (const [key, value] of pairs) {
      if (value !== undefined && value !== '') args.push('-metadata', `${key}=${value}`);
    }
  }

  args.push('-y', out);
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed for ${out}\n${run.stderr ?? ''}`);
  }
}

// --- the E2E library ------------------------------------------------------

export interface AlbumFixture {
  artist: string;
  album: string;
  year: number;
  genre: string;
  codec: Codec;
  ext: string;
  cover: string;
  /** `[title, seconds]`, in running order. */
  tracks: Array<[string, number]>;
}

/**
 * Four records, three codecs, two of them by one artist.
 *
 * Invented names, on purpose: the demo fixtures use real records because a
 * marketing page has to look like a real library, but a test suite asserting
 * on "Radiohead" would be asserting on somebody's catalogue. These are chosen
 * to be unambiguous under search - no two share a word - and "Nova Static" has
 * two records so a discography is more than a list of one.
 *
 * The durations are short (12-22 s) because every suite that presses play
 * waits on real wall-clock seconds, and long enough that a position can be
 * watched to advance without the song ending underneath the assertion.
 *
 * ARRAY ORDER IS ADD ORDER, and it is load-bearing. The hub stamps `added_at`
 * with its own clock at insert (db.rs::upsert_track), so a library written all
 * at once arrives inside one millisecond and "Recently added" comes back in
 * whatever order the directory walk happened to take - different on the next
 * run, on the next machine, and on the next filesystem. `writeLibrary` writes
 * one record at a time and lets the caller scan between them, which spreads
 * the stamps out and makes the shelf an ORDER rather than a set. Newest first,
 * so a shelf reads: Longhand, Ember Days, Blue Hour, Field Notes.
 */
export const ALBUMS: AlbumFixture[] = [
  {
    artist: 'The Quiet Ledger',
    album: 'Field Notes',
    year: 2019,
    genre: 'Folk',
    codec: 'mp3',
    ext: 'mp3',
    cover: '#3d5a3f',
    tracks: [
      ['Margin Sketch', 12],
      ['Ink and Weather', 19],
      ['Ledger Line', 21],
    ],
  },
  {
    artist: 'Nova Static',
    album: 'Blue Hour',
    year: 2021,
    genre: 'Electronic',
    codec: 'flac',
    ext: 'flac',
    cover: '#2b3a55',
    tracks: [
      ['Slate Rooftops', 14],
      ['Paper Lantern', 16],
      ['Signal Fade', 18],
      ['Harbour Lights', 20],
    ],
  },
  {
    artist: 'Nova Static',
    album: 'Ember Days',
    year: 2023,
    genre: 'Electronic',
    codec: 'aac',
    ext: 'm4a',
    cover: '#7a3b2e',
    tracks: [
      ['Kindling', 13],
      ['Copper Wire', 15],
      ['Ember Days', 17],
    ],
  },
  {
    artist: 'Marla Vane',
    album: 'Longhand',
    year: 2024,
    genre: 'Jazz',
    codec: 'aac',
    ext: 'm4a',
    cover: '#584070',
    tracks: [
      ['Fountain Pen Blues', 22],
      ['Longhand', 18],
    ],
  },
];

/**
 * The book, deliberately untagged.
 *
 * `Audiobooks/` IS the contract - scan.rs decides a file is a book by that
 * folder name and nothing else - and the chapters carry no tags at all, so
 * the title of each falls back to the file name and the album falls back to
 * the folder. That is exactly the split-MP3 download the folder rule exists
 * for, and `audiobooks` (suite 9) asserts on it: twelve files named
 * `Chapter 1` .. `Chapter 12`, which sort wrong under a naive string sort.
 */
export const BOOK = {
  author: 'Ada Sorrel',
  title: 'The Long Ascent',
  chapters: 12,
  seconds: 8,
};

export interface TrackFixture {
  title: string;
  artist: string;
  album: string;
  trackNo: number;
  seconds: number;
  /** Relative to the music root, exactly as the hub will index it. */
  path: string;
}

export interface LibraryManifest {
  albums: AlbumFixture[];
  tracks: TrackFixture[];
  book: { author: string; title: string; chapters: string[]; paths: string[] };
  /** Every music track plus every chapter. */
  count: number;
}

/** One record, or the book, now on disk - and how many files are there in total. */
export interface Stage {
  label: string;
  /** Every file written so far, which is what the hub should be holding after a scan. */
  total: number;
}

/**
 * Writes the whole library under `musicDir` and returns what it wrote.
 *
 * The manifest is the suites' vocabulary: a spec that wants "the third song of
 * Blue Hour" reads it from here rather than hard-coding a title that a later
 * edit to ALBUMS would quietly invalidate.
 *
 * `onStage` is awaited after each record and after the book, and is where the
 * caller asks the hub for a scan. That is what makes `added_at` an order (see
 * the note on ALBUMS); pass nothing and the whole library simply lands at
 * once, which is fine for anything that does not care.
 */
export async function writeLibrary(
  musicDir: string,
  coverDir: string,
  onStage?: (stage: Stage) => Promise<void>,
): Promise<LibraryManifest> {
  ensureFfmpeg('the E2E library');

  const tracks: TrackFixture[] = [];
  for (const record of ALBUMS) {
    // Beside the music root, never inside it: a loose image under
    // `Audiobooks/` is read as that book's cover, and one under an album
    // folder is one more thing the scanner has to have an opinion about.
    const cover = join(coverDir, `${record.artist} - ${record.album}.jpg`);
    coverJpeg(cover, record.cover);
    record.tracks.forEach(([title, seconds], index) => {
      const trackNo = index + 1;
      const file = `${String(trackNo).padStart(2, '0')} ${title}.${record.ext}`;
      const path = `Music/${record.artist}/${record.album}/${file}`;
      silence({
        out: join(musicDir, path),
        seconds,
        codec: record.codec,
        cover,
        tags: {
          title,
          artist: record.artist,
          albumArtist: record.artist,
          album: record.album,
          track: `${trackNo}/${record.tracks.length}`,
          year: record.year,
          genre: record.genre,
        },
      });
      tracks.push({ title, artist: record.artist, album: record.album, trackNo, seconds, path });
    });
    await onStage?.({ label: `${record.artist} - ${record.album}`, total: tracks.length });
  }

  const chapters: string[] = [];
  const paths: string[] = [];
  for (let n = 1; n <= BOOK.chapters; n += 1) {
    const name = `Chapter ${n}`;
    const path = `Audiobooks/${BOOK.author}/${BOOK.title}/${name}.mp3`;
    silence({ out: join(musicDir, path), seconds: BOOK.seconds, codec: 'mp3', tags: null });
    chapters.push(name);
    paths.push(path);
  }
  await onStage?.({ label: `${BOOK.author} - ${BOOK.title}`, total: tracks.length + chapters.length });

  return {
    albums: ALBUMS,
    tracks,
    book: { author: BOOK.author, title: BOOK.title, chapters, paths },
    count: tracks.length + chapters.length,
  };
}
