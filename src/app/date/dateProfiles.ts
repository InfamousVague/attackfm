import type { ServerSession } from '../api/http.ts';
import {
  fetchDateProfiles,
  type DateArtistProfile,
  type PreviewDateCard,
} from '../api/curator.ts';

/**
 * Who the deck's artists are, kept ahead of the cards.
 *
 * Structurally the same store as dateCanvas.ts, for the same reason: the deck
 * knows what is coming several cards before you do, so the answer should be
 * sitting here by the time the card is in your hand. What changed is where the
 * work happens - the hub now builds these when it deals the hand, so the usual
 * path costs nothing at all: `seed()` reads the profile straight off the card
 * the deal already delivered.
 *
 * The batch warm is the fallback for the two cases the deal cannot cover: the
 * library half of the deck (auditions, which never pass through the deal) and a
 * deck that has been open long enough to outrun what it was dealt.
 *
 * Module-level rather than a component ref, so leaving Music Date and coming
 * back keeps everything already learned. Nothing here holds an object URL, so
 * the cap is purely about memory.
 */

/** Entries kept before the oldest is dropped. A sitting rarely passes 40
 *  distinct artists, and each is a few hundred bytes. */
const CAP = 40;
/** A profile the hub says is `partial` is only the catalogue's half - the full
 *  build is running behind it. Worth one re-ask, not a poll. */
const SHALLOW_RETRY_MS = 15_000;

interface Entry {
  profile: DateArtistProfile | null;
  at: number;
}

/**
 * `undefined` = never asked. `null` = asked, and the hub has nothing on file.
 * The difference is the whole point: the old code caught its failures and
 * dropped them, so an artist that answered nothing was asked about again on
 * every single card advance, forever.
 */
const settled = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const order: string[] = [];

/**
 * A deliberately dumber fold than the server's: lowercase, apostrophes gone,
 * everything else collapsed to single spaces. It does NOT need to agree with
 * `discovery::artist_key_public` - the server re-keys authoritatively, so a
 * miss here costs one extra ask and can never produce the wrong artist. A
 * second copy of the real fold in TypeScript would be a rule with two homes.
 */
export function artistKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/['’ʼ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function remember(key: string, profile: DateArtistProfile | null): void {
  if (!settled.has(key)) order.push(key);
  settled.set(key, { profile, at: Date.now() });
  while (order.length > CAP) {
    const oldest = order.shift();
    if (oldest !== undefined) settled.delete(oldest);
  }
}

/** Whether this entry should be asked about again: never seen, or the hub said
 *  it only had half of it and enough time has passed for the rest to land. */
function wants(key: string): boolean {
  const held = settled.get(key);
  if (!held) return true;
  if (!held.profile?.partial) return false;
  return Date.now() - held.at > SHALLOW_RETRY_MS;
}

/** What is known about this artist right now, without asking. `undefined`
 *  means nobody has asked yet - the caller can show "looking them up". */
export function knownProfile(name: string): DateArtistProfile | null | undefined {
  return settled.get(artistKey(name))?.profile;
}

/**
 * Take the profiles the deal already delivered. Free - no request, no await:
 * the hub built these before it answered, and they arrived on the cards.
 */
export function seedDateProfiles(cards: PreviewDateCard[]): void {
  for (const c of cards) {
    if (c.profile === undefined || !c.artist) continue;
    const key = artistKey(c.artist);
    // A seeded partial must not overwrite a fuller one already learned.
    const held = settled.get(key);
    if (held?.profile && !held.profile.partial && c.profile?.partial) continue;
    remember(key, c.profile);
  }
}

/**
 * Ask for everyone in the next stretch of deck, in ONE request.
 *
 * Names are sent verbatim: the hub keys its reply by exactly what it was given,
 * because only it can compute the real fold.
 */
export async function warmDateProfiles(session: ServerSession, names: string[]): Promise<void> {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const name = n?.trim();
    if (!name) continue;
    const key = artistKey(name);
    if (seen.has(key) || inFlight.has(key) || !wants(key)) continue;
    seen.add(key);
    wanted.push(name);
  }
  if (wanted.length === 0) return;

  const run = (async () => {
    try {
      const rows = await fetchDateProfiles(session, wanted);
      for (const name of wanted) {
        remember(artistKey(name), rows[name] ?? null);
      }
    } catch {
      // Leave no trace: an older hub has no such route, and a failed ask must
      // not become a cached "nothing" that never gets retried.
    } finally {
      for (const name of wanted) inFlight.delete(artistKey(name));
    }
  })();
  // Registered before the await, so a second warm for the same names in the
  // same tick rides this request rather than starting a twin.
  for (const name of wanted) inFlight.set(artistKey(name), run);
  await run;
}

/** For the pane's own checks - the store is otherwise opaque. */
export function profileStoreSize(): number {
  return settled.size;
}

/** Testing seam: forget everything. */
export function resetDateProfiles(): void {
  settled.clear();
  inFlight.clear();
  order.length = 0;
}
