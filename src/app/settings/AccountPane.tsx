import { useContext } from 'react';
import { Avatar, Button, Heading, Text } from '@glacier/react';
import { CircleUserRound, LogOut } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { HouseholdSection, LinkDeviceSection } from '../servers/ServerSettings.tsx';
import { WhereYouListen } from '../profile/WhereYouListen.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';
import { RecoveryCodesSection } from './RecoveryCodes.tsx';
import { SettingsNavContext } from './settingsShared.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { PaneHero, PaneSection, SettingsEmpty } from './kit/settingsKit.tsx';

/**
 * Who you are here, and everywhere else you are.
 *
 * The identity smear this pane gathers: "Signed in as…" and Log out lived at
 * the bottom of General; the servers saved to your account, the QR that signs
 * a new phone in, and the household lived behind Servers -> Access, which is
 * an address nobody would guess; and the devices playing through the account
 * sat inside Servers -> Network. Every one of them answers the same question -
 * "my account, and the things attached to it" - so they live on one page with
 * the account's name on the door.
 *
 * The Servers pane keeps what is genuinely about BOXES: the dashboard of the
 * one you are on, and the network of mirrors serving bytes. Seats and
 * sign-ins are about YOU, and this is your page.
 */
export function AccountPane() {
  const { session, disconnect } = useServerSession();
  const goTo = useContext(SettingsNavContext);
  const t = useT();

  if (!session) {
    return (
      <div className="prefsBody">
        <SettingsEmpty
          icon={<CircleUserRound size={22} />}
          title={t('settings.accountSignedOut')}
          body={t('settings.accountSignedOutBody')}
          action={goTo ? { label: t('settings.accountSetUpUnderServers'), onPress: () => goTo('server') } : undefined}
        />
      </div>
    );
  }

  return (
    <div className="prefsBody">
      <PaneSection>
        {/* Log out removes this account from THIS DEVICE. The library,
            downloads and playlists all stay on the server; signing back in
            restores them - which is why the button needs no confirmation. */}
        <PaneHero
          glyph={<Avatar name={session.username || 'AttackFM'} size="md" />}
          // A session restored from before usernames were stored has an empty
          // one; the hero still needs a first line.
          title={session.username || t('settings.summarySignedIn')}
          meta={session.url.replace(/^https?:\/\//, '')}
          trailing={
            <Button variant="outline" size="sm" onClick={() => void disconnect()}>
              <LogOut size={14} /> {t('settings.logOut')}
            </Button>
          }
        />
      </PaneSection>

      <RecoveryCodesSection />

      <section className="serversSettings__part">
        <header className="serversSettings__partHead">
          <Heading level={3} noMargin>
            {t('settings.whereYouListen')}
          </Heading>
          <Text size="sm" tone="muted">
            {t('settings.whereYouListenBody')}
          </Text>
        </header>
        <WhereYouListen />
      </section>

      <LinkDeviceSection />
      <HouseholdSection />

      <section className="serversSettings__part">
        <header className="serversSettings__partHead">
          <Heading level={3} noMargin>
            {t('settings.devices')}
          </Heading>
          <Text size="sm" tone="muted">
            {t('settings.devicesBody')}
          </Text>
        </header>
        <DevicesSettings />
      </section>
    </div>
  );
}
