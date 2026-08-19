import type { ServerSession } from '../../app/api/http.ts';
import { deck, STEM_ORDER } from './engine.ts';
import {
  requestStems,
  stemAuthHeaders,
  stemBlockUrl,
  stemStatus,
  type StemStatus,
} from '../../app/api/stems.ts';

/**
 * Putting a song on the deck, in one place.
 *
 * Two surfaces do this now - the Pads board, and the Stems panel on the Now
 * Playing screen - and the sequence is fiddly enough that two copies would
 * drift: ask what exists, queue a separation only if nothing does, wait it out,
 * then hand the deck a way to fetch blocks. Getting the "only if nothing does"
 * part wrong is not cosmetic; it makes songs unplayable on a server whose
 * separator has been removed since.
 */

// The app's own session, not a narrowed copy: this used to declare the two
// fields it happened to touch, which is exactly how it ended up unable to build
// a mix URL (that needs streamToken) without casting.
export type Session = ServerSession;

export interface Song {
  id: number;
  title: string;
  artist: string;
  /** Seconds. Zero when the tags never said, which only costs looping. */
  duration: number;
}

/**
 * What the wait looks like from outside.
 *
 * A separation is minutes of GPU, and a spinner held for minutes is
 * indistinguishable from a hang - so this carries the real shape of it: which
 * phase, and how far through where the server can say. `fraction` is null when
 * there is genuinely no number (queued behind another song), which a bar should
 * show as unknown rather than as zero.
 */
export interface Preparing {
  phase: 'asking' | 'queued' | 'separating' | 'packing' | 'loading';
  fraction: number | null;
  /** Parts written so far, of how many the model makes. */
  filed: number;
  parts: number;
  /** Separations ahead of this one, where the server can say. */
  ahead: number | null;
  /**
   * Seconds since this wait began.
   *
   * The one number that is always available. A server that predates live
   * progress sends no percentage at all, and without this the panel had nothing
   * moving on it for the entire separation - which for a job that takes minutes
   * is indistinguishable from a hang, and is exactly how a working separation
   * came to look broken.
   */
  seconds: number;
}

export type Progress = (p: Preparing) => void;

/** `afm://123` or `afm://123@origin` - the id is what the stems API wants. */
export function trackId(path: string): number | null {
  if (!path.startsWith('afm://')) return null;
  const body = path.slice('afm://'.length);
  const at = body.indexOf('@');
  const id = Number(at === -1 ? body : body.slice(0, at));
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

async function api<T>(session: Session, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${session.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)));
  return (await res.json()) as T;
}

export interface Outcome {
  ok: boolean;
  stems: string[];
  /** Set when it did not work, in words worth showing someone. */
  problem?: string;
  /** True when another song took the deck while this was still working, in
   *  which case the caller must not touch any state - it is not theirs. */
  superseded?: boolean;
}

/**
 * Separate if needed, then open the whole song on the deck.
 *
 * Nothing is downloaded here. The deck streams the song a block at a time, so
 * this only establishes WHICH parts exist and hands over a way to fetch them:
 * the first sound arrives one block later rather than one song later.
 */
export async function putOnDeck(
  session: Session,
  song: Song,
  from: number,
  say: Progress,
): Promise<Outcome> {
  deck.clear();
  // Captured after the clear that bumped it. Everything below checks it: a
  // second song started while this one is still separating leaves TWO of these
  // running, and the loser has to stop rather than keep polling a job nobody is
  // waiting for and dropping its parts into somebody else's deck.
  const era = deck.generation;
  const mine = () => deck.generation === era;

    // The shared client, so URL shapes and auth rules live in one place. This
    // file's own idea of a status was narrower than the server's and dropped
    // the progress, phase and queue fields it then read back off `any`.
    const status = (): Promise<StemStatus> => stemStatus(session, song.id);

  try {
    // ASK FIRST, and only queue a separation if there is nothing there.
    //
    // Requesting one unconditionally looks harmless and is not: the request
    // endpoint refuses outright on a server with no separator installed, so a
    // song that WAS separated on a box whose tooling has changed since became
    // unplayable - the parts sitting on disk, and the only thing between them
    // and the board a request nobody needed to make.
    let have = (await status()).stems.map((x) => x.stem);

    if (have.length === 0) {
      const began = Date.now();
      const since = () => Math.round((Date.now() - began) / 1000);
      say({ phase: 'asking', fraction: null, filed: 0, parts: 6, seconds: 0, ahead: null });
      const asked = await requestStems(session, song.id);
      let state = asked.state;
      // Separation is minutes of GPU the first time and nothing at all after,
      // because the result is kept. Polled at a second rather than the old two
      // and a half: there is a bar moving now, and a bar that steps every two
      // and a half seconds looks broken even while it is right.
      while (state === 'queued' || state === 'running') {
        if (!mine()) return { ok: false, stems: [], superseded: true };
        await new Promise((r) => window.setTimeout(r, 1000));
        const now = await status();
        state = now.state;
        /*
         * A missing `phase` is not the same as being queued, and treating it as
         * one was a real bug: servers older than live progress never send the
         * field, so every separation on one of them read "waiting for the
         * separator" from the first second to the last. The JOB STATE is the
         * thing that knows - `running` means the model is working on this song,
         * whether or not the box can say how far along it is.
         */
          // The server's phase is a free string; this model's is a union, so an
          // unrecognised one falls back to what the JOB state says rather than
          // being asserted through.
          const phase: Preparing['phase'] =
            now.phase === 'separating' || now.phase === 'packing'
              ? now.phase
              : state === 'running'
                ? 'separating'
                : 'queued';
        say({
          phase,
          fraction: typeof now.progress === 'number' ? now.progress : null,
          filed: now.stems.length,
          parts: now.parts ?? 6,
          seconds: since(),
          ahead: typeof now.queuedAhead === 'number' ? now.queuedAhead : null,
        });
      }
      if (!mine()) return { ok: false, stems: [], superseded: true };
      if (state === 'failed') {
        // The server knows exactly why - it timed out, or demucs said something.
        // Replacing that with a shrug is how a diagnosable failure becomes a
        // mystery, and this one threw the answer away.
        const why = (await status().catch(() => null))?.error;
        return {
          ok: false,
          stems: [],
          problem: why ? `Could not separate that: ${why}` : 'That one could not be separated.',
        };
      }
      have = (await status()).stems.map((x) => x.stem);
    }
    if (!mine()) return { ok: false, stems: [], superseded: true };
    say({ phase: 'loading', fraction: null, filed: have.length, parts: have.length, seconds: 0, ahead: null });

    // Canonical order first, then anything a newer separator produced that this
    // build has never heard of - which should still land on the board rather
    // than being silently dropped.
    const stems = [
      ...STEM_ORDER.filter((x) => have.includes(x)),
      ...have.filter((x) => !STEM_ORDER.includes(x as (typeof STEM_ORDER)[number])),
    ];
    if (stems.length === 0) return { ok: false, stems: [], problem: 'Nothing came back for that song.' };

    deck.open({
      trackId: song.id,
      duration: song.duration,
      stems,
      from,
      fetch: (stem, at, len, flac) =>
        fetch(stemBlockUrl(session, song.id, stem, { from: at, len, flac }), {
            headers: stemAuthHeaders(session),
          }).then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.arrayBuffer();
        }),
    });
    return { ok: true, stems };
  } catch (e) {
    if (!mine()) return { ok: false, stems: [], superseded: true };
    return {
      ok: false,
      stems: [],
      problem: e instanceof Error && e.message ? e.message : 'Your server did not answer.',
    };
  }
}
