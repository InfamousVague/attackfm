import { useMemo } from 'react';

/**
 * The server's own wall: the covers and Canvas clips `/api/wall` handed out,
 * in the app's front-door treatment (servers/ArtWall - four columns drifting
 * at four speeds, tilted, blurred), so the invite page shows the library it
 * is inviting to rather than a stock set. Clips are tiles like any other,
 * muted and looping; a wall is a texture, not a screening.
 */
const DURATIONS = ['46s', '55s', '64s', '73s'];
const COLUMNS = DURATIONS.length;

type Tile = { kind: 'img' | 'video'; src: string };

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function LiveWall({ covers, canvases }: { covers: string[]; canvases: string[] }) {
  const cols = useMemo(() => {
    const tiles: Tile[] = shuffled([
      ...covers.map((src) => ({ kind: 'img' as const, src })),
      ...canvases.map((src) => ({ kind: 'video' as const, src })),
    ]);
    const out: Tile[][] = Array.from({ length: COLUMNS }, () => []);
    tiles.forEach((t, i) => out[i % COLUMNS]!.push(t));
    return out;
  }, [covers, canvases]);
  return (
    <div className="artWall" aria-hidden="true">
      {cols.map((tiles, i) => (
        <div
          key={i}
          className="artWall__col"
          data-dir={i % 2 === 0 ? 'up' : 'down'}
          style={{ ['--wall-dur' as string]: DURATIONS[i] }}
        >
          {[...tiles, ...tiles].map((t, j) =>
            t.kind === 'video' ? (
              <video key={j} src={t.src} muted loop autoPlay playsInline preload="metadata" />
            ) : (
              <img key={j} src={t.src} alt="" loading="eager" decoding="async" />
            ),
          )}
        </div>
      ))}
    </div>
  );
}
