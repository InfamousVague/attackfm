import { Button, Pill, ScrollArea } from '@glacier/react';
import { ChartNoAxesColumn, Flame, Headphones, Hourglass, User, Users } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PresenceMark } from '../profile/PresenceMark.tsx';
import { NowPlayingLine } from '../profile/RegistryFriends.tsx';
import { listenedTime } from '../profile/friendPresence.ts';
import { useFriendsGlance } from '../profile/friendsGlance.ts';
import { activeFriends, HERO_CAST, type ActiveFriend } from '../profile/friendStanding.ts';
import { TOUCH_HOLD_MS, useHeroSeat } from '../profile/heroSeat.ts';
import { artistImageKnown, cachedArtistImage, resolveArtistImage } from '../albumArtist/artistImage.ts';
import { ArtistLink } from '../ux/ArtistLink.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { useJamOptional } from '../player/jam.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * The friends hero: one person, big, and the rest as faces under them.
 *
 * Discover's People shelf answers "is anybody about?" with a card of stacked
 * thumbnails and a headline naming whoever sorted first. That is a status
 * light. This is the other half - who, exactly, and what could you do about
 * it - and it takes turns rather than showing a grid, because four friends
 * drawn small is a list, and a list is what the Friends page already is.
 *
 * The turn-taking is in `heroSeat.ts` and the ranking is in
 * `friendStanding.ts`; both are pure, because both are the parts that fail
 * silently. What is left here is the drawing.
 */
export function FriendsHero({ onOpenFriends }: { onOpenFriends?: () => void }) {
  const t = useT();
  const registry = useRegistryOptional();
  const { session: server } = useServerSession();
  const jam = useJamOptional();
  const friends = useFriendsGlance();

  // A clock the ranking can be recomputed against. Standing is a claim with a
  // freshness bound in it, so a page left open has to be allowed to change its
  // mind about a song that has gone stale - without that tick the hero would
  // still be announcing it at midnight.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const sameHub = useMemo(() => {
    const here = server?.url ?? null;
    return (f: RegistryFriend) => !!f.serverUrl && here === f.serverUrl.replace(/\/+$/, '');
  }, [server]);
  const hosting = useMemo(() => {
    const hosts = new Set((jam?.friendJams ?? []).map((room) => room.hostName.toLowerCase()));
    return (f: RegistryFriend) => hosts.has(f.handle.toLowerCase());
  }, [jam?.friendJams]);

  const cast = useMemo(() => {
    void tick;
    return activeFriends(friends, { sameHub, hosting }, Date.now()).slice(0, HERO_CAST);
  }, [friends, sameHub, hosting, tick]);

  // "Held" is one word for every reason the card must not change under
  // somebody: a pointer on it, focus in it, a tap it has just answered, or a
  // face they chose off the rail themselves.
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState(false);
  const touched = useRef(0);
  useEffect(() => {
    if (!pinned) return;
    const id = setTimeout(() => setPinned(false), 90_000);
    return () => clearTimeout(id);
  }, [pinned]);
  const { seat, show } = useHeroSeat(cast, busy || pinned);

  // Pictures for the artists the cast is actually on, warmed once per name.
  // The friends list already warms top artists this way; this adds the song's
  // artist, which is the one the band most wants and the one that changes.
  //
  // Keyed on the NAMES, not on the cast: the cast is a fresh array on every
  // tick and every poll, and an effect keyed on its identity would tear down
  // and rebuild every thirty seconds. That matters more than a wasted render,
  // because the teardown aborts the lookup - and `resolveArtistImage`
  // remembers a failed lookup as a miss, so a fetch cancelled mid-flight would
  // cache "this artist has no picture" and the band would stay flat for the
  // rest of the session.
  const wanted = [
    ...new Set(
      cast
        .flatMap((c) => [c.friend.nowPlaying?.artist, c.friend.weekTopArtist])
        .map((n) => (n ?? '').trim())
        .filter(Boolean),
    ),
  ].sort();
  const wantedKey = wanted.join('\u0000');
  useEffect(() => {
    if (!server) return;
    const names = wantedKey.split('\u0000').filter((n) => n && !artistImageKnown(n));
    if (names.length === 0) return;
    const control = new AbortController();
    let live = true;
    void Promise.all(names.map((n) => resolveArtistImage(server, n, control.signal))).then(() => {
      // The pictures land in a module cache, so the band has to be told to
      // look again rather than being handed them.
      if (live) setTick((n) => n + 1);
    });
    return () => {
      live = false;
      control.abort();
    };
  }, [server, wantedKey]);

  if (!registry?.session || seat === null) return null;

  const f = seat.friend;
  const np = f.nowPlaying;
  const near = sameHub(f);
  const hosts = hosting(f);
  // The same two gates the friend row uses, and for the same reasons: listen
  // along follows a friend who is PLAYING and needs you free; invite gathers
  // an online friend into a room you host. No verb here that is not already a
  // verb there - a hero is a shortcut, not a second set of rules.
  const showAlong = !!jam && near && seat.standing === 'playing' && !jam.current;
  const showInvite = !!jam && near && !showAlong && (!jam.current || jam.hosting);
  const band = cachedArtistImage(np?.artist ?? '') ?? cachedArtistImage(f.weekTopArtist ?? '') ?? f.bannerUrl ?? null;

  return (
    <section
      className="friendsHero"
      aria-label={t('discover.friendsHeroAria')}
      onPointerEnter={() => setBusy(true)}
      onPointerLeave={() => setBusy(false)}
      onFocus={() => setBusy(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBusy(false);
      }}
      /* Touch has no hover to hold the card still, so the tap buys the
         stillness itself - and it has to be released on a timer, because
         there is no matching "finger left" event to release it. */
      onPointerDown={() => {
        touched.current = Date.now();
        setBusy(true);
        setTimeout(() => {
          if (Date.now() - touched.current >= TOUCH_HOLD_MS) setBusy(false);
        }, TOUCH_HOLD_MS);
      }}
    >
      <div className="friendsHero__card" data-standing={seat.standing}>
        {/* The scrim exists to hold type over a picture. With no picture it is
            a gradient over the card's own surface - which in the light theme
            reads as a grey wash down an otherwise clean card, darkening
            something that was never too bright. No band, no scrim. */}
        {band && (
          <>
            <img className="friendsHero__band" src={band} alt="" aria-hidden loading="lazy" />
            <span className="friendsHero__scrim" aria-hidden />
          </>
        )}
        <div className="friendsHero__who">
          <PresenceMark f={f} standing={seat.standing} size="lg" hosting={hosts} />
          <div className="friendsHero__words">
            <p className="friendsHero__handle">@{f.handle}</p>
            {/* What they are on, when there is something; otherwise the
                plainest true sentence about them. "Here" is not a song and
                must not be dressed as one. */}
            {np ? (
              <span className="friendsHero__line">
                <NowPlayingLine f={f} />
              </span>
            ) : (
              <p className="friendsHero__line friendsHero__line--quiet">
                {f.sharing === false ? t('profile.keepsListeningPrivate') : t('discover.friendIsHere')}
              </p>
            )}
          </div>
        </div>

        {/* The week is the person; the song is only the news. A friend who is
            merely here still has a week, which is what keeps the card worth
            reading on a quiet evening. Pills wrap rather than ellipsise: a
            tile clips exactly the part that matters, which the stats panel
            learned the hard way. */}
        <div className="friendsHero__week">
          {typeof f.weekMinutes === 'number' && f.weekMinutes > 0 && (
            <Pill variant="soft" size="sm" icon={<Hourglass size={13} />}>
              {t('profile.timeThisWeek', { time: listenedTime(f.weekMinutes) })}
            </Pill>
          )}
          {typeof f.streakDays === 'number' && f.streakDays > 1 && (
            <Pill variant="soft" size="sm" icon={<Flame size={13} />}>
              {t('profile.dayStreakShort', { count: f.streakDays })}
            </Pill>
          )}
          {f.weekTopArtist && (
            <Pill variant="soft" size="sm" icon={<User size={13} />}>
              <ArtistLink artist={f.weekTopArtist} />
            </Pill>
          )}
        </div>

        <div className="friendsHero__actions">
          {showAlong && (
            <Button
              variant="solid"
              size="sm"
              aria-label={t('profile.listenAlongWith', { handle: f.handle })}
              onClick={() => void jam?.invite(f.handle, 'along')}
            >
              <Headphones size={15} />
              {t('profile.listenAlong')}
            </Button>
          )}
          {showInvite && (
            <Button
              variant={jam?.current ? 'soft' : 'solid'}
              size="sm"
              aria-label={t('profile.inviteWhoToGroove', { handle: f.handle })}
              onClick={() => void jam?.jamWith(f.handle)}
            >
              <Users size={15} />
              {t('profile.inviteToGroove')}
            </Button>
          )}
          {onOpenFriends && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('profile.profileForWho', { handle: f.handle })}
              onClick={onOpenFriends}
            >
              <ChartNoAxesColumn size={15} />
              {t('profile.profile')}
            </Button>
          )}
        </div>
      </div>

      {/* Everyone else, as faces. This is the manual walk: the rotation is a
          convenience, and the rail is how somebody overrules it. With one
          friend in the cast there is nothing to walk, and a one-face rail
          would be a lie about there being more. */}
      {cast.length > 1 && (
        <ScrollArea orientation="horizontal" className="friendsRail" hideScrollbar>
          <div className="friendsRail__row">
            {cast.map((c) => (
              <FriendChip
                key={c.friend.id}
                c={c}
                current={c.friend.handle === f.handle}
                hosting={hosting(c.friend)}
                onShow={() => {
                  show(c.friend.handle);
                  setPinned(true);
                }}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

/**
 * One friend at rail size: the face, its marks, and the handle.
 *
 * Nothing else - at this size a song title is a smear. The handle truncates
 * with an ellipsis and never to initials: a cut-off name is still a name, and
 * initials are a puzzle with the answer removed.
 */
function FriendChip({
  c,
  current,
  hosting,
  onShow,
}: {
  c: ActiveFriend;
  current: boolean;
  hosting: boolean;
  onShow: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="friendChip"
      /* The seated friend is the same person as the hero above, not a second
         one - `aria-current` is what says so, and the filled ring is what says
         it to everybody else. */
      aria-current={current || undefined}
      aria-label={t('discover.showFriend', { handle: c.friend.handle })}
      onClick={onShow}
    >
      <PresenceMark f={c.friend} standing={c.standing} size="md" hosting={hosting} />
      <span className="friendChip__handle">{c.friend.handle}</span>
    </button>
  );
}
