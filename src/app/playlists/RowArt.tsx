import { useArtLoad } from '../ux/artLoad.ts';
import { artSized } from '../server.ts';
import placeholderArt from '../../assets/attack-wave.png';

/** One row's cover thumb: skeleton while the bytes come, pop on arrival. A
 *  component of its own so the hook lives outside the render callbacks that
 *  draw the rows - shared by the playlist page and the playlist modal, which
 *  each used to carry an identical copy. */
export function RowArt({ artwork }: { artwork: string | null }) {
  const src = artSized(artwork, 160) ?? placeholderArt;
  const art = useArtLoad(src, 'songArt');
  return <img {...art} src={src} alt="" loading="lazy" />;
}
