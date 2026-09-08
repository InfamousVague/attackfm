import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import placeholderArt from '../../assets/attack-wave.png';

// The title cell's thumb, pulled into its own component because a DataGrid
// cell is a render callback where hooks cannot live. It owns the row's sizing
// too: a ~40px thumb wants the 160 variant, never the full embedded picture.
export function SongArt({ artwork }: { artwork: string | null }) {
  const src = artSized(artwork, 160) || placeholderArt;
  const art = useArtLoad(src, 'songArt');
  return <img {...art} src={src} alt="" loading="lazy" />;
}
