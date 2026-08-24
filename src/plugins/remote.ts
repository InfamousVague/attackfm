/**
 * Remote plugins: the repositories they come from, the installed set, and the
 * evaluator that turns a stored bundle back into a live Plugin object.
 *
 * A repository is a URL serving `index.json` (the manifest of plugins it
 * offers) and, beside it, one bundle file per plugin version. Installing
 * downloads the bundle ONCE and persists its code locally; from then on the
 * plugin loads at every boot from storage, network or not. A repository is
 * therefore a distribution channel, not a runtime dependency - deleting a
 * source does not uninstall what came from it.
 *
 * Installing a plugin is installing code. The UI says so before a source is
 * added, the default list ships with exactly one entry - the user's own
 * server - and bundles only ever travel the sources the user has listed.
 */

import type { Plugin } from './types.ts';
import { HOST_API_VERSION, installHostRuntime } from './hostRuntime.ts';
import { normalizeServerUrl } from '../app/api/http.ts';

const SOURCES_KEY = 'attackfm-plugin-sources';
const INSTALLED_KEY = 'attackfm-plugins-installed';
/*
 * What this ACCOUNT wants installed, as opposed to what this DEVICE has.
 *
 * The installed record carries the bundle itself in `code`, which is why it is
 * device-local and must stay that way: syncing it would push tens of kilobytes
 * of executable text per plugin through the preferences blob, and the blob is
 * meant to describe a person's taste, not to be a delivery channel for code.
 *
 * This is the same list with the code taken out - id, where it came from, and
 * which version was installed. Small enough to sync, and enough for another
 * device to go and fetch the same bundles from the same repositories, which it
 * already has because the repository list syncs too.
 */
const WANTED_KEY = 'attackfm-plugins-wanted';

/** One plugin a person has chosen, described so any device can get it. */
export interface WantedPlugin {
  id: string;
  source: string;
  version: string;
}

export function readWanted(): WantedPlugin[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WANTED_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is WantedPlugin =>
        !!w && typeof (w as WantedPlugin).id === 'string' && typeof (w as WantedPlugin).source === 'string',
    );
  } catch {
    return [];
  }
}
/** Defaults the user has deliberately removed, so a merge never re-adds them. */
const REMOVED_DEFAULTS_KEY = 'attackfm-plugin-sources-removed';

/**
 * The official public repository, baked in so every install's marketplace is
 * stocked - fresh ones from first boot, and existing ones through the merge in
 * `readSources`. Removable in Settings like any added source (the removal is
 * remembered); it carries only the public-flagged set, so what a fresh
 * install or an App Store reviewer can reach stays the lawyer-calm catalogue.
 */
export const DEFAULT_SOURCES: readonly string[] = ['https://plugins.attack.fm'];

/**
 * Plugins installed for you on first run. Empty on purpose.
 *
 * It shipped an equalizer, which put an unexplained extra destination in front
 * of everyone who had never asked for one - and a newcomer counting the things
 * they must understand does not need a graphic EQ to be among them on launch
 * day.
 *
 * HiFi Lab was briefly the exception, on the argument that the console's HiFi
 * room was useless without the page that built a chain. The better answer was
 * to stop needing the page: the console builds the chain itself now, so the
 * exception retired with it and this is empty again.
 *
 * The machinery stays: anything listed here is fetched from whatever source
 * carries it and, like a default source, remembered when removed so
 * uninstalling is not undone on the next launch.
 */
// 'librivox' was here until 2026-08-24. It is RETIRED rather than deleted -
// the source stays in plugins-repo and one flag brings it back - so this list
// simply stops installing it on new devices. Deliberately NOT added to
// DEPRECATED_PLUGINS below: that list actively uninstalls a bundle from every
// phone that has one, which is a heavier thing than withdrawing it, and this is
// a withdrawal for now rather than for good.
export const DEFAULT_PLUGINS: readonly string[] = ['audible'];

/** Default plugins the user has removed, so the auto-install never re-adds them. */
const REMOVED_DEFAULT_PLUGINS_KEY = 'attackfm-plugins-removed-defaults';

/**
 * Plugins that are no longer part of the app - uninstalled on sight, wherever
 * they were installed from. It covers both kinds of retirement: one a core
 * feature superseded (`audiobooks`, when the Books shelf briefly became core),
 * and one that has simply been withdrawn. The audiobook downloaders went the
 * second way when AttackFM went back to being about music, and listing them
 * here is what takes them off a phone that already had them - a repository
 * dropping a plugin is not, by itself, an uninstall.
 */
export const DEPRECATED_PLUGINS: readonly string[] = [
  // 'audible' and 'librivox' were named here when audiobooks came out of the
  // app on 12 August. They are back (2026-08-22) and MUST NOT be listed: this
  // list is what actively uninstalls a bundle from a device, so leaving them
  // would withdraw the plugin from every phone the moment it installed it.
  // The old built-in 'audiobooks' plugin stays retired - it was superseded by
  // the built-in Books shelf, not revived.
  'audiobooks',
  // Folded into the player's sound console, which now carries both whole: the
  // HiFi room builds a chain box by box, and the Filters room is the same shelf
  // of finished sounds this plugin was.
  //
  // They have to be named here rather than merely dropped from the repository:
  // an installed bundle lives in this device's own storage and keeps rendering
  // its page forever, so withdrawing them without this would leave two copies
  // of the same UI on every phone that ever installed one - and the stale copy
  // is the one with a nav item pointing at it.
  //
  // Pedals is deliberately NOT here. Fifty-five stompboxes is a board you go
  // somewhere to build, not something to scroll past on the way to a volume
  // slider, so it keeps its page and stays a plugin.
  'hifi-lab',
  'filters',
  // Karaoke is core now (src/app/player/KaraokeButton.tsx). As a plugin it
  // could never queue its own separation - it only ever polled - so it hung on
  // any song the pads had not already taken apart.
  'karaoke',
  // The pad board is gone entirely - taking a part out of the song you are
  // listening to is the console's Stems tab, and that needs no page. Named here
  // so a copy installed from the repository before it was compiled in comes off
  // the device too, rather than living on as the only Pads anyone still has.
  'pads',
  // Withdrawn at Matt's word, and each for its own reason.
  //
  // The EQ rack is the clearest: it is the third thing to save and recall a
  // curve, after the sound console's own HiFi chain and its Filters shelf, and
  // being a plugin was the only difference between them.
  'eq-rack',
  // The looper was an instrument on a music player's shelf - a sampler with
  // pads, choke groups and its own transport. The Pads board went for the same
  // reason: it is a thing to PLAY rather than a way to listen, and the app is
  // the second of those.
  'looper',
  // Album filler read the library for records you nearly own and offered the
  // missing songs. It is the one of the three with no successor in the app,
  // and it goes anyway - a page whose whole job is a shopping list sits oddly
  // in a player, and the curator already answers "what is missing" in the
  // shape the app actually uses.
  'album-filler',
];

/** One plugin as a repository's manifest lists it. */
export interface RemotePluginListing {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  /** Bundle filename, resolved relative to the manifest. */
  entry: string;
  /** Host API the bundle was built against; refused when newer than ours. */
  api: number;
  desktopOnly?: boolean;
  serverBacked?: boolean;
  requiresServer?: boolean;
}

export interface RemoteManifest {
  api: number;
  name?: string;
  plugins: RemotePluginListing[];
}

/** What persists for an installed plugin: metadata plus the bundle itself. */
export interface InstalledRemotePlugin {
  id: string;
  name: string;
  version: string;
  source: string;
  api: number;
  code: string;
  installedAt: number;
}

// --- sources ---------------------------------------------------------------

export function readSources(): string[] {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (!raw) return [...DEFAULT_SOURCES];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_SOURCES];
    const sources = parsed.filter((s): s is string => typeof s === 'string');
    // A default that shipped AFTER this install stored its list still joins
    // it - otherwise the official repository only ever reaches fresh installs.
    // Removal is respected through the tombstone, so "linked by default" never
    // becomes "impossible to unlink".
    const removed = readRemovedDefaults();
    for (const source of DEFAULT_SOURCES) {
      if (!sources.includes(source) && !removed.includes(source)) sources.push(source);
    }
    return sources;
  } catch {
    return [...DEFAULT_SOURCES];
  }
}

function readRemovedDefaults(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REMOVED_DEFAULTS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeRemovedDefaults(removed: string[]): void {
  try {
    localStorage.setItem(REMOVED_DEFAULTS_KEY, JSON.stringify(removed));
  } catch {
    // Storage unavailable - the removal still applies for this session.
  }
}

function writeSources(sources: string[]): void {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
  } catch {
    // Storage unavailable - the list still applies for this session.
  }
}

/** A source address is normalized exactly like a server address - it was the
 *  same four lines, copied; now it is the same function, named for this door. */
export const normalizeSourceUrl = normalizeServerUrl;

export function addSource(url: string): string[] {
  const origin = normalizeSourceUrl(url);
  const sources = readSources();
  if (origin && !sources.includes(origin)) sources.push(origin);
  writeSources(sources);
  // Adding a default back is a change of heart: clear its tombstone.
  if (DEFAULT_SOURCES.includes(origin)) {
    writeRemovedDefaults(readRemovedDefaults().filter((s) => s !== origin));
  }
  return sources;
}

export function removeSource(url: string): string[] {
  const sources = readSources().filter((s) => s !== url);
  writeSources(sources);
  if (DEFAULT_SOURCES.includes(url)) {
    const removed = readRemovedDefaults();
    if (!removed.includes(url)) writeRemovedDefaults([...removed, url]);
  }
  return sources;
}

// --- the repository wire ---------------------------------------------------

/** Fetches a repository's manifest. Throws with a toast-worthy message. */
export async function fetchManifest(source: string, signal?: AbortSignal): Promise<RemoteManifest> {
  const response = await fetch(`${source}/index.json`, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`${source} answered ${response.status}`);
  const manifest = (await response.json()) as RemoteManifest;
  if (!Array.isArray(manifest.plugins)) throw new Error(`${source} is not a plugin repository`);
  return manifest;
}

/** Downloads one listing's bundle and persists it as installed. */
export async function installPlugin(
  source: string,
  listing: RemotePluginListing,
  signal?: AbortSignal,
): Promise<InstalledRemotePlugin> {
  if (listing.api > HOST_API_VERSION) {
    throw new Error(
      `${listing.name} needs a newer app (plugin API ${listing.api}, this app speaks ${HOST_API_VERSION})`,
    );
  }
  const response = await fetch(`${source}/${listing.entry}`, { signal });
  if (!response.ok) throw new Error(`bundle fetch failed: ${response.status}`);
  const code = await response.text();

  const installed: InstalledRemotePlugin = {
    id: listing.id,
    name: listing.name,
    version: listing.version,
    source,
    api: listing.api,
    code,
    installedAt: Date.now(),
  };

  // Evaluated once before persisting: a bundle that cannot even produce a
  // plugin object must fail the install, not the next twenty launches.
  evaluateBundle(installed);

  const all = readInstalled().filter((p) => p.id !== listing.id);
  all.push(installed);
  writeInstalled(all);
  return installed;
}

/** Uninstalls any deprecated plugin still sitting in storage. Returns true when
 *  it removed one, so the caller can reload the runtime. */
export function pruneDeprecatedPlugins(): boolean {
  const installed = readInstalled();
  const keep = installed.filter((p) => !DEPRECATED_PLUGINS.includes(p.id));
  if (keep.length === installed.length) return false;
  writeInstalled(keep);
  return true;
}

export function uninstallPlugin(id: string): void {
  writeInstalled(readInstalled().filter((p) => p.id !== id));
  // Removing a default is a decision: tombstone it so the auto-install leaves
  // it alone from here on.
  if (DEFAULT_PLUGINS.includes(id)) {
    const removed = readRemovedDefaultPlugins();
    if (!removed.includes(id)) writeRemovedDefaultPlugins([...removed, id]);
  }
}

function readRemovedDefaultPlugins(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REMOVED_DEFAULT_PLUGINS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeRemovedDefaultPlugins(ids: string[]): void {
  try {
    localStorage.setItem(REMOVED_DEFAULT_PLUGINS_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable - the removal still holds for this session.
  }
}

/**
 * Installs any default plugin that is not already installed and has not been
 * removed, from whichever listed source (plus the connected hub's own
 * repository) carries it. Returns true when it installed at least one, so the
 * caller can reload the runtime. Safe to call repeatedly - already-installed and
 * tombstoned defaults are skipped, so it is a no-op once everything has landed.
 */
/** Is version `a` newer than `b`? A small dotted-number compare - enough for the
 *  plugins' own `x.y.z`, and false on anything it cannot parse (so "unsure"
 *  never triggers an update). */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function ensureDefaultPlugins(extraSources: readonly string[] = []): Promise<boolean> {
  const installedVer = new Map(readInstalled().map((p) => [p.id, p.version]));
  const removed = readRemovedDefaultPlugins();
  const candidates = new Set(DEFAULT_PLUGINS.filter((id) => !removed.includes(id)));
  if (candidates.size === 0) return false;

  // The best (newest) listing for each default across every source, so source
  // order cannot pin a plugin to a stale copy.
  const best = new Map<string, { source: string; listing: RemotePluginListing }>();
  const sources = [...new Set([...extraSources, ...readSources()])];
  for (const source of sources) {
    let manifest: RemoteManifest;
    try {
      manifest = await fetchManifest(source);
    } catch {
      continue; // an unreachable source is not a reason to give up on the rest
    }
    for (const listing of manifest.plugins) {
      if (!candidates.has(listing.id)) continue;
      const cur = best.get(listing.id);
      if (!cur || isNewerVersion(listing.version, cur.listing.version)) {
        best.set(listing.id, { source, listing });
      }
    }
  }

  let changed = false;
  for (const [id, { source, listing }] of best) {
    const have = installedVer.get(id);
    // Install if missing; update if the catalogue has a newer version; leave a
    // current install alone.
    if (have !== undefined && !isNewerVersion(listing.version, have)) continue;
    try {
      await installPlugin(source, listing);
      changed = true;
    } catch {
      // A bundle that will not install is left for the next launch to retry.
    }
  }
  return changed;
}

export function readInstalled(): InstalledRemotePlugin[] {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is InstalledRemotePlugin =>
        !!p && typeof (p as InstalledRemotePlugin).id === 'string' && typeof (p as InstalledRemotePlugin).code === 'string',
    );
  } catch {
    return [];
  }
}

function writeInstalled(all: InstalledRemotePlugin[]): void {
  try {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(all));
    /*
     * Derived here rather than at the three call sites, so an install, an
     * update and a removal cannot disagree about it. Written AFTER the installed
     * list, so a storage quota that refuses the bundle also refuses to claim the
     * plugin is wanted - the throw below leaves both untouched.
     */
    localStorage.setItem(
      WANTED_KEY,
      JSON.stringify(all.map(({ id, source, version }) => ({ id, source, version }))),
    );
  } catch (err) {
    // A bundle that does not fit the storage quota cannot survive a relaunch;
    // better to say so than to pretend the install stuck.
    throw new Error(
      `could not persist the plugin: ${err instanceof Error ? err.message : 'storage refused it'}`,
    );
  }
}

/**
 * Install whatever this account wants and this device has not got.
 *
 * The other half of syncing the wanted list. Signing in on a new phone brings
 * the repository list and the wanted list down through the preferences blob;
 * this is what turns those two lists into working plugins, by fetching the same
 * bundles from the same repositories the other device used.
 *
 * Deliberately additive: it never REMOVES a plugin this device has and the list
 * does not mention. Removing on one device would otherwise reach across and
 * uninstall on every other, which is a far worse surprise than an extra plugin
 * - and the existing "removed defaults" list already exists to express a
 * deliberate removal without deleting anything.
 *
 * Every failure is per-plugin and silent-ish: a repository that has gone away,
 * or a plugin pulled from it, must not stop the other four arriving. What it
 * returns is what actually landed, so a caller can say so.
 */
export async function restoreWanted(signal?: AbortSignal): Promise<string[]> {
  const wanted = readWanted();
  if (wanted.length === 0) return [];
  const have = new Set(readInstalled().map((p) => p.id));
  const missing = wanted.filter((w) => !have.has(w.id));
  if (missing.length === 0) return [];

  // One manifest fetch per repository, not per plugin: five plugins from one
  // repository is one round trip.
  const bySource = new Map<string, WantedPlugin[]>();
  for (const w of missing) {
    const list = bySource.get(w.source);
    if (list) list.push(w);
    else bySource.set(w.source, [w]);
  }

  const landed: string[] = [];
  for (const [source, list] of bySource) {
    let manifest: RemoteManifest;
    try {
      manifest = await fetchManifest(source, signal);
    } catch {
      // The repository is gone or unreachable. Its plugins stay wanted, so the
      // next launch tries again rather than forgetting they were ever asked for.
      continue;
    }
    for (const w of list) {
      const listing = manifest.plugins.find((l) => l.id === w.id);
      if (!listing) continue;
      try {
        await installPlugin(source, listing, signal);
        landed.push(w.id);
      } catch {
        // A bundle that will not evaluate, or an API too new for this build.
        // installPlugin has already refused to persist it.
      }
    }
  }
  return landed;
}

// --- evaluation ------------------------------------------------------------

/**
 * Turns a stored bundle back into a Plugin object.
 *
 * A bundle is an IIFE that assigns its exports to `AttackFMPluginExport` -
 * evaluated inside a Function scope so that name never leaks to the global -
 * and exports a `createPlugin(host)` factory. Every module import inside it
 * was compiled down to a `__ATTACKFM_HOST__.modules[...]` lookup, so the host
 * table is installed (idempotently) first.
 */
export function evaluateBundle(installed: InstalledRemotePlugin): Plugin {
  const host = installHostRuntime();
  const factory = new Function(
    `"use strict";${installed.code}\n;return AttackFMPluginExport;`,
  )() as { createPlugin?: (host: unknown) => Plugin };
  if (typeof factory?.createPlugin !== 'function') {
    throw new Error(`${installed.name} is not an AttackFM plugin bundle`);
  }
  const plugin = factory.createPlugin(host);
  if (!plugin || typeof plugin.id !== 'string' || plugin.id !== installed.id) {
    throw new Error(`${installed.name} produced a plugin that does not match its listing`);
  }
  return plugin;
}

/**
 * Every installed plugin, evaluated. Failures come back separately so the
 * marketplace can show them against the card; one broken bundle never blocks
 * the rest.
 */
export function loadInstalledPlugins(): {
  plugins: Plugin[];
  failures: Map<string, string>;
} {
  const plugins: Plugin[] = [];
  const failures = new Map<string, string>();
  for (const installed of readInstalled()) {
    try {
      plugins.push(evaluateBundle(installed));
    } catch (err) {
      failures.set(installed.id, err instanceof Error ? err.message : String(err));
    }
  }
  return { plugins, failures };
}
