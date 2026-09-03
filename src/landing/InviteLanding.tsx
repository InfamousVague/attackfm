import { Button, Text } from '@glacier/react';
import { Check, Copy, Disc3, ListMusic, Music, User, Users } from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { ArtWall } from '../app/servers/ArtWall.tsx';
import { LiveWall } from './LiveWall.tsx';
import { AppDoors } from './appDoors.tsx';

/**
 * An invite LINK, opened in a browser: the same card the app raises for it
 * (servers/JoinCard - the server's mark, name, glance and whose it is), on
 * the page instead of over one, with the two doors a browser can offer:
 * open the app if it is here, or fetch it for this machine if it is not.
 *
 * The code is printed too, because a scheme link is a dead end on a device
 * with no app and pasting always works. And the page says what happens
 * next: the app holds the invite across signing in, so once an account
 * exists the same link joins the server by itself.
 */

export interface InviteDoc {
  code: string;
  state: 'ok' | 'missing' | 'used' | 'expired';
  serverName: string;
  serverUrl: string;
  from: string;
  standing: boolean;
  maxUses: number | null;
  remaining: number | null;
}

/** The hub's public glance (`/api/server`), as much of it as this hub has. */
interface Glance {
  name?: string;
  owner?: string;
  tracks?: number;
  artists?: number;
  albums?: number;
  playlists?: number;
  members?: number;
}

/** What `/api/wall` hands out: paths on the hub, signed for the day. */
interface WallDoc {
  covers?: string[];
  canvases?: string[];
}

/** Fewer covers than this and the stock wall reads better than a sparse one. */
const WALL_MINIMUM = 8;

export function InviteLanding({ invite }: { invite: InviteDoc }) {
  const [glance, setGlance] = useState<Glance | null>(null);
  const [wall, setWall] = useState<{ covers: string[]; canvases: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const code = invite.code.toUpperCase();

  // The server's own glance, from the server: a box that is asleep or
  // unreachable from here still leaves a joinable card, just a quieter one.
  useEffect(() => {
    if (invite.state !== 'ok' || !invite.serverUrl) return undefined;
    const controller = new AbortController();
    const hub = invite.serverUrl.replace(/\/+$/, '');
    fetch(`${hub}/api/server`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<Glance>) : Promise.reject(new Error(String(res.status)))))
      .then(setGlance)
      .catch(() => {});
    // The hub's own wall, where the hub is new enough to offer one; the
    // stock wall otherwise, or while this is still on its way.
    fetch(`${hub}/api/wall`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<WallDoc>) : Promise.reject(new Error(String(res.status)))))
      .then((doc) => {
        const covers = (doc.covers ?? []).map((p) => `${hub}${p}?size=160`);
        const canvases = (doc.canvases ?? []).map((p) => `${hub}${p}`);
        if (covers.length >= WALL_MINIMUM) setWall({ covers, canvases });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [invite]);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const name = invite.serverName || glance?.name || 'a server';
  const owner = glance?.owner || '';
  const stats: { icon: ReactNode; value: number; label: string }[] = glance
    ? [
        ...(typeof glance.tracks === 'number' ? [{ icon: <Music size={14} />, value: glance.tracks, label: glance.tracks === 1 ? 'song' : 'songs' }] : []),
        ...(typeof glance.artists === 'number' ? [{ icon: <User size={14} />, value: glance.artists, label: 'artists' }] : []),
        ...(typeof glance.albums === 'number' ? [{ icon: <Disc3 size={14} />, value: glance.albums, label: 'albums' }] : []),
        ...(typeof glance.playlists === 'number' ? [{ icon: <ListMusic size={14} />, value: glance.playlists, label: 'playlists' }] : []),
        ...(typeof glance.members === 'number' ? [{ icon: <Users size={14} />, value: glance.members, label: glance.members === 1 ? 'member' : 'members' }] : []),
      ]
    : [];

  const dead =
    invite.state === 'missing'
      ? { title: 'That invite is not valid', body: 'The link may have been mistyped, or the invite withdrawn.' }
      : invite.state === 'used'
        ? { title: 'That invite has already been used', body: 'Ask whoever sent it for another.' }
        : invite.state === 'expired'
          ? { title: 'That invite has expired', body: 'Ask whoever sent it for another.' }
          : null;

  return (
    <div className="stage">
      <div className="wallBackdrop" aria-hidden>
        {wall ? <LiveWall covers={wall.covers} canvases={wall.canvases} /> : <ArtWall />}
      </div>
      <main className="card card--invite">
        {dead ? (
          <div className="head">
            <span className="joinCard__mark joinCard__mark--dead" aria-hidden>
              !
            </span>
            <h1>{dead.title}</h1>
            <Text tone="muted" size="sm">
              {dead.body}
            </Text>
          </div>
        ) : (
          <>
            <div className="head">
              <span className="joinCard__mark" aria-hidden>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <h1>Join {name}</h1>
              <Text tone="muted" size="sm">
                {owner ? `${owner}'s server` : 'A music library on AttackFM'}
                {invite.from ? ` · invited by @${invite.from}` : ''}
              </Text>
              {stats.length > 0 && (
                <ul className="joinCard__stats">
                  {stats.map((s) => (
                    <li key={s.label} className="joinCard__stat">
                      <span className="joinCard__statIcon" aria-hidden>
                        {s.icon}
                      </span>
                      <span className="joinCard__statValue">{s.value.toLocaleString()}</span>
                      <span className="joinCard__statLabel">{s.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* The app, when it is here: the scheme the app registers on
                every platform. A device without it lands on the download
                beside it, because a scheme link nobody handles does nothing.
                Shared with the jam and profile pages - see appDoors. */}
            <AppDoors scheme={`i/${encodeURIComponent(code)}`} />

            <div className="codeBox">
              <Text tone="muted" size="xs">
                Or enter this code in AttackFM under Join a server
              </Text>
              <div className="codeBox__row">
                <code className="codeBox__code">{code}</code>
                <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy the invite code">
                  {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>

            <Text tone="muted" size="xs" className="carry">
              Just installed it? Sign in or create your account in the app, then open this link again -
              it joins {name} by itself.
            </Text>
          </>
        )}
      </main>
    </div>
  );
}
