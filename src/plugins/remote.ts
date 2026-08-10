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

const SOURCES_KEY = 'attackfm-plugin-sources';
const INSTALLED_KEY = 'attackfm-plugins-installed';

/**
 * The repositories a fresh install starts with: none.
 *
 * Plugins run with the app's own reach, and downloading music is a plugin - so
 * the app ships with no sources and no way to fetch one until the user
 * deliberately adds a repository in Settings. Nothing to install means no
 * download or import surfaces appear, which is the honest default and what an
 * App Store reviewer (or anyone who has not opted in) should see.
 */
export const DEFAULT_SOURCES: readonly string[] = [];

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
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [...DEFAULT_SOURCES];
  }
}

function writeSources(sources: string[]): void {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
  } catch {
    // Storage unavailable - the list still applies for this session.
  }
}

export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function addSource(url: string): string[] {
  const origin = normalizeSourceUrl(url);
  const sources = readSources();
  if (origin && !sources.includes(origin)) sources.push(origin);
  writeSources(sources);
  return sources;
}

export function removeSource(url: string): string[] {
  const sources = readSources().filter((s) => s !== url);
  writeSources(sources);
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

export function uninstallPlugin(id: string): void {
  writeInstalled(readInstalled().filter((p) => p.id !== id));
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
  } catch (err) {
    // A bundle that does not fit the storage quota cannot survive a relaunch;
    // better to say so than to pretend the install stuck.
    throw new Error(
      `could not persist the plugin: ${err instanceof Error ? err.message : 'storage refused it'}`,
    );
  }
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
