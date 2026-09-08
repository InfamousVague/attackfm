import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetMeta,
  metaFor,
  metaKey,
  metaSnapshot,
  setMeta,
  subscribeMeta,
} from './playlistMeta.ts';

/**
 * A playlist's decoration, and the identity rule underneath it.
 *
 * The store is module state seeded once at import, so every test here cleans
 * up after itself rather than leaning on the harness's localStorage wipe -
 * which clears the disk copy and not the snapshot in memory.
 */
const used: string[] = [];
const key = (name: string) => {
  const k = metaKey('https://hub.example', name);
  used.push(k);
  return k;
};

afterEach(() => {
  for (const k of used.splice(0)) forgetMeta(k);
});

describe('metaKey', () => {
  it('qualifies an id by its origin, so two hubs’ list 7 stay apart', () => {
    expect(metaKey('https://a.example', '7')).not.toBe(metaKey('https://b.example', '7'));
  });

  it('files a local playlist under "local" rather than under undefined', () => {
    expect(metaKey(null, 'abc')).toBe('local#abc');
    expect(metaKey(undefined, 'abc')).toBe('local#abc');
  });
});

describe('metaFor', () => {
  it('returns the SAME object every time for an undecorated playlist', () => {
    /*
     * REGRESSION, and the one assertion in this file that is not about
     * behaviour a person can see. This is read through useSyncExternalStore,
     * which compares snapshots by IDENTITY. A fresh `{}` per call never equals
     * the last one, so React re-rendered, read again, got another new object,
     * and looped until it gave up - on the common case of a playlist nobody
     * has described yet, which is all of them at first.
     */
    expect(metaFor(key('never-touched'))).toBe(metaFor(key('never-touched-either')));
  });

  it('hands back a FROZEN empty, so a caller cannot decorate every playlist at once', () => {
    const none = metaFor(key('undecorated'));
    expect(Object.isFrozen(none)).toBe(true);
    expect(() => {
      (none as { description?: string }).description = 'oops';
    }).toThrow();
    expect(metaFor(key('some-other-list')).description).toBeUndefined();
  });

  it('returns what was written', () => {
    const k = key('described');
    setMeta(k, { description: 'Songs for the drive' });
    expect(metaFor(k).description).toBe('Songs for the drive');
  });
});

describe('setMeta', () => {
  it('merges a patch rather than replacing the record', () => {
    const k = key('merging');
    setMeta(k, { description: 'A' });
    setMeta(k, { folder: 'Road trips' });
    expect(metaFor(k)).toEqual({ description: 'A', folder: 'Road trips' });
  });

  it('treats empty as DELETION, so the synced blob does not accumulate keys', () => {
    const k = key('cleared');
    setMeta(k, { description: 'A', folder: 'F' });
    setMeta(k, { description: '' });
    expect(metaFor(k)).toEqual({ folder: 'F' });
    expect('description' in metaFor(k)).toBe(false);
  });

  it('drops the whole entry once its last field goes', () => {
    // Otherwise the blob grows a key per playlist anyone ever opened the
    // editor on, without anything having been added.
    const k = key('emptied');
    setMeta(k, { description: 'A' });
    setMeta(k, { description: '' });
    expect(k in metaSnapshot()).toBe(false);
    // And back to the shared empty, not a lingering {} of its own.
    expect(metaFor(k)).toBe(metaFor(key('another-undecorated')));
  });

  it('writes through to storage so the decoration survives a relaunch', () => {
    const k = key('persisted');
    setMeta(k, { coverPath: 'afm://12' });
    const raw = JSON.parse(localStorage.getItem('attackfm-playlist-meta') ?? '{}') as Record<
      string,
      { coverPath?: string }
    >;
    expect(raw[k]?.coverPath).toBe('afm://12');
  });

  it('changes the snapshot identity, which is what makes the page re-render', () => {
    const before = metaSnapshot();
    setMeta(key('identity'), { description: 'x' });
    expect(metaSnapshot()).not.toBe(before);
  });
});

describe('subscribeMeta', () => {
  it('tells listeners about a write, and stops on unsubscribe', () => {
    const heard = vi.fn();
    const off = subscribeMeta(heard);
    setMeta(key('watched'), { description: 'one' });
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    setMeta(key('watched-2'), { description: 'two' });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('forgetMeta', () => {
  it('removes a deleted playlist’s decoration', () => {
    const k = key('deleted');
    setMeta(k, { description: 'gone soon' });
    forgetMeta(k);
    expect(k in metaSnapshot()).toBe(false);
  });

  it('does nothing - and notifies nobody - for a playlist that had none', () => {
    const heard = vi.fn();
    const off = subscribeMeta(heard);
    forgetMeta(metaKey('https://hub.example', 'never-existed'));
    expect(heard).not.toHaveBeenCalled();
    off();
  });
});
