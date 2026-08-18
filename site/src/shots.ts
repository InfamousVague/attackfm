/**
 * The screenshot manifest.
 *
 * Every image on the page is named here rather than inline in a component, so a
 * re-capture is a change to ONE file. `scripts/capture-site-shots.mjs` produces
 * these from a real signed-in app; re-run it rather than editing screens by hand.
 *
 * Rule for this file: nothing that shows music being acquired. The importer is a
 * private plugin of Matt's, not part of the product. The capture script disables
 * those plugins outright, which is a stronger guarantee than avoiding their
 * screens by hand - see EXCLUDED at the bottom.
 */

export interface Shot {
  /** Path under site/public, or null while the capture is pending. */
  src: string | null;
  /** Alt text - these carry real meaning, so they are written, not derived. */
  alt: string;
  /** Shown in the placeholder while src is null. */
  label: string;
}

const shot = (file: string, label: string, alt: string): Shot => ({
  src: `/shots/${file}.png`,
  label,
  alt,
});

export const SHOTS = {
  home: shot('home', 'Home', 'The AttackFM library screen: Liked, All songs, On repeat and a DJ set, above a shelf of playlists'),
  library: shot('library', 'Library', 'The full song list, showing four thousand tracks with artwork, album and date added'),
  nowPlaying: shot('nowPlaying', 'Now Playing', 'The now playing screen, artwork spinning as a record above the transport controls'),
  booth: shot('booth', 'The Booth', 'The Booth, showing Music Date, a live DJ set, and what the curator has read across the library'),
  stats: shot('stats', 'Listening', 'Listening statistics for the week: 21.2 hours, 656 plays, 372 songs and 277 artists, with the top artist and album'),
  desktop: shot('desktop', 'Desktop', 'AttackFM running full width on a desktop, with playlists and listening stats'),
  desktopAlbum: shot('desktopAlbum', 'Playlist', 'A playlist open on the desktop, its tracks listed beside the player bar'),
} satisfies Record<string, Shot>;

export type ShotKey = keyof typeof SHOTS;

/**
 * Cover art for the hero wall - real sleeves from a real library, one per album,
 * downscaled because they sit behind a blur and are never seen at full size.
 */
export const WALL: string[] = Array.from(
  { length: 24 },
  (_, i) => `/wall/cover-${String(i).padStart(2, '0')}.jpg`,
);

/**
 * Surfaces that must NEVER be captured for this site:
 * - the Downloads page and any import job list
 * - the Discover page's "add this playlist" affordances
 * - Settings panes naming the importer, or any plugin repository
 * - anything showing a Spotify link, mirror or sync
 *
 * Two more were captured and then deliberately dropped:
 * - the LYRICS panel, which reproduces a copyrighted lyric sheet in full
 * - the EQUALISER popover, which surfaces unshipped "HiFi chain" work
 * - the QUEUE panel, which only ever holds explicitly-added songs and so always
 *   photographs as an empty state
 * - the PROFILE tab, which without a registry account signed in is an
 *   account-creation form with a password field
 */
export const EXCLUDED = [
  'downloads',
  'imports',
  'discover-add',
  'spotify',
  'plugin-repos',
  'lyrics',
  'equaliser',
] as const;
