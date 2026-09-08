import type { RemoteManifest, RemotePluginListing } from '../../plugins/remote.ts';

/**
 * What a plugin repository is offering, read off whatever came back.
 *
 * Beside `pluginRepos.tsx` rather than in it because both of these answer a
 * question about UNTRUSTED input - a manifest fetched from somebody else's
 * URL, and two version strings written by hand - and both fail quietly when
 * they get it wrong: a repository whose plugins simply do not appear, or an
 * "update" that installs an older build over a newer one.
 */

/** A repository's fetched manifest, the reason it could not be read, or a wait. */
export type Feed = RemoteManifest | string | 'loading';

export function listingsOf(feed: Feed | undefined): RemotePluginListing[] {
  return typeof feed === 'object' && feed !== null && 'plugins' in feed ? feed.plugins : [];
}

/**
 * Dotted versions, newest wins. Only a STRICTLY higher version counts as an
 * update: comparing by inequality would nag forever about a repository that
 * happens to be pinned behind what is installed, and offer a "update" that
 * silently downgrades.
 */
export function isNewer(candidate: string, installed: string): boolean {
  const parts = (v: string) => v.split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
