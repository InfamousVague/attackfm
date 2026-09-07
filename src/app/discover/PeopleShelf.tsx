import { Flame, Headphones, Radio } from '@glacier/icons';
import { useMemo } from 'react';
import dateChip from '../../assets/chip-music-date.webp';
import { Shelf } from '../home/homeCards.tsx';
import { Trans, useT } from '../i18n/LocaleShell.tsx';
import { useDiscoverFeed } from '../home/DiscoverFeed.tsx';
import { useFriendsGlance } from '../profile/friendsGlance.ts';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { useJamOptional } from '../player/jam.tsx';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { mosaicArts } from '../ux/artLoad.ts';
import type { RegistryFriend } from '../servers/registry.ts';
import type { Jam } from '../api/jams.ts';

/**
 * People: the three ways this page is not only you and the machine.
 *
 * One card each, and each only when there is somebody behind the door -
 * friends who are listening right now (the registry's presence, read from
 * the poll the notification bell already runs), a groove a friend is hosting
 * (the groove provider's own poll), and Music Date, which is a room full of
 * strangers' songs. A card onto an empty room is worse than no card, so the
 * shelf is as short as the evening is quiet, and absent when nobody is about.
 */
export function PeopleShelf({
  onOpenFriends,
}: {
  /** The Friends page - where the live card leads. */
  onOpenFriends?: () => void;
}) {
  const { session, auditions } = useDiscoverFeed();
  const registry = useRegistryOptional();
  const friends = useFriendsGlance();
  const jam = useJamOptional();
  const t = useT();

  // Online, or heard from with a song on: the registry's own two signals.
  const live = useMemo(
    () => friends.filter((f) => f.online || f.nowPlaying?.playing),
    [friends],
  );
  const room = jam?.friendJams[0] ?? null;
  const dateOpen = session !== null && musicDateDoorOpen();

  const cards: React.ReactNode[] = [];
  if (registry?.session && live.length > 0) {
    cards.push(<FriendsLiveCard key="friends" friends={live} onOpen={onOpenFriends} />);
  }
  if (jam && room) {
    cards.push(<JamCard key="jam" jam={room} onJoin={() => void jam.join(room.id)} />);
  }
  if (dateOpen) {
    cards.push(<MusicDateCard key="date" waiting={auditions.mine} />);
  }
  if (cards.length === 0) return null;

  return (
    <Shelf title={t('discover.people')} count={cards.length}>
      {cards}
    </Shelf>
  );
}

/** Friends hearing something right now: their faces, and what the first is on. */
function FriendsLiveCard({ friends, onOpen }: { friends: RegistryFriend[]; onOpen?: () => void }) {
  const t = useT();
  const playing = friends.find((f) => f.nowPlaying?.playing) ?? friends[0]!;
  const song = playing.nowPlaying;
  const others = friends.length - 1;
  return (
    <button type="button" className="peopleCard" onClick={onOpen} disabled={!onOpen}>
      <span className="peopleCard__face peopleCard__face--friends" aria-hidden>
        {friends.slice(0, 4).map((f) => (
          <FriendAvatar key={f.id} handle={f.handle} size="lg" src={f.avatarUrl ?? undefined} />
        ))}
        <span className="peopleCard__glyph">
          <Headphones size={16} />
        </span>
      </span>
      <span className="peopleCard__text">
        <span className="peopleCard__title">
          {/* One friend is named, several are counted - which is a plural
              form, not two sentences: languages that count differently at two
              or at eleven get to say so in the catalogue. */}
          {t('discover.friendsLive', { count: friends.length, handle: playing.handle })}
        </span>
        <span className="peopleCard__blurb">
          {/* One whole sentence per case rather than a line assembled here.
              The handle, the song and the "+2 others" tail read in this order
              in English and the separators between them are English
              punctuation; a translator who only ever sees the pieces cannot
              move either. `count` is the OTHERS, so a language with a dual
              form gets to say "and two more" its own way. */}
          {song?.playing
            ? others > 0
              ? t('discover.friendPlayingMore', {
                  count: others,
                  handle: playing.handle,
                  title: song.title,
                  artist: song.artist,
                })
              : t('discover.friendPlaying', {
                  handle: playing.handle,
                  title: song.title,
                  artist: song.artist,
                })
            : t('discover.onlineNow')}
        </span>
      </span>
    </button>
  );
}

/**
 * A groove a friend is hosting: who is in it, by name, what is on, and one
 * tap to join. The whole card is the Join - the pill on the face only says so.
 * The names are what make it a room rather than a number: "3 listening" says
 * it is busy; "Matt, Ana, Ben" says whose evening you would be walking into.
 * All of it comes off the room poll the provider already runs.
 */
function JamCard({ jam, onJoin }: { jam: Jam; onJoin: () => void }) {
  const t = useT();
  // Two entries, because a room with no artist name is not the same sentence
  // with a hole left in it: the dash between title and artist is a separator
  // this language chose, and it has nothing to separate when the artist is
  // unknown.
  const title = jam.trackTitle
    ? jam.trackArtist
      ? t('discover.songLine', { title: jam.trackTitle, artist: jam.trackArtist })
      : jam.trackTitle
    : t('discover.nothingOnYet');
  const who = whoIsIn(jam, t);
  return (
    <button
      type="button"
      className="peopleCard peopleCard--groove"
      onClick={onJoin}
      aria-label={t('discover.joinGrooveAria', { host: jam.hostName, who })}
    >
      <span className="peopleCard__face peopleCard__face--jam" aria-hidden>
        <FriendAvatar handle={jam.hostName} size="lg" />
        <span className="peopleCard__glyph peopleCard__glyph--live">
          <Radio size={16} />
        </span>
        <span className="peopleCard__cta">{t('discover.join')}</span>
      </span>
      <span className="peopleCard__text">
        <span className="peopleCard__title">
          <Trans i18nKey="discover.hostingGroove" values={{ host: jam.hostName }} />
        </span>
        <span className="peopleCard__blurb peopleCard__who">{who}</span>
        <span className="peopleCard__blurb">{title}</span>
      </span>
    </button>
  );
}

/** "Matt, Ana, Ben", or "Matt +3" once there are more names than a line
 *  holds. The host leads either way.
 *
 *  Takes the translator rather than reaching for one: this is a plain function
 *  called from a render, and the overflow form is a COUNT - a language with a
 *  dual form wants its own word for "and two more" - so it has to come out of
 *  the catalogue with the number in it, not be glued together here. */
function whoIsIn(jam: Jam, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const host = jam.hostName;
  const others = (jam.members ?? []).filter((m) => m.toLowerCase() !== host.toLowerCase());
  const names = [host, ...others];
  const count = Math.max(names.length, jam.memberCount);
  if (count <= 3 && names.length === count) return names.join(', ');
  return t('discover.whoPlusMore', { host, count: count - 1 });
}

/**
 * Music Date, as a door. The face is the deck itself - the sleeves of the
 * songs actually waiting - so the card is honest about being empty when
 * there is nothing to meet; with nothing waiting it wears the room's own art.
 */
function MusicDateCard({ waiting }: { waiting: { artwork: string | null }[] }) {
  const t = useT();
  const covers = useMemo(() => mosaicArts(waiting.map((w) => w.artwork), 4, 640), [waiting]);
  const n = waiting.length;
  return (
    <button type="button" className="peopleCard" onClick={openMusicDate} aria-label={t('discover.openMusicDate')}>
      <span
        className="peopleCard__face peopleCard__face--date"
        data-covers={covers.length > 0 ? covers.length : undefined}
        aria-hidden
      >
        {covers.length > 0 ? (
          covers.map((src, i) => <img key={i} src={src} alt="" loading="lazy" />)
        ) : (
          <img className="peopleCard__art" src={dateChip} alt="" loading="lazy" />
        )}
        <span className="peopleCard__glyph">
          <Flame size={16} />
        </span>
      </span>
      <span className="peopleCard__text">
        <span className="peopleCard__title">{t('discover.musicDate')}</span>
        <span className="peopleCard__blurb">
          {n > 0 ? t('discover.dateWaiting', { count: n }) : t('discover.dateEmpty')}
        </span>
      </span>
    </button>
  );
}
