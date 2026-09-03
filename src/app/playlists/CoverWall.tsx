import { useMemo } from 'react';
import { mosaicArts } from '../ux/artLoad.ts';
import { useLoopArt } from '../ux/loopArt.ts';

/**
 * The covers of a list, drifting slowly behind its header.
 *
 * A playlist's identity is the records in it, and the header says so with the
 * actual sleeves, moving, so a list looks like the music it holds before you
 * have read a word of it.
 *
 * Built to the app's front-door treatment (servers/ArtWall): a slab of columns,
 * each scrolling vertically at a different speed and in alternating directions,
 * the whole thing tilted off-square. That tilt plus the vertical drift is what
 * reads as a diagonal - the same look the sign-in wall wears, brought here so
 * the two are recognisably one thing. It replaced a single horizontal strip,
 * whose one seam this trades for four independent per-column ones.
 *
 * Each column holds its covers TWICE and travels exactly half its own height,
 * which is what makes each loop seamless: at the end of the run the second copy
 * sits exactly where the first began. `transform` only, one promoted layer per
 * column, nothing measured per frame.
 *
 * Reduced motion stops it dead rather than hiding it: the covers are the point
 * and they still read as a wall standing still.
 */

/**
 * How many sleeves the wall carries. Dealt round-robin across the columns, so
 * neighbouring columns never start on the same picture; deduped by image, so
 * this is a ceiling. No longer has to divide by anything - each column loops on
 * its own, so the old "multiple of the row count" seam constraint is retired.
 */
const WALL_COVERS = 20;

/** Below this there is no wall to be had - one sleeve tiled is wallpaper. */
const WALL_MINIMUM = 3;

/**
 * Canvas clips, when the wall is built from those instead (the Music header).
 *
 * Far fewer than the sleeve count, and the reason is decoders rather than
 * taste: every clip in the wall is a <video> playing at once, and each column
 * carries its share TWICE for the seam - so this number doubles before it
 * reaches the device. Six is what `/api/wall` hands out and twelve muted inline
 * clips is a load a phone can carry; a wall of twenty would be forty.
 */
const WALL_CLIPS = 6;

/** Two distinct clips is already a wall, because each one is itself moving -
 *  the thing a single tiled sleeve could never be. */
const CLIP_MINIMUM = 2;

/**
 * Tiles per column, per copy - and this one is geometry, not taste.
 *
 * A column scrolls by travelling half its own height, so the half has to be at
 * least as tall as the slab or the tail of the loop drags empty space through
 * the frame. Twenty sleeves make five-deep columns and clear that on their own;
 * six clips would make columns one and two deep, which is exactly how the first
 * cut of this came out - imagery along the top and black underneath.
 *
 * So a clip column is always this many tiles, repeating its own clips to get
 * there, and the tile is given a fixed height in CSS chosen so that two of them
 * exceed the tallest slab this header builds. Fixed count times fixed height
 * means the fill does not depend on how wide the screen is.
 */
const CLIP_TILES = 2;

/** At most this many clip columns. Three rather than the sleeves' four: the
 *  tiles are tall, and every column costs two live decoders. */
const CLIP_COLUMNS = 3;

/** Four columns, four durations that never line up - columns sharing a period
 *  would pulse together instead of drifting. Slow on purpose. */
const DURATIONS = ['46s', '55s', '64s', '73s'];
const COLUMNS = DURATIONS.length;

/** Deal the covers round-robin into the columns. */
function toColumns(covers: readonly string[]): string[][] {
  const out: string[][] = Array.from({ length: COLUMNS }, () => []);
  covers.forEach((src, i) => out[i % COLUMNS]!.push(src));
  return out;
}

/**
 * Deal the clips into columns of a FIXED depth, wrapping round the set to fill
 * the last places when there are not enough to go round.
 *
 * Unlike the sleeves, this cannot just deal what it has and let the columns
 * come out uneven: a short column is a gap in the loop (see CLIP_TILES). So the
 * count of columns bends to the number of clips instead, and within a column
 * the set repeats rather than leaving a hole.
 */
function toClipColumns(clips: readonly string[]): string[][] {
  const wide = Math.min(CLIP_COLUMNS, Math.max(1, Math.ceil(clips.length / CLIP_TILES)));
  return Array.from({ length: wide }, (_, col) =>
    Array.from({ length: CLIP_TILES }, (_, row) => clips[(col + row * wide) % clips.length]!),
  );
}

export function CoverWall({
  artworks,
  clips,
  loading = 'lazy',
}: {
  artworks: readonly (string | null)[];
  /**
   * Canvas clips to build the wall from INSTEAD of the sleeves - the moving
   * covers this library already stores, from `/api/wall`. Given enough of them
   * the wall is video; short of that it falls back to `artworks`, so a server
   * with no Canvas source is never a blank header.
   */
  clips?: readonly string[];
  /**
   * Lazy behind a header, where the wall is one band of a page that scrolls
   * past it. Eager where the wall IS the page (the registry's playlist link
   * page hangs it behind everything): there is nothing to defer for, and a
   * lazy wall that never intersects - a hidden tab, a browser that will not
   * observe through a filtered, transformed slab - is a wall that never draws.
   */
  loading?: 'lazy' | 'eager';
}) {
  // Clips pause themselves whenever the page is hidden; this puts them back.
  useLoopArt();
  // 160, not 640: this is blurred past the point where detail survives.
  const covers = useMemo(() => mosaicArts(artworks, WALL_COVERS, 160), [artworks]);
  const reel = useMemo(() => (clips ?? []).slice(0, WALL_CLIPS), [clips]);
  // Clips win when there are enough of them; otherwise the sleeves, exactly as
  // before. Decided here rather than by the caller so every wall falls back the
  // same way.
  const moving = reel.length >= CLIP_MINIMUM;
  const cols = useMemo(
    () => (moving ? toClipColumns(reel) : toColumns(covers)),
    [moving, reel, covers],
  );
  // A column of one cover tiled is wallpaper; keep the minimum on the whole set.
  if (!moving && covers.length < WALL_MINIMUM) return null;

  return (
    <div className="coverWall" data-kind={moving ? 'clip' : undefined} aria-hidden="true">
      <div className="coverWall__slab">
        {cols.map((column, i) => (
          <div
            key={i}
            className="coverWall__col"
            data-dir={i % 2 === 0 ? 'up' : 'down'}
            style={{ ['--wall-dur' as string]: DURATIONS[i] }}
          >
            {/* Twice through: the animation travels -50%, so the copy lands
                where the original started and the seam never shows. Map the same
                slice again rather than anything that might reorder it. */}
            {[...column, ...column].map((src, j) =>
              moving ? (
                <WallClip key={j} src={src} />
              ) : (
                <img key={j} src={src} alt="" loading={loading} decoding="async" />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One clip in the wall. Muted, inline and looping - the same contract the
 * date cards' Canvas plays under, which is what lets it autoplay at all.
 *
 * `onEnded` restarts it: WebKit drops `loop` after the decoder is interrupted
 * (a call, another app taking the session), and a wall with one dead column is
 * worse than one that never moved.
 */
function WallClip({ src }: { src: string }) {
  return (
    <video
      className="coverWall__clip"
      data-loop-art=""
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
      onEnded={(e) => {
        const v = e.currentTarget;
        v.currentTime = 0;
        void v.play().catch(() => {});
      }}
    />
  );
}
