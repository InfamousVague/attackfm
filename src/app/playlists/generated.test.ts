import { describe, expect, it } from 'vitest';
import { GENERATED_PLAYLIST_FOLDERS, isGeneratedPlaylist } from './generated.ts';

/**
 * The line between a list the SERVER fills and a list a person keeps.
 *
 * Every list surface in the app gates on this one predicate, and it fails in
 * both directions. Too generous and a playlist somebody made by hand
 * disappears from their own library and out of the "Add to playlist" picker,
 * with no message saying where it went. Too strict and fifteen chart lists
 * pile up above the lists they actually keep - which is exactly what happened
 * before the gate existed.
 */

describe('isGeneratedPlaylist', () => {
  it('names the folders the SERVER fills, not the ones a person made', () => {
    // These belong on Discover, and never in the "Add to playlist" picker -
    // which listed them fifteen deep above the lists a person keeps.
    expect(isGeneratedPlaylist({ folder: 'Charts' })).toBe(true);
    expect(isGeneratedPlaylist({ folder: 'New music' })).toBe(true);
    expect(isGeneratedPlaylist({ folder: 'Road trips' })).toBe(false);
    expect(isGeneratedPlaylist({})).toBe(false);
  });

  it('is exact - a folder merely named LIKE one of them is a person’s', () => {
    expect(isGeneratedPlaylist({ folder: 'charts' })).toBe(false);
    expect(isGeneratedPlaylist({ folder: 'New music 2026' })).toBe(false);
    expect([...GENERATED_PLAYLIST_FOLDERS].sort()).toEqual(['Charts', 'New music']);
  });

  it('lets an unfiled list through - most of a person’s lists are in no folder', () => {
    /*
     * The commonest playlist in the app has no folder at all, and the `?? ''`
     * is what stands between that and disappearing. A truthiness test on the
     * folder, or a lookup that treated absent as a match, would empty the
     * picker for nearly everybody.
     */
    expect(isGeneratedPlaylist({ folder: undefined })).toBe(false);
    expect(isGeneratedPlaylist({ folder: '' })).toBe(false);
  });

  it('reads the FOLDER, never the name of the list', () => {
    // A person is entitled to call their own playlist "Charts". What makes a
    // list the server's is where it is filed, not what it is called.
    expect(isGeneratedPlaylist({ name: 'Charts' } as { folder?: string })).toBe(false);
  });

  it('is whitespace-exact, because the folder name is a server literal', () => {
    // The hub writes these two strings; nothing trims them on the way in, so
    // a near miss is a chart shelf appearing among somebody's own lists.
    expect(isGeneratedPlaylist({ folder: ' Charts' })).toBe(false);
    expect(isGeneratedPlaylist({ folder: 'New  music' })).toBe(false);
    expect(isGeneratedPlaylist({ folder: 'New Music' })).toBe(false);
  });
});
