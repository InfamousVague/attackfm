import { describe, expect, it } from 'vitest';
import { suggestionTarget } from './suggestionTarget.ts';
import type { Suggestion } from '../api/curator.ts';

/**
 * A catalogue suggestion, named the way the importer wants it named.
 *
 * The `kind` decides which plugins are even offered: the chrome asks every
 * enabled handler whether it can service the target, and a handler that only
 * fetches albums will decline a playlist. So a wrong kind is not a wrong
 * label - it is an Add button that goes inert, or worse, one handler quietly
 * taking a job another was built for.
 *
 * It also has to survive an OLDER SERVER, where `kind` is simply absent. A
 * card from such a hub is still a link to a list, which is why the default is
 * `playlist` and not a throw.
 */

const suggestion = (over: Partial<Suggestion> = {}): Suggestion =>
  ({
    id: 's1',
    title: 'Top 50 Global',
    blurb: '',
    cover: null,
    url: 'https://deezer.test/playlist/1',
    section: 'Trending now',
    trackCount: 50,
    ...over,
  }) as Suggestion;

describe('suggestionTarget', () => {
  it('carries the two things a handler actually needs: the name and the link', () => {
    const target = suggestionTarget(suggestion());
    expect(target.title).toBe('Top 50 Global');
    expect(target.url).toBe('https://deezer.test/playlist/1');
  });

  it('passes the album and track kinds through', () => {
    expect(suggestionTarget(suggestion({ kind: 'album' })).kind).toBe('album');
    expect(suggestionTarget(suggestion({ kind: 'track' })).kind).toBe('track');
  });

  it('calls anything else a playlist, which is what a suggestion IS', () => {
    /*
     * "Every suggestion is a link to a list; `kind` says which shape when the
     * server knows." An older hub sends no kind at all, and a hub sending a
     * word this client has not met yet must not fall out of the ladder into
     * `undefined` - that is a target no handler matches and an Add button
     * that does nothing when pressed.
     */
    expect(suggestionTarget(suggestion()).kind).toBe('playlist');
    expect(suggestionTarget(suggestion({ kind: 'playlist' })).kind).toBe('playlist');
    expect(suggestionTarget(suggestion({ kind: 'compilation' })).kind).toBe('playlist');
    expect(suggestionTarget(suggestion({ kind: '' })).kind).toBe('playlist');
  });

  it('names no artist, because a list is not by anybody', () => {
    // `artist` is how a handler searches a store for one record. Filling it
    // with a section name or a first track would send an importer looking for
    // a release that does not exist.
    expect(suggestionTarget(suggestion({ kind: 'album' })).artist).toBeUndefined();
  });

  it('is decided by the same call the page gates on', () => {
    /*
     * The page asks `hasHandlers(suggestionTarget(item))` to decide whether
     * to draw the Add button, then builds the target again to run it. Those
     * two must agree exactly, or a button appears and then finds nobody home.
     */
    const item = suggestion({ kind: 'album' });
    expect(suggestionTarget(item)).toEqual(suggestionTarget(item));
  });
});
