//! A photograph for an artist's name.
//!
//! Friends announce a top artist as a bare string - "Fontaines D.C." - and a
//! card wants a picture behind it. Nothing in the library can answer that when
//! the artist is someone a friend plays and you do not own, so this asks the
//! catalogue the same way the artist page does, and remembers the answer.
//!
//! Everything here is best-effort by design. A card with no picture is a card
//! with a gradient, which is fine; a card that blocked on a lookup, or asked
//! again on every render, would not be. So: one in-flight request per name,
//! a persistent cache, and negative results remembered too - an artist the
//! catalogue does not know should be asked about once, not once a second.

import { fetchCatalogArtist, type ServerSession } from './server.ts';

const KEY = 'attackfm-artist-pictures';
/** How long an answer stays good. Artist photos change rarely; a month keeps
 *  the cache useful without pinning a wrong picture forever. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry {
  /** The picture URL, or null when the catalogue had none. */
  url: string | null;
  at: number;
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Entry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // The in-memory map still serves this run.
  }
}

const memory = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const all = readAll();
  const now = Date.now();
  for (const [name, entry] of Object.entries(all)) {
    if (now - entry.at < TTL_MS) memory.set(name, entry);
  }
}

function normalise(name: string): string {
  return name.trim().toLowerCase();
}

/** The cached picture for a name, without asking anyone. Safe in a render. */
export function cachedArtistImage(name: string): string | null {
  if (!name.trim()) return null;
  hydrate();
  return memory.get(normalise(name))?.url ?? null;
}

/** Whether this name has already been answered, right or wrong. */
export function artistImageKnown(name: string): boolean {
  if (!name.trim()) return true;
  hydrate();
  return memory.has(normalise(name));
}

/**
 * Look a name up, once.
 *
 * Concurrent callers for the same artist share one request - a grid of eight
 * friends who all love the same band should cost one lookup, not eight. The
 * empty id is deliberate: `/api/artist` resolves by name when it has no
 * catalogue id, which is exactly the position a friend's announcement leaves
 * us in.
 */
export async function resolveArtistImage(
  session: ServerSession,
  name: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  hydrate();
  const key = normalise(clean);
  const hit = memory.get(key);
  if (hit) return hit.url;
  const already = inFlight.get(key);
  if (already) return already;

  const run = (async () => {
    let url: string | null = null;
    try {
      const artist = await fetchCatalogArtist(session, '', clean, signal);
      url = artist.picture ?? null;
    } catch {
      // No catalogue, no network, or a name it cannot place. Remembered as a
      // miss so the grid stops asking.
      url = null;
    }
    const entry: Entry = { url, at: Date.now() };
    memory.set(key, entry);
    const all = readAll();
    all[key] = entry;
    writeAll(all);
    inFlight.delete(key);
    return url;
  })();
  inFlight.set(key, run);
  return run;
}
