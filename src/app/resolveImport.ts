import { fold, sameArtist, titleKey } from './owned.ts';
import { searchCatalog, type SearchResult, type ServerSession } from './server.ts';

/**
 * Finding a record the importer can actually take.
 *
 * A discography arrives from Deezer, and the importer refuses a Deezer link as
 * primary input - it uses Deezer as a download SOURCE, never as something you
 * hand it. So every album on an artist page names a real record that the app
 * knows about and cannot fetch, which is a dead end wearing the shape of a
 * button.
 *
 * The way out is that the same record almost always exists on Spotify, and the
 * catalogue search can see Spotify (it borrows SpotiFLAC's metadata client,
 * which reaches Spotify from a box where the web player's anonymous token is
 * blocked). So a tap on a missing record searches for it by name and hands the
 * importer the Spotify link it wanted all along.
 *
 * The matching is the careful part. Searching "Radiohead OK Computer" returns
 * "Radiohead's OK Computer" by The Gentlemen Of NUCO, three string-quartet
 * tribute records, and a piano-covers album - all genuinely called what you
 * asked for. Importing one of those instead of the real thing is worse than
 * importing nothing, so a candidate has to answer to BOTH the title and the
 * artist before it is offered.
 */

/** A URL shaped like the one a resolve would find. Used only to ask the acquire
 *  handlers "would you take an album link, if I had one?" - a downloader's
 *  `canHandle` tests for a URL, so probing with an empty one always says no and
 *  the control would never appear. */
export const PROBE_URL = 'https://open.spotify.com/album/0000000000000000000000';

/**
 * Whether the importer can take this row as primary input.
 *
 * The server says so per row - but only a server new enough to have been told
 * to. Against an older one the field is simply absent, and reading `undefined`
 * as "no" makes every candidate unusable: the resolver rejects the whole result
 * set and every record on every page answers "Not on Spotify", which is both
 * wrong and the least debuggable way to be wrong.
 *
 * So an absent field means "the server did not say", and we work it out from
 * the link ourselves with the same rule the server uses. A server that DOES
 * say still wins - it knows things the URL shape does not.
 */
export function importable(row: { url: string; importable?: boolean }): boolean {
  if (typeof row.importable === 'boolean') return row.importable;
  return row.url.includes('open.spotify.com/') || row.url.startsWith('spotify:');
}

/** How close a candidate is to what was asked for; lower is better, and
 *  anything at or past `REJECT` is not the same record. */
const REJECT = 9;

function score(candidate: SearchResult, artist: string, title: string): number {
  // The billing has to match first. A tribute album carries the tribute band's
  // name, so this is what keeps "VSQ Performs Radiohead" out.
  if (!sameArtist(fold(candidate.subtitle), fold(artist))) return REJECT;

  const want = titleKey(title);
  const got = titleKey(candidate.title);
  if (!want || !got) return REJECT;
  if (got === want) return 0;
  // A deluxe or anniversary edition IS the record, wearing a longer name; the
  // reverse (what you asked for containing what was found) is a different
  // record whose name happens to be a prefix, so it does not count.
  if (got.startsWith(`${want} `)) return 1;
  return REJECT;
}

/**
 * The best importable match for a record, or null when the catalogue has none.
 *
 * Only ever returns something the importer can take: an unimportable candidate
 * is no better than the link we already had.
 */
export async function resolveImportable(
  session: ServerSession,
  kind: 'album' | 'track',
  artist: string,
  title: string,
  signal?: AbortSignal,
): Promise<SearchResult | null> {
  // Ask with the title REDUCED to the recording it names. A catalogue title
  // carries its billing - "Knuckle Velvet (feat. Yah Wav)" - and handing that
  // whole string to search throws it off badly enough that the right track
  // does not come back at all (it answers with other people's "Velvet"). The
  // same query without the credit puts it first. The raw title is still tried
  // if the clean one finds nothing, since the cleaner only knows the noise it
  // has been taught.
  const cleaned = titleKey(title);
  const queries = cleaned && cleaned !== fold(title) ? [cleaned, title] : [title];

  for (const q of queries) {
    const results = await searchCatalog(session, `${artist} ${q}`, signal);
    let best: SearchResult | null = null;
    let bestScore = REJECT;
    for (const r of results) {
      if (r.kind !== kind || !importable(r)) continue;
      const s = score(r, artist, title);
      if (s < bestScore) {
        best = r;
        bestScore = s;
        if (s === 0) break;
      }
    }
    if (best) return best;
  }
  return null;
}
