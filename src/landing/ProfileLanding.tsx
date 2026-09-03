import { Text } from '@glacier/react';
import { UserRound } from '@glacier/icons';
import { ArtWall } from '../app/servers/ArtWall.tsx';
import { AppDoors } from './appDoors.tsx';

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

export function ProfileLanding({ profile }: { profile: ProfileDocLanding }) {
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
            <h1>No one goes by that handle</h1>
            <Text tone="muted" size="sm">
              The link may have been mistyped, or the account closed.
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
                On AttackFM · add them and listen along
              </Text>
            </div>

            <AppDoors scheme={`u/${encodeURIComponent(profile.handle)}`} label="Add in AttackFM" />

            <Text tone="muted" size="xs" className="carry">
              This page shows a handle and a picture, and nothing else. What @{profile.handle}{' '}
              listens to is for their friends - opening this in AttackFM asks to be one.
            </Text>
          </>
        )}
      </main>
    </div>
  );
}
