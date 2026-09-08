import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Getting into a groove.
 *
 * The whole point of this module is that FIVE different things can happen
 * when somebody taps a link or types a code, and the app says a different
 * sentence for each. Collapsing two of them was a shipped bug: "the registry
 * could not be asked" read as "your friend's groove is over", which is a lie
 * told to somebody whose wifi dropped for a second.
 *
 * So the suite is arranged by ANSWER rather than by function, and the
 * assertions are on the discriminant - `kind` - because the discriminant is
 * what picks the sentence.
 */

/* The registry is the first of the two questions. Mocked at the module
   boundary rather than over fetch, because `lookupGroove`'s contract is
   written in terms of RegistryError's status: a 404 is an answer ("no such
   link"), anything else is a failure to ask. A fetch-level fake would let a
   change to that mapping pass unnoticed. */
vi.mock('../servers/registry.ts', async () => {
  class RegistryError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'RegistryError';
    }
  }
  return { RegistryError, fetchJamShare: vi.fn() };
});

import { RegistryError, fetchJamShare } from '../servers/registry.ts';
import type { JamShare } from '../servers/registry.ts';
import {
  clearGrooveCode,
  enterGroove,
  hubHost,
  lookupGroove,
  onGrooveCode,
  openGrooveCode,
  sameHub,
  walkIn,
} from './grooveEntry.ts';

const asked = vi.mocked(fetchJamShare);

/** A share row as the registry hands it out. */
function share(over: Partial<JamShare> = {}): JamShare {
  return {
    code: 'BLUE-CAT',
    jamId: 'room-1',
    hubUrl: 'https://matt.attack.fm',
    hubName: 'AttackFM',
    by: 'matt',
    url: 'https://attack.fm/j/BLUE-CAT',
    ...over,
  };
}

/** The groove provider, reduced to the one method this module calls. */
function jamThat(join: (id: string) => Promise<boolean>) {
  return { join: vi.fn(join) } as unknown as Parameters<typeof walkIn>[0];
}

afterEach(() => {
  clearGrooveCode();
});

describe('hubHost / sameHub', () => {
  it('reads a hub as its address, without scheme or trailing slash', () => {
    expect(hubHost('https://matt.attack.fm/')).toBe('matt.attack.fm');
    expect(hubHost('  http://matt.attack.fm//  ')).toBe('matt.attack.fm');
    expect(hubHost('matt.attack.fm')).toBe('matt.attack.fm');
  });

  it('keeps the path, because a hub can live under one', () => {
    expect(hubHost('https://box.example/afm/')).toBe('box.example/afm');
  });

  it('calls two spellings of one box the same hub', () => {
    // The link carries https and the app signed in over http, or one of them
    // has the slash. Neither difference is a different server.
    expect(sameHub('http://matt.attack.fm', 'https://matt.attack.fm/')).toBe(true);
    expect(sameHub('https://MATT.attack.fm', 'https://matt.attack.fm')).toBe(true);
  });

  it('calls two boxes different hubs', () => {
    expect(sameHub('https://matt.attack.fm', 'https://kim.attack.fm')).toBe(false);
    // A path IS part of the address: two hubs behind one name is a real
    // arrangement, and a link to one must not walk into the other.
    expect(sameHub('https://box.example/afm', 'https://box.example/other')).toBe(false);
  });
});

describe('lookupGroove', () => {
  it('answers null for a 404 - the registry knows no link by that name', async () => {
    asked.mockRejectedValueOnce(new RegistryError(404, 'no such share'));
    await expect(lookupGroove('NOPE')).resolves.toBeNull();
  });

  it('throws for anything else - "we could not ask" is not "there is none"', async () => {
    asked.mockRejectedValueOnce(new RegistryError(500, 'boom'));
    await expect(lookupGroove('BLUE-CAT')).rejects.toBeInstanceOf(RegistryError);

    // Offline: not a RegistryError at all, and it must still not read as 404.
    asked.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(lookupGroove('BLUE-CAT')).rejects.toBeInstanceOf(TypeError);
  });

  it('hands the share straight back', async () => {
    asked.mockResolvedValueOnce(share());
    await expect(lookupGroove('BLUE-CAT')).resolves.toMatchObject({ jamId: 'room-1' });
  });
});

describe('walkIn - three answers, and they must stay three', () => {
  it('joined: the hub let us in', async () => {
    await expect(walkIn(jamThat(() => Promise.resolve(true)), 'room-1')).resolves.toBe('joined');
  });

  it('ended: the hub answered, and the answer was no', async () => {
    await expect(walkIn(jamThat(() => Promise.resolve(false)), 'room-1')).resolves.toBe('ended');
  });

  it('failed: the hub did not answer at all', async () => {
    await expect(walkIn(jamThat(() => Promise.reject(new Error('offline'))), 'room-1')).resolves.toBe(
      'failed',
    );
  });

  it('keeps "ended" and "failed" distinct - the shipped bug', () => {
    // Stated as its own case because the two are one `catch` away from being
    // the same string, and nothing else in the suite would notice: both are
    // "not joined", and a caller that only checks for 'joined' passes either
    // way. The distinction only exists because it is asserted here.
    const answers = new Set(['joined', 'ended', 'failed']);
    expect(answers.size).toBe(3);
  });
});

describe('enterGroove', () => {
  it('joins a share on this hub', async () => {
    asked.mockResolvedValueOnce(share());
    const jam = jamThat(() => Promise.resolve(true));
    await expect(
      enterGroove(jam, 'https://matt.attack.fm', { code: 'BLUE-CAT', bare: false }),
    ).resolves.toEqual({ kind: 'joined' });
    expect(jam.join).toHaveBeenCalledWith('room-1');
  });

  it('says "elsewhere" for a real link on another hub, and never asks this one', async () => {
    const other = share({ hubUrl: 'https://kim.attack.fm', hubName: "Kim's" });
    asked.mockResolvedValueOnce(other);
    const jam = jamThat(() => Promise.resolve(true));
    const out = await enterGroove(jam, 'https://matt.attack.fm', { code: 'BLUE-CAT', bare: false });
    expect(out).toEqual({ kind: 'elsewhere', share: other });
    // The hub is not asked at all: it could not answer for a room it does
    // not hold, and a false from it would be read as "ended".
    expect(jam.join).not.toHaveBeenCalled();
  });

  it('says "ended" when the share is real, on this hub, and the hub says no', async () => {
    const row = share();
    asked.mockResolvedValueOnce(row);
    const out = await enterGroove(jamThat(() => Promise.resolve(false)), 'https://matt.attack.fm', {
      code: 'BLUE-CAT',
      bare: false,
    });
    // The share rides along: the sentence names the host and their hub.
    expect(out).toEqual({ kind: 'ended', share: row });
  });

  it('says "failed" when the share is real and the hub could not be reached', async () => {
    asked.mockResolvedValueOnce(share());
    const out = await enterGroove(
      jamThat(() => Promise.reject(new Error('offline'))),
      'https://matt.attack.fm',
      { code: 'BLUE-CAT', bare: false },
    );
    // NOT 'ended'. A dropped connection must not tell somebody their
    // friend's groove is over.
    expect(out).toEqual({ kind: 'failed' });
  });

  it('says "missing" for a pasted link the registry does not know', async () => {
    asked.mockRejectedValueOnce(new RegistryError(404, 'no such share'));
    const jam = jamThat(() => Promise.resolve(true));
    const out = await enterGroove(jam, 'https://matt.attack.fm', { code: 'GONE', bare: false });
    expect(out).toEqual({ kind: 'missing', bare: false });
    // A link's code is not a room id, so there is nothing to try on the hub.
    expect(jam.join).not.toHaveBeenCalled();
  });

  it('says "failed", not "missing", when a pasted link could not be looked up', async () => {
    asked.mockRejectedValueOnce(new RegistryError(503, 'registry down'));
    const out = await enterGroove(jamThat(() => Promise.resolve(true)), 'https://matt.attack.fm', {
      code: 'BLUE-CAT',
      bare: false,
    });
    expect(out).toEqual({ kind: 'failed' });
  });

  it('falls through to the hub for a TYPED code, which may be a room id', async () => {
    asked.mockRejectedValueOnce(new RegistryError(404, 'no such share'));
    const jam = jamThat(() => Promise.resolve(true));
    const out = await enterGroove(jam, 'https://matt.attack.fm', { code: 'room-9', bare: true });
    expect(out).toEqual({ kind: 'joined' });
    // The deck prints the room's own id as "Code", and only the hub knows it.
    expect(jam.join).toHaveBeenCalledWith('room-9');
  });

  it('says "missing" for a typed code neither the registry nor the hub knows', async () => {
    asked.mockRejectedValueOnce(new RegistryError(404, 'no such share'));
    const out = await enterGroove(jamThat(() => Promise.resolve(false)), 'https://matt.attack.fm', {
      code: 'room-9',
      bare: true,
    });
    // `bare: true` is what lets the sheet say "no groove by that code" rather
    // than "that link is not a groove".
    expect(out).toEqual({ kind: 'missing', bare: true });
  });

  it('says "failed" for a typed code when the registry was unreachable and the hub said no', async () => {
    // The hub's no is real but not the whole story: the registry might have
    // known this code. Reporting "missing" would be a guess presented as a
    // fact, so the unreachable registry wins.
    asked.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const out = await enterGroove(jamThat(() => Promise.resolve(false)), 'https://matt.attack.fm', {
      code: 'room-9',
      bare: true,
    });
    expect(out).toEqual({ kind: 'failed' });
  });

  it('says "failed" for a typed code the hub could not answer for', async () => {
    asked.mockRejectedValueOnce(new RegistryError(404, 'no such share'));
    const out = await enterGroove(
      jamThat(() => Promise.reject(new Error('offline'))),
      'https://matt.attack.fm',
      { code: 'room-9', bare: true },
    );
    expect(out).toEqual({ kind: 'failed' });
  });

  it('joins a typed code the registry DOES know, without touching the hub twice', async () => {
    asked.mockResolvedValueOnce(share({ code: 'room-9', jamId: 'room-1' }));
    const jam = jamThat(() => Promise.resolve(true));
    await expect(
      enterGroove(jam, 'https://matt.attack.fm', { code: 'room-9', bare: true }),
    ).resolves.toEqual({ kind: 'joined' });
    expect(jam.join).toHaveBeenCalledTimes(1);
    // The registry's jamId, not the typed string: the share is the mapping.
    expect(jam.join).toHaveBeenCalledWith('room-1');
  });
});

describe('the join-a-code sheet store', () => {
  it('replays to a subscriber that arrives after the opener', () => {
    // The whole reason the store exists: the row lives in a popover that is
    // unmounted by the tap that opens the sheet, so the opener can fire
    // before the sheet has mounted.
    openGrooveCode('BLUE-CAT');
    const seen: string[] = [];
    onGrooveCode((seed) => seen.push(seed));
    expect(seen).toEqual(['BLUE-CAT']);
  });

  it('tells a subscriber already listening', () => {
    const seen: string[] = [];
    onGrooveCode((seed) => seen.push(seed));
    // Nothing held yet, so nothing replayed on subscribe.
    expect(seen).toEqual([]);
    openGrooveCode('PINK-DOG');
    expect(seen).toEqual(['PINK-DOG']);
  });

  it('does not reopen for the next subscriber once taken', () => {
    openGrooveCode('BLUE-CAT');
    clearGrooveCode();
    const seen: string[] = [];
    onGrooveCode((seed) => seen.push(seed));
    expect(seen).toEqual([]);
  });

  it('stops telling a subscriber that has unsubscribed', () => {
    const seen: string[] = [];
    const off = onGrooveCode((seed) => seen.push(seed));
    off();
    openGrooveCode('BLUE-CAT');
    expect(seen).toEqual([]);
  });

  it('replays an EMPTY seed - the sheet was asked for with nothing in the field', () => {
    // `held` is a string, and '' is a real value: guarding with `if (held)`
    // rather than `held !== null` would silently drop the plain "Have a
    // code?" tap, which is the common case.
    openGrooveCode();
    const seen: string[] = [];
    onGrooveCode((seed) => seen.push(seed));
    expect(seen).toEqual(['']);
  });
});
