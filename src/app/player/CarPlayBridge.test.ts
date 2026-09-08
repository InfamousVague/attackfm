import { describe, expect, it } from 'vitest';
import type { Track } from '../core/tauri.ts';
import { buildCarTree, resolveSpokenRequest } from './CarPlayBridge.tsx';

/**
 * The car's browse tree, and what a spoken request means.
 *
 * Both halves are pure by design - the module says so - and both are
 * otherwise only reachable through a React effect and a native bridge, which
 * is to say: through a car. That is what makes these worth pinning. A branch
 * that publishes empty is the dead end the feature exists to remove, and a
 * spoken "play Rumours" that returns one song is a drive that goes quiet
 * after three minutes.
 *
 * The names in the tree run through `translate()`, which without an i18next
 * catalogue answers with the key itself. That is fine and deliberate: the
 * assertions here are on IDS, ORDER and PRESENCE, which is where the logic
 * lives. The wording is the catalogue's business, and pinning it here would
 * make this suite fail every time somebody edited a string.
 */

function song(over: Partial<Track> & { title: string }): Track {
  return {
    path: `/Music/${over.title}.mp3`,
    artist: 'Somebody',
    album: 'A record',
    // `genre` and `lyrics` are not optional on a Track, and `searchLibrary`
    // reads both without a guard - a fixture that leaves them off tests the
    // search engine's tolerance for a malformed row rather than the car.
    genre: '',
    lyrics: '',
    duration: 180,
    ...over,
  } as Track;
}

const idsUnder = (tree: Record<string, { id: string }[]>, branch: string) =>
  (tree[branch] ?? []).map((n) => n.id);

describe('buildCarTree - which branches exist at all', () => {
  it('always offers the three collections', () => {
    const tree = buildCarTree([], [], []);
    expect(idsUnder(tree, 'attackfm.root')).toEqual([
      'collection:liked',
      'collection:all',
      'collection:shuffle',
    ]);
  });

  it('publishes no branch with nothing behind it', () => {
    // A branch that opens onto an empty list is exactly the dead end this
    // feature was built to remove.
    const tree = buildCarTree([], [], []);
    const root = idsUnder(tree, 'attackfm.root');
    expect(root).not.toContain('branch:artists');
    expect(root).not.toContain('branch:albums');
    expect(root).not.toContain('branch:books');
    expect(root).not.toContain('branch:playlists');
  });

  it('adds each branch as soon as something is behind it', () => {
    const tree = buildCarTree(
      [
        song({ title: 'One', artist: 'A', album: 'Rec' }),
        song({ title: 'Book', artist: 'Reader', album: 'A Novel', kind: 'book' } as Partial<Track> & {
          title: string;
        }),
      ],
      [],
      [{ id: 'p1', name: 'Drive', paths: ['/Music/One.mp3'] }],
    );
    const root = idsUnder(tree, 'attackfm.root');
    expect(root).toContain('branch:artists');
    expect(root).toContain('branch:albums');
    expect(root).toContain('branch:books');
    expect(root).toContain('branch:playlists');
  });

  it('does not file a book under artists or albums', () => {
    // A book has an artist and an album tag like anything else; putting it in
    // those branches would scatter a twelve-part audiobook through the
    // artist list.
    const tree = buildCarTree(
      [song({ title: 'Ch 1', artist: 'Reader', album: 'A Novel', kind: 'book' } as Partial<Track> & {
        title: string;
      })],
      [],
      [],
    );
    expect(idsUnder(tree, 'attackfm.root')).not.toContain('branch:artists');
    expect(idsUnder(tree, 'branch:books')).toEqual(['book:/Music/Ch 1.mp3']);
  });

  it('skips a track with no artist and no album rather than filing it under ""', () => {
    const tree = buildCarTree([song({ title: 'Untagged', artist: '', album: '' })], [], []);
    expect(idsUnder(tree, 'attackfm.root')).not.toContain('branch:artists');
    expect(idsUnder(tree, 'attackfm.root')).not.toContain('branch:albums');
  });
});

describe('buildCarTree - telling two albums of one name apart', () => {
  it('keys an album by title AND artist', () => {
    // "Greatest Hits" is nobody's in particular. Keying on the title alone
    // merges two records into one row that plays a mix of both.
    const tree = buildCarTree(
      [
        song({ title: 'a', artist: 'Queen', album: 'Greatest Hits' }),
        song({ title: 'b', artist: 'ABBA', album: 'Greatest Hits' }),
      ],
      [],
      [],
    );
    const albums = idsUnder(tree, 'branch:albums');
    expect(albums).toHaveLength(2);
    expect(albums).toContain('album:Greatest Hits\u0000Queen');
    expect(albums).toContain('album:Greatest Hits\u0000ABBA');
  });

  it('shows the artist as the album row’s subtitle', () => {
    const tree = buildCarTree([song({ title: 'a', artist: 'Queen', album: 'Greatest Hits' })], [], []);
    expect(tree['branch:albums']![0]).toMatchObject({
      name: 'Greatest Hits',
      subtitle: 'Queen',
    });
  });

  it('gathers one artist’s records under one artist row', () => {
    const tree = buildCarTree(
      [
        song({ title: 'a', artist: 'Queen', album: 'News' }),
        song({ title: 'b', artist: 'Queen', album: 'Opera' }),
      ],
      [],
      [],
    );
    expect(idsUnder(tree, 'branch:artists')).toEqual(['artist:Queen']);
  });
});

describe('buildCarTree - order and the branch cap', () => {
  it('sorts artists alphabetically, ignoring case', () => {
    const tree = buildCarTree(
      ['zebra', 'Alpha', 'mango'].map((artist) => song({ title: artist, artist, album: artist })),
      [],
      [],
    );
    expect(idsUnder(tree, 'branch:artists')).toEqual(['artist:Alpha', 'artist:mango', 'artist:zebra']);
  });

  it('sorts albums by TITLE, not by the artist packed into the key', () => {
    // The key is `title\0artist`, so a plain string sort would order by the
    // title's bytes and then silently by the artist - and an album whose
    // title differs only in case would sort miles from its neighbour.
    const tree = buildCarTree(
      [
        song({ title: 'a', artist: 'Zoe', album: 'Apples' }),
        song({ title: 'b', artist: 'Amy', album: 'zebras' }),
        song({ title: 'c', artist: 'Bob', album: 'Mangoes' }),
      ],
      [],
      [],
    );
    expect(idsUnder(tree, 'branch:albums')).toEqual([
      'album:Apples\u0000Zoe',
      'album:Mangoes\u0000Bob',
      'album:zebras\u0000Amy',
    ]);
  });

  it('caps a branch at 200 rows', () => {
    // Not a technical limit: a dashboard list is read at a glance by somebody
    // who should be watching the road.
    const many = Array.from({ length: 250 }, (_, i) =>
      song({ title: `t${i}`, artist: `Artist ${String(i).padStart(3, '0')}`, album: `Album ${i}` }),
    );
    const tree = buildCarTree(many, [], []);
    expect(tree['branch:artists']).toHaveLength(200);
    expect(tree['branch:albums']).toHaveLength(200);
    // The cap applies after the sort, so it is the first 200 alphabetically
    // rather than the first 200 the library happened to list.
    expect(tree['branch:artists']![0]!.id).toBe('artist:Artist 000');
    expect(tree['branch:artists']![199]!.id).toBe('artist:Artist 199');
  });

  it('caps books and playlists too', () => {
    const books = Array.from({ length: 210 }, (_, i) =>
      song({ title: `b${i}`, album: `Book ${i}`, kind: 'book' } as Partial<Track> & { title: string }),
    );
    const lists = Array.from({ length: 210 }, (_, i) => ({ id: `p${i}`, name: `List ${i}`, paths: [] }));
    const tree = buildCarTree(books, [], lists);
    expect(tree['branch:books']).toHaveLength(200);
    expect(tree['branch:playlists']).toHaveLength(200);
  });

  it('names a book by its album, falling back to the title', () => {
    const tree = buildCarTree(
      [
        song({ title: 'Ch 1', artist: 'Reader', album: 'A Novel', kind: 'book' } as Partial<Track> & {
          title: string;
        }),
        song({ title: 'Loose', artist: 'Reader', album: '', kind: 'book' } as Partial<Track> & {
          title: string;
        }),
      ],
      [],
      [],
    );
    expect(tree['branch:books']!.map((n) => n.name)).toEqual(['A Novel', 'Loose']);
  });
});

describe('resolveSpokenRequest - the order of preference', () => {
  const rumours = [
    song({ title: 'Second Hand News', artist: 'Fleetwood Mac', album: 'Rumours', trackNo: 1 }),
    song({ title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', trackNo: 2 }),
    song({ title: 'Go Your Own Way', artist: 'Fleetwood Mac', album: 'Rumours', trackNo: 3 }),
  ];
  const tusk = [
    song({ title: 'Tusk', artist: 'Fleetwood Mac', album: 'Tusk', trackNo: 1 }),
    song({ title: 'Sara', artist: 'Fleetwood Mac', album: 'Tusk', trackNo: 2 }),
  ];
  const other = [song({ title: 'Rumours of War', artist: 'Someone Else', album: 'Elsewhere' })];
  const library = [...rumours, ...tusk, ...other];

  it('an artist named outright beats everything', () => {
    // Every one of their songs also matches those words; the person meant
    // the artist.
    const queue = resolveSpokenRequest(library, 'Fleetwood Mac');
    expect(queue).toHaveLength(5);
    expect(queue.every((t) => t.artist === 'Fleetwood Mac')).toBe(true);
  });

  it('runs an artist’s queue album by album, in track order inside each', () => {
    const queue = resolveSpokenRequest(library, 'Fleetwood Mac');
    expect(queue.map((t) => `${t.album}/${t.trackNo}`)).toEqual([
      'Rumours/1',
      'Rumours/2',
      'Rumours/3',
      'Tusk/1',
      'Tusk/2',
    ]);
  });

  it('an album beats a single song of the same name', () => {
    // "play Rumours" wants the record, not whichever of its tracks happens to
    // rank highest inside it - and not the unrelated song called "Rumours of
    // War" either.
    const queue = resolveSpokenRequest(library, 'Rumours');
    expect(queue.map((t) => t.title)).toEqual(['Second Hand News', 'Dreams', 'Go Your Own Way']);
  });

  it('falls through to songs when neither an artist nor an album answers', () => {
    const queue = resolveSpokenRequest(library, 'Dreams');
    expect(queue[0]?.title).toBe('Dreams');
  });

  it('returns the whole song list behind a match, not just the one track', () => {
    // A car that stops after three minutes has not really answered.
    const queue = resolveSpokenRequest(library, 'Fleetwood');
    expect(queue.length).toBeGreaterThan(1);
  });

  it('answers nothing for a library that holds nothing like it', () => {
    expect(resolveSpokenRequest(library, 'Wagner')).toEqual([]);
  });

  it('answers nothing at all for an empty request', () => {
    expect(resolveSpokenRequest(library, '')).toEqual([]);
    expect(resolveSpokenRequest(library, '   ')).toEqual([]);
  });

  it('keeps a track with no number at the front of its album', () => {
    const untracked = [
      song({ title: 'B side', artist: 'Solo', album: 'Odds' }),
      song({ title: 'A side', artist: 'Solo', album: 'Odds', trackNo: 4 }),
    ];
    // `?? 0` is the rule: an untagged track sorts as zero rather than
    // dropping out of the queue.
    expect(resolveSpokenRequest(untracked, 'Solo').map((t) => t.title)).toEqual(['B side', 'A side']);
  });
});
