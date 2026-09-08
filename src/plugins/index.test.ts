/**
 * Which plugins this device can host right now.
 *
 * `filterAvailable` is three lines and decides whether a nav item, a settings
 * tab, a palette command and a marketplace card exist. Its three flags are not
 * synonyms and the file says so:
 *
 *   - `desktopOnly` drops on anything but a subprocess-capable desktop;
 *   - `requiresServer` needs a connected server on EVERY platform, desktop
 *     included, because no local equivalent exists;
 *   - `serverBacked` needs EITHER a local engine OR a connected server, "so
 *     the importer reaches a phone the moment it signs in".
 *
 * Every one of the eight (flag x connection) combinations is below, because
 * the only way these read differently is at a boundary, and a plugin that
 * appears one platform too widely is a nav item that opens onto nothing.
 *
 * ── A NOTE ON THE IMPORT ORDER, WHICH IS LOAD-BEARING ──
 *
 * `./runtime.tsx` is imported FIRST, deliberately, and this file will not run
 * without it. `src/plugins/index.ts` sits in an import cycle: it builds
 * REGISTERED from `buy`/`books`/`visualizers`, whose own module graphs reach
 * back to `runtime/pluginsProvider.tsx`, which imports `../index.ts` and then
 * calls `availablePlugins(true)` AT MODULE SCOPE for its duplicate-id check.
 * Entered from `index.ts`, that call lands while `REGISTERED` is still in its
 * temporal dead zone and throws "Cannot access 'REGISTERED' before
 * initialization"; entered from the barrel - which is the direction the app
 * itself takes, since `pluginsProvider.tsx` is the only importer of
 * `index.ts` - everything resolves. See the Phase 2 report.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './runtime.tsx';
import type { Plugin } from './types.ts';

/** `canRunSubprocesses` is a module-level const computed from `isTauri()` at
 *  import time, so "am I on a desktop" is only reachable through the module. */
const platform = vi.hoisted(() => ({ canRunSubprocesses: false }));
vi.mock('../app/core/platform.ts', () => platform);

const { availablePlugins, filterAvailable, localizePlugins, registeredIds } = await import(
  './index.ts'
);

/** A plugin, with only the flags this function reads. */
const p = (id: string, flags: Partial<Plugin> = {}) =>
  ({ id, name: id, description: '', ...flags }) as Plugin;

const ids = (list: readonly Plugin[]) => list.map((x) => x.id);

beforeEach(() => {
  platform.canRunSubprocesses = false;
});

describe('filterAvailable: a plugin with no flags', () => {
  it('runs everywhere, connected or not', () => {
    const plain = [p('books')];
    expect(ids(filterAvailable(plain, false))).toEqual(['books']);
    expect(ids(filterAvailable(plain, true))).toEqual(['books']);
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(plain, false))).toEqual(['books']);
  });
});

describe('filterAvailable: desktopOnly', () => {
  const only = [p('shell', { desktopOnly: true })];

  it('is absent on a phone, even signed in', () => {
    expect(ids(filterAvailable(only, true))).toEqual([]);
  });

  it('is present on a desktop, even signed out', () => {
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(only, false))).toEqual(['shell']);
  });

  it('takes precedence over the other two flags', () => {
    // `desktopOnly` is checked first and returns, so a plugin carrying it plus
    // `requiresServer` is judged on the platform alone. Stated because the
    // header says `serverBacked` is "Ignored when `desktopOnly` is set", and
    // the ordering in the source is the only thing that makes that true.
    const both = [p('shell', { desktopOnly: true, requiresServer: true, serverBacked: true })];
    expect(ids(filterAvailable(both, false))).toEqual([]);
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(both, false))).toEqual(['shell']);
  });
});

describe('filterAvailable: requiresServer', () => {
  const needs = [p('discover', { requiresServer: true })];

  it('is absent without a server, ON A DESKTOP TOO', () => {
    /*
     * The distinction that makes this flag worth having: "no local equivalent
     * exists (the discover feed is built on the hub), so a desktop without one
     * shows nothing either." A `serverBacked` plugin would appear here.
     */
    expect(ids(filterAvailable(needs, false))).toEqual([]);
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(needs, false))).toEqual([]);
  });

  it('is present the moment a server is connected, on any platform', () => {
    expect(ids(filterAvailable(needs, true))).toEqual(['discover']);
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(needs, true))).toEqual(['discover']);
  });

  it('takes precedence over serverBacked when both are set', () => {
    const both = [p('x', { requiresServer: true, serverBacked: true })];
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(both, false))).toEqual([]);
  });
});

describe('filterAvailable: serverBacked', () => {
  const backed = [p('importer', { serverBacked: true })];

  it('REACHES A PHONE the moment it signs in', () => {
    // The importer needs an engine, and a connected hub is one.
    expect(ids(filterAvailable(backed, false))).toEqual([]);
    expect(ids(filterAvailable(backed, true))).toEqual(['importer']);
  });

  it('runs on a desktop with no server at all, off the local engine', () => {
    platform.canRunSubprocesses = true;
    expect(ids(filterAvailable(backed, false))).toEqual(['importer']);
  });
});

describe('filterAvailable: the whole truth table', () => {
  it('answers all eight combinations exactly once', () => {
    const all = [
      p('plain'),
      p('desktopOnly', { desktopOnly: true }),
      p('requiresServer', { requiresServer: true }),
      p('serverBacked', { serverBacked: true }),
    ];
    const seen = (desktop: boolean, connected: boolean) => {
      platform.canRunSubprocesses = desktop;
      return ids(filterAvailable(all, connected));
    };
    expect(seen(false, false)).toEqual(['plain']);
    expect(seen(false, true)).toEqual(['plain', 'requiresServer', 'serverBacked']);
    expect(seen(true, false)).toEqual(['plain', 'desktopOnly', 'serverBacked']);
    expect(seen(true, true)).toEqual([
      'plain',
      'desktopOnly',
      'requiresServer',
      'serverBacked',
    ]);
  });

  it('keeps the order it was given, because the array IS the ordering', () => {
    // "slots never sort, they walk it" - the registry's order decides how
    // contributions render, how providers nest, and how commands merge.
    const list = [p('c'), p('a'), p('b')];
    expect(ids(filterAvailable(list, true))).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate what it was handed', () => {
    const list = [p('a', { requiresServer: true }), p('b')];
    filterAvailable(list, false);
    expect(ids(list)).toEqual(['a', 'b']);
  });
});

describe('availablePlugins', () => {
  it('is filterAvailable over the compiled-in registry', () => {
    // The two must not drift: the remote-install path goes through the plain
    // function, and a rule applied to only one of the two lists is a plugin
    // that behaves differently depending on where it came from.
    const registry = availablePlugins(true);
    expect(ids(registry)).toEqual(ids(filterAvailable(registry, true)));
  });

  it('re-filters on connect and on disconnect', () => {
    const off = availablePlugins(false);
    const on = availablePlugins(true);
    expect(off.length).toBeLessThanOrEqual(on.length);
    for (const plugin of off) expect(ids(on)).toContain(plugin.id);
  });
});

describe('registeredIds', () => {
  it('names every compiled-in plugin, for collision checks', () => {
    // The set exists so a remote install cannot shadow a built-in id.
    const compiled = registeredIds();
    expect(compiled.size).toBeGreaterThan(0);
    for (const plugin of availablePlugins(true)) expect(compiled.has(plugin.id)).toBe(true);
  });

  it('hands out a fresh Set, so a caller cannot edit the registry', () => {
    expect(registeredIds()).not.toBe(registeredIds());
  });

  it('holds no id with a colon in it', () => {
    // The colon is the namespace separator in palette command and settings
    // section ids; an id carrying one would let contributions collide across
    // the very plugins the namespacing keeps apart.
    for (const id of registeredIds()) expect(id).not.toContain(':');
  });
});

describe('localizePlugins', () => {
  const t = (key: string) => `«${key}»`;

  it('puts the words back on a plugin built before any language was chosen', () => {
    // A plugin object is module-scope data, built at import time, so the
    // compiled-in three carry catalogue KEYS in their text fields.
    const [out] = localizePlugins([p('x', { name: 'plugins.x.name', description: 'plugins.x.desc' })], t);
    expect(out?.name).toBe('«plugins.x.name»');
    expect(out?.description).toBe('«plugins.x.desc»');
  });

  it('translates every nested label a plugin can contribute', () => {
    const Nothing = () => null;
    const rich = p('x', {
      details: 'd',
      tags: ['t1', 't2'],
      settingsSections: [{ id: 's', label: 'l', Content: Nothing }],
      pages: [{ id: 'p', label: 'pl', place: 'tab', Page: Nothing }],
      downloads: [{ id: 'dl', label: 'dll', Rows: Nothing }],
    } as unknown as Partial<Plugin>);
    const [out] = localizePlugins([rich], t) as [Plugin];
    expect(out.details).toBe('«d»');
    expect(out.tags).toEqual(['«t1»', '«t2»']);
    expect(out.settingsSections?.[0]?.label).toBe('«l»');
    expect(out.pages?.[0]?.label).toBe('«pl»');
    expect(out.downloads?.[0]?.label).toBe('«dll»');
  });

  it('leaves an absent field absent rather than translating undefined', () => {
    const [out] = localizePlugins([p('x')], t) as [Plugin];
    expect('details' in out).toBe(false);
    expect('tags' in out).toBe(false);
    expect('pages' in out).toBe(false);
  });

  it('does not mutate the registry object it copies from', () => {
    // The registry is module-scope and shared; translating in place would mean
    // the second language change translated an already-translated string.
    const original = p('x', { name: 'plugins.x.name' });
    localizePlugins([original], t);
    expect(original.name).toBe('plugins.x.name');
  });

  it('keeps every other field untouched', () => {
    const original = p('x', { name: 'n', requiresServer: true });
    const [out] = localizePlugins([original], t) as [Plugin];
    expect(out.id).toBe('x');
    expect(out.requiresServer).toBe(true);
  });
});
