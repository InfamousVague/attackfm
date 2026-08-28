/*
 * Is the hub answering?
 *
 * Not the same question as `navigator.onLine`, which is why that is not used
 * here: a phone sitting on wifi with a dead home server is emphatically online
 * and can reach nothing that matters. What the app actually needs to know is
 * whether ITS server is replying, and the only honest source for that is
 * whether requests to it are coming back.
 *
 * WHY ANYTHING CARES. Several surfaces refuse a local copy in favour of the
 * server - a track with effects on has to be rendered by the hub, so the vault
 * copy is deliberately declined. That trade is right while the hub is there and
 * exactly wrong when it is not: a song that plays without its filters beats a
 * song that does not play. This is what lets those places tell the difference.
 */

/** Two in a row, because one timeout is a hiccup and not an outage. */
const SILENCES_BEFORE_DOWN = 2;

let silences = 0;
let down = false;
const listeners = new Set<() => void>();

/*
 * navigator.onLine, in the one direction it can be trusted.
 *
 * The note above still holds: "online" proves nothing - wifi with a dead hub
 * is online and can reach nothing that matters, so a TRUE from the browser
 * never marks the server up. But FALSE is a hard fact: airplane mode, radios
 * off - no request can succeed. Waiting for two JSON calls to time out before
 * believing it was this module's blind spot, and it had a real cost: at a
 * cold boot in airplane mode the flag started "up", so every gate that
 * declines the local copy in the server's favour (the effects rack above all)
 * declined it into a void, and cached music would not play until something
 * unrelated had failed twice.
 */
if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  down = true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    silences = SILENCES_BEFORE_DOWN;
    publish(true);
  });
  window.addEventListener('online', () => {
    // Optimistic: the radios are back, let the next real request confirm.
    // Wrong only in the direction that costs a failed stream attempt; the
    // other direction kept working music silent.
    silences = 0;
    publish(false);
  });
}

function publish(next: boolean): void {
  if (next === down) return;
  down = next;
  for (const fn of listeners) fn();
}

/** The transport failed: no status, no body - nobody answered the door. */
export function noteServerSilent(): void {
  silences += 1;
  if (silences >= SILENCES_BEFORE_DOWN) publish(true);
}

/**
 * Something came back.
 *
 * ANY reply counts, including a 500 and a 404: those are the server talking.
 * Only silence means it is gone, and treating an error page as an outage would
 * have the app fall back to the vault over a bad request.
 */
export function noteServerAnswered(): void {
  silences = 0;
  publish(false);
}

/**
 * A media element failed at the transport - the <audio> src that never
 * loaded, the stream that died. Counted exactly like a silent JSON call,
 * because it is one: nobody answered. The player is often the FIRST thing to
 * touch the network after connectivity dies, and before this its failures
 * never taught the flag anything - the song failed, the vault stayed
 * declined, and the flag went on claiming the server was fine.
 */
export function noteMediaSilent(): void {
  noteServerSilent();
}

/** Best guess: has the hub stopped answering? */
export function serverSeemsDown(): boolean {
  return down;
}

export function subscribeReachability(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
