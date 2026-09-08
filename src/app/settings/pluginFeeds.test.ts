import { describe, expect, it } from 'vitest';
import { isNewer, listingsOf, type Feed } from './pluginFeeds.ts';
import type { RemoteManifest, RemotePluginListing } from '../../plugins/remote.ts';

/**
 * Reading somebody else's plugin repository.
 *
 * Both halves of this file take input from outside the app and both fail
 * without saying anything. `listingsOf` is handed whatever came back from a
 * URL - a manifest, an error message, or nothing yet - and a wrong guard
 * there means a repository whose plugins simply do not appear in the browse
 * shelf, which looks exactly like a repository with no plugins. `isNewer`
 * compares two hand-written version strings, and getting it wrong either nags
 * forever about an update that is not one, or offers an "update" that
 * installs an older build over a newer one.
 */

function listing(over: Partial<RemotePluginListing> = {}): RemotePluginListing {
  return { id: 'spotify-import', name: 'Spotify import', version: '1.0.0', url: 'https://x/p.js', ...over } as RemotePluginListing;
}

function manifest(plugins: RemotePluginListing[]): RemoteManifest {
  return { plugins } as RemoteManifest;
}

describe('listingsOf', () => {
  it('hands back every plugin a repository offered', () => {
    // The count is the assertion: a guard that reached for `feed.plugins[0]`
    // or filtered on a field the manifest need not carry would drop the rest
    // of a repository silently.
    const feed = manifest([listing({ id: 'a' }), listing({ id: 'b' }), listing({ id: 'c' })]);
    expect(listingsOf(feed).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('is empty, never undefined, for a repository that has not answered yet', () => {
    // Three callers do `listingsOf(feed).map(...)` straight into JSX. An
    // undefined here is a blank pane and a console error, mid-render.
    expect(listingsOf('loading')).toEqual([]);
    expect(listingsOf(undefined)).toEqual([]);
  });

  it('is empty for a repository that failed, whatever it said', () => {
    // The failure IS the feed for a broken source - the string is the reason,
    // and a truthy-object check would treat it as a manifest.
    expect(listingsOf('404 Not Found')).toEqual([]);
    expect(listingsOf('')).toEqual([]);
  });

  it('is empty for an answer that is not a manifest at all', () => {
    // A URL that serves some other JSON - an index page, an error envelope -
    // parses fine and has no `plugins`. Reading `.plugins` off it would put
    // undefined into a `.map`.
    expect(listingsOf({} as Feed)).toEqual([]);
    expect(listingsOf(null as unknown as Feed)).toEqual([]);
  });
});

describe('isNewer', () => {
  it('compares each dotted part as a NUMBER, so 0.10.0 beats 0.9.0', () => {
    // The bug the parse exists for: compared as strings, "0.10.0" sorts below
    // "0.9.0" and a repository that has shipped ten minor versions stops
    // offering updates entirely, forever, with nothing in any log.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('refuses an EQUAL version, so an up-to-date plugin is not offered forever', () => {
    // Strictly higher. `>=` here means the update banner never goes away -
    // and every "update" reinstalls what is already there.
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
  });

  it('refuses an older one, so a pinned repository cannot downgrade you', () => {
    expect(isNewer('1.2.0', '1.3.0')).toBe(false);
    expect(isNewer('1.2.0', '2.0.0')).toBe(false);
  });

  it('treats a missing part as zero, in both directions', () => {
    // Version strings are hand-written and lengths differ. 1.2 and 1.2.0 are
    // the same build; 1.2.1 is newer than 1.2.
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0', '1.2')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
    expect(isNewer('1.2', '1.2.1')).toBe(false);
  });

  it('splits on the pre-release and build separators as well as the dot', () => {
    // `1.2.0-2` is the second build of 1.2.0, and the split is what lets the
    // trailing number count at all rather than parsing as NaN.
    expect(isNewer('1.2.0-2', '1.2.0-1')).toBe(true);
    expect(isNewer('1.2.0+5', '1.2.0+5')).toBe(false);
  });

  it('reads an unparseable part as zero rather than as NaN', () => {
    /*
     * `Number.parseInt('beta', 10) || 0`. Without the fallback the comparison
     * is against NaN, which is false in every direction - so a repository
     * that tags one build `1.2.beta` stops offering updates and, more
     * confusingly, keeps offering them for its OTHER plugins, which reads as
     * the marketplace being flaky rather than as a version string.
     */
    expect(isNewer('1.3.beta', '1.2.0')).toBe(true);
    expect(isNewer('1.2.beta', '1.2.1')).toBe(false);
    expect(isNewer('', '')).toBe(false);
  });
});
