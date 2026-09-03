import { useEffect } from 'react';
import { fetchDateCandidates } from '../api/curator.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { discoveryNoticesEnabled } from '../settings/behaviourPrefs.ts';
import { dismissNotice, noteNotice } from './notices.ts';

/**
 * "Songs are waiting to meet you," in the bell.
 *
 * Music Date deals the collector's finds a few seconds at a time - art and
 * sound, no names - and the pool behind it fills on the server's own schedule.
 * The `dates` notice kind has existed since the ring did, with an icon and a
 * settings line, and nothing ever raised one: you learned the pool had grown
 * only by opening the deck. This is the watcher that says so.
 *
 * A RATCHET, not a level. The pool's depth (`total`) goes both ways - it grows
 * when the collector finds more, and SHRINKS every time you judge a card - so
 * ringing on "it changed" would buzz on every swipe. Instead a high-water mark
 * is kept per account and only ever climbs: a notice fires when the pool passes
 * a new peak by a few, and judging cards (which only lowers the pool) or the
 * server refilling back toward an old peak stays silent. Only genuinely new
 * depth, beyond the highest the pool has ever reached for you, is news.
 *
 * The mark lives in localStorage, per account, for the same reasons as the
 * new-music baseline beside it: durable across launches, and not the notice
 * ring (which is bounded and clearable). Scoped by account so one listener's
 * pool is never counted for another.
 */

/** A 'waiting to meet you' pool is not urgent to the second. Three minutes is
 *  a light touch and one request per tick per device. */
const POLL_MS = 3 * 60 * 1000;

/** How far past the previous peak the pool must climb to be worth a word - so a
 *  single card trickling in does not ring, but a real refill does. */
const STEP = 3;

/** localStorage, per account. `hw` is the high-water mark (only ever climbs);
 *  `lastId` is the notice currently standing, so a new peak can replace it. */
interface Mark {
  hw: number;
  lastId: string;
}

function keyFor(url: string, user: string): string {
  return `attackfm-dates-hw:${url}:${user}`;
}

/** Read the mark, or null when this account has never been observed - the
 *  difference between "seed silently" and "measure against the peak". */
function readMark(key: string): Mark | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Mark>;
    return {
      hw: typeof parsed.hw === 'number' && parsed.hw >= 0 ? parsed.hw : 0,
      lastId: typeof parsed.lastId === 'string' ? parsed.lastId : '',
    };
  } catch {
    return null;
  }
}

function writeMark(key: string, mark: Mark): void {
  try {
    localStorage.setItem(key, JSON.stringify(mark));
  } catch {
    // A refusal just means a re-seed next launch; a lost notice, never a wrong one.
  }
}

export function MusicDateNotices() {
  const { session } = useServerSession();

  useEffect(() => {
    if (!session) return;
    const key = keyFor(session.url, session.username);
    let alive = true;

    const look = async () => {
      if (!discoveryNoticesEnabled()) return;
      if (document.visibilityState === 'hidden') return;

      let pool;
      try {
        // count=1: `total` is the FULL pool depth whatever the count, so this is
        // the one-card, one-number request the Music Date chip already uses to
        // read the same figure.
        pool = await fetchDateCandidates(session, 1);
      } catch {
        return;
      }
      if (!alive) return;

      const total = pool.total;
      const mark = readMark(key);
      if (mark === null) {
        // First sight: the pool as it stands is the peak, said silently. A pool
        // that was already deep when you installed is not an arrival.
        writeMark(key, { hw: total, lastId: '' });
        return;
      }

      // Climbed past the peak by a clear margin, or gone from empty to anything.
      const rose = total >= mark.hw + STEP || (mark.hw === 0 && total > 0);
      if (!rose) {
        // A shrink (you judged some) or a refill toward an old peak never lowers
        // the mark and never rings.
        return;
      }

      const id = `dates:waiting:${total}`;
      if (mark.lastId && mark.lastId !== id) dismissNotice(mark.lastId);

      noteNotice({
        id,
        kind: 'dates',
        title: 'Waiting to meet you',
        body:
          total === 1
            ? 'A song is queued for a date — art and sound, no names.'
            : `${total} songs are queued for a date — art and sound, no names.`,
        // The top card's cover, a remote catalogue URL. Straight through, not
        // via artSized (which is for library art ids); null draws the disc glyph.
        art: pool.cards[0]?.cover || null,
        door: 'date',
        // Not owned tracks, so no `song`: a tray tap opens the app, the in-app
        // row opens Music Date through its door.
        at: Date.now(),
      });

      writeMark(key, { hw: total, lastId: id });
    };

    void look();
    const timer = window.setInterval(() => void look(), POLL_MS);
    const onWake = () => void look();
    document.addEventListener('visibilitychange', onWake);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onWake);
      window.clearInterval(timer);
    };
  }, [session]);

  return null;
}
