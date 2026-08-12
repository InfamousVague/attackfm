/**
 * The Bandsintown public artist-events endpoint, best-effort. It needs no
 * account - `app_id` is a self-chosen identifier - and answers CORS openly.
 * Everything here is defensive: a missing artist, a shape surprise, or a
 * closed network all come back as an empty list, and the page says what it
 * could and could not reach rather than failing whole.
 */

export interface Gig {
  artist: string;
  /** ISO local datetime from the API, e.g. "2026-09-14T20:00:00". */
  when: string;
  venue: string;
  city: string;
  /** Region + country, joined for the filter and the row. */
  where: string;
  /** The best link we have - offers first, the event page as fallback. */
  url: string | null;
}

const CACHE_KEY = 'attackfm-gig-radar-cache';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheShape {
  at: number;
  gigs: Record<string, Gig[]>;
}

export function readCache(): CacheShape | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null') as CacheShape | null;
    if (!parsed || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache(gigs: Record<string, Gig[]>): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), gigs }));
  } catch {
    // A cache that will not write is just a slower radar.
  }
}

/** One artist's upcoming events, or [] for any kind of no. */
export async function fetchGigs(artist: string, signal?: AbortSignal): Promise<Gig[]> {
  try {
    const response = await fetch(
      `https://rest.bandsintown.com/artists/${encodeURIComponent(artist)}/events?app_id=attackfm&date=upcoming`,
      { signal },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map((e): Gig | null => {
        const ev = e as {
          datetime?: string;
          url?: string;
          venue?: { name?: string; city?: string; region?: string; country?: string };
          offers?: Array<{ url?: string }>;
        };
        if (!ev?.datetime || !ev.venue?.name) return null;
        return {
          artist,
          when: ev.datetime,
          venue: ev.venue.name,
          city: ev.venue.city ?? '',
          where: [ev.venue.region, ev.venue.country].filter(Boolean).join(', '),
          url: ev.offers?.[0]?.url ?? ev.url ?? null,
        };
      })
      .filter((g): g is Gig => g !== null);
  } catch {
    return [];
  }
}
