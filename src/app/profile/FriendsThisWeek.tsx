import { ArtistLink } from '../ux/ArtistLink.tsx';
import { Users } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { Switch } from '@glacier/react';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { fetchFriends, type RegistryFriend } from '../servers/registry.ts';
import { setSharing, useSharing } from './listeningShare.tsx';
import { fetchStatsSummary, fmtMinutes } from './stats.ts';
import { Heading } from './StatsBits.tsx';

/**
 * The leaderboard, such as it is: your week beside the friends who share
 * theirs. Strictly opt-in both ways - the switch here controls whether YOUR
 * numbers go out (see listeningShare.tsx for how off = silence), and a friend
 * with the switch off simply has no row. No registry identity, no section.
 */
export function FriendsThisWeek({
  myMinutes,
  myStreak,
}: {
  /** Passed through when the page already holds the week summary; fetched
   *  quietly otherwise so the card is per-week whatever the chips show. */
  myMinutes: number | null;
  myStreak: number | null;
}) {
  const { session: registry } = useRegistry();
  const { session: server } = useServerSession();
  const sharing = useSharing();
  const [friends, setFriends] = useState<RegistryFriend[]>([]);
  const [week, setWeek] = useState<{ minutes: number; streak: number } | null>(
    myMinutes === null ? null : { minutes: myMinutes, streak: myStreak ?? 0 },
  );

  useEffect(() => {
    if (myMinutes !== null) {
      setWeek({ minutes: myMinutes, streak: myStreak ?? 0 });
      return;
    }
    if (!server) return;
    const ctrl = new AbortController();
    void fetchStatsSummary(server, 'week', ctrl.signal)
      .then((s) => setWeek({ minutes: s.minutes, streak: s.streakDays }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [myMinutes, myStreak, server]);

  useEffect(() => {
    if (!registry) return;
    let live = true;
    void fetchFriends(registry.token)
      .then((feed) => live && setFriends(feed.friends))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [registry, sharing]);

  if (!registry) return null;

  const sharers = friends
    .filter((f) => typeof f.weekMinutes === 'number')
    .sort((a, b) => (b.weekMinutes ?? 0) - (a.weekMinutes ?? 0));
  const rows: { who: string; minutes: number; streak: number | null; top: string | null; me: boolean }[] = [
    ...(sharing && week
      ? [{ who: 'You', minutes: week.minutes, streak: week.streak, top: null, me: true }]
      : []),
    ...sharers.map((f) => ({
      who: `@${f.handle}`,
      minutes: f.weekMinutes ?? 0,
      streak: f.streakDays ?? null,
      top: f.weekTopArtist ?? null,
      me: false,
    })),
  ].sort((a, b) => b.minutes - a.minutes);
  const most = rows[0]?.minutes ?? 0;

  return (
    <section className="statsSection">
      <Heading icon={<Users size={14} />}>Friends this week</Heading>
      <Switch
        label="Share my listening with friends"
        checked={sharing}
        onCheckedChange={setSharing}
      />
      <p className="statsFriendsNote">
        {sharing
          ? 'Sharing minutes, streak and top artist — nothing more. Switch off and it fades from friends within the week.'
          : 'Off: your numbers stay home. Friends who share still show below.'}
      </p>
      {rows.length === 0 ? (
        <p className="statsFriendsNote">
          {friends.length === 0
            ? 'No friends on the registry yet.'
            : 'None of your friends share their listening yet.'}
        </p>
      ) : (
        <ol className="statsFriends">
          {rows.map((row) => (
            <li key={row.who} className="statsFriendRow" data-me={row.me || undefined}>
              <span className="statsFriendRow__who">{row.who}</span>
              <span className="statsFriendRow__rail" aria-hidden>
                <span
                  className="statsFriendRow__fill"
                  style={{ inlineSize: most > 0 ? `${(row.minutes / most) * 100}%` : '0%' }}
                />
              </span>
              <span className="statsFriendRow__meta">
                {fmtMinutes(row.minutes)}
                {row.streak != null && row.streak > 1 && ` · ${row.streak}d streak`}
                {row.top && (
                  <>
                    {' · '}
                    {/* Their week's artist may not be in YOUR library, but
                        the artist page opens by name and says so honestly -
                        a door beats dead text either way. */}
                    <ArtistLink artist={row.top} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
