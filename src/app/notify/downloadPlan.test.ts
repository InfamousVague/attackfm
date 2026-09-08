/**
 * "What a change in the download queue should DO, as one pure function."
 *
 * The module was split out of the effect that used to perform it, and its
 * header says exactly why: the inline version compared a unix-SECONDS
 * timestamp from the server against a millisecond duration, so its freshness
 * test was false forever and every download that finished while the app was
 * backgrounded was dropped on the floor - the exact case the feature exists
 * for. "It type-checked, it built, and the store's own tests passed, because
 * they exercised the ring rather than the decision about what to put in it."
 *
 * This file is that missing test. It exercises the decision.
 *
 * The prose is deliberately NOT asserted. `translate` is stubbed to echo its
 * key, so what is checked is WHICH catalogue entry the code chose - which is
 * the decision - and the translation programme landing on this tree can reword
 * every one of them without a single failure here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MusicImportJob, MusicImportState } from '../../plugins/importsBridge.ts';

vi.mock('../i18n/LocaleShell.tsx', () => ({
  translate: (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key,
}));

const { FRESH_WINDOW_MS, START_WINDOW_MS, landedLine, planFromQueue, silentLanding, snapshotOf } =
  await import('./downloadPlan.ts');

const NOW = 1_800_000_000_000;

/** A job, with only the fields this module reads spelled out. */
function job(over: Partial<MusicImportJob> & { id: string; state: MusicImportState }): MusicImportJob {
  return {
    url: '',
    kind: 'track',
    title: '',
    service: 'test',
    quality: 'best',
    total: 1,
    completed: 0,
    error: null,
    /** MILLISECONDS here; the seconds-form cases set it explicitly. */
    createdAt: NOW - 1000,
    artworkUrl: null,
    subtitle: null,
    currentTrack: null,
    tracks: [],
    currentIndex: null,
    outputDir: '/tmp',
    files: [],
    ...over,
  } as MusicImportJob;
}

const seen = (...pairs: [string, MusicImportState][]) => new Map(pairs);

describe('the first look at the queue', () => {
  it('reports STARTS, because your own press must be answered', () => {
    /*
     * The seed rule, and the half of it that was added after the first
     * download of a session went silent: on a new account the queue is empty
     * at launch, so nothing seeds, and then `enqueue` inserts the job you just
     * asked for optimistically - making YOUR press the first thing this ever
     * sees. Swallowing it wholesale ate the one answer the app gives for
     * pressing the button.
     */
    const plan = planFromQueue(null, [job({ id: 'a', state: 'downloading' })], NOW);
    expect(plan.started.map((j) => j.id)).toEqual(['a']);
  });

  it('says nothing about landings or failures on the first look', () => {
    // Those are the ones a shared queue is full of, and there is no way to
    // tell them apart from history.
    const plan = planFromQueue(
      null,
      [job({ id: 'a', state: 'done', files: ['/x.flac'] }), job({ id: 'b', state: 'error' })],
      NOW,
    );
    expect(plan.notices).toEqual([]);
    expect(plan.landed).toBe(0);
  });

  it('does not call a queue that was already running a start', () => {
    // "a queue that was already running when the app launched has not
    // started, it has resumed."
    const old = job({ id: 'a', state: 'downloading', createdAt: NOW - START_WINDOW_MS - 1 });
    expect(planFromQueue(null, [old], NOW).started).toEqual([]);
  });

  it('an EMPTY previous map is not the same as no previous map', () => {
    // `previous === null` means "nothing has been seen yet". An empty Map
    // means "the queue was empty and now it is not", which reports normally.
    const landing = job({ id: 'a', state: 'done', files: ['/x.flac'] });
    expect(planFromQueue(null, [landing], NOW).landed).toBe(0);
    expect(planFromQueue(new Map(), [landing], NOW).landed).toBe(1);
  });
});

describe('seconds versus milliseconds', () => {
  it('READS A SECONDS TIMESTAMP, which is what the server actually sends', () => {
    /*
     * The bug this module was carved out to prevent, executed directly.
     * `createdAt` arrives as `duration_since(UNIX_EPOCH).as_secs()`. Compared
     * raw against a millisecond window, the age is a thousandfold too large
     * and every freshness test is false forever.
     */
    const inSeconds = Math.floor((NOW - 30_000) / 1000);
    const plan = planFromQueue(null, [job({ id: 'a', state: 'downloading', createdAt: inSeconds })], NOW);
    expect(plan.started.map((j) => j.id)).toEqual(['a']);
  });

  it('reads a millisecond timestamp identically', () => {
    // The third case: the decoder is not "always multiply by 1000". 1e12 ms is
    // 2001, so anything below it cannot be a millisecond stamp for a running
    // app - and anything above it must be left alone.
    const plan = planFromQueue(null, [job({ id: 'a', state: 'downloading', createdAt: NOW - 30_000 })], NOW);
    expect(plan.started.map((j) => j.id)).toEqual(['a']);
  });

  it('lands a background finish that a seconds-blind comparison would swallow', () => {
    // The feature's whole reason for existing: a download that finished
    // minutes later, from a background poll.
    const inSeconds = Math.floor((NOW - 60_000) / 1000);
    const plan = planFromQueue(
      new Map(),
      [job({ id: 'a', state: 'done', files: ['/x.flac'], createdAt: inSeconds })],
      NOW,
    );
    expect(plan.landed).toBe(1);
  });
});

describe('a state that changed', () => {
  it('ignores a job whose state is exactly what it was', () => {
    const j = job({ id: 'a', state: 'downloading' });
    const plan = planFromQueue(seen(['a', 'downloading']), [j], NOW);
    expect(plan).toEqual({ started: [], notices: [], landed: 0 });
  });

  it('announces a landing once, and not again on the next tick', () => {
    const done = job({ id: 'a', state: 'done', files: ['/x.flac'] });
    expect(planFromQueue(seen(['a', 'downloading']), [done], NOW).landed).toBe(1);
    expect(planFromQueue(seen(['a', 'done']), [done], NOW).landed).toBe(0);
  });

  it('treats a RETRY as a start worth answering', () => {
    // "pressing Retry is the one start a person explicitly asked for, and it
    // deserves the same answer the first attempt got."
    const retried = job({ id: 'a', state: 'downloading' });
    expect(planFromQueue(seen(['a', 'error']), [retried], NOW).started.map((j) => j.id)).toEqual(['a']);
  });

  it('does not call a queued-to-downloading transition a start', () => {
    // It was already seen running; the toast was said when it appeared.
    const j = job({ id: 'a', state: 'downloading' });
    expect(planFromQueue(seen(['a', 'queued']), [j], NOW).started).toEqual([]);
  });
});

describe('freshness', () => {
  it('lands a job never seen start, if it is recent enough', () => {
    // "The idle poll runs about once a minute, so a single track can be queued
    // and finished inside one gap - genuine news that must not be swallowed."
    const j = job({ id: 'a', state: 'done', files: ['/x.flac'], createdAt: NOW - 60_000 });
    expect(planFromQueue(new Map(), [j], NOW).landed).toBe(1);
  });

  it('stays quiet about an unseen job that is another device catching us up', () => {
    const j = job({
      id: 'a',
      state: 'done',
      files: ['/x.flac'],
      createdAt: NOW - FRESH_WINDOW_MS - 1,
    });
    expect(planFromQueue(new Map(), [j], NOW).landed).toBe(0);
  });

  it('lands an OLD job it did see start, whatever its age', () => {
    // `was !== undefined ||` - age only gates the ones with no history. A long
    // album import is old by the time it finishes and is still your news.
    const j = job({
      id: 'a',
      state: 'done',
      files: ['/x.flac'],
      createdAt: NOW - 10 * FRESH_WINDOW_MS,
    });
    expect(planFromQueue(seen(['a', 'downloading']), [j], NOW).landed).toBe(1);
  });

  it('does not re-announce an ancient failure on every launch', () => {
    /*
     * Failures sit in the server's queue until somebody clears them. Without
     * the gate, every old failure comes back on each launch - "including ones
     * already read and cleared, which would come back from a ring that no
     * longer holds them."
     */
    const stale = job({ id: 'a', state: 'error', createdAt: NOW - FRESH_WINDOW_MS - 1 });
    expect(planFromQueue(new Map(), [stale], NOW).notices).toEqual([]);
    const fresh = job({ id: 'a', state: 'error', createdAt: NOW - 1000 });
    expect(planFromQueue(new Map(), [fresh], NOW).notices).toHaveLength(1);
  });
});

describe('a job that filed nothing', () => {
  it('is silent when every track was already owned', () => {
    // Re-importing a record you already have runs to `done` having filed no
    // files and skipped every track; the server's own push stays quiet too.
    const j = job({ id: 'a', state: 'done', files: [], skipped: 12 });
    expect(silentLanding(j)).toBe(true);
    expect(planFromQueue(seen(['a', 'downloading']), [j], NOW).landed).toBe(0);
  });

  it('is NOT silent when the transport simply never populates files', () => {
    /*
     * Gated on the SKIP as well as the empty file list, "deliberately: a
     * transport that never populates `files` would otherwise have all its real
     * landings swallowed" - the same shape of silent loss the module exists
     * to prevent.
     */
    const j = job({ id: 'a', state: 'done', files: [] });
    expect(silentLanding(j)).toBe(false);
    expect(planFromQueue(seen(['a', 'downloading']), [j], NOW).landed).toBe(1);
  });

  it('is not silent when something actually landed alongside the skips', () => {
    expect(silentLanding(job({ id: 'a', state: 'done', files: ['/x.flac'], skipped: 3 }))).toBe(false);
  });
});

describe('the row a landing produces', () => {
  it('names the count for several songs and the title for one', () => {
    expect(landedLine(job({ id: 'a', state: 'done', files: ['/1', '/2'] }))).toBe(
      'downloads.landedCount({"count":2})',
    );
    expect(landedLine(job({ id: 'a', state: 'done', files: ['/1'], title: 'Kid A' }))).toBe(
      'downloads.landedTitle({"title":"Kid A"})',
    );
    expect(landedLine(job({ id: 'a', state: 'done', files: ['/1'] }))).toBe('downloads.landedIt');
  });

  it('carries ONE song so a tray tap can start it', () => {
    const j = job({ id: 'a', state: 'done', files: ['/1'], title: 'Idioteque', subtitle: 'Radiohead' });
    const [row] = planFromQueue(seen(['a', 'downloading']), [j], NOW).notices;
    expect(row?.song).toEqual({ title: 'Idioteque', artist: 'Radiohead' });
    expect(row?.door).toBe('downloads');
  });

  it('carries no song for an album, which has nothing single to start', () => {
    const j = job({ id: 'a', state: 'done', files: ['/1', '/2'], title: 'Kid A' });
    const [row] = planFromQueue(seen(['a', 'downloading']), [j], NOW).notices;
    expect(row?.song).toBeUndefined();
  });

  it('falls back to the first item for an artist name', () => {
    const j = job({
      id: 'a',
      state: 'done',
      files: ['/1'],
      title: 'Idioteque',
      items: [{ title: 'Idioteque', artist: 'Radiohead' }],
    });
    const [row] = planFromQueue(seen(['a', 'downloading']), [j], NOW).notices;
    expect(row?.song).toEqual({ title: 'Idioteque', artist: 'Radiohead' });
  });

  it('SHARES ONE ID between a failure and its retry, but not one kind', () => {
    /*
     * "fail → retry → fail replaces its own row rather than stacking three
     * identical complaints. The ring treats a change of KIND as a different
     * event, so a retry that finally lands still rings."
     *
     * Both halves of that contract in one place, because the two ends of it
     * live in two files and only agree by convention.
     */
    const failed = planFromQueue(seen(['a', 'downloading']), [job({ id: 'a', state: 'error' })], NOW);
    const landed = planFromQueue(
      seen(['a', 'error']),
      [job({ id: 'a', state: 'done', files: ['/1'] })],
      NOW,
    );
    expect(failed.notices[0]?.id).toBe('import:a');
    expect(landed.notices[0]?.id).toBe('import:a');
    expect(failed.notices[0]?.kind).toBe('failed');
    expect(landed.notices[0]?.kind).toBe('drops');
  });

  it('counts one buzz for the tick, not one per song', () => {
    const plan = planFromQueue(
      seen(['a', 'downloading'], ['b', 'downloading']),
      [
        job({ id: 'a', state: 'done', files: ['/1'] }),
        job({ id: 'b', state: 'done', files: ['/2'] }),
      ],
      NOW,
    );
    expect(plan.landed).toBe(2);
    expect(plan.notices).toHaveLength(2);
  });

  it('names a failure with its title when it has one', () => {
    const named = planFromQueue(
      seen(['a', 'downloading']),
      [job({ id: 'a', state: 'error', title: 'Kid A' })],
      NOW,
    );
    expect(named.notices[0]?.body).toBe('downloads.failedNamed({"title":"Kid A"})');
    const anon = planFromQueue(seen(['b', 'downloading']), [job({ id: 'b', state: 'error' })], NOW);
    expect(anon.notices[0]?.body).toBe('downloads.failedUnnamed');
  });
});

describe('snapshotOf', () => {
  it('is exactly what the next comparison needs', () => {
    const jobs = [job({ id: 'a', state: 'done' }), job({ id: 'b', state: 'queued' })];
    expect(snapshotOf(jobs)).toEqual(new Map([['a', 'done'], ['b', 'queued']]));
  });

  it('round-trips: a snapshot fed back reports no change at all', () => {
    const jobs = [job({ id: 'a', state: 'downloading' }), job({ id: 'b', state: 'done', files: ['/1'] })];
    const plan = planFromQueue(snapshotOf(jobs), jobs, NOW);
    expect(plan).toEqual({ started: [], notices: [], landed: 0 });
  });
});
