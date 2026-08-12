import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Spinner, Text } from '@glacier/react';
import { History, Play } from '@glacier/icons';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import type { Track } from '@attackfm/app/tauri';
import type { PluginPageProps } from '../../src/plugins/types.ts';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 12,
};

interface RewindYear {
  yearsAgo: number;
  tracks: Array<{ id: number; plays: number }>;
}

/** A server track's row id out of its `afm://<id>` path, or null for local
 *  files - the same convention server.ts uses, restated here because the
 *  helper is not part of the host seam. */
function idFromPath(path: string): number | null {
  const m = /^afm:\/\/(\d+)$/.exec(path);
  return m && m[1] ? Number.parseInt(m[1], 10) : null;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const YEAR_MS = Math.round(365.25 * 24 * 60 * 60 * 1000);

/**
 * The cabin. One fetch on mount fills the played-then shelves; the arrivals
 * shelves are pure library maths. Every shelf plays as a set, most-played
 * (or newest-arrived) first.
 */
export function TimeMachinePage({ onPlay }: PluginPageProps) {
  const { tracks } = useLibrary();
  const { session } = useServerSession();
  const [years, setYears] = useState<RewindYear[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current || !session) return;
    fetched.current = true;
    fetch(`${session.url}/api/rewind`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? 'Your home server does not have the time machine yet - update it to travel.'
              : `The hub answered ${response.status}.`,
          );
        }
        const body = (await response.json()) as { years?: RewindYear[] };
        setYears(body.years ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'The ledger did not answer.');
        setYears([]);
      });
  }, [session]);

  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracks) {
      const id = idFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [tracks]);

  const thisYear = new Date().getFullYear();

  const playedShelves = useMemo(
    () =>
      (years ?? [])
        .map((y) => ({
          label: `On repeat in ${thisYear - y.yearsAgo}`,
          tracks: y.tracks.map((t) => byId.get(t.id)).filter((t): t is Track => !!t),
        }))
        .filter((s) => s.tracks.length >= 3),
    [years, byId, thisYear],
  );

  /** What ARRIVED around this date, per past year with enough of a delivery. */
  const arrivalShelves = useMemo(() => {
    const now = Date.now();
    const out: Array<{ label: string; tracks: Track[] }> = [];
    for (let k = 1; k <= 8; k += 1) {
      const centre = now - k * YEAR_MS;
      const found = tracks
        .filter((t) => Math.abs(t.addedAt - centre) < MONTH_MS / 2)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, 30);
      if (found.length >= 3) out.push({ label: `Arrived in ${thisYear - k}`, tracks: found });
    }
    return out;
  }, [tracks, thisYear]);

  const shelf = (label: string, set: Track[], key: string) => (
    <div key={key} style={{ ...panel, ...stack(8) }}>
      <div style={row(10)}>
        <Text weight="semibold" style={{ flex: 1 }}>
          {label}
        </Text>
        <Text tone="muted" size="xs">
          {set.length} songs
        </Text>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const first = set[0];
            if (first) onPlay(first, set);
          }}
        >
          <Play size={14} /> Play
        </Button>
      </div>
      <Text tone="muted" size="xs">
        {set
          .slice(0, 4)
          .map((t) => `${t.title} — ${t.artist}`)
          .join(' · ')}
        {set.length > 4 ? ' · …' : ''}
      </Text>
    </div>
  );

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 780, margin: '0 auto' }}>
      <div style={row(10)}>
        <History size={20} />
        <div style={{ ...stack(2), flex: 1 }}>
          <Text as="h1" size="lg" weight="bold">
            Time machine
          </Text>
          <Text tone="muted" size="sm">
            Around this date, in the years the ledger remembers.
          </Text>
        </div>
      </div>

      {years === null && !error && (
        <div style={row(8)}>
          <Spinner size="sm" aria-label="" />
          <Text tone="muted" size="sm">
            Reading the ledger…
          </Text>
        </div>
      )}
      {error && (
        <Text tone="danger" size="sm" role="status">
          {error}
        </Text>
      )}

      {playedShelves.map((s, i) => shelf(s.label, s.tracks, `p-${i}`))}
      {arrivalShelves.map((s, i) => shelf(s.label, s.tracks, `a-${i}`))}

      {years !== null && playedShelves.length === 0 && arrivalShelves.length === 0 && !error && (
        <Text tone="muted" size="sm">
          The ledger is still young - come back when this date has some history behind it.
        </Text>
      )}
    </div>
  );
}
