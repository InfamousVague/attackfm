import { useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { MirrorSection, ServerSettings } from './ServerSettings.tsx';
import { ServersPanel } from './ServersPage.tsx';
import { SubNav } from '../settings/kit/settingsKit.tsx';

/**
 * The boxes: the one you are signed into, and the network serving bytes.
 *
 * This pane used to be three chunks - This server / Network / Access - and
 * carried the whole account inside it: device pairing, the household, the
 * servers saved to your account, plus the Devices list embedded into Network.
 * All of that moved to the Account & devices pane, because seats and sign-ins
 * are about YOU; what is left here is genuinely about machines:
 *
 * - THIS SERVER: the box you are on. Its numbers, its disk, its scan, its
 *   people, and the way out.
 * - NETWORK: the other boxes. Which one actually serves a song, how near each
 *   is, how much of your library it holds, and the mirror copier.
 *
 * The chunks switch on SubNav tabs rather than a SegmentedControl: a
 * segmented control answers "which value", tabs answer "which page", and
 * dressing both alike was how this pane read as a form when it is a small
 * book.
 */

type Chunk = 'server' | 'network';

const CHUNKS: { id: Chunk; label: string }[] = [
  { id: 'server', label: 'This server' },
  { id: 'network', label: 'Network' },
];

export function ServersSettings() {
  const { session } = useServerSession();
  const [chunk, setChunk] = useState<Chunk>('server');

  // Signed out there is one thing to do - connect - and ServerSettings is the
  // form that does it. Tabs over a single form would be two labels pointing
  // at an empty room.
  if (!session) {
    return (
      <div className="prefsBody serversSettings">
        <ServerSettings />
      </div>
    );
  }

  return (
    <div className="prefsBody serversSettings">
      <SubNav
        value={chunk}
        onValueChange={(next) => setChunk(next as Chunk)}
        options={CHUNKS}
      />

      {chunk === 'server' && <ServerSettings />}

      {chunk === 'network' && (
        <>
          <ServersPanel />
          <MirrorSection />
        </>
      )}
    </div>
  );
}
