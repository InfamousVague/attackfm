import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glacier/tokens/css/tokens.css';
import '@glacier/react/styles.css';
import './borrowed.css';
import './landing.css';
import { PlaylistLanding, type SharedPlaylistDoc } from './PlaylistLanding.tsx';
import { InviteLanding, type InviteDoc } from './InviteLanding.tsx';
import { JamLanding, type JamDoc } from './JamLanding.tsx';
import { ProfileLanding, type ProfileDocLanding } from './ProfileLanding.tsx';

/**
 * The registry's playlist page, mounted over the shell it served. The shell
 * carries the Open Graph tags (so a messenger unfurls the link) and the
 * playlist itself as `window.__SHARE__`, so nothing is fetched to draw.
 */
const globals = window as unknown as {
  __SHARE__?: SharedPlaylistDoc;
  __INVITE__?: InviteDoc;
  __JAM__?: JamDoc;
  __PROFILE__?: ProfileDocLanding;
};
const root = document.getElementById('root');
if (root && globals.__SHARE__) {
  createRoot(root).render(
    <StrictMode>
      <PlaylistLanding share={globals.__SHARE__} />
    </StrictMode>,
  );
} else if (root && globals.__INVITE__) {
  // An invite link (/i/<code>): the same bundle, the join card's page.
  createRoot(root).render(
    <StrictMode>
      <InviteLanding invite={globals.__INVITE__} />
    </StrictMode>,
  );
} else if (root && globals.__JAM__) {
  // A jam link (/j/<code>): a live room, and the honest limit on who can
  // walk into one.
  createRoot(root).render(
    <StrictMode>
      <JamLanding jam={globals.__JAM__} />
    </StrictMode>,
  );
} else if (root && globals.__PROFILE__) {
  // A profile link (/u/<handle>): a person, and the way to add them.
  createRoot(root).render(
    <StrictMode>
      <ProfileLanding profile={globals.__PROFILE__} />
    </StrictMode>,
  );
}
