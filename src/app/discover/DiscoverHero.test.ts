/**
 * `heroLead` - what the top of Discover leads with.
 *
 * Three arms, in a stated order: "the newest thing the machine has for you:
 * the first 'New for you' list, or - on a hub with no model to build one - the
 * daylist, the one card that moves with the clock. Neither yet (a fresh
 * account, a curator still reading) and it leads with the library itself."
 *
 * The fourth field is the one worth pinning hardest. `first` is the song a
 * single Canvas clip is asked for, and the library arm must leave it null -
 * a video request for "the library" is a request for nothing, and the hero
 * would sit on a dead fetch rather than falling through to its mosaic.
 *
 * Only the function is exercised, not the component: everything below the
 * lead is a `<CoverWall>` wearing it, and a render test would assert that
 * React can mount a div.
 */
import { describe, expect, it } from 'vitest';
import { heroLead } from './DiscoverHero.tsx';
import type { DiscoverFeedValue } from '../home/DiscoverFeed.tsx';
import type { NewMusicList, NewMusicTrack } from '../api/newMusic.ts';
import type { Track } from '../core/tauri.ts';

/** The translator echoes its key, so the assertions name the catalogue entry
 *  the code chose rather than the English it happens to hold today. */
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as Parameters<typeof heroLead>[2];

const track = (n: number, artwork: string | null = null): Track =>
  ({ path: `afm://${n}`, title: `Song ${n}`, artist: `Artist ${n}`, artwork }) as Track;

/** A catalogue row. `cover` is typed non-null on `NewMusicTrack`, so the
 *  no-cover case - which the hero really does have to survive - goes in as an
 *  explicit `as unknown as`, saying out loud that it is malformed rather than
 *  hiding it behind a loosened type. */
const listItem = (n: number, cover: string | null = `https://hub.test/c${n}`): NewMusicTrack =>
  ({
    id: `deezer:track:${n}`,
    title: `New ${n}`,
    artist: `Band ${n}`,
    cover,
    url: `https://deezer.test/${n}`,
    preview: '',
    seed: 'Band 1',
    bpm: null,
    lyricsRead: false,
    score: 1,
  }) as unknown as NewMusicTrack;

const forYouList = (over: Partial<NewMusicList> = {}): NewMusicList =>
  ({ id: 'l1', title: 'Out this week', blurb: '', items: [listItem(1), listItem(2)], ...over }) as NewMusicList;

const daylistCard = (over: Record<string, unknown> = {}) => ({
  id: 'curated-daylist-1',
  title: 'Tuesday morning',
  subtitle: 'card 1',
  blurb: 'Something bright',
  flavor: 'heuristic' as const,
  tracks: [track(1, 'https://hub.test/a?track=1'), track(2, 'https://hub.test/a?track=2')],
  ...over,
});

/** A feed with everything off; each test switches one thing on. */
function feed(over: {
  newMusic?: NewMusicList[] | null;
  daylist?: ReturnType<typeof daylistCard> | null;
} = {}): DiscoverFeedValue {
  return {
    newMusic: over.newMusic ?? null,
    home: { daylist: over.daylist ?? null },
  } as unknown as DiscoverFeedValue;
}

describe('the order the three arms are tried in', () => {
  it('leads with the first "New for you" list when there is one', () => {
    const lead = heroLead(feed({ newMusic: [forYouList()], daylist: daylistCard() }), [track(1)], t);
    expect(lead.kind).toBe('list');
    expect(lead.title).toBe('Out this week');
    expect(lead.kicker).toBe('discover.newForYou');
  });

  it('falls to the daylist on a hub with no model to build a list', () => {
    const lead = heroLead(feed({ newMusic: [], daylist: daylistCard() }), [track(1)], t);
    expect(lead.kind).toBe('daylist');
    // The daylist's own two lines swap places here: the clock heading becomes
    // the kicker, and the card's real name becomes the title.
    expect(lead.kicker).toBe('Tuesday morning');
    expect(lead.title).toBe('card 1');
    expect(lead.blurb).toBe('Something bright');
  });

  it('falls to the library when neither has anything', () => {
    const lead = heroLead(feed(), [track(1)], t);
    expect(lead.kind).toBe('library');
    expect(lead.kicker).toBe('nav.discover');
    expect(lead.title).toBe('discover.libraryReadBack');
  });

  it('treats a feed that has not answered the same as an empty one', () => {
    // `newMusic` is null until the fetch lands; the hero must not wait.
    expect(heroLead(feed({ newMusic: null }), [track(1)], t).kind).toBe('library');
  });

  it('skips the global list, which is not "for you"', () => {
    // `newForYouLists` filters it out; a hub with only the global list should
    // fall through to the daylist rather than lead with everyone's chart.
    const global = forYouList({ id: 'nm-popping' });
    const lead = heroLead(feed({ newMusic: [global], daylist: daylistCard() }), [track(1)], t);
    expect(lead.kind).toBe('daylist');
  });
});

describe('THE LIBRARY LEAD NEVER ASKS FOR A CANVAS', () => {
  it('leaves `first` null, because there is no one song to ask about', () => {
    /*
     * A Canvas clip is fetched by title and artist. "The library" has neither,
     * so a lead that named one would be asking the hub about a song that does
     * not exist - a request that fails slowly and leaves the band blank while
     * it does.
     */
    const lead = heroLead(feed(), [track(1), track(2)], t);
    expect(lead.first).toBeNull();
  });

  it('still leaves it null when the library is full of songs', () => {
    const many = Array.from({ length: 50 }, (_, i) => track(i, `https://hub.test/a${i}`));
    expect(heroLead(feed(), many, t).first).toBeNull();
  });

  it('and the OTHER two arms do name a song', () => {
    // The third case: `first: null` is a property of the library arm, not of
    // the function - a lead that never named a song would never show a clip.
    const list = heroLead(feed({ newMusic: [forYouList()] }), [], t);
    expect(list.first).toEqual({ title: 'New 1', artist: 'Band 1' });
    const day = heroLead(feed({ daylist: daylistCard() }), [], t);
    expect(day.first).toEqual({ title: 'Song 1', artist: 'Artist 1' });
  });

  it('leaves it null on an empty list or an empty daylist', () => {
    expect(heroLead(feed({ newMusic: [forYouList({ items: [] })] }), [], t).first).toBeNull();
    expect(heroLead(feed({ daylist: daylistCard({ tracks: [] }) }), [], t).first).toBeNull();
  });
});

describe('the blurb', () => {
  it('uses the list\'s own line when it has one', () => {
    const lead = heroLead(feed({ newMusic: [forYouList({ blurb: 'Nine you do not own' })] }), [], t);
    expect(lead.blurb).toBe('Nine you do not own');
  });

  it('counts the songs when the list has no line', () => {
    // A pluralised count through the catalogue, not `${n} songs`.
    const lead = heroLead(feed({ newMusic: [forYouList({ blurb: '' })] }), [], t);
    expect(lead.blurb).toBe('discover.notOwnedYetCount:{"count":2}');
  });

  it('says something different for an empty library than for a full one', () => {
    // "add some music" and "still learning" are two different situations and
    // the fresh-account one must not read as a progress report.
    expect(heroLead(feed(), [], t).blurb).toBe('discover.addMusicBlurb');
    expect(heroLead(feed(), [track(1)], t).blurb).toBe('discover.learningBlurb');
  });
});

describe('the covers each arm wears', () => {
  it('takes the list\'s own covers, deduped', () => {
    const list = forYouList({
      items: [listItem(1), listItem(1), listItem(2), listItem(3), listItem(4), listItem(5)],
    });
    const lead = heroLead(feed({ newMusic: [list] }), [], t);
    expect(lead.covers).toEqual([1, 2, 3, 4].map((n) => `https://hub.test/c${n}`));
  });

  it('drops list items with no cover', () => {
    const list = forYouList({ items: [listItem(1, null), listItem(2)] });
    expect(heroLead(feed({ newMusic: [list] }), [], t).covers).toEqual(['https://hub.test/c2']);
  });

  it('folds one album down to one sleeve on the daylist arm', () => {
    // `mosaicArts` compares by origin+path, so four songs off one record are
    // one picture - the hero would otherwise draw the same sleeve four times.
    const lead = heroLead(feed({ daylist: daylistCard() }), [], t);
    expect(lead.covers).toHaveLength(1);
    expect(lead.covers[0]).toContain('size=640');
  });

  it('asks for the tile-sized variant on the library arm too', () => {
    const many = [track(1, 'https://hub.test/a1'), track(2, 'https://hub.test/a2')];
    const lead = heroLead(feed(), many, t);
    expect(lead.covers).toHaveLength(2);
    for (const url of lead.covers) expect(url).toContain('size=640');
  });

  it('is simply empty when nothing has a cover', () => {
    expect(heroLead(feed(), [track(1), track(2)], t).covers).toEqual([]);
  });
});

describe('what the page needs to suppress a duplicate below', () => {
  it('carries the list or the tracks, so the shelves can drop what the hero took', () => {
    // The interface exists "so the page can keep the shelves from showing the
    // same list an inch below it".
    const list = heroLead(feed({ newMusic: [forYouList()] }), [], t);
    expect(list.list?.id).toBe('l1');
    expect(list.tracks).toBeUndefined();

    const day = heroLead(feed({ daylist: daylistCard() }), [], t);
    expect(day.tracks).toHaveLength(2);
    expect(day.list).toBeUndefined();

    const library = heroLead(feed(), [track(1)], t);
    expect(library.list).toBeUndefined();
    expect(library.tracks).toBeUndefined();
  });
});
