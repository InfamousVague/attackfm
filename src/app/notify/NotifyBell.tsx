import { useEffect, useState } from 'react';
import { Button, CounterBadge, IconButton, Popover, Text } from '@glacier/react';
import { Bell, Download, Trash2, X } from '@glacier/icons';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { noticeGlyph } from './kinds.ts';
import { clearNotices, dismissNotice, markAllRead, msOf, useNotices, useUnreadKinds, useUnreadNotices } from './notices.ts';
import type { Notice, NoticeDoor } from './notices.ts';
import { useHasDownloadQueue } from '../../plugins/runtime/pluginHooks.tsx';
import { discoverDoorOpen, openDiscover } from '../nav/discoverDoor.ts';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { openPlaylistById, playlistDoorOpen } from '../nav/playlistDoor.ts';
import { useJamOptional } from '../player/jam.tsx';

/**
 * The bell, and the news behind it.
 *
 * It sits in the one piece of chrome every page shares, so "the notifications"
 * is a place rather than a thing you have to be looking at the right screen to
 * catch. That is the whole argument for it: the app's only completion signal
 * used to be a pill that appeared over whatever you were doing for three
 * seconds and then never existed again.
 *
 * The panel holds two different tenses and says so in its layout. WHAT IS
 * HAPPENING NOW sits at the top - the work in flight, which is where the
 * floating chip's sentence went, and which is live rather than remembered.
 * WHAT HAPPENED sits below it, newest first, and persists.
 */
export function NotifyBell({
  iconSize = 16,
  onOpenDownloads,
  onOpenFriends,
}: {
  /** 16 in the desktop title bar, 18 in the mobile header - the house sizes. */
  iconSize?: number;
  onOpenDownloads: () => void;
  /** Where a friend-request row goes. Optional: a surface without a Friends
   *  page simply leaves those rows unpressable. */
  onOpenFriends?: () => void;
}) {
  const items = useNotices();
  const unread = useUnreadNotices();
  const kinds = useUnreadKinds();
  const dl = useDownloadsOptional();
  // The same predicate the Downloads PAGE is gated on, not `dl !== null`:
  // another plugin can contribute a queue without owning this bridge, and
  // the page renders for it too.
  const hasQueue = useHasDownloadQueue();
  const active = dl?.active ?? [];
  const [open, setOpen] = useState(false);
  // A groove row's door is an answer: pressing it accepts the ask. The
  // provider's own accept, so the row and the profile card do one thing.
  const groove = useJamOptional();

  /**
   * Which rows were new when the panel opened.
   *
   * Opening marks everything read, because a count that survives being looked
   * at is a count nobody trusts. But the ROWS keep their mark until the panel
   * closes, so the thing you opened the bell to find is still pointed at while
   * you are reading it.
   */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!open) {
      setFresh(new Set());
      return;
    }
    setFresh(new Set(items.filter((n) => !n.read).map((n) => n.id)));
    markAllRead();
    // items is deliberately absent: this must run when the panel OPENS, not
    // every time a row lands while it is open - the second would keep
    // re-marking and repaint the dots under the reader's eyes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // One number across every sized job; jobs that do not know their total
  // (a single track, or one still enumerating) ride along without skewing it.
  // This arithmetic came from the chip that used to float above the transport.
  const sized = active.filter((j) => (j.total ?? 0) > 0);
  const done = sized.reduce((sum, j) => sum + j.completed, 0);
  const total = sized.reduce((sum, j) => sum + (j.total ?? 0), 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  const label =
    active.length > 0
      ? `Notifications — ${active.length} downloading`
      : unread > 0
        ? `Notifications — ${unread} new`
        : 'Notifications';

  return (
    <Popover
      placement="bottom-end"
      // The same two classes the equalizer wears, so this sheet IS that sheet:
      // .popoverSheet carries the scroll and gesture contract every popover
      // shares, and .notifyPopoverPanel carries the one thing that differs here,
      // its width.
      //
      // Neither paints, and that is the point. The kit's panel element is
      // transparent on its own, which once read as "dress it yourself" - but the
      // kit paints the surface from an ArrowGlass SIBLING of the panel, so a
      // panel that dresses itself lays a second pane over the first. Doing that
      // is what made this one popover a dark slab among frosted ones.
      className="popoverSheet notifyPopoverPanel"
      aria-label="Notifications"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton
          className="notifyBell"
          // Drives the swing below. `undefined` rather than false so the
          // attribute is absent entirely when nothing is in flight.
          data-busy={active.length > 0 || undefined}
          variant="ghost"
          size="sm"
          aria-label={label}
        >
          <Bell size={iconSize} />
          {unread > 0 && (
            <CounterBadge
              className="notifyBell__badge"
              count={unread}
              max={99}
              size="sm"
              // A failure you have not seen is the one thing here worth a
              // different colour - the same convention the ⋮ badge uses.
              tone={kinds.has('failed') ? 'danger' : 'accent'}
            />
          )}
        </IconButton>
      }
    >
      <div className="notifyPanel">
        <div className="notifyPanel__head">
          <span className="notifyPanel__title">
            <Bell size={14} /> Notifications
          </span>
          {items.length > 0 && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Clear notifications"
              title="Clear"
              onClick={() => clearNotices()}
            >
              <Trash2 size={15} />
            </IconButton>
          )}
        </div>

        {active.length > 0 && (
          <div className="notifyLive">
            <Text tone="muted" size="xs" className="notifyLive__head">
              {`${active.length} downloading${pct !== null ? ` · ${pct}%` : ''}`}
            </Text>
            {active.map((job) => {
              // The song coming down right now, and who it is by - the popover
              // knows both from the embed, and a row that says only "Playlist
              // 12/40" answers a question nobody asked. `items` is absent on a
              // server older than the field; the line then shows the title
              // alone, exactly as the current-track line always did.
              const at = job.currentIndex ?? -1;
              const nowTitle = job.currentTrack || (at >= 0 ? job.tracks[at] : null);
              const nowArtist = at >= 0 ? job.items?.[at]?.artist : null;
              return (
              <div key={job.id} className="notifyLive__row">
                <span className="notifyLive__art" aria-hidden>
                  {job.artworkUrl ? (
                    <img src={job.artworkUrl} alt="" loading="lazy" />
                  ) : (
                    <Download size={13} />
                  )}
                </span>
                <span className="notifyLive__text">
                  <span className="notifyLive__name">{job.title || 'That link'}</span>
                  {job.state === 'downloading' && nowTitle && (
                    <span className="notifyLive__now">
                      {nowTitle}
                      {nowArtist ? <span className="notifyLive__by"> · {nowArtist}</span> : null}
                    </span>
                  )}
                </span>
                {(job.total ?? 0) > 0 && (
                  <span className="notifyLive__count">
                    {job.completed}/{job.total}
                  </span>
                )}
                <span
                  className="notifyLive__bar"
                  style={{
                    // Width only, no colour: the rail is painted in CSS from
                    // the accent ramp, so a chain of these stays on theme.
                    ['--notify-progress' as string]:
                      (job.total ?? 0) > 0
                        ? `${Math.round((job.completed / (job.total ?? 1)) * 100)}%`
                        : '0%',
                  }}
                  aria-hidden
                />
              </div>
              );
            })}
          </div>
        )}

        {items.length === 0 ? (
          <div className="notifyPanel__empty">
            <span className="notifyPanel__emptyGlyph" aria-hidden>
              <Bell size={18} />
            </span>
            <Text tone="muted" size="sm">
              Nothing new. Downloads and news land here.
            </Text>
          </div>
        ) : (
          <ul className="notifyList">
            {/* Newest first. The ring itself stays in arrival order so that
                dropping the eldest is a cheap slice; the reversal is the
                reader's order, not the store's. */}
            {[...items].reverse().map((n) => (
              <NoticeRow
                key={n.id}
                notice={n}
                unseen={fresh.has(n.id)}
                /*
                 * PER DOOR, because there is more than one now.
                 *
                 * A row kept from a time when the importer was installed must
                 * not still look pressable once it is gone: the Downloads page
                 * is gated on the same flag, so the press would land on
                 * nothing. That gate is about DOWNLOADS though, and applying
                 * it to every row made a friend request unpressable whenever
                 * the download queue happened to be empty - which is nearly
                 * always.
                 */
                canOpen={canOpenDoor(n.door, hasQueue, onOpenFriends != null, n.playlist, groove !== null && !!n.from)}
                onOpen={() => {
                  setOpen(false);
                  if (n.door === 'downloads') onOpenDownloads();
                  else if (n.door === 'friends') onOpenFriends?.();
                  // Discover and Music Date are reached through their module
                  // seams, the same ones the Discover chips knock on - so the
                  // bell needs no handler threaded down to it for either.
                  else if (n.door === 'discover') openDiscover();
                  else if (n.door === 'date') openMusicDate();
                  // A shared list, or one somebody added to: the page itself,
                  // through the same kind of seam. Opening it is also what
                  // marks the share seen and takes this row away.
                  else if (n.door === 'playlist' && n.playlist) openPlaylistById(n.playlist);
                  // The ask, answered. The watcher takes the row away once
                  // the poll no longer carries the invite.
                  else if (n.door === 'groove' && n.from) void groove?.acceptInvite(n.from);
                }}
              />
            ))}
          </ul>
        )}

        {hasQueue && (
          /* Load-bearing, not a convenience: removing the floating chip removed
             the only Downloads door a desktop BROWSER has, since the library's
             own action row is gated on the desktop app rather than the desktop
             layout. */
          <div className="notifyPanel__more">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onOpenDownloads();
              }}
            >
              Open downloads
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}

/**
 * Whether a row's door has somewhere to land right now.
 *
 * PER DOOR, because a row kept from a time when its destination existed must
 * not still look pressable once it is gone - the Downloads page follows the
 * importer, Friends follows a surface that offers it, and the two discovery
 * doors follow whether their fullscreen/tab seam is registered at all (both
 * are, for the whole app's life, so those are effectively always open - but
 * asking keeps a stale row from a build that had neither honest).
 */
function canOpenDoor(
  door: NoticeDoor,
  hasQueue: boolean,
  hasFriends: boolean,
  playlist: string | undefined,
  hasGroove: boolean,
): boolean {
  switch (door) {
    case 'groove':
      // Only with a provider to say yes through, and an asker to say it to.
      return hasGroove;
    case 'downloads':
      return hasQueue;
    case 'friends':
      return hasFriends;
    case 'discover':
      return discoverDoorOpen();
    case 'date':
      return musicDateDoorOpen();
    case 'playlist':
      // A row that names no list (an older shape, or a hand-edited ring)
      // cannot be a door to one.
      return !!playlist && playlistDoorOpen();
    default:
      return false;
  }
}

function NoticeRow({
  notice,
  unseen,
  canOpen,
  onOpen,
}: {
  canOpen: boolean;
  notice: Notice;
  unseen: boolean;
  onOpen: () => void;
}) {
  const Glyph = noticeGlyph(notice.kind);
  const pressable = notice.door !== null && canOpen;
  return (
    <li>
      <div
        className="notifyRow"
        data-kind={notice.kind}
        data-unread={unseen || undefined}
        // A row with nowhere to go is not a button. Making it one would promise
        // a destination that does not exist.
        role={pressable ? 'button' : undefined}
        tabIndex={pressable ? 0 : undefined}
        onClick={pressable ? onOpen : undefined}
        onKeyDown={
          pressable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
      >
        <span className="notifyRow__art">
          {notice.art ? (
            <img src={notice.art} alt="" loading="lazy" />
          ) : (
            <Glyph size={15} />
          )}
        </span>
        <span className="notifyRow__text">
          <span className="notifyRow__title">{notice.title}</span>
          <span className="notifyRow__body">{notice.body}</span>
        </span>
        <span className="notifyRow__when">{agoOf(notice.at)}</span>
        {/* One row, gone. "Clear all" was the only answer here, which is a poor
            one for a single stuck notice - a download that failed and will not
            stop saying so is exactly the row you want rid of while keeping the
            five you have not read. Its own button, OUTSIDE the pressable row's
            handler: a press must not also open downloads on the way past. */}
        <button
          type="button"
          className="notifyRow__dismiss"
          aria-label={`Dismiss ${notice.title}`}
          onClick={(e) => {
            e.stopPropagation();
            dismissNotice(notice.id);
          }}
        >
          <X size={13} />
        </button>
      </div>
    </li>
  );
}

/**
 * "3 min" — how long ago, in the fewest characters that stay true.
 *
 * The house has two of these already (the friends list, the storage pane) and
 * they disagree about their units, so this is a third rather than a shared
 * module nobody asked for. The seconds-versus-milliseconds decode is NOT one of
 * its opinions though - that lives in notices.ts, once, because a second copy
 * of it is how the watcher came to be comparing a seconds timestamp against a
 * millisecond duration and silently dropping every arrival.
 */
function agoOf(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - msOf(at)) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
