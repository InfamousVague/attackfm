import { Flame, Headphones, Radio } from '@glacier/icons';
import { useMemo } from 'react';
import dateChip from '../../assets/chip-music-date.webp';
import { Shelf } from '../home/homeCards.tsx';
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
 * the poll the notification bell already runs), a jam a friend is hosting
 * (the jam provider's own poll), and Music Date, which is a room full of
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
    <Shelf title="People" count={cards.length}>
      {cards}
    </Shelf>
  );
}

/** Friends hearing something right now: their faces, and what the first is on. */
function FriendsLiveCard({ friends, onOpen }: { friends: RegistryFriend[]; onOpen?: () => void }) {
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
          {friends.length === 1 ? `@${playing.handle} is listening` : `${friends.length} friends listening`}
        </span>
        <span className="peopleCard__blurb">
          {song?.playing
            ? `@${playing.handle} · ${song.title} — ${song.artist}${others > 0 ? ` · +${others}` : ''}`
            : 'Online now'}
        </span>
      </span>
    </button>
  );
}

/** A room a friend is hosting: who, what is on, how many are in. */
function JamCard({ jam, onJoin }: { jam: Jam; onJoin: () => void }) {
  const title = jam.trackTitle ? `${jam.trackTitle} — ${jam.trackArtist ?? ''}`.trim() : 'Nothing on yet';
  return (
    <button type="button" className="peopleCard" onClick={onJoin}>
      <span className="peopleCard__face peopleCard__face--jam" aria-hidden>
        <FriendAvatar handle={jam.hostName} size="lg" />
        <span className="peopleCard__glyph peopleCard__glyph--live">
          <Radio size={16} />
        </span>
      </span>
      <span className="peopleCard__text">
        <span className="peopleCard__title">{jam.hostName} is hosting a jam</span>
        <span className="peopleCard__blurb">
          {title}
          {jam.memberCount > 1 ? ` · ${jam.memberCount} listening` : ''}
        </span>
      </span>
    </button>
  );
}

/**
 * Music Date, as a door. The face is the deck itself - the sleeves of the
 * songs actually waiting - so the card is honest about being empty when
 * there is nothing to meet; with nothing waiting it wears the room's own art.
 */
function MusicDateCard({ waiting }: { waiting: { artwork: string | null }[] }) {
  const covers = useMemo(() => mosaicArts(waiting.map((t) => t.artwork), 4, 640), [waiting]);
  const n = waiting.length;
  return (
    <button type="button" className="peopleCard" onClick={openMusicDate} aria-label="Open Music Date">
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
        <span className="peopleCard__title">Music Date</span>
        <span className="peopleCard__blurb">
          {n > 0 ? `${n} waiting, art and sound, no names` : 'Meet what the collector found'}
        </span>
      </span>
    </button>
  );
}
