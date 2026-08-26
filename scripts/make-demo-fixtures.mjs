/**
 * The demo library: a fixture hub for the marketing site.
 *
 * attack.fm shows the REAL app rather than screenshots of it (see
 * vite.demo.config.ts), and the app needs a library to show. This writes one:
 * the JSON the server would have answered with, and the cover for each record.
 *
 * The records are real - see demo-albums.mjs for why they are sourced rather
 * than invented - and so is the artwork: `src/assets/wall` already ships these
 * sleeves for the site's hero wall, so pointing the fixture at them adds no
 * new material to the repo and keeps one copy of each file.
 *
 * Output lands in site/public/demo-hub, which is generated and git-ignored.
 * It is the SITE's public tree deliberately: fixtures under the app's own
 * public/ would be copied into the phone build and shipped to listeners.
 */
import { copyFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALBUMS, seconds } from './demo-albums.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALL = join(ROOT, 'src/assets/wall');
const OUT = join(ROOT, 'site/public/demo-hub');
const API = join(OUT, 'api');
const ART = join(API, 'art');
const MEDIA = join(OUT, 'media');

/** A deterministic PRNG, so a rebuild does not reshuffle the whole page. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
mkdirSync(MEDIA, { recursive: true });



/*
 * Fixed, never `Date.now()`.
 *
 * "Added 3 days ago" has to mean the same thing in every build, or the shelf
 * order on the marketing page depends on the hour it was deployed and no two
 * screenshots of it agree.
 */
const NOW = 1_767_200_000_000; // 2026-01-01, in epoch MILLISECONDS - which is
const DAY = 86_400_000;        // the unit the server's `addedAt` is in, and the
                               // unit SongTable feeds straight to new Date().
                               // Seconds here dated the whole library to 1970.

const tracks = [];
const byTitle = new Map();
let id = 1;

ALBUMS.forEach((rec, ai) => {
  copyFileSync(join(WALL, rec.art), join(ART, rec.art));
  const r = rng(ai * 104729 + 7);
  rec.tracks.forEach(([title, clock], n) => {
    const duration = seconds(clock);
    const lossless = rec.format === 'flac';
    const track = {
      id,
      title,
      artist: rec.artist,
      albumArtist: rec.artist,
      album: rec.album,
      trackNo: n + 1,
      discNo: 1,
      year: rec.year,
      genre: rec.genre,
      lyrics: '',
      duration,
      codec: rec.format,
      lossless,
      sampleRate: 44100,
      bitDepth: lossless ? 16 : 0,
      channels: 2,
      // A believable spread: lossless rips vary with the music, AAC does not.
      bitrate: lossless ? 820 + Math.round(r() * 320) : 256,
      sizeBytes: Math.round((duration * (lossless ? 176400 : 32000)) / (lossless ? 8 : 1)),
      /*
       * Interleaved across records, not blocked by album.
       *
       * An import adds a whole record at once, but a LIBRARY is built a record
       * at a time over years - and "Recently added" showing four faces of the
       * same sleeve is the tell that nothing here is real.
       */
      addedAt: NOW - ((n * ALBUMS.length + ai) * DAY * 2 + ai * 3_600),
      artId: rec.art,
      rev: id,
      kind: 'music',
      path: `Music/${rec.artist}/${rec.album}/${String(n + 1).padStart(2, '0')} ${title}.${rec.format}`,
    };
    tracks.push(track);
    byTitle.set(`${rec.artist} - ${title}`, id);
    id += 1;
  });
});

/** Look a track up the way a person would name it, and fail loudly. */
function pick(...names) {
  return names.map((name) => {
    const found = byTitle.get(name);
    if (!found) throw new Error(`demo fixture: no such track ${name}`);
    return found;
  });
}

const write = (name, value) => writeFileSync(join(API, name), JSON.stringify(value));

write('library.json', { rev: id, more: false, tracks, removed: [] });
write('me.json', {
  id: 1, username: 'demo', isAdmin: false,
  streamToken: 'demo.0.99999999999.demo', streamTokenExpires: 86_400,
});
write('server.json', {
  api: 1, name: 'Demo library', needsSetup: false,
  tracks: tracks.length, transcode: false, version: '0.0.0',
});

// Hearts, spread across records rather than clustered on one - a person's
// liked songs are not one album.
write('favorites.json', {
  tracks: pick(
    'Radiohead - Weird Fishes/Arpeggi',
    'Radiohead - Let Down',
    'Fleetwood Mac - The Chain',
    'Fleetwood Mac - Dreams',
    'Miles Davis - Blue in Green',
    'Nirvana - Heart-Shaped Box',
    'Amy Winehouse - Love Is a Losing Game',
    'Tame Impala - Apocalypse Dreams',
    'Arctic Monkeys - Do I Wanna Know?',
    'Daft Punk - Instant Crush',
    'Kendrick Lamar - Alright',
    'The Weeknd - Call Out My Name',
    'SZA - Broken Clocks',
  ),
});

/*
 * The DJ set.
 *
 * A live set is normally written by the model on the hub from what this
 * listener has actually played, and there is no hub here - so the set is
 * canned, and it is canned from THIS library, which is what makes it read as
 * a set rather than a placeholder. The lines are the demo's own words about
 * the demo's own records.
 */
write('dj.json', {
  ai: true,
  vibe: 'something with its feet up',
  blocks: [
    {
      say: "Starting where the room is already quiet. Three that never ask for anything.",
      trackIds: pick(
        'Miles Davis - Blue in Green', 'Fleetwood Mac - Songbird', 'Radiohead - Nude',
      ),
    },
    {
      say: "You keep coming back to records that sound like the room they were cut in. Here are two more of those.",
      trackIds: pick('Amy Winehouse - Love Is a Losing Game', "Fleetwood Mac - I Don't Want to Know"),
    },
    {
      say: "Lifting it. Same decade, twice the pulse - and the second one is a gamble, it has never come up for you before.",
      trackIds: pick(
        'Tame Impala - Feels Like We Only Go Backwards', 'Arctic Monkeys - Arabella',
        'Daft Punk - Instant Crush',
      ),
    },
    {
      say: "Landing it somewhere long. Put this on and go and do something else.",
      trackIds: pick('Radiohead - Weird Fishes/Arpeggi', 'Miles Davis - Flamenco Sketches'),
    },
  ],
});

write('playlists.json', {
  playlists: [
    {
      id: 1, name: 'Late shift', description: 'For the hours nobody else is up.',
      folder: '', coverUrl: null, createdAt: NOW - 9 * DAY,
      tracks: pick(
        'Radiohead - Videotape', 'Miles Davis - Blue in Green', 'The Weeknd - Wasted Times',
        'SZA - Normal Girl', 'Tame Impala - One More Hour', 'Radiohead - Nude',
        'Amy Winehouse - Wake Up Alone',
      ),
    },
    {
      id: 2, name: 'Kitchen radio', description: '',
      folder: '', coverUrl: null, createdAt: NOW - 54 * DAY,
      tracks: pick(
        'Fleetwood Mac - Go Your Own Way', 'Daft Punk - Get Lucky',
        'Arctic Monkeys - R U Mine?', 'Amy Winehouse - Rehab',
        'Fleetwood Mac - Say You Love Me', 'Tame Impala - Feels Like We Only Go Backwards',
      ),
    },
    {
      id: 3, name: 'Long drive', description: 'Nothing under four minutes.',
      folder: '', coverUrl: null, createdAt: NOW - 120 * DAY,
      tracks: pick(
        'Radiohead - Paranoid Android', 'Daft Punk - Giorgio by Moroder',
        'Miles Davis - So What', 'Kendrick Lamar - Mortal Man',
        'Tame Impala - Apocalypse Dreams', 'Radiohead - Weird Fishes/Arpeggi',
      ),
    },
    {
      id: 4, name: 'Sunday morning', description: 'Volume low, curtains open.',
      folder: '', coverUrl: null, createdAt: NOW - 210 * DAY,
      tracks: pick(
        'Fleetwood Mac - Songbird', 'Miles Davis - Flamenco Sketches',
        'Fleetwood Mac - Landslide', 'Radiohead - Faust Arp',
        'Miles Davis - Will o\' the Wisp', 'Nirvana - Dumb',
      ),
    },
  ],
});

/*
 * WHAT EVERY TRACK PLAYS: silence, one file per length.
 *
 * The page shows the app really playing, and that needs a real media element
 * with a real clock. It cannot be the music - these are other people's
 * recordings on a public page - so demo.html substitutes silence for every
 * stream URL.
 *
 * One file per DURATION, not one file for everything, because the transport
 * reads its length off the media element and not off the tag (see
 * timelineDuration in deckShared.ts, which is right to prefer the element:
 * that is the length of what is actually coming out). A single long file made
 * every song on the page claim to be twenty-eight minutes, contradicting the
 * running time printed beside it in the very same list.
 *
 * 8 kHz mono is inaudible-by-construction anyway and encodes a four-minute
 * silence into about 19 kB; 145 lengths come to under 3 MB, fetched one small
 * file at a time.
 */
const lengths = [...new Set(tracks.map((t) => t.duration))].sort((a, b) => a - b);
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('\n  ffmpeg is required to build the demo fixtures (it generates the');
  console.error('  silent audio each track plays). Install it and re-run.\n');
  process.exit(1);
}
for (const secs of lengths) {
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
    '-t', String(secs), '-c:a', 'aac', '-b:a', '6k', '-movflags', '+faststart',
    '-y', join(MEDIA, `${secs}.m4a`),
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${secs}s`);
}

/*
 * The id -> length map, as a classic script.
 *
 * demo.html has to rewrite a stream URL the instant the app assigns it, which
 * is synchronous - so this cannot be something the shim fetches. Loading it as
 * a blocking <script> before the shim is what guarantees the map is in hand
 * before the first note.
 */
const map = Object.fromEntries(tracks.map((t) => [t.id, t.duration]));
writeFileSync(join(MEDIA, 'streams.js'), `window.__demoStreams=${JSON.stringify(map)};\n`);

const hours = (tracks.reduce((a, t) => a + t.duration, 0) / 3600).toFixed(1);
console.log(`demo fixtures: ${ALBUMS.length} albums · ${tracks.length} tracks · ${hours}h`);
console.log(`  ${lengths.length} silent lengths · ${OUT.replace(`${ROOT}/`, '')}`);
