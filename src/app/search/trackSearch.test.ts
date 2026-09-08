import { describe, expect, it } from 'vitest';
import {
  filterTracks,
  lyricExcerpt,
  matches,
  parseQuery,
  searchLibrary,
} from './trackSearch.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * Every search bar in the app agrees through this module, so a wrong answer
 * here is wrong everywhere at once and never says so. The blocks below are
 * the four ways it can be wrong, each named in the programme plan:
 * `approximate` claimed over nothing; a three-letter word "rescued" into a
 * different word; the banded Levenshtein accepting three edits; and the
 * metadata word-AND conflated with the lyric contiguous-phrase, which would
 * make every short query match every lyric.
 */

describe('parseQuery', () => {
  it('splits a field operator off the free text', () => {
    const q = parseQuery('artist:radiohead ok computer');
    expect(q.fields.artist).toEqual(['radiohead']);
    expect(q.phrase).toBe('ok computer');
    expect(q.scoped).toBe(true);
    expect(q.active).toBe(true);
  });

  it('keeps the spaces of a QUOTED value and drops the quotes', () => {
    expect(parseQuery('album:"in rainbows"').fields.album).toEqual(['in rainbows']);
  });

  it('takes only one word from an unquoted value, leaving the rest as free text', () => {
    // The alternative - swallowing the rest of the line - makes the operator
    // feel like a trap the first time somebody types two of them.
    const q = parseQuery('album:kid a');
    expect(q.fields.album).toEqual(['kid']);
    expect(q.phrase).toBe('a');
  });

  it('accepts both spellings of the lyrics operator, into one field', () => {
    expect(parseQuery('lyric:love').fields.lyrics).toEqual(['love']);
    expect(parseQuery('lyrics:love').fields.lyrics).toEqual(['love']);
  });

  it('is case-insensitive in the operator NAME, not only in its value', () => {
    /*
     * REGRESSION. The operator regex carries `i`, so "Artist:" matched - and
     * the captured name was then used verbatim as the key into `fields`.
     * `fields['Artist']` is undefined and `.push` on it threw a TypeError,
     * inside the `useMemo` that SearchPage runs on every keystroke. A phone's
     * keyboard capitalises the first letter of a field by default and this
     * input does not turn that off, so typing an operator at the start of the
     * search bar took the page down.
     */
    expect(parseQuery('Artist:Beyoncé').fields.artist).toEqual(['beyonce']);
    expect(parseQuery('ARTIST:radiohead').fields.artist).toEqual(['radiohead']);
    expect(parseQuery('Lyrics:love').fields.lyrics).toEqual(['love']);
    expect(parseQuery('Lyric:love').fields.lyrics).toEqual(['love']);
    expect(parseQuery('Album:"in rainbows"').fields.album).toEqual(['in rainbows']);
    expect(parseQuery('Genre:rock').fields.genre).toEqual(['rock']);
  });

  it('narrows on a capitalised operator rather than searching for its text', () => {
    // The half that says the fix is a fix and not just a swallowed throw.
    const q = parseQuery('Artist:radiohead karma');
    expect(q.scoped).toBe(true);
    expect(q.phrase).toBe('karma');
  });

  it('collects several operators, and several of one kind', () => {
    const q = parseQuery('artist:blur artist:gorillaz genre:rock');
    expect(q.fields.artist).toEqual(['blur', 'gorillaz']);
    expect(q.fields.genre).toEqual(['rock']);
  });

  it('does NOT scope on an operator with nothing typed after it yet', () => {
    // Mid-type. Narrowing on an empty value would blank the results between
    // the colon and the first letter.
    const q = parseQuery('artist:');
    expect(q.scoped).toBe(false);
    expect(q.fields.artist).toEqual([]);
  });

  it('is inactive for an empty or whitespace query', () => {
    expect(parseQuery('   ').active).toBe(false);
    expect(parseQuery('').active).toBe(false);
  });
});

describe('matches - metadata is word-ANDed, lyrics are a contiguous phrase', () => {
  const song = track({
    title: 'Karma Police',
    artist: 'Radiohead',
    album: 'OK Computer',
    lyrics: 'This is what you get\nwhen you mess with us',
  });

  it('accepts metadata words scattered across title, artist and album', () => {
    expect(matches(song, 'radiohead computer', ['radiohead', 'computer'])).toBe(true);
  });

  it('accepts a verbatim lyric phrase', () => {
    expect(matches(song, 'mess with us', ['mess', 'with', 'us'])).toBe(true);
  });

  it('REFUSES lyric words that are merely all present, scattered', () => {
    // The bug this split prevents: a lyric is long prose, so the short words
    // of any query turn up somewhere in it. Word-ANDing lyrics would make
    // every short query match every song that carries any.
    expect(matches(song, 'get us', ['get', 'us'])).toBe(false);
  });

  it('does not read a phrase across the line break it really has', () => {
    // `flatten` collapses the newline to a space, so the phrase spanning two
    // printed lines is contiguous in the folded blob - that is deliberate.
    expect(matches(song, 'you get when you mess', ['you', 'get', 'when', 'you', 'mess'])).toBe(true);
  });

  it('is false for a track with no lyrics and no metadata hit', () => {
    expect(matches(track({ title: 'A', artist: 'B', album: 'C' }), 'zzz', ['zzz'])).toBe(false);
  });
});

describe('filterTracks', () => {
  const library = [
    track({ title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', genre: 'Rock' }),
    track({ title: 'Song 2', artist: 'Blur', album: 'Blur', genre: 'Britpop' }),
  ];

  it('hands back the SAME array for an inactive query', () => {
    // Callers bind this straight to an input; an empty field must be the full
    // library and must not churn a new array identity on every keystroke.
    expect(filterTracks(library, '  ')).toBe(library);
  });

  it('narrows a shelf by a field operator', () => {
    expect(filterTracks(library, 'artist:blur').map((t) => t.title)).toEqual(['Song 2']);
  });

  it('applies the operator AND the free text', () => {
    expect(filterTracks(library, 'artist:radiohead karma')).toHaveLength(1);
    expect(filterTracks(library, 'artist:radiohead song')).toHaveLength(0);
  });

  it('returns everything the operator admits when there is no free text', () => {
    expect(filterTracks(library, 'genre:rock')).toHaveLength(1);
  });
});

describe('searchLibrary', () => {
  const library = [
    track({
      title: 'Karma Police',
      artist: 'Radiohead',
      albumArtist: 'Radiohead',
      album: 'OK Computer',
      genre: 'Alternative Rock, Art Rock',
      artwork: 'ok.jpg',
    }),
    track({
      title: 'Paranoid Android',
      artist: 'Radiohead',
      albumArtist: 'Radiohead',
      album: 'OK Computer',
      genre: 'Alternative Rock',
    }),
    track({ title: 'Song 2', artist: 'Blur', albumArtist: 'Blur', album: 'Blur', genre: 'Britpop' }),
  ];

  it('finds an artist by name and counts what the library holds of theirs', () => {
    const hits = searchLibrary(library, 'radiohead');
    expect(hits.artists.map((a) => a.name)).toEqual(['Radiohead']);
    expect(hits.artists[0]?.count).toBe(2);
    expect(hits.approximate).toBe(false);
  });

  it('lays out an artist’s RECORDS when their name is typed', () => {
    // An album answers to its own title and to whoever made it.
    expect(searchLibrary(library, 'radiohead').albums.map((a) => a.title)).toEqual(['OK Computer']);
  });

  it('does not make an artist card out of a song that merely mentions them', () => {
    // "Owning Blinding Lights makes The Weeknd worth showing as a song, not as
    // the artist you asked for."
    const mention = [track({ title: 'Ode To Radiohead', artist: 'Somebody Else', album: 'X' })];
    expect(searchLibrary(mention, 'radiohead').artists).toEqual([]);
    expect(searchLibrary(mention, 'radiohead').songs).toHaveLength(1);
  });

  it('answers to a filed name without its article - "The Marías" is "marias"', () => {
    const filed = [track({ title: 'Only In My Dreams', artist: 'The Marías', album: 'Cinema' })];
    expect(searchLibrary(filed, 'marias').artists.map((a) => a.name)).toEqual(['The Marías']);
  });

  it('keeps two records of the same name by different artists apart', () => {
    // The album key is title AND album-artist, for exactly this.
    const twins = [
      track({ title: 'A', artist: 'Queen', albumArtist: 'Queen', album: 'Greatest Hits' }),
      track({ title: 'B', artist: 'Abba', albumArtist: 'Abba', album: 'Greatest Hits' }),
    ];
    const hits = searchLibrary(twins, 'greatest hits');
    expect(hits.albums).toHaveLength(2);
    expect(hits.albums.map((a) => a.artist).sort()).toEqual(['Abba', 'Queen']);
  });

  it('keeps a record with a guest on it as ONE album, credited to the album artist', () => {
    const guested = [
      track({ title: 'One', artist: 'Radiohead', albumArtist: 'Radiohead', album: 'In Rainbows', trackNo: 1 }),
      track({ title: 'Two', artist: 'Radiohead feat. Guest', albumArtist: 'Radiohead', album: 'In Rainbows', trackNo: 2 }),
    ];
    const hits = searchLibrary(guested, 'in rainbows');
    expect(hits.albums).toHaveLength(1);
    expect(hits.albums[0]?.count).toBe(2);
    expect(hits.albums[0]?.artist).toBe('Radiohead');
    // And its tracks come back in running order.
    expect(hits.albums[0]?.tracks.map((t) => t.trackNo)).toEqual([1, 2]);
  });

  it('splits a comma-joined genre tag into its own genres', () => {
    expect(searchLibrary(library, 'art rock').genres.map((g) => g.name)).toEqual(['Art Rock']);
  });

  it('puts a title hit above a lyric hit', () => {
    const both = [
      track({ title: 'Nothing', artist: 'X', album: 'Y', lyrics: 'everything and karma police' }),
      track({ title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer' }),
    ];
    const songs = searchLibrary(both, 'karma police').songs;
    expect(songs[0]?.track.title).toBe('Karma Police');
    expect(songs[0]?.why).toBe('title');
    expect(songs[1]?.why).toBe('lyrics');
  });

  it('puts an artist’s own songs above someone else’s that merely name them', () => {
    // The module's own example: searching "ashnikko" wants Ashnikko, not the
    // Lady Gaga remix she guested on.
    const mixed = [
      track({ title: 'Rain On Me (Ashnikko Remix)', artist: 'Lady Gaga', album: 'Chromatica' }),
      track({ title: 'Slumber Party', artist: 'Ashnikko', album: 'Demidevil' }),
    ];
    const songs = searchLibrary(mixed, 'ashnikko').songs;
    expect(songs[0]?.track.artist).toBe('Ashnikko');
    expect(songs[0]?.why).toBe('artist');
  });

  it('...but a title that STARTS with the words still wins, which is the ladder', () => {
    // Deliberate, and the counter-case that stops the rule above being read as
    // "the artist always wins": a song actually called what you typed is what
    // the typist meant.
    const mixed = [
      track({ title: 'Ashnikko Remix', artist: 'Lady Gaga', album: 'Chromatica' }),
      track({ title: 'Slumber Party', artist: 'Ashnikko', album: 'Demidevil' }),
    ];
    expect(searchLibrary(mixed, 'ashnikko').songs[0]?.why).toBe('title');
  });

  it('returns nothing at all for an inactive query', () => {
    const hits = searchLibrary(library, '   ');
    expect(hits).toEqual({ artists: [], albums: [], genres: [], songs: [], approximate: false });
  });
});

describe('the typo rescue', () => {
  const library = [
    track({ title: 'Karma Police', artist: 'Radiohead', albumArtist: 'Radiohead', album: 'OK Computer' }),
    track({ title: 'Enter Sandman', artist: 'Metallica', albumArtist: 'Metallica', album: 'Metallica' }),
  ];

  it('rescues a long word typed with one wrong letter, and SAYS it did', () => {
    const hits = searchLibrary(library, 'netallica');
    expect(hits.songs.map((s) => s.track.title)).toEqual(['Enter Sandman']);
    expect(hits.approximate).toBe(true);
  });

  it('rescues two edits in a nine-letter word', () => {
    expect(searchLibrary(library, 'netallico').songs).toHaveLength(1);
  });

  it('REFUSES three edits - the band and the budget, not just the length', () => {
    // Same length, three substitutions. A rescue this loose reaches a
    // different word, which is not a rescue.
    expect(searchLibrary(library, 'netallixo').songs).toEqual([]);
  });

  it('does not rescue a THREE-letter word into a different real word', () => {
    // At three letters every typo is also another word - "sun"/"son",
    // "her"/"here" - so short words get no budget at all.
    const short = [track({ title: 'Son', artist: 'Nobody', album: 'Nothing' })];
    expect(searchLibrary(short, 'sun').songs).toEqual([]);
    // And the same query still finds it when spelled right, which is what
    // makes the line above mean something.
    expect(searchLibrary(short, 'son').songs).toHaveLength(1);
  });

  it('treats a long word typed SHORT as a prefix rather than spending edits', () => {
    /*
     * "radioh" ALONE would never reach the rescue - it is a substring of
     * "radiohead", so the exact pass already answers and this would be a test
     * of nothing. Pairing it with a second, genuinely mistyped word is what
     * empties the exact pass and puts the question to `nearWord`: "radioh" is
     * three edits from "radiohead" and must still be reached, as a prefix.
     */
    expect(searchLibrary(library, 'radioh polise').songs.map((s) => s.track.title)).toEqual([
      'Karma Police',
    ]);
    // ...but only a REAL prefix: one wrong letter at the end of a short stub
    // is past the budget for its length, and the prefix arm does not fall
    // back to counting edits.
    expect(searchLibrary(library, 'radiox polise').songs).toEqual([]);
    // And the same stub with a correctly spelled partner still finds nothing
    // through the rescue when the partner is not in the library at all.
    expect(searchLibrary(library, 'radioh zzzzzzzz').songs).toEqual([]);
  });

  it('never claims `approximate` when the rescue found nothing either', () => {
    // The bug this pins: "showing results for" printed above empty space,
    // telling somebody their library holds a near-miss it does not hold.
    const hits = searchLibrary(library, 'zzzzzzzzz');
    expect(hits.songs).toEqual([]);
    expect(hits.artists).toEqual([]);
    expect(hits.approximate).toBe(false);
  });

  it('never claims `approximate` when the query was right the first time', () => {
    expect(searchLibrary(library, 'metallica').approximate).toBe(false);
  });

  it('does not run the rescue for a field operator that matched nothing', () => {
    // A field operator that matched nothing means the library does not hold
    // it, which no amount of spelling forgiveness can fix.
    const hits = searchLibrary(library, 'artist:netallica');
    expect(hits.songs).toEqual([]);
    expect(hits.approximate).toBe(false);
  });

  it('marks a rescued song as such', () => {
    expect(searchLibrary(library, 'netallica').songs[0]?.why).toBe('near');
  });
});

describe('lyricExcerpt', () => {
  const song = track({
    title: 'Karma Police',
    artist: 'Radiohead',
    album: 'OK Computer',
    lyrics: 'Karma police, arrest this man\nHe talks in maths\n\nHe buzzes like a fridge',
  });

  it('returns the line carrying the phrase, AS WRITTEN', () => {
    expect(lyricExcerpt(song, 'talks in maths')).toBe('He talks in maths');
  });

  it('finds a line typed without its punctuation or capitals', () => {
    expect(lyricExcerpt(song, 'karma police arrest')).toBe('Karma police, arrest this man');
  });

  it('is null when the phrase is not in the lyrics (a metadata hit)', () => {
    expect(lyricExcerpt(song, 'radiohead')).toBe(null);
  });

  it('is null for a track with no lyrics, and for a query with no free text', () => {
    expect(lyricExcerpt(track({ lyrics: '' }), 'anything')).toBe(null);
    expect(lyricExcerpt(song, 'artist:radiohead')).toBe(null);
  });
});
