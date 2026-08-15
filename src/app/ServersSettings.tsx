import { Heading, Text } from '@glacier/react';
import { useServerSession } from './serverSession.tsx';
import { ServerSettings } from './ServerSettings.tsx';
import { ServersPanel } from './ServersPage.tsx';
import { WhereYouListen } from './WhereYouListen.tsx';

/**
 * Everything about servers, in one pane.
 *
 * There used to be three doors onto this: a Settings pane for the box you are
 * signed into, a second Settings pane for the ones your account can reach, and
 * a whole nav destination in the overflow menu for their health and routing.
 * Three names for one subject, and the nav destination could not even scroll -
 * it had no overflow of its own, so a list longer than the screen had no way
 * down. Living here fixes that by construction: the settings pane is already
 * the scroller.
 *
 * The three parts are kept as they were rather than rewritten into one list,
 * because they answer three different questions and each holds something the
 * others do not:
 *
 * - THIS SERVER: the dashboard, the scan, sign out, the household, linking a
 *   device, users, streaming quality, uploads. The admin surface.
 * - STREAMING: which box actually serves a song, how near each one is, how
 *   much of your library it holds, and what to delete to make room.
 * - YOUR ACCOUNT: switching which server you are signed into, forgetting one
 *   everywhere, and the invite doors.
 *
 * They overlap in what they LIST - the same boxes appear more than once - but
 * not in what they DO, and merging the lists would have cost real actions.
 */
export function ServersSettings() {
  const { session } = useServerSession();

  return (
    <div className="prefsBody serversSettings">
      {/* Signed out, this is the whole pane: ServerSettings renders the
          connect form, and there is no network or account list to speak of
          until it succeeds. */}
      <ServerSettings />

      {session && (
        <>
          <ServersPanel />

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
