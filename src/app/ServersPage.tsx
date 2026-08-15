import { Button, Field, Heading, Input, Skeleton, Switch, Text } from '@glacier/react';
import { HardDrive, Radio, RefreshCw, X } from '@glacier/icons';
import { StorageManager } from './StorageManager.tsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useRegistry } from './registrySession.tsx';
import { fetchSavedServers } from './serverSync.ts';
import type { Membership } from './registry.ts';
import {
  enterServer,
  fetchServerStats,
  loadCachedIndex,
  pairClaim,
  type ServerSession,
  type ServerStats,
} from './server.ts';
import {
  addMirror,
  healthOf,
  loadHoldings,
  mirrorList,
  probeAll,
  refreshHoldings,
  removeMirror,
  routingPref,
  setRoutingPref,
  subscribeMirrors,
  trackKey,
  type Mirror,
} from './mirrors.ts';

/**
 * Where the music comes from, and what it costs to keep it there.
 *
 * A library that lives on two boxes raises two questions the rest of the app
 * deliberately hides: which one is answering right now, and which one is full.
 * This page is the only place both are visible, because they are the same
 * decision seen from two ends - a song is on the near box because someone
 * copied it there, and the near box has room because someone deleted something
 * else.
 *
 * The session server is always first and cannot be removed: it is the library
 * itself, not a copy of it. Everything below it is a delivery route.
 */

function gb(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 10) return `${Math.round(g)} GB`;
  if (g >= 0.1) return `${g.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Latency, said the way a person would judge it. */
function nearness(ms: number | null, ok: boolean): { value: string; label: string; tone: string } {
  if (!ok) return { value: 'offline', label: 'unreachable', tone: 'bad' };
  if (ms == null) return { value: '—', label: 'checking…', tone: 'idle' };
  const value = `${Math.round(ms)} ms`;
  if (ms < 40) return { value, label: 'same network', tone: 'best' };
  if (ms < 150) return { value, label: 'close', tone: 'good' };
  if (ms < 400) return { value, label: 'far', tone: 'ok' };
  return { value, label: 'very far', tone: 'slow' };
}

interface Row {
  url: string;
  name: string;
  primary: boolean;
  isAdmin: boolean;
  /** How many of the session library's songs this box can serve. */
  held: number;
  latencyMs: number | null;
  ok: boolean;
  stats: ServerStats | null;
}

export function ServersPanel() {
  const { session } = useServerSession();
  const [mirrors, setMirrors] = useState<Mirror[]>(mirrorList);
  const [stats, setStats] = useState<Record<string, ServerStats | null>>({});
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [routing, setRouting] = useState(routingPref);
  // Cleaning one server is a whole screen's worth of list, so it takes over
  // the page rather than opening yet another nav destination.
  const [managing, setManaging] = useState<string | null>(null);

  useEffect(() => subscribeMirrors(() => setMirrors(mirrorList())), []);

  // The whole library's keys, once: every row's "holds N of yours" is this set
  // intersected with that box's holdings, and rebuilding it per row on a
  // 4,000-song library is the difference between instant and visibly slow.
  const libraryKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!session) return keys;
    for (const t of loadCachedIndex(session.url).tracks) keys.add(trackKey(t.artist, t.title));
    return keys;
  }, [session, tick]);

  const refresh = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const urls = [session.url, ...mirrorList().map((m) => m.url)];
      await probeAll(urls);
      await Promise.all(mirrorList().map((m) => refreshHoldings(m)));
      // Stats are per-server and each needs that server's own token, so a
      // mirror that has gone stale simply reports nothing rather than failing
      // the page.
      const entries = await Promise.all(
        [{ url: session.url, token: session.token }, ...mirrorList()].map(async (s) => {
          try {
            return [s.url, await fetchServerStats(s as never)] as const;
          } catch {
            return [s.url, null] as const;
          }
        }),
      );
      setStats(Object.fromEntries(entries));
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows: Row[] = useMemo(() => {
    if (!session) return [];
    const countHeld = (url: string) => {
      let n = 0;
      for (const key of loadHoldings(url).keys()) if (libraryKeys.has(key)) n += 1;
      return n;
    };
    const home = healthOf(session.url);
    const first: Row = {
      url: session.url,
      name: stats[session.url]?.name ?? 'This server',
      primary: true,
      isAdmin: session.isAdmin,
      held: libraryKeys.size,
      latencyMs: home?.latencyMs ?? null,
      ok: home?.ok ?? true,
      stats: stats[session.url] ?? null,
    };
    return [
      first,
      ...mirrors.map((m) => {
        const h = healthOf(m.url);
        return {
          url: m.url,
          name: stats[m.url]?.name ?? m.name ?? m.url.replace(/^https?:\/\//, ''),
          primary: false,
          isAdmin: m.isAdmin,
          held: countHeld(m.url),
          latencyMs: h?.latencyMs ?? null,
          ok: h?.ok ?? false,
          stats: stats[m.url] ?? null,
        };
      }),
    ];
    // `tick` is the redraw signal after a probe: latency lives in a module map
    // rather than state, deliberately (the heartbeat writes it from outside
    // React), so the page asks to be re-read rather than being told.
  }, [session, mirrors, stats, libraryKeys, tick]);

  // Which box would actually serve a song right now, by the same rule the
  // resolver uses - shown so the routing is legible instead of mysterious.
  const fastest = useMemo(() => {
    const reachable = rows.filter((r) => r.ok && r.latencyMs != null && r.held > 0);
    if (reachable.length === 0) return null;
    return reachable.reduce((a, b) => ((a.latencyMs ?? 1e9) <= (b.latencyMs ?? 1e9) ? a : b));
  }, [rows]);

  if (!session) {
    // The pane above this one already explains how to connect; there is
    // nothing about the network to show until there is one.
    return null;
  }

  if (managing) {
    const target: ServerSession | null =
      managing === session.url ? session : (mirrors.find((m) => m.url === managing) ?? null);
    if (target) {
      return (
        <StorageManager
          target={target}
          name={rows.find((r) => r.url === managing)?.name ?? managing}
          peerUrls={rows.map((r) => r.url)}
          onBack={() => {
            setManaging(null);
            void refresh();
          }}
        />
      );
    }
  }

  return (
    <div className="serversPanel">
      <header className="serversPage__head">
        <div>
          <Heading level={3} noMargin>Streaming</Heading>
          <Text size="sm" tone="muted">
            {rows.length === 1
              ? 'One server. Add another to keep a second copy and stream from whichever is closer.'
              : `${rows.length} servers · playing from ${fastest?.name ?? 'the nearest that has the song'}`}
          </Text>
        </div>
        <Button variant="ghost" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={16} />
          {busy ? 'Checking…' : 'Re-check'}
        </Button>
      </header>

      {mirrors.length > 0 && (
        <label className="serversPage__routing">
          <span>
            <Text>Stream from the closest server</Text>
            <Text size="sm" tone="muted">
              Off plays everything from this server, however far away it is.
            </Text>
          </span>
          <Switch
            checked={routing}
            onCheckedChange={(on: boolean) => {
              setRoutingPref(on);
              setRouting(on);
            }}
          />
        </label>
      )}

      <div className="serversPage__list">
        {rows.map((row) => (
          <ServerCard
            key={row.url}
            row={row}
            libraryTotal={libraryKeys.size}
            serving={fastest?.url === row.url && routing}
            onManage={row.isAdmin ? () => setManaging(row.url) : undefined}
            onForget={row.primary ? undefined : () => removeMirror(row.url)}
          />
        ))}
      </div>

      <SavedServers
        linked={rows.map((r) => r.url)}
        onLinked={() => void refresh()}
      />

      <AddServer onAdded={() => void refresh()} />
    </div>
  );
}

function ServerCard({
  row,
  libraryTotal,
  serving,
  onManage,
  onForget,
}: {
  row: Row;
  libraryTotal: number;
  serving: boolean;
  /** Only where this account can actually delete: hosts, not guests. */
  onManage?: () => void;
  onForget?: () => void;
}) {
  const near = nearness(row.latencyMs, row.ok);
  const pct = libraryTotal > 0 ? Math.round((row.held / libraryTotal) * 100) : 0;
  const used = row.stats?.bytesUsed ?? 0;
  const quota = row.stats?.quotaBytes ?? 0;
  const free = row.stats?.diskFreeBytes ?? null;
  // The tighter of the two ceilings is the honest one: a 500 GB disk behind a
  // 110 GB quota is a 110 GB server.
  const ceiling = quota > 0 && (free == null || quota - used < free) ? quota : used + (free ?? 0);
  const fullPct = ceiling > 0 ? Math.min(100, Math.round((used / ceiling) * 100)) : 0;

  return (
    <section className="serverCard" data-serving={serving || undefined}>
      <div className="serverCard__top">
        <span className="serverCard__icon" aria-hidden>
          <Radio size={18} />
        </span>
        <div className="serverCard__id">
          <Text>{row.name}</Text>
          <Text size="sm" tone="muted">
            {row.url.replace(/^https?:\/\//, '')}
            {row.primary ? ' · your library' : ''}
            {row.isAdmin ? ' · you host this' : ''}
          </Text>
        </div>
        {serving && <span className="serverCard__badge">playing from here</span>}
        {onForget && (
          <button type="button" className="serverCard__forget" onClick={onForget} aria-label="Forget this server">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="serverCard__metrics">
        <div className="serverMetric">
          <span className="serverMetric__value" data-tone={near.tone}>
            {near.value}
          </span>
          <span className="serverMetric__label">{near.label}</span>
        </div>
        <div className="serverMetric">
          <span className="serverMetric__value">
            {row.stats || row.held > 0 ? (
              <>
                {row.held.toLocaleString()}
                {!row.primary && libraryTotal > 0 ? ` · ${pct}%` : ''}
              </>
            ) : (
              <Skeleton variant="text" width="2.5rem" />
            )}
          </span>
          <span className="serverMetric__label">
            {row.primary ? 'songs' : 'of your songs'}
          </span>
        </div>
        <div className="serverMetric">
          <span className="serverMetric__value">
            {row.stats ? gb(used) : <Skeleton variant="text" width="3rem" />}
          </span>
          <span className="serverMetric__label">
            {ceiling > 0 ? `of ${gb(ceiling)} used` : 'stored'}
          </span>
        </div>
      </div>

      {!row.primary && libraryTotal > 0 && (
        <div className="serverCard__bar" role="img" aria-label={`${pct}% of your library is here`}>
          <span className="serverCard__barFill" style={{ inlineSize: `${pct}%` }} />
        </div>
      )}
      {ceiling > 0 && (
        <div className="serverCard__disk">
          <div className="serverCard__bar" data-kind="disk">
            <span
              className="serverCard__barFill"
              data-full={fullPct > 90 || undefined}
              style={{ inlineSize: `${fullPct}%` }}
            />
          </div>
          <Text size="sm" tone="muted">
            {gb(Math.max(0, ceiling - used))} free
          </Text>
        </div>
      )}
      {onManage && (
        <Button variant="ghost" className="serverCard__manage" onClick={onManage}>
          Free up space
        </Button>
      )}
    </section>
  );
}

/**
 * Adding a server, without a password crossing the room.
 *
 * The other box mints a six-digit code (Settings → link a device) and this
 * turns it into a session of its own - the same exchange the phone already
 * uses to sign in without typing. It matters more here than there: the app
 * holds ONE session, so signing into the second server to add it would sign
 * you out of the first, which is precisely the thing this page exists to
 * avoid.
 */
function AddServer({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const clean = url.trim().replace(/\/+$/, '');
    if (!clean || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const withScheme = /^https?:\/\//.test(clean) ? clean : `https://${clean}`;
      const session = await pairClaim(withScheme, code.trim());
      addMirror({
        url: withScheme,
        token: session.token,
        streamToken: session.streamToken,
        username: session.username,
        isAdmin: session.isAdmin,
      });
      await refreshHoldings({ ...session, addedAt: Date.now() } as Mirror);
      setOpen(false);
      setUrl('');
      setCode('');
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="soft" onClick={() => setOpen(true)}>
        <HardDrive size={16} />
        Add another server
      </Button>
    );
  }

  return (
    <section className="serversPage__add">
      <Text>Add a server</Text>
      <Text size="sm" tone="muted">
        On the other server, open Settings and tap “Link a device” for a six-digit code.
      </Text>
      <Field label="Address">
        <Input
          placeholder="music.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field label="Code">
        <Input
          placeholder="123456"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      {error && (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      )}
      <div className="serversPage__addActions">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={busy || !url.trim() || !code.trim()}>
          {busy ? 'Linking…' : 'Link'}
        </Button>
      </div>
    </section>
  );
}

/**
 * Servers saved to the account that this device has not linked yet.
 *
 * The account stores addresses, never tokens, so "connect" here is a real
 * sign-in: the device presents its registry identity to that server and the
 * server decides, exactly as it would for a stranger. What the account saved
 * was the reminder, not the key - which is why this can be offered on a phone
 * that has never touched the box before without any credential having
 * travelled.
 */
function SavedServers({ linked, onLinked }: { linked: string[]; onLinked: () => void }) {
  const { session: registry } = useRegistry();
  const [saved, setSaved] = useState<Membership[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchSavedServers().then((list) => {
      if (live) setSaved(list);
    });
    return () => {
      live = false;
    };
  }, [registry?.token, linked.length]);

  const missing = saved.filter((m) => !linked.includes(m.serverUrl.replace(/\/+$/, '')));
  if (!registry) {
    return (
      <Text size="sm" tone="muted">
        Sign in to your AttackFM account to save these servers and get them back on your next device.
      </Text>
    );
  }
  if (missing.length === 0) return null;

  const connect = async (m: Membership) => {
    setBusy(m.serverUrl);
    setError(null);
    try {
      const next = await enterServer(m.serverUrl, registry.token);
      addMirror({
        url: m.serverUrl,
        token: next.token,
        streamToken: next.streamToken,
        username: next.username,
        isAdmin: next.isAdmin,
        name: m.serverName || undefined,
      });
      await refreshHoldings({ ...next, addedAt: Date.now() } as Mirror);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That server would not let this device in.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="serversPage__saved">
      <Text>Saved to your account</Text>
      <Text size="sm" tone="muted">
        Signed in elsewhere. Connect to stream from them here too.
      </Text>
      {missing.map((m) => (
        <div key={m.serverUrl} className="serversPage__savedRow">
          <span>
            <Text>{m.serverName || m.serverUrl.replace(/^https?:\/\//, '')}</Text>
            <Text size="sm" tone="muted">
              {m.serverUrl.replace(/^https?:\/\//, '')}
              {m.role === 'owner' ? ' · you host this' : ''}
            </Text>
          </span>
          <Button variant="soft" disabled={busy !== null} onClick={() => void connect(m)}>
            {busy === m.serverUrl ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      ))}
      {error && (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      )}
    </section>
  );
}
