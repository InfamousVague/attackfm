/**
 * Folders the SERVER fills - the chart lists it keeps ("Top USA", "Top 50
 * Global"...) and its new-music list. Generated on their own clock, never
 * filed by a person: they belong on Discover, not among the lists you made,
 * and never in the "Add to playlist" picker - which listed them, fifteen
 * deep, above the lists a person actually keeps.
 *
 * The membership test lives beside the folder names rather than in the
 * provider, because the names ARE the test: every list surface gates on this
 * one predicate, and a surface that had to import the whole playlist provider
 * to ask the question could not be checked without one.
 */
export const GENERATED_PLAYLIST_FOLDERS: ReadonlySet<string> = new Set(['Charts', 'New music']);

export function isGeneratedPlaylist(p: { folder?: string }): boolean {
  return GENERATED_PLAYLIST_FOLDERS.has(p.folder ?? '');
}
