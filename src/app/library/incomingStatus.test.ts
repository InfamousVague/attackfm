import { describe, expect, it } from 'vitest';
import { incomingStatus, shortFailure, type Tr } from './incomingStatus.ts';
import type { IncomingTrack } from '../downloads/incoming.tsx';

/**
 * The one line under an arriving song's name.
 *
 * Three situations wear this line - a download that is RUNNING, one the hub
 * has promised but is not touching right now, and one that already DIED and
 * can be started again - and the whole value of the line is telling them
 * apart. Getting it wrong is not a cosmetic slip: a spinner and "downloading"
 * over a song nothing is fetching is the sentence that made these rows look
 * stuck for days, and it looks exactly like progress while it does it.
 *
 * The translator echoes its key and its options, so every assertion below
 * names the catalogue entry the code chose rather than the English that entry
 * happens to hold today.
 */
const tr = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as Tr;

/** An arriving song. `over` names only the fields the case is about. */
const incoming = (over: Partial<IncomingTrack> = {}): IncomingTrack => ({
  key: 'artist|song',
  title: 'Song',
  artist: 'Artist',
  artwork: null,
  progress: null,
  source: 'like',
  ...over,
});

describe('shortFailure', () => {
  it('keeps the FIRST line and drops the transcript underneath it', () => {
    /*
     * The whole job. The server sends a sentence a person can act on and then
     * its own provider transcript below - stack frames, a URL, a status code.
     * Rendered whole, the actionable half is pushed off the end of a table
     * cell by machinery nobody reading the row can use.
     */
    expect(
      shortFailure('Not found on any source\n  at deezer::fetch (deezer.rs:88)\n  502', tr),
    ).toBe('Not found on any source');
  });

  it('strips the "Retry to resume" tail, because the button IS the retry', () => {
    // The row already carries a retry control; repeating the instruction in
    // the one line of space costs the reason the job failed.
    expect(shortFailure('Download stalled. Retry to resume.', tr)).toBe('Download stalled.');
    expect(shortFailure('Download stalled Retry to resume', tr)).toBe('Download stalled');
  });

  it('falls back to the generic word when there is nothing to say', () => {
    // Null, absent, blank, and whitespace-only all mean the server told us
    // nothing - and a row with an empty status line reads as a bug.
    expect(shortFailure(null, tr)).toBe('downloads.failed');
    expect(shortFailure(undefined, tr)).toBe('downloads.failed');
    expect(shortFailure('', tr)).toBe('downloads.failed');
    expect(shortFailure('   \n details below', tr)).toBe('downloads.failed');
  });

  it('falls back when the whole first line WAS the retry instruction', () => {
    // Stripping the tail can empty the string. The `cut || fallback` at the
    // end of the function is the only thing between that and a blank line.
    expect(shortFailure('Retry to resume.', tr)).toBe('downloads.failed');
  });

  it('truncates at a cell width, and marks that it did', () => {
    /*
     * 48 characters fit; 49 do not. The ellipsis is the part that matters -
     * a hard cut at 45 reads as a message that happens to end mid-word, and
     * the reader cannot tell whether the server stopped or the table did.
     */
    const fits = 'x'.repeat(48);
    expect(shortFailure(fits, tr)).toBe(fits);
    const over = 'x'.repeat(49);
    expect(shortFailure(over, tr)).toBe(`${'x'.repeat(45)}…`);
    expect(shortFailure(over, tr)).toHaveLength(46);
  });
});

describe('incomingStatus', () => {
  it('says a RUNNING download is downloading', () => {
    expect(incomingStatus(incoming({ artist: '' }), tr)).toBe('downloads.downloading');
  });

  it('never calls a stalled download running - the failure that started this', () => {
    /*
     * `stalled` means the hub has promised the song and is NOT fetching it
     * right now; it retries daily. "Downloading" over that is a spinner
     * pretending motion over an empty queue, and the row looked alive for
     * days at a time.
     */
    const waiting = incomingStatus(incoming({ artist: '', stalled: true }), tr);
    expect(waiting).toBe('downloads.waitingTurn');
    expect(waiting).not.toBe('downloads.downloading');
  });

  it('distinguishes "waiting its turn" from "it already died"', () => {
    /*
     * Both are stalled; only one has anything scheduled to touch it. A job
     * with a retry control is a job that FAILED, and saying it will retry -
     * with nothing running - is the other half of the same lie.
     */
    const dead = incoming({
      artist: '',
      stalled: true,
      onRetry: () => {},
      failure: 'Not found on any source',
    });
    expect(incomingStatus(dead, tr)).toBe('Not found on any source');
    expect(incomingStatus({ ...dead, onRetry: undefined }, tr)).toBe('downloads.waitingTurn');
  });

  it('reports the reason a dead job gives, not the generic word, when it has one', () => {
    // The point of surfacing the failure at all: "not found" and "stalled"
    // are the same row to the code and opposite decisions to the person.
    const dead = (failure: string) =>
      incomingStatus(incoming({ artist: '', stalled: true, onRetry: () => {}, failure }), tr);
    expect(dead('Not found on any source')).not.toBe(dead('Download stalled'));
    // ...and it still falls back when the job died silently.
    expect(
      incomingStatus(incoming({ artist: '', stalled: true, onRetry: () => {} }), tr),
    ).toBe('downloads.failed');
  });

  it('joins the credit and the status through ONE catalogue entry, not a dash', () => {
    /*
     * Which side of the join each half sits on - and whether a dash is the
     * right mark at all - is the translator's call. Two fragments glued here
     * would be an English sentence wearing eight languages' words.
     */
    expect(incomingStatus(incoming(), tr)).toBe(
      'downloads.statusWithArtist:{"artist":"Artist","status":"downloads.downloading"}',
    );
  });

  it('says the status alone when the song has no credit', () => {
    // A catalogue row with no artist would otherwise render the join entry
    // around an empty name - a dash with nothing in front of it.
    expect(incomingStatus(incoming({ artist: '' }), tr)).toBe('downloads.downloading');
  });
});
