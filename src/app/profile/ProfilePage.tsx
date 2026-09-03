import { ArtistLink } from '../ux/ArtistLink.tsx';
import { Button, Heading, IconButton, Text } from '@glacier/react';
import { Camera, Copy, ImagePlus, LogOut, Trash2, Users } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJam } from '../player/jam.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { AccountSetup, FriendAvatar, FriendsSection } from './RegistryFriends.tsx';
import { FriendProfilePage } from './FriendProfilePage.tsx';
import { useSharing, setSharing } from './listeningShare.tsx';
import {
  removeProfileImage,
  uploadProfileImage,
  type RegistryFriend,
} from '../servers/registry.ts';
import { prepareImage, type ImageKind } from './pickImage.ts';
import { enterServer, remotePath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The Profile page: you, and everything social that hangs off you.
 *
 * It stands where Friends stood, because the friends were never the whole
 * story - they are one section of a person. The page stacks in the order the
 * layers actually depend on each other:
 *
 *   who you are        - the registry identity (or creating one),
 *   what is live       - jams happening right now, joinable this second,
 *   where you listen   - every server this device has entered, one tap to
 *                        switch, plus the two doors: invite a friend IN, or
 *                        join somewhere new yourself,
 *   who you know       - the friends graph.
 *
 * The server section is the page's real work. Sharing a hub used to hide
 * behind an Invite button inside a modal inside the friends header; joining
 * one appeared only while you had no server at all - so the two most asked
 * questions ("how do I get into my friend's server?", "how do I add another
 * one?") had answers the page never showed. Here they are cards, always.
 */

// --- live layer (moved whole from the old Friends page) ---------------------

/*
 * The code box and the nearby scan used to sit here.
 *
 * Both were doors INTO a jam, on the page about YOU, and both are answered
 * where a jam actually happens - the badge on the player, which is on screen
 * while the music is. A page about a person should not be a control panel for
 * a room.
 */

function LiveNow() {
  const { session } = useServerSession();
  const jam = useJam();
  const { tracks } = useLibrary();

  // What a room is playing, resolved against this device's own library - the
  // whole point of friends being on your server is that their now-playing is
  // your catalogue too.
  const trackOf = (trackId: number | null) =>
    trackId != null ? (tracks.find((t) => t.path === remotePath(trackId)) ?? null) : null;

  const liveRooms = jam.friendJams.filter((room) => room.id !== jam.current?.id);
  const currentTrack = jam.current ? trackOf(jam.current.trackId) : null;
  if (!session) return null;

  return (
    <>
      {(jam.current || liveRooms.length > 0) && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Live now</h2>

          {/* The room this listener is in: the one card on the page that is
              happening to THEM right now, so it reads as a place - cover art,
              a pulse, who is inside - rather than a row. */}
          {jam.current && (
            <div className="jamLive">
              {/* The song's cover when there is one; the Users glyph when there
                  is not. A room has no artwork of its own, and the station mark
                  said "AttackFM" where the honest answer is "several people" -
                  which is also the mark this feature wears on Now Playing, so
                  the two are recognisably the same thing. */}
              <span className="jamLive__art" aria-hidden>
                {currentTrack?.artwork ? (
                  <img src={currentTrack.artwork} alt="" />
                ) : (
                  <span className="jamArt__glyph">
                    <Users size={22} />
                  </span>
                )}
                <span className="jamLive__pulse" />
              </span>
              <span className="jamLive__body">
                <span className="jamLive__title">
                  {jam.hosting ? 'Your jam' : `${jam.current.hostName}'s jam`}
                </span>
                <span className="jamLive__song">
                  {currentTrack ? (
                    <>
                      {currentTrack.title} — <ArtistLink artist={currentTrack.artist} />
                    </>
                  ) : (
                    'Waiting for the first song'
                  )}
                </span>
                <span className="jamLive__meta">
                  {jam.current.memberCount === 1
                    ? 'Just you so far'
                    : `${jam.current.memberCount} listening`}
                  {jam.hosting ? ' · you set the pace' : ' · following along'}
                  {/* The code IS the invitation: read it out in a car, where
                      nobody shares your wifi and the person beside you may
                      not be in your friends list yet. */}
                  {jam.hosting && (
                    <button
                      type="button"
                      className="jamLive__code"
                      title="Copy the code"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(jam.current!.id.toUpperCase())
                          .catch(() => {});
                      }}
                    >
                      Code {jam.current.id.toUpperCase()}
                    </button>
                  )}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void jam.leave()}>
                Leave
              </Button>
            </div>
          )}

          {/* Friends' rooms: cards you can walk into, each wearing its host and
              whatever is on in there. */}
          {liveRooms.length > 0 && (
            <div className="jamRooms">
              {liveRooms.map((room) => {
                const playing = trackOf(room.trackId);
                return (
                  <div key={room.id} className="jamRoom">
                    <span className="jamRoom__art" aria-hidden>
                      {playing?.artwork ? (
                        <img src={playing.artwork} alt="" />
                      ) : (
                        <span className="jamArt__glyph">
                          <Users size={20} />
                        </span>
                      )}
                      <FriendAvatar handle={room.hostName} size="sm" className="jamRoom__host" />
                    </span>
                    <span className="jamRoom__name">{room.hostName}</span>
                    <span className="jamRoom__meta">
                      {playing ? playing.title : 'Listening'}
                      {` · ${room.memberCount} inside`}
                    </span>
                    <Button variant="solid" size="sm" onClick={() => void jam.join(room.id)}>
                      Join
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* No code box and no nearby scan below this any more. Both were doors
          INTO a jam, parked on the page about YOU, and both are answered where
          a jam actually happens - the badge on the player, which is on screen
          while the music is. A page about a person should not be a control
          panel for a room. */}
    </>
  );
}

/** The address as people say it - the host, no scheme. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

// --- the page ---------------------------------------------------------------

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return raw.trim() || 'That did not work.';
}

export function ProfilePage({
  onPlay,
  onOpenArtist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const { session, applySession } = useServerSession();
  const { session: registry, account, apply, signOut } = useRegistry();
  const sharing = useSharing();
  // A friend opened into their own profile - a takeover of the whole tab, the
  // way the stats room is. Held HERE, at the page, rather than inside the
  // friends grid, so it replaces the page instead of sitting in a section of
  // it. Friends live on Profile now: the grid used to be a tab of its own, and
  // by request it is folded back in under you, where it began.
  const [profileFor, setProfileFor] = useState<RegistryFriend | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  /*
   * The two pictures.
   *
   * A file input rather than anything cleverer: the OS picker already knows
   * the camera roll, and its change event is the gesture the upload rides on.
   * The value is cleared after each pick so choosing the same file twice still
   * fires. What lands on the registry is a downscaled JPEG (pickImage.ts) -
   * never the four-thousand-pixel original, and never its EXIF.
   */
  const fileInput = useRef<HTMLInputElement | null>(null);
  const wanted = useRef<ImageKind>('avatar');
  const [picking, setPicking] = useState<ImageKind | null>(null);
  // Same reason as the avatar's: a banner whose bytes have gone should leave
  // the card plain, not broken.
  const [bannerBroken, setBannerBroken] = useState(false);

  const pick = (kind: ImageKind) => {
    wanted.current = kind;
    fileInput.current?.click();
  };

  const chose = async (file: Blob) => {
    if (!registry) return;
    const kind = wanted.current;
    setPicking(kind);
    setNote(null);
    try {
      const small = await prepareImage(file, kind);
      const { url } = await uploadProfileImage(registry.token, kind, small);
      apply({ ...registry, [kind === 'avatar' ? 'avatarUrl' : 'bannerUrl']: url });
    } catch (err) {
      setNote({ tone: 'bad', text: messageOf(err) });
    } finally {
      setPicking(null);
    }
  };

  const clearImages = async () => {
    if (!registry) return;
    setPicking('avatar');
    setNote(null);
    try {
      await Promise.all([
        removeProfileImage(registry.token, 'avatar'),
        removeProfileImage(registry.token, 'banner'),
      ]);
      apply({ ...registry, avatarUrl: null, bannerUrl: null });
    } catch (err) {
      setNote({ tone: 'bad', text: messageOf(err) });
    } finally {
      setPicking(null);
    }
  };

  const visit = useCallback(
    async (url: string) => {
      if (!registry) return;
      setNote(null);
      try {
        const next = await enterServer(url.replace(/\/+$/, ''), registry.token);
        applySession(next);
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.` });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err) });
      }
    },
    [registry, applySession],
  );

  if (profileFor) {
    return (
      <FriendProfilePage
        friend={profileFor}
        onBack={() => setProfileFor(null)}
        onPlay={onPlay}
        onOpenArtist={onOpenArtist}
        onVisit={(f) => {
          if (f.serverUrl) void visit(f.serverUrl);
        }}
      />
    );
  }

  return (
    <div className="homePage profilePage">
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) void chose(file);
        }}
      />
      {registry && account ? (
        /*
         * The hero card: a band of your own picture, your face sitting ON it,
         * and your name under both.
         *
         * It was a row - a small round mark beside a handle, with the banner
         * washed behind the whole strip - and that is a list item, not a
         * profile. The banner is the card's top now and the face overlaps its
         * edge, which is the shape a person recognises as "this page is about
         * me" before reading a word of it. Both pictures are chosen from here:
         * the camera on the face, the corner button for the band.
         */
        <header className="profileHero">
          <div className="profileHero__cover" data-bannered={registry.bannerUrl && !bannerBroken ? '' : undefined}>
            {registry.bannerUrl && !bannerBroken && (
              <img
                className="profileHero__banner"
                src={registry.bannerUrl}
                alt=""
                aria-hidden
                onError={() => setBannerBroken(true)}
              />
            )}
            {/* On the band itself, where the thing it changes is. */}
            <span className="profileHero__coverTools">
              <IconButton
                variant="ghost"
                size="sm"
                className="profileHero__coverButton"
                aria-label={registry.bannerUrl ? 'Change your banner' : 'Add a banner'}
                title={registry.bannerUrl ? 'Change your banner' : 'Add a banner'}
                disabled={picking !== null}
                onClick={() => pick('banner')}
              >
                <ImagePlus size={16} />
              </IconButton>
              {(registry.bannerUrl || registry.avatarUrl) && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="profileHero__coverButton"
                  aria-label="Remove your pictures"
                  title="Remove your pictures"
                  disabled={picking !== null}
                  onClick={() => void clearImages()}
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            </span>
          </div>

          <button
            type="button"
            className="profileHero__faceButton"
            aria-label={registry.avatarUrl ? 'Change your picture' : 'Choose a picture'}
            disabled={picking !== null}
            onClick={() => pick('avatar')}
          >
            <FriendAvatar
              handle={account.handle}
              size="lg"
              className="profileHero__face"
              src={registry.avatarUrl}
            />
            <span className="profileHero__faceEdit" aria-hidden>
              <Camera size={14} />
            </span>
          </button>

          <span className="profileHero__body">
            <h1 className="profileHero__handle">@{account.handle}</h1>
            <span className="profileHero__caption">
              {session
                ? `Listening from ${hostOf(session.url)}${session.username ? ` as ${session.username}` : ''}`
                : 'Your account, on every server'}
            </span>
          </span>
        </header>
      ) : (
        <AccountSetup onDone={apply} />
      )}

      <LiveNow />

      {/* The people, folded back under you. Tapping a card opens that friend as
          a takeover (profileFor above); visiting their server is handled here
          so the answer lands next to the card that asked. */}
      {registry && account && (
        <section className="homeShelf profileFriends">
          <Heading level={2} noMargin className="homeShelfTitle">
            Friends
          </Heading>
          {note && (
            <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'}>
              {note.text}
            </Text>
          )}
          <FriendsSection
            token={registry.token}
            me={account.handle}
            onOpen={setProfileFor}
            onVisit={(friend) => {
              if (friend.serverUrl) void visit(friend.serverUrl);
            }}
          />
          <footer className="friendsPage__foot">
            <Text size="xs" tone="subtle">
              {sharing
                ? 'Friends on this server can open your full profile - your stats and your liked songs. Friends elsewhere see your minutes, top artist and streak for the week, nothing more.'
                : 'You are not sharing your listening, so your card is blank and your profile is a closed door.'}
            </Text>
            <button
              type="button"
              className="friendsPage__shareToggle"
              onClick={() => setSharing(!sharing)}
            >
              {sharing ? 'Stop sharing my listening' : 'Share my listening'}
            </button>
          </footer>
        </section>
      )}

      {/* The last thing on the page, and deliberately: signing out is the one
          control here you almost never want and would hate to hit by accident.
          It sat in the hero's corner, a thumb's width from the button that
          changes your picture. */}
      {registry && account && (
        <button type="button" className="profileSignOut" onClick={signOut}>
          <LogOut size={15} />
          <span>Sign out of @{account.handle}</span>
        </button>
      )}
    </div>
  );
}
