//! The ranking signal: which songs are most likely to be wanted next, and the
//! Date-deck hint that the page publishes for the sweep to act on.

import {
  fetchHome,
  fetchRemoteFavorites,
  fetchRemotePlaylists,
  remotePath,
  trackIdFromPath,
  type ServerSession,
} from '../server.ts';

// --- what is worth holding -------------------------------------------------

/**
 * The next Dates, published by the deck itself.
 *
 * Everything else {@link rankHotness} weighs is a fact the SERVER holds -
 * likes, play counts, recency. The Date deck is not: it is computed on the
 * device from what has already been judged, passed and hearted this sitting,
 * so the only place that knows it is the page drawing it. It is left here as
 * a hint rather than fetched, and an empty hint simply means the deck has not
 * been opened yet.
 */
const DATE_DECK_KEY = 'attackfm-date-deck';

/** How many cards ahead to guarantee. */
export const DATE_CACHE_TARGET = 20;

// Persisted, because the page that publishes the deck is rarely open when the
// sweep that could act on it runs. The launch sweep fires ninety seconds in -
// long before anyone has navigated to Dates - and with an in-memory hint that
// pass would warm nothing, so "instant" would only ever start being true on
// the SECOND visit of a session. The stored deck is at worst a few days
// stale, and staleness here is cheap: these are library songs the listener
// was about to be shown anyway, and the next visit republishes the truth.
let dateDeck: string[] = (() => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DATE_DECK_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string').slice(0, DATE_CACHE_TARGET);
  } catch {
    return [];
  }
})();

/**
 * Tell the cache which cards are coming. Called by the Date page as its deck
 * changes; the next sweep acts on it, and the launch sweep of the NEXT run
 * acts on it too - see the note on `dateDeck`.
 */
export function setDateDeck(keys: string[]): void {
  dateDeck = keys.slice(0, DATE_CACHE_TARGET);
  try {
    localStorage.setItem(DATE_DECK_KEY, JSON.stringify(dateDeck));
  } catch {
    // Then the next launch warms nothing until the page opens - the old
    // behaviour, not an error.
  }
}

export interface Hotness {
  /** How many liked songs the server reported, or -1 if it could not be asked. */
  liked?: number;
  /** Library path (`afm://<id>`), most-wanted first. */
  keys: string[];
  /** Why, for the settings pane to explain itself. */
  reasons: Map<string, string>;
}

/**
 * Rank the library by how likely it is to be wanted next.
 *
 * The weights are ordinal rather than measured - what matters is the ORDER,
 * and that liked songs beat heavy rotation beats recent beats new. A song can
 * score on several counts and should: something both liked and on repeat is
 * the surest bet on the phone.
 *
 * This is also the ranking a "fast sync" server would need to decide what to
 * hold, which is why it returns keys and reasons rather than doing anything
 * with them.
 */
export async function rankHotness(session: ServerSession): Promise<Hotness> {
  const score = new Map<string, number>();
  const reasons = new Map<string, string>();
  const bump = (id: number, points: number, why: string) => {
    const key = remotePath(id);
    score.set(key, (score.get(key) ?? 0) + points);
    if (!reasons.has(key)) reasons.set(key, why);
  };

  // The next cards on the Date deck, ahead of everything - including likes.
  //
  // Not because a Date matters more than a song you love, but because of when
  // it is needed. A liked song is a permanent resident and will be cached on
  // any pass; a Date is judged in about four seconds and then gone, so the
  // round trip lands inside the swipe, which is exactly where it shows. It is
  // also a bounded set - twenty songs - so putting it first cannot crowd the
  // cache out the way an unbounded signal could.
  dateDeck.forEach((key, i) => {
    const id = trackIdFromPath(key);
    if (id !== null) bump(id, 2000 - i, 'up next on Dates');
  });

  // Liked songs are the one signal the listener stated out loud.
  let liked = 0;
  try {
    const favorites = await fetchRemoteFavorites(session);
    liked = favorites.length;
    for (const id of favorites) bump(id, 1000, 'liked');
  } catch {
    // A signal that will not load is one fewer input, not a failure - but it
    // IS the difference between "you have no liked songs" and "we could not
    // ask", so it leaves -1 behind rather than nothing.
    liked = -1;
  }

  // Everything in a playlist, just under liked.
  //
  // A playlist is a stated wish in the same way a like is - somebody put that
  // song there on purpose - so it belongs with the permanent residents rather
  // than with the guesses. UNDER liked rather than level with it because a like
  // is about the song and a playlist is often about an occasion; when the budget
  // runs out, the song you love is the one that should stay.
  //
  // Fetched rather than read from the playlists context, because this runs from
  // the sweep rather than from a component - which also means a phone that has
  // never opened the playlists page still holds them.
  //
  // Deliberately flat: every track in every list scores the same. Ranking lists
  // against each other would need a signal nobody has stated, and position
  // within a list says nothing about how much it is wanted.
  //
  // Collected into a Set FIRST because bump() accumulates, and being on two
  // playlists is one signal recorded twice rather than two signals agreeing. Add
  // it per list and a song on two of them scores 1400, which would put it above
  // liked and quietly invert the whole order this block just claimed to keep.
  try {
    const lists = await fetchRemotePlaylists(session);
    const listed = new Set<number>();
    for (const list of lists) {
      for (const id of list.tracks) listed.add(id);
    }
    for (const id of listed) bump(id, 700, 'in a playlist');
  } catch {
    // Same as the others: one fewer input, not a failure.
  }

  try {
    const feed = await fetchHome(session);
    // Play count, but flattened: the 200-play song and the 40-play song are
    // both "yours", and letting raw counts run would let one obsession crowd
    // the whole cache out.
    for (const { id, plays } of feed.heavyPlays ?? []) {
      bump(id, 300 + Math.min(200, Math.sqrt(plays) * 40), 'on repeat');
    }
    for (const id of feed.heavy ?? []) bump(id, 300, 'on repeat');
    // Recency decays down the list, so the last thing played outranks the
    // fortieth.
    (feed.recent ?? []).forEach((id, i) => bump(id, Math.max(40, 250 - i * 5), 'played recently'));
    for (const album of feed.jumpBackIn ?? []) {
      for (const id of album) bump(id, 120, 'from an album you came back to');
    }
    for (const id of feed.fresh ?? []) bump(id, 60, 'newly added');
  } catch {
    // Same.
  }

  const keys = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return { keys, reasons, liked };
}
