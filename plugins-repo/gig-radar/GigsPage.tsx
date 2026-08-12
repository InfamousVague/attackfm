import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Input, Spinner, Text } from '@glacier/react';
import { ExternalLink, Radar, RefreshCw } from '@glacier/icons';
import { useLibrary } from '@attackfm/app/library';
import { openExternal } from '@attackfm/app/openExternal';
import { fetchGigs, readCache, writeCache, type Gig } from './api.ts';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 12,
};

/** How many of the most-collected artists one sweep checks. */
const SWEEP = 30;
/** Requests in flight at once - polite to a public API. */
const LANE = 4;

/** The date badge a row leads with: "SEP 14". */
function dateBadge(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    .toUpperCase();
}

/**
 * The radar: sweep the top library artists, pool every upcoming show, filter
 * by whatever corner of the world the user types. The sweep is resumable-ish:
 * results land artist by artist, so the list fills while it runs.
 */
export function GigsPage() {
  const { tracks } = useLibrary();
  const [gigs, setGigs] = useState<Record<string, Gig[]>>(() => readCache()?.gigs ?? {});
  const [sweeping, setSweeping] = useState(false);
  const [swept, setSwept] = useState(0);
  const [filter, setFilter] = useState('');
  const runRef = useRef(0);

  const artists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tracks) {
      const name = t.artist.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, SWEEP)
      .map(([name]) => name);
  }, [tracks]);

  const sweep = async () => {
    if (sweeping || artists.length === 0) return;
    const run = (runRef.current += 1);
    setSweeping(true);
    setSwept(0);
    const pool: Record<string, Gig[]> = {};
    let done = 0;
    // A little lane pool: LANE fetches in flight, artists queue behind them.
    let next = 0;
    const worker = async () => {
      while (next < artists.length) {
        const mine = artists[next];
        next += 1;
        if (!mine) continue;
        const found = await fetchGigs(mine);
        if (runRef.current !== run) return;
        if (found.length > 0) {
          pool[mine] = found;
          setGigs((prev) => ({ ...prev, [mine]: found }));
        }
        done += 1;
        setSwept(done);
      }
    };
    await Promise.all(Array.from({ length: LANE }, () => worker()));
    if (runRef.current === run) {
      setGigs((prev) => {
        const merged = { ...prev, ...pool };
        writeCache(merged);
        return merged;
      });
      setSweeping(false);
    }
  };

  // One sweep on first open, unless the hour cache already answered.
  useEffect(() => {
    if (Object.keys(gigs).length === 0) void sweep();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upcoming = useMemo(() => {
    const all = Object.values(gigs).flat();
    const q = filter.trim().toLowerCase();
    const kept = q
      ? all.filter((g) =>
          [g.city, g.where, g.venue, g.artist].some((s) => s.toLowerCase().includes(q)),
        )
      : all;
    return kept.sort((a, b) => a.when.localeCompare(b.when)).slice(0, 120);
  }, [gigs, filter]);

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 780, margin: '0 auto' }}>
      <div style={row(10)}>
        <Radar size={20} />
        <div style={{ ...stack(2), flex: 1 }}>
          <Text as="h1" size="lg" weight="bold">
            Gigs
          </Text>
          <Text tone="muted" size="sm">
            Upcoming shows from your {artists.length} most-collected artists.
          </Text>
        </div>
        <Button variant="outline" size="sm" disabled={sweeping} onClick={() => void sweep()}>
          {sweeping ? <Spinner size="sm" aria-label="" /> : <RefreshCw size={14} />}
          {sweeping ? ` ${swept}/${artists.length}` : ' Sweep again'}
        </Button>
      </div>

      <Input
        value={filter}
        placeholder="Filter by city, country, venue, artist…"
        aria-label="Filter shows"
        onChange={(e) => setFilter(e.currentTarget.value)}
      />

      {upcoming.length === 0 ? (
        <Text tone="muted" size="sm" role="status">
          {sweeping
            ? `Sweeping… ${swept} of ${artists.length} artists checked.`
            : filter
              ? 'Nothing matches that filter right now.'
              : 'Nothing on the radar yet. Sweep again later, or check the filter - the feed only knows what promoters tell it.'}
        </Text>
      ) : (
        upcoming.map((g, i) => (
          <div key={`${g.artist}-${g.when}-${i}`} style={{ ...panel, ...row(12) }}>
            <span
              style={{
                minWidth: 58,
                textAlign: 'center',
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: '0.06em',
                color: 'var(--glacier-accent-text)',
              }}
            >
              {dateBadge(g.when)}
            </span>
            <div style={{ ...stack(2), flex: 1, minWidth: 0 }}>
              <Text weight="semibold">{g.artist}</Text>
              <Text tone="muted" size="xs">
                {g.venue}
                {g.city ? ` · ${g.city}` : ''}
                {g.where ? ` · ${g.where}` : ''}
              </Text>
            </div>
            {g.url && (
              <Button variant="outline" size="sm" onClick={() => void openExternal(g.url!)}>
                <ExternalLink size={14} /> Tickets
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
