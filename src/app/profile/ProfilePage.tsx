import { ArtistLink } from '../ux/ArtistLink.tsx';
import { HomeStatsCards } from '../library/HomeStatsCards.tsx';
import { ShareProfileSheet } from './ShareProfile.tsx';
import { Button, Heading, IconButton, Text } from '@glacier/react';
import { Camera, Copy, Crop, ImagePlus, LogOut, Trash2, Users } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJam } from '../player/jam.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistry } from '../servers/registrySession.tsx';
import { AccountSetup, FriendAvatar, FriendsSection } from './RegistryFriends.tsx';
import { FriendProfilePage } from './FriendProfilePage.tsx';
import { useSharing, setSharing } from './listeningShare.tsx';
import { useOfferShare } from '../nav/shareDoor.ts';
import {
  removeProfileImage,
  uploadProfileImage,
  type RegistryFriend,
} from '../servers/registry.ts';
import { type ImageKind } from './pickImage.ts';
import { CropPhoto } from './CropPhoto.tsx';
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
      {/* Someone asked to listen along with you: answering here starts the room
          with your player as its clock, and drops them in. Its own block above
          Live now, because it is a question waiting on you rather than a place
          already happening. */}
      {jam.invites.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Asking to jam</h2>
          <div className="jamRooms">
            {jam.invites.map((inv) => {
              // 'jam' = they host and want you in; 'along' = they want to hear
              // what YOU are playing, so your yes makes your player the clock.
              const toJam = inv.kind === 'jam';
              return (
                <div key={`${inv.from}\n${inv.at}`} className="jamRoom jamRoom--invite">
                  <span className="jamRoom__art jamRoom__art--face" aria-hidden>
                    <FriendAvatar handle={inv.from} size="lg" />
                  </span>
                  <span className="jamRoom__name">{inv.from}</span>
                  <span className="jamRoom__meta">
                    {toJam ? 'invited you to jam' : 'wants to hear along with you'}
                  </span>
                  <span className="jamRoom__actions">
                    <Button variant="ghost" size="sm" onClick={() => void jam.declineInvite(inv.from)}>
                      Dismiss
                    </Button>
                    <Button variant="solid" size="sm" onClick={() => void jam.acceptInvite(inv.from)}>
                      {toJam ? 'Join' : 'Start'}
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

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
  onOpenStats,
}: {
  /** Opens This week - the strip under the hero is its door. */
  onOpenStats: () => void;
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
  /*
   * The page's one status line, and WHERE it is shown is half of it.
   *
   * It used to render only inside the Friends shelf, a long way down the page
   * from the buttons that pick a picture. So a picture that was refused said
   * so, correctly and in plain words, on a part of the screen nobody was
   * looking at - which reads exactly like nothing happening at all. `at` puts
   * each answer beside the control that asked the question.
   */
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string; at: 'pictures' | 'friends' } | null>(
    null,
  );

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
  // Mounted on first use: the sheet draws a card and re-encodes both pictures.
  const [sharingProfile, setSharingProfile] = useState(false);
  /*
   * Your profile IS what this page shares, so it takes over the header's share
   * button rather than adding a second one under your handle. Two share
   * affordances on one screen is a question the reader has to answer - which
   * one shares me? - and the header button is the one every other page has
   * already taught them. Left to the invite card until there is a registry
   * account to point at: with no handle there is no profile to hand over.
   */
  useOfferShare(
    registry && account
      ? { label: 'Share your profile', open: () => setSharingProfile(true) }
      : null,
  );

  const pick = (kind: ImageKind) => {
    wanted.current = kind;
    fileInput.current?.click();
  };

  /*
   * The chosen picture, on its way to being cropped.
   *
   * `owned` says whether the URL is an object URL this component made and must
   * revoke, or a registry URL being repositioned, which must NOT be revoked -
   * it is the picture the page is still displaying.
   */
  const [cropping, setCropping] = useState<{ src: string; kind: ImageKind; owned: boolean } | null>(
    null,
  );

  const closeCrop = useCallback(() => {
    setCropping((cur) => {
      if (cur?.owned) URL.revokeObjectURL(cur.src);
      return null;
    });
  }, []);

  // A file off the camera roll: straight into the cropper, not straight up.
  const chose = (file: Blob) => {
    setNote(null);
    setCropping({ src: URL.createObjectURL(file), kind: wanted.current, owned: true });
  };

  /** Move or resize the picture already in use, without going back to the
   *  camera roll for it. The registry serves these with an open CORS header,
   *  so it can be re-cut in a canvas here. */
  const reposition = (kind: ImageKind) => {
    const src = kind === 'avatar' ? registry?.avatarUrl : registry?.bannerUrl;
    if (!src) return;
    setNote(null);
    setCropping({ src, kind, owned: false });
  };

  const uploadCropped = async (blob: Blob) => {
    if (!registry || !cropping) return;
    const kind = cropping.kind;
    setPicking(kind);
    try {
      const { url } = await uploadProfileImage(registry.token, kind, blob);
      apply({ ...registry, [kind === 'avatar' ? 'avatarUrl' : 'bannerUrl']: url });
      if (kind === 'banner') setBannerBroken(false);
      closeCrop();
    } catch (err) {
      setNote({ tone: 'bad', text: messageOf(err), at: 'pictures' });
      closeCrop();
    } finally {
      setPicking(null);
    }
  };

  /** Take ONE of them off. It used to be a single button that removed both at
   *  once, which is not a thing anybody wants: a banner you have gone off does
   *  not mean you have gone off your own face. */
  const removeImage = async (kind: ImageKind) => {
    if (!registry) return;
    setPicking(kind);
    setNote(null);
    try {
      await removeProfileImage(registry.token, kind);
      apply({ ...registry, [kind === 'avatar' ? 'avatarUrl' : 'bannerUrl']: null });
      if (kind === 'banner') setBannerBroken(false);
    } catch (err) {
      setNote({ tone: 'bad', text: messageOf(err), at: 'pictures' });
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
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.`, at: 'friends' });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err), at: 'friends' });
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
      {/*
       * `image/*` rather than a list of formats, and the difference is the
       * whole feature on a phone.
       *
       * iOS turns an accept list into UTTypes and filters the photo picker to
       * them. A list of jpeg/png/webp does not contain HEIC - which is what
       * every iPhone camera has written by default since 2017 - so the picker
       * opened onto a library with the photographs greyed out and only
       * screenshots (PNG) selectable. It looked like the picker was broken;
       * it was doing exactly what it had been told.
       *
       * `image/*` shows the whole library and lets iOS hand over a JPEG
       * transcode of a HEIC, which costs us nothing: everything here is
       * re-encoded to JPEG on the way out anyway (pickImage.ts). Anything the
       * browser cannot decode is caught there and said out loud.
       */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) void chose(file);
        }}
      />
      {cropping && (
        <CropPhoto
          src={cropping.src}
          kind={cropping.kind}
          busy={picking !== null}
          onCancel={closeCrop}
          onDone={(blob) => void uploadCropped(blob)}
        />
      )}
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
            {/* On the band itself, where the thing it changes is. Three verbs
                rather than two, because "change" and "remove" were never the
                whole set: most of the time what you want is the picture you
                already chose, an inch to the left. */}
            <span className="profileHero__coverTools">
              {registry.bannerUrl && !bannerBroken && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="profileHero__coverButton"
                  aria-label="Reposition your banner"
                  title="Reposition your banner"
                  disabled={picking !== null}
                  onClick={() => reposition('banner')}
                >
                  <Crop size={16} />
                </IconButton>
              )}
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
              {registry.bannerUrl && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="profileHero__coverButton"
                  aria-label="Remove your banner"
                  title="Remove your banner"
                  disabled={picking !== null}
                  onClick={() => void removeImage('banner')}
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

          {/* The face's own two verbs, beside it rather than on it: the circle
              is small and already means "choose a photo", so stacking a delete
              onto it would be two targets a thumb cannot tell apart. Shown only
              when there is a picture to act on. */}
          {registry.avatarUrl && (
            <span className="profileHero__faceTools">
              <IconButton
                variant="ghost"
                size="sm"
                className="profileHero__coverButton"
                aria-label="Reposition your picture"
                title="Reposition your picture"
                disabled={picking !== null}
                onClick={() => reposition('avatar')}
              >
                <Crop size={16} />
              </IconButton>
              <IconButton
                variant="ghost"
                size="sm"
                className="profileHero__coverButton"
                aria-label="Remove your picture"
                title="Remove your picture"
                disabled={picking !== null}
                onClick={() => void removeImage('avatar')}
              >
                <Trash2 size={16} />
              </IconButton>
            </span>
          )}

          <span className="profileHero__body">
            <h1 className="profileHero__handle">@{account.handle}</h1>
            {/* Beside the buttons that caused it. A picture refused for its
                format or its size is the one failure on this page a person is
                actively waiting on. */}
            {note?.at === 'pictures' && (
              <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'} className="profileHero__note">
                {note.text}
              </Text>
            )}
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

      {/*
        Your week, directly under your face.

        It lived on the Library, which is a page about the MUSIC - and a strip
        of your own minutes and your own streak is not about the music, it is
        about you. Here it sits on the page that already is, one line under the
        name it belongs to, and it is the door into the full stats room that
        the removed "This week" badge used to be. Self-sufficient as ever: no
        week to speak of and it draws nothing at all, so the profile does not
        open on a strip of zeros.
      */}
      <HomeStatsCards onOpenStats={onOpenStats} />

      <LiveNow />

      {/* The people, folded back under you. Tapping a card opens that friend as
          a takeover (profileFor above); visiting their server is handled here
          so the answer lands next to the card that asked. */}
      {registry && account && (
        <section className="homeShelf profileFriends">
          <Heading level={2} noMargin className="homeShelfTitle">
            Friends
          </Heading>
          {note?.at === 'friends' && (
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
      {registry && account && sharingProfile && (
        <ShareProfileSheet
          handle={account.handle}
          avatarUrl={registry.avatarUrl ?? null}
          bannerUrl={registry.bannerUrl ?? null}
          open={sharingProfile}
          onClose={() => setSharingProfile(false)}
        />
      )}

      {registry && account && (
        <button type="button" className="profileSignOut" onClick={signOut}>
          <LogOut size={15} />
          <span>Sign out of @{account.handle}</span>
        </button>
      )}
    </div>
  );
}
