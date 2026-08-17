/**
 * THE text fold: lowercase, unaccented, apostrophes dropped, every other run
 * of punctuation collapsed to a single space.
 *
 * This is a cross-language CONTRACT, not a convenience. The server folds with
 * `fold` in server/src/discovery.rs (and `folded` in enrichment.rs), and the
 * mirror availability map, the owned-check and search all join catalogue
 * strings to file tags through this exact shape - a disagreement between any
 * two copies means the app quietly believes a mirror lacks a song it declined
 * to copy because it already had it. Three client copies used to keep in step
 * by hand; now there is one, and the Rust side is the only other place the
 * rule lives.
 *
 * Apostrophes are DROPPED rather than spaced - "Don't" and "Dont" are the
 * same song, and one tagger in three leaves it out.
 */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/['’ʼ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
