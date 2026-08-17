import { Spinner, Text } from '@glacier/react';
import { useServerSession } from './serverSession.tsx';
import { ConnectForm } from './ServerConnect.tsx';
import { Connected } from './ServerDashboard.tsx';

/**
 * The Server pane: point the app at a music server, sign in, and choose how
 * the music should arrive.
 *
 * Signed out, this is a connect form that probes the address first - so a
 * fresh server offers to make its first account, and a set-up one asks to be
 * signed into. Signed in, it is a status board: what the library holds, how the
 * last sync went, and the one control that actually changes what is heard -
 * lossless bytes or a re-encode.
 *
 * The sections themselves live in sibling modules now - ServerConnect (the
 * form), ServerDashboard (the status board, with ServerUsers and ServerUpload
 * inside it), LinkDeviceSection, MirrorSection and HouseholdSection - and this
 * file is the root switch plus re-exports of the pieces ServersSettings mounts.
 */
export function ServerSettings() {
  const { session, restoring } = useServerSession();
  if (restoring) {
    return (
      <div className="prefsBody">
        <div className="prefsSection">
          <Spinner size="sm" /> <Text tone="muted">Reconnecting…</Text>
        </div>
      </div>
    );
  }
  return session ? <Connected /> : <ConnectForm />;
}

export { LinkDeviceSection } from './LinkDeviceSection.tsx';
export { MirrorSection } from './MirrorSection.tsx';
export { HouseholdSection } from './HouseholdSection.tsx';
