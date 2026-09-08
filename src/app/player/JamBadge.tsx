import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { IconButton, Popover, Text, useToast } from '@glacier/react';
import {
  Check,
  Clock,
  Copy,
  Crown,
  Hourglass,
  KeyRound,
  LogOut,
  Music,
  Pause,
  Power,
  QrCode,
  Radio,
  Share2,
  Smartphone,
  Speaker,
  UserPlus,
  Users,
  Waves,
  Wifi,
  X,
} from '@glacier/icons';
import { useJamOptional, type PendingAdd } from './jam.tsx';
import { hostWaiting } from './hostQuiet.ts';
import type { HearMode } from './deckShared.ts';
import { onGrooveArm, takeGrooveArm } from '../nav/grooveDoor.ts';
import { openFriendPicker } from '../nav/friendPickerDoor.ts';
import { openGrooveCode } from './grooveEntry.ts';
import { nowPlayingDoorOpen } from '../nav/nowPlayingDoor.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { publishJamShare } from '../servers/registry.ts';
import { ShareJamSheet } from './ShareJam.tsx';
import { hostOf, jamQrDataUrl } from './jamShare.ts';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { useLibrary } from '../library/library.tsx';
import { useRoomTrack, useRoomTracks } from './roomTrack.ts';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatAgo, formatLocale, formatNumber, formatTotal } from '../ux/format.ts';
import { artSized, trackIdFromPath, type Jam, type JamPerson } from '../server.ts';
import type { ServerSession } from '../api/http.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The groove, at the decks.
 *
 * Who else is hearing this, on the screen where you are hearing it - and now
 * the whole room at a glance, built the way the DJ's seat beside it is: a
 * deck of cards at popover scale, art first. In a room the hero wears the
 * song's sleeve with the members' faces stacked on it and a live pulse; the
 * song on now, the room's queue with the guests' waiting adds ahead of it,
 * the people with their standing, the code and a QR to hand the room on,
 * and the way out. Out of a room: one tap to start, the asks waiting on you,
 * and your friends' rooms as doors.
 *
 * Nothing here fetches on its own beyond the link the room is shared by
 * (minted once per room, the same link the share sheet mints, and only once
 * the panel is open) - the provider polls the room, the library holds the
 * sleeves, and the QR is drawn from the link in hand.
 *
 * THE GLYPH IS THE POINT. A groove has no artwork of its own - what is on the
 * screen belongs to the song, not to the room - so the trigger keeps the
 * `Users` mark this feature wears everywhere, with the count on it.
 *
 * Two seats. The sheet's action row is the one the phone has; the wide strip
 * carries its own, since it has no sheet to lift. A landing (jam.tsx) opens
 * whichever is the right one through nav/grooveDoor: the sheet's takes the
 * arm as it mounts, the strip's only on a shape with no sheet coming - so
 * one join opens one deck, on the surface that was raised for it.
 */

/** How recently a member's device must have polled to be "listening". The
 *  poll runs every three seconds in a room, eight when hidden; ninety is a
 *  phone left in a bag, not a slow network. */
const FRESH_MS = 90_000;

/** How many faces the hero stacks before it counts the rest. */
const FACES = 4;

/** A stable empty line-up, so a room with no queue keys the same each render. */
const NO_IDS: number[] = [];

// --- time and lists, in words ----------------------------------------------

/**
 * A span of hub time, coarse on purpose: nobody wants seconds here. `null`
 * under a minute so the caller can say "just now" its own way.
 *
 * The UNITS come from Intl rather than this file: "min", "h" and "d" are
 * English, and a locale decides not only how it spells them but which side of
 * the number they sit on.
 */
function spanWords(ms: number): string | null {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return null;
  // Inside a day the house running-time formatter already says it ("5 min",
  // "1 hr 20 min"); past that it would go on counting hours.
  if (m < 24 * 60) return formatTotal(m * 60);
  return formatNumber(Math.floor(m / (24 * 60)), {
    style: 'unit',
    unit: 'day',
    unitDisplay: 'short',
  });
}

/** How long ago something happened, at the same coarseness: anything inside
 *  the last minute reads as "now" rather than as a count of seconds. */
function agoWords(at: number, now: number): string {
  return formatAgo(now - at < 60_000 ? now : at, now);
}

/** Names in a line, the way this language lists things - the separator is
 *  language too, and Arabic does not spell it ", ". */
function sayNames(names: string[]): string {
  try {
    return new Intl.ListFormat(formatLocale(), { style: 'short', type: 'unit' }).format(names);
  } catch {
    // An engine without ListFormat still has to say something.
    return names.join(', ');
  }
}

/** The hub's clock as of this read: `now` and every stamp on the room are
 *  the hub's, so two phones with different ideas of the time agree. */
function hubNow(room: Jam): number {
  return room.now ?? room.receivedAt ?? Date.now();
}

/** Who is here, in words - the names when there are few enough to say.
 *  Each shape is its own entry rather than a list built with "and": the word
 *  before the last name, and whether "you" comes first at all, are decisions
 *  a language makes, not this function. */
function whoIsHere(
  t: ReturnType<typeof useT>,
  names: string[],
  me: string,
  count: number,
): string {
  const others = names.filter((n) => n.toLowerCase() !== me.toLowerCase());
  if (count <= 1) return t('player.grooveJustYou');
  if (count === 2 && others.length === 1) return t('player.grooveYouAnd', { name: others[0] });
  if (count === 3 && others.length === 2) {
    return t('player.grooveYouAndTwo', { first: others[0], second: others[1] });
  }
  return t('player.grooveListeningCount', { count });
}

/** The room's people with their standing, or - from an older hub that only
 *  names them - the names alone, with no standing to show. */
function peopleOf(room: Jam): JamPerson[] {
  if (room.people && room.people.length > 0) return room.people;
  return room.members.map((name, i) => ({
    id: i,
    name,
    joinedAt: 0,
    seenAt: 0,
    host: name.toLowerCase() === room.hostName.toLowerCase(),
  }));
}

// --- the link, once per room -----------------------------------------------

const linkByRoom = new Map<string, string>();
const qrByLink = new Map<string, string>();

/**
 * The room's link, as the share sheet mints it (the registry hands back the
 * same code for a room this account has already shared, so the sheet and the
 * deck agree). Asked for once per room, and only while the panel is open;
 * without a registry account it stays null and the QR stays quiet.
 */
function useJamLink(
  jamId: string | null,
  token: string | null,
  session: ServerSession | null,
  open: boolean,
): string | null {
  const [link, setLink] = useState<string | null>(jamId ? (linkByRoom.get(jamId) ?? null) : null);
  useEffect(() => {
    if (!jamId) {
      setLink(null);
      return;
    }
    const hit = linkByRoom.get(jamId);
    if (hit) {
      setLink(hit);
      return;
    }
    setLink(null);
    if (!open || !token || !session) return;
    let live = true;
    void publishJamShare(token, { jamId, hubUrl: session.url, hubName: hostOf(session.url) })
      .then((out) => {
        linkByRoom.set(jamId, out.url);
        if (live) setLink(out.url);
      })
      .catch(() => {
        // No link is a card with a code on it, which still works; the share
        // sheet says why when it is opened.
      });
    return () => {
      live = false;
    };
  }, [jamId, token, session, open]);
  return link;
}

/** The link as a QR, drawn from the link in hand; `null` until there is one. */
function useQr(link: string | null): string | null {
  const [qr, setQr] = useState<string | null>(link ? (qrByLink.get(link) ?? null) : null);
  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    const hit = qrByLink.get(link);
    if (hit) {
      setQr(hit);
      return;
    }
    let live = true;
    void jamQrDataUrl(link, 192)
      .then((url) => {
        qrByLink.set(link, url);
        if (live) setQr(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [link]);
  return qr;
}

// --- pieces ----------------------------------------------------------------

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="jamDeck__section" role="group" aria-label={label}>
      <span className="jamDeck__label" aria-hidden>
        {label}
      </span>
      {children}
    </div>
  );
}

/** A sleeve, or the disc that stands in when the library lacks the song. */
function Sleeve({ src, className, glyph = 18 }: { src: string | null; className: string; glyph?: number }) {
  if (src) return <img className={className} src={src} alt="" loading="lazy" decoding="async" />;
  return (
    <span className={`${className} ${className}--blank`} aria-hidden>
      <Music size={glyph} />
    </span>
  );
}

/** The sleeve as a wash behind a card: blurred to a colour, under the text. */
function Wash({ src }: { src: string | null }) {
  if (!src) return null;
  return (
    <span className="jamCard__wash" aria-hidden>
      <img src={src} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

// --- the badge -------------------------------------------------------------

export function JamBadge({ seat = 'sheet' }: { seat?: 'sheet' | 'strip' } = {}) {
  const jam = useJamOptional();
  const { session } = useServerSession();
  const registry = useRegistryOptional();
  const { tracks, forYou } = useLibrary();
  const { track: playing } = useNowPlayingMotion();
  const { toast } = useToast();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Mounted on first use: the sheet mints a link and draws a card, and this
  // component is in the transport row of every screen.
  const [sharing, setSharing] = useState(false);

  /*
   * The landing's arm. Taken on mount (the sheet was lifted for exactly
   * this, and this deck mounted with it) and again if it is armed while
   * already standing. The strip's seat waits a beat and stands down when a
   * sheet is there to lift, so a sheet mounting a frame later gets its turn
   * first. Taking clears the arm; a stale one (five seconds) is nothing.
   *
   * The sheet's seat waits out the sheet's own rise (npRise, 0.28 s) before
   * opening. The popover positions itself against its trigger ONCE, as it
   * opens, and a trigger still riding up from below the screen put the
   * panel a whole screen too low - open, and nowhere to be seen.
   */
  useEffect(() => {
    let timer = 0;
    const take = () => {
      if (seat === 'strip' && nowPlayingDoorOpen()) return;
      if (takeGrooveArm()) setOpen(true);
    };
    const claim = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(take, seat === 'sheet' ? 340 : 120);
    };
    claim();
    const off = onGrooveArm(claim);
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [seat]);

  const room = jam?.current ?? null;
  const hosting = !!jam?.hosting;
  const token = registry?.session?.token ?? null;
  const link = useJamLink(room?.id ?? null, token, session, open);
  const qr = useQr(link);

  // The library by server id, for the sleeves the room names.
  const byId = useMemo(() => {
    const m = new Map<number, Track>();
    for (const t of [...tracks, ...forYou]) {
      const id = trackIdFromPath(t.path);
      if (id != null && !m.has(id)) m.set(id, t);
    }
    return m;
  }, [tracks, forYou]);
  // The room's song and its line-up where this library lacks them: asked of
  // the hub, once, and shared with the strip and the follow seam
  // (roomTrack.ts). A song promoted for the host alone is on this hub, just
  // not on this shelf - so the hero and NOW wear its sleeve rather than a
  // disc by name. Hooks, so they stand above the returns below; a room the
  // library lists costs nothing here.
  const roomNow = useRoomTrack(jam?.current?.trackId ?? null);
  const roomLine = useRoomTracks(jam?.current?.queue ?? NO_IDS);

  // No provider (a build without grooves) or nobody signed in: a groove is a
  // thing that happens on a server, so without one there is nothing to offer.
  if (!jam || !session) return null;

  const me = session.username;

  /*
   * OUT of a room, and the button is still here.
   *
   * The panel does the three things you can do from outside a room: open
   * one, answer a friend who asked you in, or walk into a friend's.
   */
  if (!room) {
    // Friends' rooms, and the nearby ones hosted by people who are not
    // friends - on this network is reason enough to be offered the door.
    const joinable = jam.liveJams;
    const invites = jam.invites;
    const playingArt = playing && playing.kind !== 'book' ? artSized(playing.artwork, 160) : null;
    const startJam = async () => {
      if (busy) return;
      setBusy(true);
      setFailed(false);
      try {
        await jam.start();
      } catch {
        // An older server has no groove endpoint, and start() would otherwise
        // fail silently - a button that does nothing and says nothing is worse
        // than one that admits it.
        setFailed(true);
      } finally {
        setBusy(false);
      }
    };
    const join = async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await jam.join(id);
      } finally {
        setBusy(false);
      }
    };
    const answer = async (from: string, yes: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        if (yes) await jam.acceptInvite(from);
        else await jam.declineInvite(from);
      } finally {
        setBusy(false);
      }
    };
    const title =
      playing && playing.kind !== 'book'
        ? t('player.grooveToSong', { title: playing.title })
        : t('player.grooveListenTogether');
    const blurb = t('player.grooveStartBlurb');
    // Start WITH people: the picker first (hoisted, so the panel may close
    // under it), then the room, then everyone asked - one toast for the lot.
    const startWith = async () => {
      const pick = await openFriendPicker({
        title: t('player.grooveStartWithTitle'),
        hint: t('player.grooveStartWithHint'),
        mode: 'groove',
        // The picker asks with 0 too, for the disabled button.
        action: (n) => (n ? t('player.grooveStartWithCount', { count: n }) : t('player.grooveStartConfirm')),
      });
      if (!pick || pick.people.length === 0 || busy) return;
      setBusy(true);
      setFailed(false);
      try {
        await jam.jamWithAll(pick.people.map((p) => p.handle));
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Popover
        placement="top-end"
        aria-label={t('player.grooveStart')}
        className="popoverSheet jamPanel"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <IconButton variant="ghost" size="sm" className="jamTrigger" aria-label={t('player.grooveStart')}>
            <Users size={16} />
          </IconButton>
        }
      >
        <div className="jamPanel__body jamDeck">
          {/* 7. Start: art-first with what is playing, one tap to open the room. */}
          <button
            type="button"
            className="jamCard jamHero jamHero--start"
            aria-label={
              busy ? t('player.grooveStarting') : t('player.grooveStartAria', { title, blurb })
            }
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={() => void startJam()}
          >
            <Wash src={playingArt} />
            <span className="jamHero__face" aria-hidden>
              {playingArt ? (
                <img className="jamHero__art" src={playingArt} alt="" />
              ) : (
                <span className="jamHero__art jamHero__art--blank">
                  <Users size={26} />
                </span>
              )}
            </span>
            <span className="jamHero__text">
              <span className="jamHero__eyebrow">
                <Users size={12} aria-hidden />
                {t('player.grooveStart')}
              </span>
              <span className="jamHero__title">{title}</span>
              <span className="jamHero__blurb" role={busy ? 'status' : undefined}>
                {busy ? t('player.grooveOpeningRoom') : blurb}
              </span>
            </span>
            <span className="jamHero__go" aria-hidden>
              <Radio size={18} />
            </span>
          </button>
          {failed && (
            <Text tone="danger" size="xs">
              {t('player.grooveStartFailed')}
            </Text>
          )}

          {/* 7a. Start with friends: pick who first, then the room opens and
              they are asked in. The picker is hoisted (nav/friendPickerDoor)
              for the same reason the code sheet is. */}
          <button
            type="button"
            className="jamCard jamCodeDoor jamStartWith"
            aria-label={t('player.grooveStartWithAria')}
            disabled={busy}
            onClick={() => {
              setOpen(false);
              void startWith();
            }}
          >
            <span className="jamCodeDoor__glyph" aria-hidden>
              <UserPlus size={16} />
            </span>
            <span className="jamCodeDoor__text">
              <span className="jamCodeDoor__title">{t('player.grooveStartWithLabel')}</span>
              <span className="jamCodeDoor__sub">{t('player.grooveStartWithSub')}</span>
            </span>
          </button>

          {/* 7b. Have a code? A friend's deck prints one and a link's page
              prints one; this is where either gets typed. The sheet itself is
              hoisted to app level (JoinGrooveSheet): the panel dismisses on
              this tap, and a sheet rendered inside it would go with it. */}
          <button
            type="button"
            className="jamCard jamCodeDoor"
            aria-label={t('player.grooveCodeDoorAria')}
            onClick={() => {
              setOpen(false);
              openGrooveCode();
            }}
          >
            <span className="jamCodeDoor__glyph" aria-hidden>
              <KeyRound size={16} />
            </span>
            <span className="jamCodeDoor__text">
              <span className="jamCodeDoor__title">{t('player.grooveHaveCode')}</span>
              <span className="jamCodeDoor__sub">{t('player.grooveHaveCodeSub')}</span>
            </span>
          </button>

          {/* 8. Asks: friends waiting on an answer from you. */}
          {invites.length > 0 && (
            <Section label={t('player.grooveInvites')}>
              {invites.map((inv) => {
                const line =
                  inv.kind === 'jam'
                    ? t('player.grooveInviteJam', { who: inv.from })
                    : t('player.grooveInviteListen', { who: inv.from });
                // How long they have been waiting, on this device's clock
                // against the hub's stamp - close enough for minutes, and
                // left unsaid past a day, when the ask is stale anyway.
                const waited = Date.now() - inv.at;
                const when = waited < 86_400_000 ? agoWords(inv.at, Date.now()) : null;
                // Which pace applies, and how long they have waited, as ONE
                // entry: the two are separate thoughts joined by a middot in
                // English, and a language may want them the other way round.
                const pace =
                  inv.kind === 'jam' ? t('player.grooveTheirPace') : t('player.grooveYourPace');
                return (
                  <div key={`${inv.from}-${inv.at}`} className="jamCard jamAsk" role="group" aria-label={line}>
                    <span className="jamAsk__head">
                      <FriendAvatar handle={inv.from} size="md" />
                      <span className="jamAsk__text">
                        <span className="jamAsk__line">{line}</span>
                        <span className="jamAsk__when">
                          {when ? t('player.grooveAskWhen', { pace, when }) : pace}
                        </span>
                      </span>
                    </span>
                    <span className="jamActions">
                      <button
                        type="button"
                        className="jamAction jamAction--yes"
                        aria-label={
                          inv.kind === 'jam'
                            ? t('player.grooveAcceptJamAria', { who: inv.from })
                            : t('player.grooveAcceptListenAria', { who: inv.from })
                        }
                        disabled={busy}
                        onClick={() => void answer(inv.from, true)}
                      >
                        <Check size={16} aria-hidden />
                        {t('player.grooveAccept')}
                      </button>
                      <button
                        type="button"
                        className="jamAction"
                        aria-label={t('player.grooveDeclineAria', { who: inv.from })}
                        disabled={busy}
                        onClick={() => void answer(inv.from, false)}
                      >
                        <X size={16} aria-hidden />
                        {t('player.grooveDecline')}
                      </button>
                    </span>
                  </div>
                );
              })}
            </Section>
          )}

          {/* 9. Live now: friends' and nearby rooms as doors, the whole card
              the Join. A room on this network wears the network mark. */}
          {joinable.length > 0 && (
            <Section label={t('player.grooveLiveNow')}>
              <EdgeScrollRow className="jamDoors">
                {joinable.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="jamCard jamDoor"
                    aria-label={t('player.grooveJoinAria', { host: r.hostName })}
                    disabled={busy}
                    onClick={() => void join(r.id)}
                  >
                    <span className="jamDoor__head" aria-hidden>
                      <FriendAvatar handle={r.hostName} size="md" />
                      <span className="jamPulse" />
                    </span>
                    <span className="jamDoor__name">
                      {t('player.hostGroove', { host: r.hostName })}
                    </span>
                    {/* One entry, not a `> 1` ternary: "Alone so far" IS the
                        one-form of "N inside", and which counts get their own
                        wording is a decision the plural rules make - English
                        splits at one, Arabic at six places, Japanese nowhere. */}
                    <span className="jamDoor__meta">
                      {t('player.grooveInside', { count: r.memberCount })}
                    </span>
                    {r.nearby && (
                      /* The tooltip and the chip say the same thing at
                         different weights - a chip in a line of chips is
                         lower case in English, and which case a language
                         wants where is not something one entry can hold. */
                      <span className="jamNearby" title={t('player.grooveNearbyTitle')}>
                        <Wifi size={11} aria-hidden />
                        <span>{t('player.onYourNetwork')}</span>
                      </span>
                    )}
                    {r.trackTitle && (
                      <span className="jamDoor__song">
                        <Music size={11} aria-hidden />
                        <span>{r.trackTitle}</span>
                      </span>
                    )}
                  </button>
                ))}
              </EdgeScrollRow>
            </Section>
          )}
        </div>
      </Popover>
    );
  }

  // --- IN a room -----------------------------------------------------------

  const now = hubNow(room);
  const people = peopleOf(room);
  const others = Math.max(0, room.memberCount - 1);
  const quiet = !hosting && (room.hostQuiet === true || hostWaiting(room));
  const code = room.id.toUpperCase();

  // The song on: the hub's name for it, or the row's - this library's, or
  // the one the hub handed over for the room - or nothing.
  const onTrack = room.trackId != null ? (byId.get(room.trackId) ?? roomNow ?? undefined) : undefined;
  const nowTitle = room.trackTitle ?? onTrack?.title ?? null;
  const nowArtist = room.trackArtist ?? onTrack?.artist ?? null;
  const nowArt = onTrack ? artSized(onTrack.artwork, 160) : null;
  const nowBy = room.trackId != null ? room.addedBy?.[String(room.trackId)] : undefined;
  // The song on, said three ways. Each layer is a whole entry with named
  // holes rather than a fragment glued on, so "by" and ", added by" can move
  // to wherever a language puts them - Japanese puts both before the title.
  const nowState = room.playing ? t('player.groovePlaying') : t('player.groovePaused');
  const nowSong = nowArtist
    ? t('player.grooveSongByArtist', { title: nowTitle, artist: nowArtist })
    : (nowTitle ?? '');
  const nowAriaBase = t('player.grooveNowAria', { state: nowState, line: nowSong });
  const nowAria = nowBy
    ? t('player.grooveAddedByAria', { line: nowAriaBase, who: nowBy })
    : nowAriaBase;
  // The line under the title: the artist, and who put the song in. Two
  // independent facts, not a sentence - hence the middot rather than a key.
  const nowSub = [nowArtist, nowBy ? t('player.grooveAddedBy', { who: nowBy }) : null]
    .filter(Boolean)
    .join(' · ');

  // The queue, and the adds still waiting on the host's player - the
  // provider's list either way (the room's own rows for the host, none of
  // them withdrawable from here; a follower's own sends marked as such).
  const queue = room.queue.slice(0, 6);
  const pend: PendingAdd[] = jam.pending;
  // Your own name in this list is "you", lower case: it sits among other
  // people's names rather than starting a sentence, which is why it is not
  // common.you.
  const pendNames = [...new Set(pend.map((p) => (p.mine ? t('player.grooveYouInList') : p.by)))];
  const mine = pend.filter((p) => p.mine);
  // One sentence with three holes in it, and the same one the screen reader
  // gets: it used to be built twice, with a colon in the label and a dash on
  // screen, which is two entries to translate for one thing to say.
  const pendingLine = t('player.groovePending', {
    count: pend.length,
    where: hosting ? t('player.grooveWaitingOnYou') : t('player.grooveWaitingOnHost'),
    names: sayNames(pendNames),
  });

  // The most recent thing that happened, said once under the people.
  const events = [...(room.events ?? [])].sort((a, b) => b.at - a.at).slice(0, 2);
  const eventsLine = events
    .map((e) => {
      const when = agoWords(e.at, now);
      return e.kind === 'joined'
        ? t('player.grooveEventJoined', { who: e.who, when })
        : e.kind === 'left'
          ? t('player.grooveEventLeft', { who: e.who, when })
          : e.kind === 'host'
            ? t('player.grooveEventHost', { who: e.who, when })
            : // A kind this build has no words for. The hub's own word for it
              // goes through untranslated - it is a wire value, not prose -
              // but the line around it can still be put in order.
              t('player.grooveEventOther', { who: e.who, what: e.kind, when });
    })
    .join(' · ');

  // The hero's words.
  const eyebrow = hosting ? t('player.yourGroove') : t('player.hostGroove', { host: room.hostName });
  const title = whoIsHere(
    t,
    people.map((p) => p.name),
    me,
    room.memberCount,
  );
  const going = room.createdAt ? spanWords(now - room.createdAt) : null;
  // Where a follower hears it, on the hero's line and on its own card below.
  // Lower case and its own entry: these read mid-line here, where the cards
  // below open with them, so they are not player.onThisDevice.
  const hear: HearMode | null = hosting ? null : (jam.hear ?? 'device');
  const hearWords =
    hear === 'speaker'
      ? t('player.grooveOnHostSpeaker', { host: room.hostName })
      : t('player.grooveOnThisDevice');
  const pace = hosting
    ? t('player.grooveYouSetPace')
    : t('player.hostSetsPace', { host: room.hostName });
  // Not a sentence: two or three independent phrases the eye reads as a list,
  // each its own entry so a translator moves the words INSIDE one. The middot
  // between them is punctuation, and stays here.
  const blurbParts = [pace];
  if (hear) blurbParts.push(hearWords);
  blurbParts.push(going ? t('player.grooveGoing', { span: going }) : t('player.grooveJustStarted'));
  const blurb = quiet ? t('player.grooveQuietBlurb') : blurbParts.join(' · ');
  const faces = people.slice(0, FACES);
  const extraFaces = Math.max(0, people.length - FACES);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ message: t('player.grooveCodeIs', { code }) });
    }
  };
  const share = () => {
    // The sheet is a sibling of the popover (see below); shut the panel so
    // the two are never stacked, then raise the sheet.
    setOpen(false);
    setSharing(true);
  };
  // Anyone in the room may pass it on: the picker (hoisted) with the room's
  // people left out, then one 'jam' invite each and one toast for the lot.
  const inviteFriends = () => {
    setOpen(false);
    void openFriendPicker({
      title: t('player.grooveInviteFriends'),
      hint: hosting
        ? t('player.grooveIntoYourGroove')
        : t('player.grooveIntoHostGroove', { host: room.hostName }),
      mode: 'groove',
      exclude: people.map((p) => p.name),
      action: (n) => (n ? t('player.grooveInviteCount', { count: n }) : t('player.grooveInvite')),
    }).then((pick) => {
      if (pick && pick.people.length) void jam.inviteAll(pick.people.map((p) => p.handle), 'jam');
    });
  };

  const trigName = hosting
    ? t('player.grooveTriggerHosting', { count: room.memberCount })
    : t('player.grooveTriggerFollowing', { host: room.hostName, count: room.memberCount });

  return (
    <>
      <Popover
        placement="top-end"
        aria-label={trigName}
        className="popoverSheet jamPanel"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <IconButton
            variant="ghost"
            size="sm"
            className="jamTrigger"
            // Hosting reads differently from following: one is your room, the
            // other is somebody else's. Same glyph, different weight.
            data-hosting={hosting || undefined}
            aria-label={trigName}
          >
            <Users size={16} />
            {/* The count sits on the glyph rather than beside it, so the row's
                rhythm is unchanged whether or not a groove is on. */}
            {room.memberCount > 1 && (
              <span className="jamTrigger__count" aria-hidden>
                {formatNumber(room.memberCount)}
              </span>
            )}
          </IconButton>
        }
      >
        <div className="jamPanel__body jamDeck" data-quiet={quiet || undefined}>
          {/* 1. The room: the song's sleeve as its face, the people on it. */}
          <div
            className="jamCard jamHero"
            role="group"
            aria-label={t('player.grooveHeroAria', { eyebrow, title, blurb })}
          >
            <Wash src={nowArt} />
            <span className="jamHero__face" aria-hidden>
              <Sleeve src={nowArt} className="jamHero__art" glyph={26} />
              <span className="jamHero__faces">
                {faces.map((p) => (
                  <FriendAvatar key={p.id} handle={p.name} size="sm" className="jamHero__avatar" />
                ))}
                {extraFaces > 0 && <span className="jamHero__more">+{formatNumber(extraFaces)}</span>}
              </span>
              <span className="jamPulse jamHero__pulse" data-quiet={quiet || undefined} />
            </span>
            <span className="jamHero__text">
              <span className="jamHero__eyebrow">
                {hosting ? <Crown size={12} aria-hidden /> : <Users size={12} aria-hidden />}
                {eyebrow}
              </span>
              <span className="jamHero__title">{title}</span>
              <span className="jamHero__blurb" data-quiet={quiet || undefined}>
                {quiet && <Hourglass size={12} aria-hidden />}
                {blurb}
              </span>
            </span>
          </div>

          {/* 2. Now: what the room is hearing, by name - the one line a member
              whose library lacks the song still gets. */}
          {nowTitle && (
            <Section label={t('player.grooveNow')}>
              <div className="jamCard jamNow" role="group" aria-label={nowAria}>
                <Wash src={nowArt} />
                <Sleeve src={nowArt} className="jamNow__art" />
                <span className="jamNow__text">
                  <span className="jamNow__eyebrow">{nowState}</span>
                  <span className="jamNow__title">{nowTitle}</span>
                  <span className="jamNow__sub">{nowSub}</span>
                </span>
                <span className="jamNow__state" data-playing={room.playing || undefined} aria-hidden>
                  {room.playing ? <Waves size={16} /> : <Pause size={16} />}
                </span>
              </div>
            </Section>
          )}

          {/* 2b. Hearing it on: a follower's seat - this deck, in time with
              the room, or the host's speaker with this phone quiet. Switches
              at once (PlayerHost reads the choice) and is remembered for
              this room. A host hears their own deck and sees no card. */}
          {hear && (
            <Section label={t('player.grooveHearingOn')}>
              <div className="jamHear" role="radiogroup" aria-label={t('player.grooveHearAria')}>
                <button
                  type="button"
                  role="radio"
                  className="jamCard jamHear__option"
                  aria-checked={hear === 'device'}
                  data-on={hear === 'device' || undefined}
                  onClick={() => jam.setHear('device')}
                >
                  <span className="jamHear__disc" aria-hidden>
                    <Smartphone size={18} />
                  </span>
                  <span className="jamHear__text">
                    <span className="jamHear__name">{t('player.grooveHearDevice')}</span>
                    <span className="jamHear__sub">{t('player.grooveHearDeviceSub')}</span>
                  </span>
                  {hear === 'device' && <Check className="jamHear__check" size={16} aria-hidden />}
                </button>
                <button
                  type="button"
                  role="radio"
                  className="jamCard jamHear__option"
                  aria-checked={hear === 'speaker'}
                  data-on={hear === 'speaker' || undefined}
                  onClick={() => jam.setHear('speaker')}
                >
                  <span className="jamHear__disc" aria-hidden>
                    <Speaker size={18} />
                  </span>
                  <span className="jamHear__text">
                    <span className="jamHear__name">
                      {t('player.grooveHearSpeaker', { host: room.hostName })}
                    </span>
                    <span className="jamHear__sub">{t('player.grooveHearSpeakerSub')}</span>
                  </span>
                  {hear === 'speaker' && <Check className="jamHear__check" size={16} aria-hidden />}
                </button>
              </div>
            </Section>
          )}

          {/* 3. Up next: the guests' waiting adds ahead of the room's line. */}
          {(queue.length > 0 || pend.length > 0) && (
            <Section label={t('player.grooveUpNext')}>
              {pend.length > 0 && (
                <div className="jamCard jamPending" role="group" aria-label={pendingLine}>
                  <span className="jamPending__head">
                    <Hourglass size={14} aria-hidden />
                    <span>{pendingLine}</span>
                  </span>
                  {mine.length > 0 && (
                    <span className="jamPending__mine">
                      {mine.map((p) => {
                        // `row`, not `t` - the translator owns that name here.
                        const row = p.track ?? byId.get(p.trackId);
                        const name = row?.title ?? t('player.grooveYourAdd');
                        return (
                          <button
                            key={p.trackId}
                            type="button"
                            className="jamChip jamChip--withdraw"
                            aria-label={t('player.grooveWithdraw', { name })}
                            onClick={() => void jam.withdraw(p.trackId)}
                          >
                            <span>{name}</span>
                            <X size={14} aria-hidden />
                          </button>
                        );
                      })}
                    </span>
                  )}
                </div>
              )}
              {queue.length > 0 && (
                <EdgeScrollRow className="jamNext" role="list" aria-label={t('player.grooveQueueAria')}>
                  {queue.map((id, i) => {
                    // The library's row, or the hub's; "not in your library"
                    // only once the hub has said it has no such track, and
                    // an ellipsis while it is still being asked.
                    const answer = roomLine.get(id);
                    // `row`, not `t` - the translator owns that name here.
                    const row = byId.get(id) ?? answer ?? undefined;
                    const by = room.addedBy?.[String(id)];
                    const name = row?.title ?? (answer === null ? t('player.notInLibrary') : '…');
                    const line = row?.artist
                      ? t('player.grooveSongByArtist', { title: name, artist: row.artist })
                      : name;
                    const spoken = t('player.grooveQueueItemAria', {
                      index: formatNumber(i + 1),
                      line,
                    });
                    return (
                      <div
                        key={`${id}-${i}`}
                        role="listitem"
                        className="jamCard jamNext__card"
                        aria-label={by ? t('player.grooveAddedByAria', { line: spoken, who: by }) : spoken}
                      >
                        <Sleeve src={row ? artSized(row.artwork, 160) : null} className="jamNext__art" glyph={20} />
                        <span className="jamNext__title" aria-hidden>
                          {name}
                        </span>
                        {by && (
                          <span className="jamChip jamChip--by" aria-hidden>
                            <UserPlus size={10} />
                            <span>{by}</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </EdgeScrollRow>
              )}
            </Section>
          )}

          {/* 4. People: named, with their standing - and who has the clock. */}
          <Section label={t('player.groovePeople')}>
            <ul className="jamCard jamPeople">
              {people.map((p) => {
                const isMe = p.name.toLowerCase() === me.toLowerCase();
                const here = p.joinedAt > 0 ? spanWords(now - p.joinedAt) : null;
                const fresh = isMe || (p.seenAt > 0 && now - p.seenAt < FRESH_MS);
                const known = p.seenAt > 0 || isMe;
                // Their standing as ONE line rather than three JSX siblings:
                // "listening" and "here 5 min" are separate facts, and only
                // this side knows which of them there is anything to say
                // about. The dot stays a mark, not a word.
                const standing = [
                  known ? (fresh ? t('player.grooveListening') : t('player.grooveQuiet')) : null,
                  p.joinedAt > 0
                    ? (here ? t('player.grooveHereFor', { span: here }) : t('player.grooveJustArrived'))
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <li key={p.id} className="jamPerson">
                    <FriendAvatar handle={p.name} size="md" />
                    <span className="jamPerson__text">
                      <span className="jamPerson__name">
                        {p.name}
                        {isMe && <span className="jamPerson__you"> · {t('player.grooveYouInList')}</span>}
                      </span>
                      {standing && (
                        <span className="jamPerson__standing">
                          {known && (
                            <span className="jamPerson__dot" data-fresh={fresh || undefined} aria-hidden />
                          )}
                          {standing}
                        </span>
                      )}
                    </span>
                    {p.host && (
                      <span className="jamPill jamPill--host">
                        <Crown size={10} aria-hidden />
                        {t('player.grooveHost')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {eventsLine && (
              <span className="jamPeople__events">
                <Clock size={12} aria-hidden />
                <span>{eventsLine}</span>
              </span>
            )}
          </Section>

          {/* 5. Invite: the code for somebody already in the app on this
              server, the QR and the link for everybody else. Anyone in the
              room can pass it on; being in it is the permission, and the hub
              still decides who gets through the door. */}
          {/* The heading and the button below both say "Invite" in English;
              they are two entries because a heading and a verb are not the
              same word in German. */}
          <Section label={t('player.grooveInviteSection')}>
            <div className="jamCard jamInvite">
              <span className="jamInvite__main">
                <span className="jamInvite__eyebrow">{t('player.grooveCode')}</span>
                <button
                  type="button"
                  className="jamInvite__code"
                  aria-label={
                    copied ? t('player.grooveCodeCopied') : t('player.grooveCodeCopy', { code })
                  }
                  aria-live="polite"
                  onClick={() => void copyCode()}
                >
                  <span className="jamInvite__mono">{code}</span>
                  <span className="jamInvite__copy" data-done={copied || undefined}>
                    {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                    {copied ? t('player.grooveCopied') : t('player.grooveCopy')}
                  </span>
                </button>
              </span>
              <span className="jamInvite__qr" data-ready={qr ? '' : undefined}>
                {qr ? (
                  <img src={qr} alt={t('player.grooveQrAlt')} />
                ) : (
                  <span className="jamInvite__qrBlank" aria-hidden>
                    <QrCode size={22} />
                  </span>
                )}
              </span>
              <span className="jamActions jamInvite__share">
                <button
                  type="button"
                  className="jamAction jamInvite__friends"
                  aria-label={t('player.grooveInviteAria')}
                  onClick={inviteFriends}
                >
                  <UserPlus size={16} aria-hidden />
                  {t('player.grooveInviteFriendsAction')}
                </button>
                <button
                  type="button"
                  className="jamAction"
                  aria-label={t('player.grooveShareAria')}
                  onClick={share}
                >
                  <Share2 size={16} aria-hidden />
                  {t('player.grooveShareLink')}
                </button>
              </span>
            </div>
          </Section>

          {/* 6. The way out. A host has two: hand the room on, or close it.
              Leaving used to end it for everyone, which is the one thing a
              host stepping out for a moment never meant. */}
          <div className="jamActions" role="group" aria-label={t('player.grooveLeaveOrEnd')}>
            {!hosting && (
              <button
                type="button"
                className="jamAction"
                aria-label={t('player.grooveLeaveAria')}
                onClick={() => void jam.leave()}
              >
                <LogOut size={16} aria-hidden />
                {t('player.grooveLeave')}
              </button>
            )}
            {hosting && others === 0 && (
              <button
                type="button"
                className="jamAction"
                data-tone="danger"
                aria-label={t('player.grooveEnd')}
                onClick={() => void jam.end()}
              >
                <Power size={16} aria-hidden />
                {t('player.grooveEnd')}
              </button>
            )}
            {hosting && others > 0 && (
              <>
                <button
                  type="button"
                  className="jamAction"
                  aria-label={t('player.grooveHandOnAria')}
                  onClick={() => void jam.leave()}
                >
                  <LogOut size={16} aria-hidden />
                  {t('player.grooveHandOn')}
                </button>
                <button
                  type="button"
                  className="jamAction"
                  data-tone="danger"
                  aria-label={t('player.grooveEndAllAria')}
                  onClick={() => void jam.end()}
                >
                  <Power size={16} aria-hidden />
                  {t('player.grooveEndAll')}
                </button>
              </>
            )}
          </div>
        </div>
      </Popover>
      {/* HOISTED OUT of the popover, and that is the whole point. Tapping Share
          dismisses the panel that carries the button, and a sheet rendered
          inside that panel is unmounted by its own trigger closing - it appears
          and vanishes in the same frame. Rendered as the popover's SIBLING it
          outlives the dismissal, and the state that opens it lives out here
          too. */}
      {sharing && (
        <ShareJamSheet
          jamId={room.id}
          hostName={room.hostName}
          listening={room.memberCount}
          open={sharing}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
