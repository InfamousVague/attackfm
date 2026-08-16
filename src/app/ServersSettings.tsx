import { useState } from 'react';
import { Heading, SegmentedControl, Text } from '@glacier/react';
import { useServerSession } from './serverSession.tsx';
import {
  HouseholdSection,
  LinkDeviceSection,
  MirrorSection,
  ServerSettings,
} from './ServerSettings.tsx';
import { ServersPanel } from './ServersPage.tsx';
import { WhereYouListen } from './WhereYouListen.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';

/**
 * Everything about servers, in one pane, three chunks at a time.
 *
 * There used to be three doors onto this subject: a Settings pane for the box
 * you are signed into, a second for the ones your account can reach, and a nav
 * destination in the overflow menu for their health and routing. Three names
 * for one thing, and the nav destination could not even scroll.
 *
 * Folding them together fixed the scroll and the duplication but made one very
 * long pane - a dashboard, a disk meter, a scan, a device pairing flow, a
 * mirror list, a user table, an uploader and two more server lists, all in a
 * single column. So the pane shows one chunk at a time:
 *
 * - THIS SERVER: the box you are on. Its numbers, its disk, its scan, its
 *   people, what it costs to stream from it, and the way out.
 * - NETWORK: the other boxes. Which one actually serves a song, how near each
 *   is, how much of your library it holds, and what to delete to make room.
 * - ACCESS: ways in and out. Pairing a device, the household, the servers saved
 *   to your account, and the invite you hand somebody else.
 *
 * The chunks own the grouping; the sections inside them are untouched, so
 * nothing had to be rewritten to be moved and nothing was lost in moving.
 */

type Chunk = 'server' | 'network' | 'access';

const CHUNKS: { value: Chunk; label: string }[] = [
  { value: 'server', label: 'This server' },
  { value: 'network', label: 'Network' },
  { value: 'access', label: 'Access' },
];

export function ServersSettings() {
  const { session } = useServerSession();
  const [chunk, setChunk] = useState<Chunk>('server');

  // Signed out there is one thing to do - connect - and ServerSettings is the
  // form that does it. Segments over a single form would be three labels
  // pointing at two empty rooms.
  if (!session) {
    return (
      <div className="prefsBody serversSettings">
        <ServerSettings />
      </div>
    );
  }

  return (
    <div className="prefsBody serversSettings">
      <SegmentedControl
        aria-label="Servers"
        fullWidth
        value={chunk}
        options={CHUNKS}
        onValueChange={(next) => setChunk(next as Chunk)}
      />

      {chunk === 'server' && <ServerSettings />}

      {chunk === 'network' && (
        <>
          <ServersPanel />
          <MirrorSection />
          {/* The devices that play through this account - the old Devices
              pane, folded in where it belongs: servers, mirrors and seats are
              all one question ("where is my music?"), and this is its page. */}
          <section className="serversSettings__part">
            <header className="serversSettings__partHead">
              <Heading level={3} noMargin>
                Devices
              </Heading>
            </header>
            <DevicesSettings />
          </section>
        </>
      )}

      {chunk === 'access' && (
        <>
          <LinkDeviceSection />
          <HouseholdSection />
          <section className="serversSettings__part">
            <header className="serversSettings__partHead">
              <Heading level={3} noMargin>
                Your account
              </Heading>
              <Text size="sm" tone="muted">
                Servers saved to your AttackFM account, wherever you sign in. Switch between
                them, or hand someone a way into yours.
              </Text>
            </header>
            <WhereYouListen />
          </section>
        </>
      )}
    </div>
  );
}
