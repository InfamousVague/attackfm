import { Text } from '@glacier/react';
import { UserRound } from '@glacier/icons';
import { ArtWall } from '../app/servers/ArtWall.tsx';
import { AppDoors } from './appDoors.tsx';
import { LocaleShell, useT } from '../app/i18n/LocaleShell.tsx';

/**
 * A profile LINK, opened in a browser: who this is, and the way to add them.
 *
 * The page is deliberately thin, and that is the feature. A profile on the
 * registry is friends-only - what somebody listens to is theirs - so a public
 * page about them can only be an introduction: the handle, the pictures they
 * chose, and the app. Anything more would mean a link people could not share
 * without publishing their listening, which is a link nobody would share.
 *
 * No wall from a hub either, unlike the invite and jam pages: a person is not
 * a server, and there is no library here to draw. The stock wall stands behind
 * them instead.
 */

export interface ProfileDocLanding {
  handle: string;
  state: 'ok' | 'missing';
  avatarUrl: string | null;
  bannerUrl: string | null;
}

/** The shell, for the reason spelled out in InviteLanding: this bundle never
 *  mounts App, so each page starts i18next and stamps the document itself. */
export function ProfileLanding({ profile }: { profile: ProfileDocLanding }) {
  return (
    <LocaleShell>
      <ProfileCard profile={profile} />
    </LocaleShell>
  );
}

function ProfileCard({ profile }: { profile: ProfileDocLanding }) {
  const t = useT();
  const dead = profile.state !== 'ok';

  return (
    <div className="stage">
      <div className="wallBackdrop" aria-hidden>
        <ArtWall />
      </div>
      <main className="card card--invite profileLanding">
        {dead ? (
          <div className="head">
            <span className="joinCard__mark joinCard__mark--dead" aria-hidden>
              !
            </span>
            <h1>{t('landing.profileMissingTitle')}</h1>
            <Text tone="muted" size="sm">
              {t('landing.profileMissingBody')}
            </Text>
          </div>
        ) : (
          <>
            {/* The face over the band, the same shape the profile page wears
                in the app and the share card carries - three places, one
                picture of a person. */}
            <div className="profileLanding__art">
              {profile.bannerUrl ? (
                <img className="profileLanding__banner" src={profile.bannerUrl} alt="" />
              ) : (
                <span className="profileLanding__banner profileLanding__banner--bare" aria-hidden />
              )}
              {profile.avatarUrl ? (
                <img className="profileLanding__face" src={profile.avatarUrl} alt="" />
              ) : (
                <span className="profileLanding__face profileLanding__face--bare" aria-hidden>
                  <UserRound size={34} />
                </span>
              )}
            </div>

            <div className="head">
              <h1>@{profile.handle}</h1>
              <Text tone="muted" size="sm">
                {t('landing.profileTagline')}
              </Text>
            </div>

            <AppDoors scheme={`u/${encodeURIComponent(profile.handle)}`} label={t('landing.addInApp')} />

            <Text tone="muted" size="xs" className="carry">
              {t('landing.profileIsThin', { handle: profile.handle })}
            </Text>
          </>
        )}
      </main>
    </div>
  );
}
