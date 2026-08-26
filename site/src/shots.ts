/**
 * The page's remaining fixed images.
 *
 * Almost nothing is left here on purpose: every screen on the home page is now
 * the app itself, running (components/Frame.tsx). What stays is the one shot
 * the demo cannot produce and the covers behind the hero.
 */

export interface Shot {
  src: string;
  /** Alt text - these carry real meaning, so they are written, not derived. */
  alt: string;
}

export const SHOTS = {
  /*
   * Reading along, photographed from a phone.
   *
   * The demo hub is a music library; read-along needs a book a hub has
   * actually transcribed, which is not something a folder of fixture JSON can
   * stand in for. A .jpg because it is dense text where PNG buys nothing and
   * costs five times the bytes, and framed `phone--native` because the device
   * it came off is a different shape from the 9/19.5 frame.
   */
  reading: {
    src: '/shots/reading.jpg',
    alt: 'An audiobook playing on a phone: the words fill the screen with the sentence being read held bright and the word being spoken underlined, above the chapter line, the time left in the book, and a waveform scrubber',
  },
} satisfies Record<string, Shot>;

/**
 * Cover art for the hero wall.
 *
 * The app's own set, read straight out of src/assets - the same sleeves the
 * demo library plays, so the wall behind the headline and the records inside
 * the frame are one collection rather than two. `eager` because they are the
 * first thing painted; the wall is the hero's ground.
 */
const COVERS = import.meta.glob('../../src/assets/wall/*.jpg', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

/*
 * cover-01 to cover-04 are NOT sleeves.
 *
 * They are AttackFM's own tile illustrations - the heart on Liked, the ring on
 * Downloads, the node graph on the DJ - which live in this folder because the
 * app draws them at cover size. In a wall that is meant to read as somebody's
 * record collection they read as the odd ones out, so the wall starts at 05.
 */
const NOT_SLEEVES = /cover-0[1-4]\.jpg$/;

export const WALL: string[] = Object.keys(COVERS)
  .filter((path) => !NOT_SLEEVES.test(path))
  .sort()
  .map((path) => COVERS[path]!);

/**
 * Surfaces that must NEVER appear on this site:
 * - the Downloads page and any import job list
 * - the Discover page's "add this playlist" affordances
 * - Settings panes naming the importer, or any plugin repository
 * - anything showing a Spotify link, mirror or sync
 *
 * The demo enforces most of this by construction rather than by care: its hub
 * is a folder of JSON with no importer behind it, and demo.html refuses every
 * off-origin request outright, so there is nothing for an acquisition surface
 * to talk to even if one rendered.
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
