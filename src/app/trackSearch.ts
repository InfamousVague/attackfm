import type { Track } from './tauri.ts';

/**
 * The app's own local-library search, shared by the ⌘K palette, the page-level
 * search bars (Home, Library) and the library half of Discover's blended
 * results, so they all agree on what "matches" means. Lives apart from any
 * component because four surfaces call it.
 */

// Fold to lowercase words separated by single spaces, dropping punctuation, so a
// typed phrase matches a lyric across the commas and line breaks it really has.
// Accents go too, and apostrophes vanish rather than splitting a word: nobody
// reaches for the option key mid-search, so "bjork" has to find Björk and "dont"
// has to find "Don't". Both sides of every comparison come through here, so this
// only ever makes a query match more - never less.
export const flatten = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/['\u2019\u02bc]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A track's searchable text, already folded. */
interface Folded {
  title: string;
  artist: string;
  /** Title, artist, album and genre in one blob, for the word-AND. */
  meta: string;
  /** Empty when the track carries none. */
  lyrics: string;
}

/**
 * The folded text of every track that has been searched, kept against the track
 * object itself.
 *
 * Folding is cheap per track and ruinous per library: a shelf's worth of lyrics
 * is around a megabyte of prose, and without this every keystroke on every
 * search bar puts all of it through two Unicode regexes - tens of milliseconds
 * that land squarely between the key and the letter appearing. A track's text
 * never changes (a re-sync builds new objects rather than editing these), so the
 * work is done once and collected with the track when the library moves on.
 */
const folded = new WeakMap<Track, Folded>();

function foldTrack(track: Track): Folded {
  let f = folded.get(track);
  if (!f) {
    f = {
      title: flatten(track.title),
      artist: flatten(track.artist),
      meta: flatten(`${track.title} ${track.artist} ${track.album} ${track.genre}`),
      lyrics: track.lyrics.length > 0 ? flatten(track.lyrics) : '',
    };
    folded.set(track, f);
  }
  return f;
}

/**
 * Whether a track answers the query. Metadata (title, artist, album, genre) is
 * word-ANDed - every typed word must appear somewhere in it - while lyrics are
 * matched as a contiguous phrase. Splitting them is the point: a lyric is long
 * prose where the short words of any query turn up scattered everywhere, so only
 * the phrase typed verbatim should count there.
 */
export function matches(track: Track, phrase: string, words: string[]): boolean {
  const f = foldTrack(track);
  if (words.every((w) => f.meta.includes(w))) return true;
  return f.lyrics.length > 0 && f.lyrics.includes(phrase);
}

/**
 * Filter a track list by a raw query string. An empty (or whitespace) query
 * returns the list unchanged, so callers can bind it straight to an input and
 * fall back to the full library when the field is cleared.
 */
export function filterTracks(tracks: readonly Track[], query: string): Track[] {
  const phrase = flatten(query);
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 0) return tracks as Track[];
  return tracks.filter((t) => matches(t, phrase, words));
}

/**
 * What the library itself holds for a query, ranked for a results page: the
 * artists the words name, then the songs, best match first.
 *
 * `filterTracks` answers "does this track match" for a list being filtered in
 * place, which is all a Library page needs - it shows every hit and the order
 * is the shelf's own. A search that ALSO reaches a catalogue needs more: its
 * local hits share the page with results from elsewhere, so only the first
 * handful are shown and they have to arrive in an order worth truncating.
 */

/** An artist the library has, as a search hit. */
export interface LocalArtist {
  name: string;
  /** The first cover found among their tracks, for the card. */
  cover: string | null;
  /** How many of their songs the library holds. */
  count: number;
}

export interface LocalHits {
  artists: LocalArtist[];
  tracks: Track[];
}

/** Past the last rank either scorer gives: "this did not match at all". */
const NO_MATCH = 9;

/** Where an artist matched, best first: the name as typed, then its words
 *  scattered through a longer billing ("Tyler" in "Tyler, The Creator"). Takes
 *  the name already through `flatten`. */
function artistRank(name: string, phrase: string, words: string[]): number {
  // "The Marías" answers to "marias": the article is how a name is filed, not
  // how anyone types it.
  const bare = name.startsWith('the ') ? name.slice(4) : name;
  if (name === phrase || bare === phrase) return 0;
  if (name.startsWith(phrase) || bare.startsWith(phrase)) return 1;
  if (name.includes(phrase)) return 2;
  return words.every((w) => name.includes(w)) ? 3 : NO_MATCH;
}

/** Where a track matched, best first. Typing an artist's name outright puts
 *  their songs above anyone else's that merely mention them - searching
 *  "ashnikko" wants Ashnikko, not a Lady Gaga remix she guested on. Below that
 *  a title hit is what the typist meant, and a lyric hit is a long shot that is
 *  right often enough to keep but never ahead of a name. Only ever asked of
 *  tracks `matches` already accepted, so the last rank means "the lyrics". */
function trackRank(track: Track, phrase: string, words: string[]): number {
  const { title, artist: name, meta } = foldTrack(track);
  const artist = artistRank(name, phrase, words);
  if (title.startsWith(phrase)) return 0;
  if (artist <= 1) return 1;
  if (title.includes(phrase)) return 2;
  if (artist < NO_MATCH) return 3;
  if (words.every((w) => title.includes(w))) return 4;
  return words.every((w) => meta.includes(w)) ? 5 : 6;
}

/**
 * The library's answer to a query. Artists match on their NAME alone: owning
 * "Blinding Lights" makes The Weeknd worth showing as a song, not as the artist
 * you asked for - and an artist card that appears for every song it happens to
 * contain a word of is noise.
 */
export function localHits(tracks: readonly Track[], query: string): LocalHits {
  const phrase = flatten(query);
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 0) return { artists: [], tracks: [] };

  // Grouped first, scored once per distinct artist rather than once per track.
  const byArtist = new Map<string, Track[]>();
  for (const t of tracks) {
    if (!t.artist) continue;
    const theirs = byArtist.get(t.artist);
    if (theirs) theirs.push(t);
    else byArtist.set(t.artist, [t]);
  }
  const artists: { rank: number; item: LocalArtist }[] = [];
  for (const [name, theirs] of byArtist) {
    const rank = artistRank(flatten(name), phrase, words);
    if (rank === NO_MATCH) continue;
    artists.push({
      rank,
      item: {
        name,
        cover: theirs.find((t) => t.artwork)?.artwork ?? null,
        count: theirs.length,
      },
    });
  }
  // The closer name wins; between two equally close, the one you have more of.
  artists.sort((a, b) => a.rank - b.rank || b.item.count - a.item.count);

  const hits: { rank: number; track: Track }[] = [];
  for (const t of tracks) {
    if (matches(t, phrase, words)) hits.push({ rank: trackRank(t, phrase, words), track: t });
  }
  // Stable, so tracks of equal rank keep the library's own order.
  hits.sort((a, b) => a.rank - b.rank);

  return { artists: artists.map((a) => a.item), tracks: hits.map((h) => h.track) };
}
