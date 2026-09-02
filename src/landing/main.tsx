import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glacier/tokens/css/tokens.css';
import '@glacier/react/styles.css';
import './landing.css';
import { PlaylistLanding, type SharedPlaylistDoc } from './PlaylistLanding.tsx';

/**
 * The registry's playlist page, mounted over the shell it served. The shell
 * carries the Open Graph tags (so a messenger unfurls the link) and the
 * playlist itself as `window.__SHARE__`, so nothing is fetched to draw.
 */
const share = (window as unknown as { __SHARE__?: SharedPlaylistDoc }).__SHARE__;
const root = document.getElementById('root');
if (root && share) {
  createRoot(root).render(
    <StrictMode>
      <PlaylistLanding share={share} />
    </StrictMode>,
  );
}
