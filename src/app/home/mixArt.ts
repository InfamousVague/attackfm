import { artworkHue, artworkUrl, mixArtwork } from '../ux/artwork.ts';

/** The object a mix's name earns - its URL and the hue of the ground it sits
 *  on - or null when the mix keeps its track mosaic. */
export function mixArt(
  title: string,
  opts: { id: string; curated?: boolean; flavor?: 'ai' | 'heuristic' },
): { src: string; hue: number } | null {
  const slug = mixArtwork(title, opts);
  return slug ? { src: artworkUrl(slug), hue: artworkHue(slug) } : null;
}
