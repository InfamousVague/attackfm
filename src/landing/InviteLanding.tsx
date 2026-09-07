import { Button, Text } from '@glacier/react';
import { Check, Copy, Disc3, ListMusic, Music, User, Users } from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { ArtWall } from '../app/servers/ArtWall.tsx';
import { LiveWall } from './LiveWall.tsx';
import { AppDoors } from './appDoors.tsx';
import { LocaleShell, useT } from '../app/i18n/LocaleShell.tsx';
import { formatNumber } from '../app/ux/format.ts';

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

/**
 * The landing bundle is its own entry point (landing/main.tsx) - it never
 * mounts App, so nothing has started i18next or stamped the document. Each
 * page raises the shell itself: it boots the catalogue before its children
 * render, hands the kit the same language, and sets `dir` on <html>, which is
 * what actually mirrors the layout for Arabic. Without it every t() here
 * would resolve to a raw key, and PlayerStrip - which the playlist page
 * borrows whole - already calls one.
 */
export function InviteLanding({ invite }: { invite: InviteDoc }) {
  return (
    <LocaleShell>
      <InviteCard invite={invite} />
    </LocaleShell>
  );
}

function InviteCard({ invite }: { invite: InviteDoc }) {
  const t = useT();
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

  const name = invite.serverName || glance?.name || t('landing.someServer');
  const owner = glance?.owner || '';
  // The stat chips draw the number and its unit in two differently styled
  // spans, so the unit is a bare noun rather than part of a sentence - but it
  // still agrees with the number, and "1 songs" is the failure this avoids.
  // The `id` is the React key: the label is a translated word now, and two
  // languages are free to spell two of these the same.
  const stats: { id: string; icon: ReactNode; value: number; label: string }[] = glance
    ? [
        ...(typeof glance.tracks === 'number' ? [{ id: 'tracks', icon: <Music size={14} />, value: glance.tracks, label: t('landing.statSongs', { count: glance.tracks }) }] : []),
        ...(typeof glance.artists === 'number' ? [{ id: 'artists', icon: <User size={14} />, value: glance.artists, label: t('landing.statArtists', { count: glance.artists }) }] : []),
        ...(typeof glance.albums === 'number' ? [{ id: 'albums', icon: <Disc3 size={14} />, value: glance.albums, label: t('landing.statAlbums', { count: glance.albums }) }] : []),
        ...(typeof glance.playlists === 'number' ? [{ id: 'playlists', icon: <ListMusic size={14} />, value: glance.playlists, label: t('landing.statPlaylists', { count: glance.playlists }) }] : []),
        ...(typeof glance.members === 'number' ? [{ id: 'members', icon: <Users size={14} />, value: glance.members, label: t('landing.statMembers', { count: glance.members }) }] : []),
      ]
    : [];

  const dead =
    invite.state === 'missing'
      ? { title: t('landing.inviteMissingTitle'), body: t('landing.inviteMissingBody') }
      : invite.state === 'used'
        ? { title: t('landing.inviteUsedTitle'), body: t('landing.inviteUsedBody') }
        : invite.state === 'expired'
          ? { title: t('landing.inviteExpiredTitle'), body: t('landing.inviteExpiredBody') }
          : null;

  // Two independent clauses - whose server this is, and who asked you - joined
  // by a middot. The middot is punctuation, not language, so it lives here and
  // each clause stays a sentence a translator can rewrite on its own.
  const byline = [
    owner ? t('landing.ownersServer', { owner }) : t('landing.aLibraryOnAttackFm'),
    invite.from ? t('landing.invitedBy', { who: invite.from }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

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
              <h1>{t('landing.joinServer', { name })}</h1>
              <Text tone="muted" size="sm">
                {byline}
              </Text>
              {stats.length > 0 && (
                <ul className="joinCard__stats">
                  {stats.map((s) => (
                    <li key={s.id} className="joinCard__stat">
                      <span className="joinCard__statIcon" aria-hidden>
                        {s.icon}
                      </span>
                      <span className="joinCard__statValue">{formatNumber(s.value)}</span>
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
                {t('landing.enterCodeInvite')}
              </Text>
              <div className="codeBox__row">
                <code className="codeBox__code">{code}</code>
                <Button variant="ghost" size="sm" onClick={copy} aria-label={t('landing.copyInviteCode')}>
                  {/* Not a plural: two labels for two states, chosen here. */}
                  {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
            </div>

            <Text tone="muted" size="xs" className="carry">
              {t('landing.inviteCarry', { name })}
            </Text>
          </>
        )}
      </main>
    </div>
  );
}
