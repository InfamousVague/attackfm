/**
 * Where a song being downloaded is supposed to end up.
 *
 * The module exists because the gap between asking and arriving is real: "A big
 * playlist import can outlast the page: an app reload, a tab crash, a phone
 * that slept. A plan held only in memory is a promise that quietly expires, and
 * the failure is invisible - the song lands in the library and simply is not in
 * the list, which reads as the app losing it rather than as a lost intent."
 *
 * Two of its decisions are the sort that look arbitrary until they are wrong:
 * the plan is keyed by JOB id rather than by URL, "because two jobs can carry
 * the same URL over a session (add, remove, add again) and only the current one
 * is owed anything"; and `FileOutcome` has a middle value, because "a plan that
 * cannot be kept used to be dropped in silence, which left every surface that
 * started one still showing the optimistic thing it said at the tap".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetPlan,
  markFiled,
  planFiling,
  plansSnapshot,
  reportOutcome,
  subscribeOutcomes,
  subscribePlans,
  type FileOutcome,
  type FilePlan,
} from './filePlan.ts';

const KEY = 'attackfm-file-plan';
const DAY = 24 * 60 * 60 * 1000;

const liked = { kind: 'liked' } as const;
const runList = { kind: 'playlist', id: 'pl-1', name: 'Run' } as const;

beforeEach(() => {
  // The snapshot is module state and outlives the per-test storage clear.
  for (const plan of plansSnapshot()) forgetPlan(plan.jobId);
  localStorage.clear();
});

describe('one plan per job', () => {
  it('records what a tap asked for', () => {
    planFiling('job-1', runList, 'Kid A');
    const [plan] = plansSnapshot();
    expect(plan).toMatchObject({ jobId: 'job-1', dest: runList, title: 'Kid A' });
    expect(typeof plan?.madeAt).toBe('number');
    expect(plan?.filed).toBeUndefined();
  });

  it('REPLACES rather than files twice when asked again', () => {
    // "asking twice replaces rather than files twice."
    planFiling('job-1', liked, 'Kid A');
    planFiling('job-1', runList, 'Kid A');
    expect(plansSnapshot()).toHaveLength(1);
    expect(plansSnapshot()[0]?.dest).toEqual(runList);
  });

  it('keeps two jobs that happen to want the same destination', () => {
    // The key is the job, not the destination and not the URL.
    planFiling('job-1', runList, 'Kid A');
    planFiling('job-2', runList, 'Amnesiac');
    expect(plansSnapshot().map((p) => p.jobId)).toEqual(['job-1', 'job-2']);
  });

  it('moves a replaced plan to the end, so the newest ask is last', () => {
    planFiling('job-1', liked, 'A');
    planFiling('job-2', liked, 'B');
    planFiling('job-1', liked, 'A again');
    expect(plansSnapshot().map((p) => p.jobId)).toEqual(['job-2', 'job-1']);
  });
});

describe('the plan\'s life', () => {
  it('marks one filed without touching the others', () => {
    planFiling('job-1', liked, 'A');
    planFiling('job-2', liked, 'B');
    markFiled('job-1');
    expect(plansSnapshot().map((p) => [p.jobId, p.filed ?? false])).toEqual([
      ['job-1', true],
      ['job-2', false],
    ]);
  });

  it('is set once, so the navigation happens once', () => {
    planFiling('job-1', liked, 'A');
    markFiled('job-1');
    markFiled('job-1');
    expect(plansSnapshot()[0]?.filed).toBe(true);
    expect(plansSnapshot()).toHaveLength(1);
  });

  it('forgets one and leaves the rest', () => {
    planFiling('job-1', liked, 'A');
    planFiling('job-2', liked, 'B');
    forgetPlan('job-1');
    expect(plansSnapshot().map((p) => p.jobId)).toEqual(['job-2']);
  });

  it('shrugs at a job it has never heard of', () => {
    planFiling('job-1', liked, 'A');
    markFiled('nope');
    forgetPlan('nope');
    expect(plansSnapshot()).toHaveLength(1);
  });
});

describe('two audiences, two channels', () => {
  it('wakes the list watchers on every change', () => {
    let woke = 0;
    const off = subscribePlans(() => {
      woke += 1;
    });
    planFiling('job-1', liked, 'A');
    markFiled('job-1');
    forgetPlan('job-1');
    expect(woke).toBe(3);
    off();
    planFiling('job-2', liked, 'B');
    expect(woke).toBe(3);
  });

  it('hands the OUTCOME to whoever asked, which is usually not who filed', () => {
    /*
     * "A card that started a plan is usually not the component that completes
     * it - often not even mounted by then - so it needs a channel it can pick
     * up on rather than a callback it has to be holding."
     */
    const seen: [string, FileOutcome][] = [];
    const off = subscribeOutcomes((plan, outcome) => seen.push([plan.jobId, outcome]));
    planFiling('job-1', liked, 'A');
    const [plan] = plansSnapshot() as [FilePlan];
    reportOutcome(plan, 'filed');
    reportOutcome(plan, 'already-yours');
    reportOutcome(plan, 'unfiled');
    expect(seen).toEqual([
      ['job-1', 'filed'],
      ['job-1', 'already-yours'],
      ['job-1', 'unfiled'],
    ]);
    off();
  });

  it('keeps the two channels apart', () => {
    // A plan being recorded is not an outcome, and an outcome is not a change
    // to the list - the surfaces that watch them are different.
    let listWoke = 0;
    let outcomes = 0;
    const offList = subscribePlans(() => {
      listWoke += 1;
    });
    const offOut = subscribeOutcomes(() => {
      outcomes += 1;
    });
    planFiling('job-1', liked, 'A');
    expect(listWoke).toBe(1);
    expect(outcomes).toBe(0);
    reportOutcome(plansSnapshot()[0] as FilePlan, 'filed');
    expect(listWoke).toBe(1);
    expect(outcomes).toBe(1);
    offList();
    offOut();
  });

  it('hands out a new snapshot per change and a stable one otherwise', () => {
    planFiling('job-1', liked, 'A');
    const first = plansSnapshot();
    expect(plansSnapshot()).toBe(first);
    markFiled('job-1');
    expect(plansSnapshot()).not.toBe(first);
  });
});

describe('persisted, because the gap is real', () => {
  const reload = async () => {
    vi.resetModules();
    return import('./filePlan.ts');
  };

  it('comes back after a reload with the destination intact', async () => {
    planFiling('job-1', runList, 'Kid A');
    const m = await reload();
    expect(m.plansSnapshot()).toHaveLength(1);
    expect(m.plansSnapshot()[0]?.dest).toEqual(runList);
  });

  it('DROPS A PLAN OLDER THAN A DAY on the way back in', () => {
    // "long enough for any real import, short enough that a plan for a job
    // that died in some way nobody recorded does not sit here forever."
    const now = Date.now();
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { jobId: 'stale', dest: liked, title: 'old', madeAt: now - DAY - 1000 },
        { jobId: 'fresh', dest: liked, title: 'new', madeAt: now - 1000 },
      ]),
    );
    return reload().then((m) => {
      expect(m.plansSnapshot().map((p) => p.jobId)).toEqual(['fresh']);
    });
  });

  it('keeps a plan right up to the boundary', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ jobId: 'edge', dest: liked, title: 'x', madeAt: Date.now() - DAY + 5000 }]),
    );
    const m = await reload();
    expect(m.plansSnapshot()).toHaveLength(1);
  });

  it('reads a torn entry as no plans rather than crashing the boot', async () => {
    localStorage.setItem(KEY, 'not json');
    expect((await reload()).plansSnapshot()).toEqual([]);

    localStorage.setItem(KEY, '{"not":"an array"}');
    expect((await reload()).plansSnapshot()).toEqual([]);
  });

  it('throws away rows with no job id', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([null, { dest: liked }, { jobId: 'good', dest: liked, madeAt: Date.now() }]),
    );
    const m = await reload();
    expect(m.plansSnapshot().map((p) => p.jobId)).toEqual(['good']);
  });

  it('holds for this run when storage refuses the write', () => {
    // "Holds for this run only, which is still better than dropping it now."
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => planFiling('job-1', liked, 'A')).not.toThrow();
    expect(plansSnapshot()).toHaveLength(1);
    setItem.mockRestore();
  });
});
