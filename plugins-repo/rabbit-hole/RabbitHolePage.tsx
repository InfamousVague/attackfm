import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Input, Pill, Spinner, Text } from '@glacier/react';
import { ArrowLeft, Check, Rabbit } from '@glacier/icons';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import type { PluginPageProps } from '../../src/plugins/types.ts';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });

interface Neighbour {
  name: string;
  picture: string | null;
  fans: number | null;
}

/** One hop of the walk, cached per artist for the session. */
const hops = new Map<string, Neighbour[]>();

async function fetchRelated(
  session: { url: string; token: string },
  artist: string,
): Promise<Neighbour[]> {
  const cached = hops.get(artist.toLowerCase());
  if (cached) return cached;
  const response = await fetch(
    `${session.url}/api/related?artist=${encodeURIComponent(artist)}`,
    { headers: { authorization: `Bearer ${session.token}` } },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'Your home server does not know this map yet - update it to walk the rabbit hole.'
        : `The hub answered ${response.status}.`,
    );
  }
  const body = (await response.json()) as { artists?: Array<Partial<Neighbour>> };
  const out = (body.artists ?? [])
    .filter((a): a is Neighbour & { name: string } => typeof a.name === 'string')
    .map((a) => ({ name: a.name, picture: a.picture ?? null, fans: a.fans ?? null }));
  hops.set(artist.toLowerCase(), out);
  return out;
}

function fansWord(fans: number | null): string | null {
  if (fans === null) return null;
  if (fans >= 1_000_000) return `${(fans / 1_000_000).toFixed(1)}m fans`;
  if (fans >= 1_000) return `${Math.round(fans / 1_000)}k fans`;
  return `${fans} fans`;
}

/**
 * The walk. `trail` is the whole state: empty means the trailhead (pick an
 * artist you own), otherwise the last entry is where you stand and the rest
 * is the way back. Owned artists carry a check; tapping an owned artist's
 * mark opens them in the library, tapping the card walks on.
 */
export function RabbitHolePage({ onOpenArtist }: PluginPageProps) {
  const { tracks } = useLibrary();
  const { session } = useServerSession();
  const [trail, setTrail] = useState<string[]>([]);
  const [neighbours, setNeighbours] = useState<Neighbour[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState('');
  const runRef = useRef(0);

  const owned = useMemo(() => {
    const set = new Set<string>();
    for (const t of tracks) set.add(t.artist.trim().toLowerCase());
    return set;
  }, [tracks]);

  const topArtists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tracks) {
      const name = t.artist.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
  }, [tracks]);

  const here = trail[trail.length - 1] ?? null;

  useEffect(() => {
    if (!here || !session) return;
    const run = (runRef.current += 1);
    setNeighbours(null);
    setError(null);
    fetchRelated(session, here)
      .then((found) => {
        if (runRef.current === run) setNeighbours(found);
      })
      .catch((err: unknown) => {
        if (runRef.current === run) {
          setError(err instanceof Error ? err.message : 'The map did not answer.');
          setNeighbours([]);
        }
      });
  }, [here, session]);

  const walkTo = (name: string) => setTrail((t) => [...t, name]);

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 860, margin: '0 auto' }}>
      <div style={row(10)}>
        {here ? (
          <Button variant="ghost" size="sm" onClick={() => setTrail((t) => t.slice(0, -1))}>
            <ArrowLeft size={15} /> {trail.length > 1 ? trail[trail.length - 2] : 'Trailhead'}
          </Button>
        ) : (
          <Rabbit size={20} />
        )}
        <div style={{ ...stack(2), flex: 1, minWidth: 0 }}>
          <Text as="h1" size="lg" weight="bold">
            {here ?? 'Rabbit hole'}
          </Text>
          <Text tone="muted" size="sm">
            {here
              ? `Who the catalogue shelves beside ${here}.`
              : 'Pick a door. Every artist opens onto their neighbours.'}
          </Text>
        </div>
        {here && owned.has(here.toLowerCase()) && (
          <Button variant="outline" size="sm" onClick={() => onOpenArtist(here)}>
            In your library
          </Button>
        )}
      </div>

      {!here && (
        <>
          <div style={{ ...row(8), flexWrap: 'wrap' }}>
            {topArtists.map((name) => (
              <Button key={name} variant="outline" size="sm" onClick={() => walkTo(name)}>
                {name}
              </Button>
            ))}
          </div>
          <div style={row(8)}>
            <Input
              value={seed}
              placeholder="…or start anywhere"
              aria-label="Start artist"
              onChange={(e) => setSeed(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && seed.trim()) {
                  walkTo(seed.trim());
                  setSeed('');
                }
              }}
            />
            <Button
              variant="solid"
              size="sm"
              disabled={seed.trim() === ''}
              onClick={() => {
                walkTo(seed.trim());
                setSeed('');
              }}
            >
              Walk
            </Button>
          </div>
        </>
      )}

      {here && neighbours === null && !error && (
        <div style={row(8)}>
          <Spinner size="sm" aria-label="" />
          <Text tone="muted" size="sm">
            Asking the map…
          </Text>
        </div>
      )}
      {error && (
        <Text tone="danger" size="sm" role="status">
          {error}
        </Text>
      )}

      {neighbours && neighbours.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(9.5rem, 1fr))',
            gap: 12,
          }}
        >
          {neighbours.map((n) => {
            const have = owned.has(n.name.toLowerCase());
            const fans = fansWord(n.fans);
            return (
              <button
                key={n.name}
                type="button"
                onClick={() => walkTo(n.name)}
                style={{
                  ...stack(6),
                  alignItems: 'center',
                  textAlign: 'center',
                  background: 'var(--glacier-surface)',
                  border: '1px solid var(--glacier-border-subtle)',
                  borderRadius: 'var(--glacier-radius-lg)',
                  padding: 14,
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: '50%',
                    overflow: 'hidden',
                    background: 'var(--glacier-surface-sunken)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  aria-hidden
                >
                  {n.picture ? (
                    <img
                      src={n.picture}
                      alt=""
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Rabbit size={24} />
                  )}
                </span>
                <Text weight="semibold" size="sm">
                  {n.name}
                </Text>
                <span style={row(6)}>
                  {fans && (
                    <Text tone="muted" size="xs">
                      {fans}
                    </Text>
                  )}
                  {have && (
                    <Pill size="sm" tone="accent">
                      <Check size={11} /> owned
                    </Pill>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {neighbours && neighbours.length === 0 && !error && (
        <Text tone="muted" size="sm">
          The map has no neighbours for this one. Step back and try another door.
        </Text>
      )}
    </div>
  );
}
