import type { Track } from '../core/tauri.ts';
import { byRunningOrder } from '../albumArtist/albums.ts';
import { fold } from '../core/fold.ts';

/**
 * The app's own local-library search, shared by the page-level search bars
 * (Home, Library) and the Search destination, so they all agree on what
 * "matches" means. Lives apart from any component because several surfaces
 * call it.
 *
 * Two doors, on purpose:
 *
 *   - `filterTracks` answers "does this track match" for a list being filtered
 *     in place, which is all a Library or Home page needs - every hit shows and
 *     the order is the shelf's own.
 *   - `searchLibrary` answers a whole query for a results PAGE: artists,
 *     albums, genres and songs, each ranked, each carrying why it matched, and
 *     with a typo rescue behind them.
 *
 * The second is the expensive one and still runs on every keystroke, so it
 * makes exactly one pass over the library and folds each track's text only
 * once in its lifetime.
 */

// Fold to lowercase words separated by single spaces, dropping punctuation, so a
// typed phrase matches a lyric across the commas and line breaks it really has.
// Accents go too, and apostrophes vanish rather than splitting a word: nobody
// reaches for the option key mid-search, so "bjork" has to find Björk and "dont"
// has to find "Don't". Both sides of every comparison come through here, so this
// only ever makes a query match more - never less.
export const flatten = fold;

/** A track's searchable text, already folded. */
interface Folded {
  title: string;
  artist: string;
  /** Who the RECORD is by, folded - empty when untagged. What albums group on,
   *  since the track credit varies across a record with a guest on it. */
  albumArtist: string;
  album: string;
  genre: string;
  /** Title, artist, album and genre in one blob, for the word-AND. */
  meta: string;
  /** The distinct words of `meta`, for the typo rescue. */
  words: string[];
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
    const meta = flatten(`${track.title} ${track.artist} ${track.album} ${track.genre}`);
    f = {
      title: flatten(track.title),
      artist: flatten(track.artist),
      albumArtist: flatten(track.albumArtist ?? ''),
      album: flatten(track.album),
      genre: flatten(track.genre),
      meta,
      words: [...new Set(meta.split(' '))].filter(Boolean),
      lyrics: track.lyrics.length > 0 ? flatten(track.lyrics) : '',
    };
    folded.set(track, f);
  }
  return f;
}

/* ------------------------------------------------------------------ query -- */

/** The fields a query can be aimed at by name. */
type Field = 'artist' | 'album' | 'genre' | 'lyrics';

/**
 * A parsed query: the free text, plus any terms aimed at one field by name.
 *
 * `artist:radiohead ok computer` reads as "songs by Radiohead whose text also
 * says ok computer" - the operator narrows, the rest still searches everything.
 * A quoted value keeps its spaces (`album:"in rainbows"`); an unquoted one is a
 * single word, because the alternative - swallowing the rest of the line - makes
 * the operator feel like a trap the first time somebody types two of them.
 *
 * There is deliberately no `year:`. The library's tracks carry no year tag on
 * this side of the wire (the scanner has never read one and the server does not
 * send one), and an operator that silently matches nothing is worse than an
 * operator that does not exist.
 */
export interface Query {
  /** As typed, trimmed - for echoing back in headings and empty states. */
  raw: string;
  /** The free text, folded: everything that was not an operator. */
  phrase: string;
  /** `phrase` split into words. */
  words: string[];
  /** Folded values for each named field, in the order they were typed. */
  fields: Record<Field, string[]>;
  /** True when at least one field operator was used. */
  scoped: boolean;
  /** True when there is anything at all to search for. */
  active: boolean;
}

// `lyric:` as well as `lyrics:` - both read naturally and neither is a word
// anyone searches for with a colon after it.
const OPERATOR = /(^|\s)(artist|album|genre|lyrics?)\s*:\s*("[^"]*"?|\S*)/giu;

const EMPTY_FIELDS = (): Record<Field, string[]> => ({
  artist: [],
  album: [],
  genre: [],
  lyrics: [],
});

/** Split a raw search string into its operators and its free text. */
export function parseQuery(raw: string): Query {
  const fields = EMPTY_FIELDS();
  let scoped = false;
  const rest = raw.replace(OPERATOR, (whole, lead: string, name: string, value: string) => {
    const term = flatten(value.replace(/"/g, ''));
    // `artist:` with nothing after it yet is somebody mid-type; it narrows
    // nothing rather than matching nothing, so the results stay put until the
    // first letter of the value lands.
    if (!term) return whole;
    scoped = true;
    fields[name === 'lyric' ? 'lyrics' : (name as Field)].push(term);
    return lead;
  });
  const phrase = flatten(rest);
  const words = phrase.split(' ').filter(Boolean);
  return {
    raw: raw.trim(),
    phrase,
    words,
    fields,
    scoped,
    active: scoped || words.length > 0,
  };
}

/** Whether a track satisfies every named-field term in the query. */
function fieldsMatch(f: Folded, q: Query): boolean {
  for (const term of q.fields.artist) if (!f.artist.includes(term)) return false;
  for (const term of q.fields.album) if (!f.album.includes(term)) return false;
  for (const term of q.fields.genre) if (!f.genre.includes(term)) return false;
  for (const term of q.fields.lyrics) if (!f.lyrics.includes(term)) return false;
  return true;
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
 * fall back to the full library when the field is cleared. Field operators
 * work here too, so `artist:` narrows a shelf the same way it narrows a search.
 */
export function filterTracks(tracks: readonly Track[], query: string): Track[] {
  const q = parseQuery(query);
  if (!q.active) return tracks as Track[];
  return tracks.filter((t) => {
    const f = foldTrack(t);
    if (!fieldsMatch(f, q)) return false;
    if (q.words.length === 0) return true;
    return matches(t, q.phrase, q.words);
  });
}

/* ------------------------------------------------------------------ typos -- */

/**
 * Whether two words are within `max` single-character edits of each other -
 * Levenshtein, banded, abandoned as soon as the whole row is already past the
 * budget. `max` is only ever 1 or 2 here, so the band is three or five cells
 * wide and the whole thing costs about as much as the `includes` it backs up.
 */
function withinEdits(a: string, b: string, max: number): boolean {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return false;
  if (a === b) return true;

  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    const from = Math.max(1, i - max);
    const to = Math.min(m, i + max);
    // Cells outside the band can never beat the budget; poisoning them keeps
    // the recurrence honest without special-casing the edges.
    if (from > 1) curr[from - 1] = max + 1;
    let best = max + 1;
    for (let j = from; j <= to; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = value;
      if (value < best) best = value;
    }
    if (to < m) curr[to + 1] = max + 1;
    if (best > max) return false;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m]! <= max;
}

/**
 * How many edits a word of this length may be off by. Short words get none:
 * at three letters every typo is also a different real word ("sun"/"son",
 * "her"/"here"), and a rescue that turns one into the other is not a rescue.
 */
function budget(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length >= 4) return 1;
  return 0;
}

/** Whether a folded blob's words include one within a typo's reach of `word`. */
function nearWord(words: readonly string[], word: string): boolean {
  const max = budget(word);
  if (max === 0) return false;
  for (const w of words) {
    // A long word typed short is a prefix, not a typo - "radioh" should find
    // "radiohead" without spending five edits on the tail.
    if (w.length > word.length + max ? w.startsWith(word) : withinEdits(w, word, max)) return true;
  }
  return false;
}

/* ----------------------------------------------------------------- ranking -- */

/** An artist the library has, as a search hit. */
export interface LocalArtist {
  name: string;
  /** The first cover found among their tracks, for the card. */
  cover: string | null;
  /** How many of their songs the library holds. */
  count: number;
}

/** An album the library has, as a search hit. */
export interface LocalAlbum {
  title: string;
  /** Whoever most of its tracks are credited to. */
  artist: string;
  cover: string | null;
  /** How many of its songs the library holds. */
  count: number;
  /** Its tracks, in track-number order where the tags carry one. */
  tracks: Track[];
}

/** A genre the library has, as a browsable hit. */
export interface LocalGenre {
  name: string;
  count: number;
  /** Up to four covers, for the tile's mosaic. */
  covers: string[];
}

/** Where a song's match came from, for the row to say so. */
export type Why = 'title' | 'artist' | 'album' | 'genre' | 'lyrics' | 'near';

/** A song hit and why it is one. */
export interface TrackHit {
  track: Track;
  why: Why;
}

export interface LibraryHits {
  artists: LocalArtist[];
  albums: LocalAlbum[];
  genres: LocalGenre[];
  songs: TrackHit[];
  /**
   * True when nothing matched as typed and everything here came back through
   * the typo rescue - so the page can say "showing results for" rather than
   * pretending the query was right.
   */
  approximate: boolean;
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

/** The same shape for a title: exact, then prefix, then anywhere, then its
 *  words scattered. Used for albums, which rank on their own name alone. */
function titleRank(title: string, phrase: string, words: string[]): number {
  if (title === phrase) return 0;
  if (title.startsWith(phrase)) return 1;
  if (title.includes(phrase)) return 2;
  return words.every((w) => title.includes(w)) ? 3 : NO_MATCH;
}

/** Where a track matched, best first. Typing an artist's name outright puts
 *  their songs above anyone else's that merely mention them - searching
 *  "ashnikko" wants Ashnikko, not a Lady Gaga remix she guested on. Below that
 *  a title hit is what the typist meant, and a lyric hit is a long shot that is
 *  right often enough to keep but never ahead of a name. Only ever asked of
 *  tracks the matcher already accepted, so the last rank means "the lyrics". */
function trackRank(f: Folded, phrase: string, words: string[]): number {
  const artist = artistRank(f.artist, phrase, words);
  if (f.title.startsWith(phrase)) return 0;
  if (artist <= 1) return 1;
  if (f.title.includes(phrase)) return 2;
  if (artist < NO_MATCH) return 3;
  if (words.every((w) => f.title.includes(w))) return 4;
  return words.every((w) => f.meta.includes(w)) ? 5 : 6;
}

/** Which field to credit a song's match to, given the rank it scored. Ranks
 *  are already ordered by which field won, so this is a lookup rather than a
 *  second search. */
function whyFrom(rank: number, f: Folded, words: string[]): Why {
  if (rank === 0 || rank === 2 || rank === 4) return 'title';
  if (rank === 1 || rank === 3) return 'artist';
  if (rank === 5) return words.every((w) => f.album.includes(w)) ? 'album' : 'genre';
  return 'lyrics';
}

/** Everything one pass over the library collects, before it is ranked. */
interface Pass {
  byArtist: Map<string, Track[]>;
  byAlbum: Map<string, { title: string; tracks: Track[] }>;
  byGenre: Map<string, { name: string; tracks: Track[] }>;
  songs: { rank: number; hit: TrackHit }[];
}

/**
 * The album key: title AND artist, so two different records called "Greatest
 * Hits" stay two records. Tracks with no album tag have no album.
 *
 * The ALBUM artist where the tags carry one, falling back to the track's. On
 * the track credit alone a record with a guest on two songs became two albums
 * in the results, each with a fraction of the songs and a count to match.
 */
function albumKey(f: Folded): string | null {
  return f.album ? `${f.album}\u001f${f.albumArtist || f.artist}` : null;
}

/** A genre tag is comma-joined in the tags ("Hip-Hop, Rap"); each side of the
 *  comma is its own genre. */
function genresOf(track: Track): string[] {
  return track.genre
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

function firstCover(tracks: readonly Track[]): string | null {
  return tracks.find((t) => t.artwork)?.artwork ?? null;
}

/**
 * The library's answer to a query: everything it holds that the words name,
 * grouped the way a results page shows it.
 *
 * Artists and albums match on their own NAME alone. Owning "Blinding Lights"
 * makes The Weeknd worth showing as a song, not as the artist you asked for -
 * and a card that appears for every song it happens to contain a word of is
 * noise.
 *
 * When nothing matches as typed, the whole pass runs again allowing a typo per
 * word. That second pass is invisible in the good case (it never runs) and
 * silent in the bad one: the results simply appear, with `approximate` set so
 * the page can admit what it did.
 */
export function searchLibrary(tracks: readonly Track[], query: string): LibraryHits {
  const q = parseQuery(query);
  if (!q.active) return { artists: [], albums: [], genres: [], songs: [], approximate: false };

  const exact = collect(tracks, q, false);
  const empty = exact.songs.length === 0 && exact.byArtist.size === 0 && exact.byAlbum.size === 0;
  // Only free text can be mistyped into nothing; a field operator that matched
  // nothing means the library does not hold it, which the rescue cannot fix.
  const pass = empty && q.words.length > 0 ? collect(tracks, q, true) : exact;
  const hits = rank(pass, q);
  // Approximate means "we found something, but not what you typed". It used to
  // mean "the rescue pass ran", which is not the same thing: when the rescue
  // also found nothing, the page still announced 'this is the closest your
  // library has' above an empty space, telling somebody their library holds a
  // near-miss it does not hold. Claim it only when there is something to show.
  const found =
    hits.songs.length > 0 ||
    hits.artists.length > 0 ||
    hits.albums.length > 0 ||
    hits.genres.length > 0;
  return { ...hits, approximate: pass !== exact && found };
}

/** One walk of the library, keeping whatever answered. */
function collect(tracks: readonly Track[], q: Query, fuzzy: boolean): Pass {
  const pass: Pass = { byArtist: new Map(), byAlbum: new Map(), byGenre: new Map(), songs: [] };
  const { phrase, words } = q;
  // With only operators typed, every track that satisfies them is a hit and
  // there is no free text to rank it by; they come back in the shelf's order.
  const bare = words.length === 0;

  for (const track of tracks) {
    const f = foldTrack(track);
    if (!fieldsMatch(f, q)) continue;

    let rank: number;
    let why: Why;
    if (bare) {
      rank = 5;
      why = 'title';
    } else if (words.every((w) => f.meta.includes(w))) {
      rank = trackRank(f, phrase, words);
      why = whyFrom(rank, f, words);
    } else if (f.lyrics.length > 0 && f.lyrics.includes(phrase)) {
      rank = 6;
      why = 'lyrics';
    } else if (fuzzy && words.every((w) => nearWord(f.words, w))) {
      // A rescued song sits below every honest one, which costs nothing: when
      // the rescue runs at all there are no honest ones.
      rank = 7;
      why = 'near';
    } else {
      continue;
    }
    pass.songs.push({ rank, hit: { track, why } });

    // The groups are built from matching tracks only when the query is bare or
    // scoped; otherwise they are scored on their own names below, over the
    // whole library, so an artist you own one matching song by does not become
    // an artist card.
    if (track.artist) {
      const theirs = pass.byArtist.get(track.artist);
      if (theirs) theirs.push(track);
      else pass.byArtist.set(track.artist, [track]);
    }
  }

  if (bare) {
    // Nothing to score names against, so the groups ARE the matching tracks'
    // groups: "genre:shoegaze" should show the shoegaze albums it found.
    for (const { hit } of pass.songs) {
      const f = foldTrack(hit.track);
      const key = albumKey(f);
      if (key) {
        const album = pass.byAlbum.get(key);
        if (album) album.tracks.push(hit.track);
        else pass.byAlbum.set(key, { title: hit.track.album, tracks: [hit.track] });
      }
      for (const name of genresOf(hit.track)) {
        const g = pass.byGenre.get(flatten(name));
        if (g) g.tracks.push(hit.track);
        else pass.byGenre.set(flatten(name), { name, tracks: [hit.track] });
      }
    }
    return pass;
  }

  // Names are scored across the whole library, not only the tracks that
  // matched: an album answers to its title whether or not its songs do.
  pass.byArtist.clear();
  for (const track of tracks) {
    const f = foldTrack(track);
    if (!fieldsMatch(f, q)) continue;

    const byName = nameHit(f.artist, phrase, words, fuzzy);
    if (track.artist && byName) {
      const theirs = pass.byArtist.get(track.artist);
      if (theirs) theirs.push(track);
      else pass.byArtist.set(track.artist, [track]);
    }
    const key = albumKey(f);
    // An album answers to its own title AND to whoever made it: typing a band's
    // name should lay out their records, which is the thing you were most
    // likely reaching for. Genres get no such courtesy - a genre is only ever
    // itself.
    if (key && (byName || nameHit(f.album, phrase, words, fuzzy))) {
      const album = pass.byAlbum.get(key);
      if (album) album.tracks.push(track);
      else pass.byAlbum.set(key, { title: track.album, tracks: [track] });
    }
    for (const name of genresOf(track)) {
      const key2 = flatten(name);
      if (!nameHit(key2, phrase, words, fuzzy)) continue;
      const g = pass.byGenre.get(key2);
      if (g) g.tracks.push(track);
      else pass.byGenre.set(key2, { name, tracks: [track] });
    }
  }
  return pass;
}

/** Whether a folded name answers the free text, with the typo rescue when the
 *  exact pass came back empty. */
function nameHit(name: string, phrase: string, words: string[], fuzzy: boolean): boolean {
  if (!name) return false;
  if (name.includes(phrase) || words.every((w) => name.includes(w))) return true;
  return fuzzy && words.every((w) => nearWord(name.split(' '), w));
}

/** How many of each group survive to the page. Generous rather than tight:
 *  the page decides what to show collapsed, and "See all" needs something to
 *  expand into. */
const MAX_GROUP = 24;

/** Turn one pass into the ranked, capped lists a page renders. */
function rank(pass: Pass, q: Query): Omit<LibraryHits, 'approximate'> {
  const { phrase, words } = q;

  const artists = [...pass.byArtist]
    .map(([name, theirs]) => ({
      rank: words.length === 0 ? 0 : artistRank(flatten(name), phrase, words),
      item: { name, cover: firstCover(theirs), count: theirs.length },
    }))
    // The closer name wins; between two equally close, the one you have more of.
    .sort((a, b) => a.rank - b.rank || b.item.count - a.item.count)
    .slice(0, MAX_GROUP)
    .map((a) => a.item);

  const albums = [...pass.byAlbum.values()]
    .map(({ title, tracks }) => ({
      rank: words.length === 0 ? 0 : titleRank(flatten(title), phrase, words),
      item: {
        title,
        // Whoever most of the record is credited to: a compilation with one
        // guest per track should not be filed under the guest.
        artist: commonArtist(tracks),
        cover: firstCover(tracks),
        count: tracks.length,
        tracks: [...tracks].sort(byRunningOrder),
      },
    }))
    .sort((a, b) => a.rank - b.rank || b.item.count - a.item.count)
    .slice(0, MAX_GROUP)
    .map((a) => a.item);

  const genres = [...pass.byGenre.values()]
    .map(({ name, tracks }) => ({
      rank: words.length === 0 ? 0 : titleRank(flatten(name), phrase, words),
      item: {
        name,
        count: tracks.length,
        covers: [...new Set(tracks.map((t) => t.artwork).filter((c): c is string => !!c))].slice(
          0,
          4,
        ),
      },
    }))
    .sort((a, b) => a.rank - b.rank || b.item.count - a.item.count)
    .slice(0, MAX_GROUP)
    .map((a) => a.item);

  // Stable, so songs of equal rank keep the library's own order.
  const songs = [...pass.songs].sort((a, b) => a.rank - b.rank).map((s) => s.hit);

  return { artists, albums, genres, songs };
}

/** The artist most of these tracks are credited to. */
function commonArtist(tracks: readonly Track[]): string {
  const tally = new Map<string, number>();
  // The album credit where a track carries one - it is the same on every song
  // of a record, guests included, which is exactly the agreement being counted.
  for (const t of tracks) {
    const name = t.albumArtist || t.artist;
    if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  let best = '';
  let most = 0;
  for (const [name, n] of tally) {
    if (n > most) {
      best = name;
      most = n;
    }
  }
  // Several names, none of them a majority, is what a compilation looks like.
  return most > tracks.length / 2 ? best : (best && tally.size === 1 ? best : 'Various artists');
}

/* ----------------------------------------------------------------- excerpt -- */

/** The lyric lines of a track, folded, cached beside the track. Built lazily
 *  because only the handful of rows actually on screen ever ask. */
const lyricLines = new WeakMap<Track, { raw: string; folded: string }[]>();

/**
 * The one line of a track's lyrics that carries the phrase, as written - the
 * excerpt a lyric hit shows so the reader can see WHY this song came back.
 * Null when the phrase is not in the lyrics at all (a metadata hit).
 */
export function lyricExcerpt(track: Track, query: string): string | null {
  const phrase = parseQuery(query).phrase;
  if (!phrase || !track.lyrics) return null;
  let lines = lyricLines.get(track);
  if (!lines) {
    lines = track.lyrics
      .split(/\r\n|\r|\n/)
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => ({ raw, folded: flatten(raw) }));
    lyricLines.set(track, lines);
  }
  return lines.find((l) => l.folded.includes(phrase))?.raw ?? null;
}
