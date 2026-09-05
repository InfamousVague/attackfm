import { Text } from '@glacier/react';
import { Music, Users } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { ArtWall } from '../app/servers/ArtWall.tsx';
import { LiveWall } from './LiveWall.tsx';
import { AppDoors } from './appDoors.tsx';

/**
 * A jam LINK, opened in a browser: whose room it is, what is on right now,
 * and the way into the app.
 *
 * A jam is unlike the other two things the registry hands out links for, and
 * the page has to be honest about it. A playlist link can be opened by anyone
 * on any server; an invite link is FOR someone with no server yet. A jam is a
 * room on ONE server, and walking in means being a member of that server - so
 * this page cannot promise entry, only the door. The app is what finds out.
 *
 * What it CAN do that a typed code cannot is say what the room is: the hub's
 * jam feed is public enough to name the host and what is playing, so somebody
 * deciding whether to bother has something to decide with. A hub that is
 * asleep or unreachable from here just leaves the quieter version of the page.
 */

export interface JamDoc {
  code: string;
  state: 'ok' | 'missing';
  by: string;
  hubName: string;
  hubUrl: string;
  jamId: string;
}

/** What `/api/wall` hands out: paths on the hub, signed for the day. */
interface WallDoc {
  covers?: string[];
  canvases?: string[];
}

/** Fewer covers than this and the stock wall reads better than a sparse one. */
const WALL_MINIMUM = 8;

export function JamLanding({ jam }: { jam: JamDoc }) {
  const [wall, setWall] = useState<{ covers: string[]; canvases: string[] } | null>(null);
  const [where, setWhere] = useState<string>(jam.hubName);

  useEffect(() => {
    if (jam.state !== 'ok' || !jam.hubUrl) return undefined;
    const controller = new AbortController();
    const hub = jam.hubUrl.replace(/\/+$/, '');
    // The server's own name, which is better than the one stamped on the link:
    // the link was made once and a server can be renamed after.
    fetch(`${hub}/api/server`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ name?: string }>) : Promise.reject(new Error())))
      .then((glance) => {
        if (glance.name) setWhere(glance.name);
      })
      .catch(() => {});
    fetch(`${hub}/api/wall`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<WallDoc>) : Promise.reject(new Error())))
      .then((doc) => {
        const covers = (doc.covers ?? []).map((p) => `${hub}${p}?size=160`);
        const canvases = (doc.canvases ?? []).map((p) => `${hub}${p}`);
        if (covers.length >= WALL_MINIMUM) setWall({ covers, canvases });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [jam]);

  const dead = jam.state !== 'ok';
  /** The address, as the person who joined that server would have typed it. */
  const host = jam.hubUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');

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
            <h1>That groove is not one we know about</h1>
            <Text tone="muted" size="sm">
              The link may have been mistyped. Ask whoever sent it for another.
            </Text>
          </div>
        ) : (
          <>
            <div className="head">
              {/* The group glyph, which is the mark this feature wears in the
                  app - the badge in the transport row, the card on the
                  profile, and now the page a link lands on. */}
              <span className="joinCard__mark" aria-hidden>
                <Users size={22} />
              </span>
              <h1>{jam.by ? `Listen along with @${jam.by}` : 'Listen along'}</h1>
              <Text tone="muted" size="sm">
                {where ? `A groove on ${where}` : 'A groove on AttackFM'} · same song, same moment
              </Text>
            </div>

            <AppDoors scheme={`j/${encodeURIComponent(jam.code)}`} label="Join in AttackFM" />

            {/* The limit, on the page rather than discovered after the tap.
                A groove is rows on one server; being on that server is what lets
                anybody in, and no link can hand that over.

                The server is named by its ADDRESS here, not by its name. Hubs
                are called things like "AttackFM" by default, and "if you are
                already on AttackFM" then reads as "if you have the app" -
                which is the opposite of what this sentence exists to say. A
                host is unambiguous and is the thing they would have typed. */}
            <Text tone="muted" size="xs" className="carry">
              <Music size={12} aria-hidden /> A groove happens on one server. If you are signed in to{' '}
              {host || 'that server'}, this walks you straight in. If you are not, you will need an
              invite from someone who is - a groove is a room, not a broadcast.
            </Text>
          </>
        )}
      </main>
    </div>
  );
}
