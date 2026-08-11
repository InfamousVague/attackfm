/**
 * The Storage lens: one GET, one page of answers to "where did the disk go".
 * Headline totals up top, then the codec split as a stacked bar, the top
 * artists and albums as plain div-width bar rows (no chart library - the
 * numbers are the point, the bars are just proportion), the collector's
 * ledger against its cap when the server runs one, and the albums that cost
 * the most disk for the fewest listens.
 */
import { useEffect, useState } from 'react';
import { Button, Text } from '@glacier/react';
import { RefreshCw } from '@glacier/icons';
import {
  MissingEndpointError,
  fetchStorage,
  type ServerSession,
  type StorageReport,
} from './api.ts';
import {
  BusyRow,
  ErrorNote,
  MissingNote,
  QuietNote,
  ToolShell,
  panel,
  row,
  stack,
} from './ui.tsx';
import { prettyBytes } from './format.ts';

const TOOL = 'Storage lens';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; report: StorageReport };

/**
 * Segment colors for the codec bar. Fixed hues rather than theme tokens: the
 * segments must stay distinguishable from EACH OTHER, which one accent token
 * cannot do. Muted enough to sit inside a glacier surface in either theme.
 */
const CODEC_COLORS = ['#6b9fd8', '#7fc8a9', '#e0bd6e', '#d88a6b', '#a08cd8', '#6bc4d8', '#c46bd8'];

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...panel, ...stack(4), minWidth: 140, flex: 1 }}>
      <Text tone="muted" size="xs">
        {label}
      </Text>
      <Text size="lg" weight="semibold" mono>
        {value}
      </Text>
      {sub && (
        <Text tone="subtle" size="xs">
          {sub}
        </Text>
      )}
    </div>
  );
}

/** A labelled proportion row: name, bytes, and a width-is-share bar under. */
function BarRow({ label, sub, bytes, max }: { label: string; sub?: string; bytes: number; max: number }) {
  const share = max > 0 ? Math.max(2, (bytes / max) * 100) : 0;
  return (
    <div style={stack(3)}>
      <div style={row(8)}>
        <Text
          size="sm"
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {label}
          {sub && (
            <Text as="span" tone="muted" size="xs">
              {'  '}
              {sub}
            </Text>
          )}
        </Text>
        <Text tone="muted" size="xs" mono>
          {prettyBytes(bytes)}
        </Text>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 'var(--glacier-radius-full)',
          background: 'var(--glacier-surface-sunken)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${share}%`,
            height: '100%',
            borderRadius: 'var(--glacier-radius-full)',
            background: 'var(--glacier-accent-solid)',
            opacity: 0.75,
          }}
        />
      </div>
    </div>
  );
}

export function StorageLens({ session, onBack }: { session: ServerSession; onBack: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoaded({ phase: 'loading' });
    fetchStorage(session)
      .then((report) => {
        if (!stale) setLoaded({ phase: 'ready', report });
      })
      .catch((e: unknown) => {
        if (stale) return;
        if (e instanceof MissingEndpointError) setLoaded({ phase: 'missing' });
        else setLoaded({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      stale = true;
    };
  }, [session, nonce]);

  return (
    <ToolShell
      title={TOOL}
      blurb="Where the server's disk went, and what could give it back."
      onBack={onBack}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw size={14} /> Refresh
        </Button>
      }
    >
      {loaded.phase === 'loading' && <BusyRow label="Measuring the library…" />}
      {loaded.phase === 'missing' && <MissingNote tool={TOOL} />}
      {loaded.phase === 'error' && (
        <ErrorNote message={loaded.message} onRetry={() => setNonce((n) => n + 1)} />
      )}
      {loaded.phase === 'ready' &&
        (() => {
          const r = loaded.report;
          const codecTotal = r.byCodec.reduce((sum, c) => sum + c.bytes, 0);
          const topArtists = r.byArtist.slice(0, 10);
          const topAlbums = r.byAlbum.slice(0, 10);
          const artistMax = topArtists[0]?.bytes ?? 0;
          const albumMax = topAlbums[0]?.bytes ?? 0;
          const ledgerShare =
            r.collector && r.collector.capBytes > 0
              ? Math.min(100, (r.collector.ledgerBytes / r.collector.capBytes) * 100)
              : 0;
          return (
            <>
              <div style={{ ...row(12), flexWrap: 'wrap', alignItems: 'stretch' }}>
                <StatTile
                  label="Library"
                  value={prettyBytes(r.libraryBytes)}
                  sub={`${r.trackCount.toLocaleString()} tracks`}
                />
                <StatTile label="Album art" value={prettyBytes(r.artBytes)} />
                <StatTile label="Transcodes" value={prettyBytes(r.transcodeBytes)} sub="Safe to clear; rebuilt on demand" />
                <StatTile label="Trash" value={prettyBytes(r.trashBytes)} sub="Dropped duplicates land here" />
              </div>

              <div style={{ ...panel, ...stack(10) }}>
                <Text weight="medium">By codec</Text>
                {codecTotal === 0 ? (
                  <Text tone="muted" size="sm">
                    Nothing measured yet.
                  </Text>
                ) : (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        height: 14,
                        borderRadius: 'var(--glacier-radius-full)',
                        overflow: 'hidden',
                      }}
                    >
                      {r.byCodec.map((c, i) => (
                        <div
                          key={c.codec}
                          title={`${c.codec}: ${prettyBytes(c.bytes)}`}
                          style={{
                            width: `${(c.bytes / codecTotal) * 100}%`,
                            background: CODEC_COLORS[i % CODEC_COLORS.length],
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ ...row(14), flexWrap: 'wrap' }}>
                      {r.byCodec.map((c, i) => (
                        <span key={c.codec} style={row(6)}>
                          <span
                            aria-hidden
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: '50%',
                              background: CODEC_COLORS[i % CODEC_COLORS.length],
                            }}
                          />
                          <Text tone="muted" size="xs">
                            {c.codec.toUpperCase() || 'unknown'} · {prettyBytes(c.bytes)} ·{' '}
                            {c.tracks.toLocaleString()} tracks
                          </Text>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <div style={{ ...row(14), alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ ...panel, ...stack(10), flex: 1, minWidth: 280 }}>
                  <Text weight="medium">Biggest artists</Text>
                  {topArtists.map((a) => (
                    <BarRow
                      key={a.artist}
                      label={a.artist}
                      sub={`${a.tracks} tracks`}
                      bytes={a.bytes}
                      max={artistMax}
                    />
                  ))}
                  {topArtists.length === 0 && (
                    <Text tone="muted" size="sm">
                      Nothing yet.
                    </Text>
                  )}
                </div>
                <div style={{ ...panel, ...stack(10), flex: 1, minWidth: 280 }}>
                  <Text weight="medium">Biggest albums</Text>
                  {topAlbums.map((a) => (
                    <BarRow
                      key={`${a.album} ${a.albumArtist}`}
                      label={a.album}
                      sub={a.albumArtist}
                      bytes={a.bytes}
                      max={albumMax}
                    />
                  ))}
                  {topAlbums.length === 0 && (
                    <Text tone="muted" size="sm">
                      Nothing yet.
                    </Text>
                  )}
                </div>
              </div>

              {r.collector && (
                <div style={{ ...panel, ...stack(8) }}>
                  <Text weight="medium">Collector ledger</Text>
                  <div style={row(10)}>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 'var(--glacier-radius-full)',
                        background: 'var(--glacier-surface-sunken)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${ledgerShare}%`,
                          height: '100%',
                          background:
                            ledgerShare > 90
                              ? 'var(--glacier-warning-text, #e0bd6e)'
                              : 'var(--glacier-accent-solid)',
                        }}
                      />
                    </div>
                    <Text tone="muted" size="xs" mono>
                      {prettyBytes(r.collector.ledgerBytes)} / {prettyBytes(r.collector.capBytes)}
                    </Text>
                  </div>
                  <Text tone="subtle" size="xs">
                    What the curator has downloaded on its own, against the cap it is allowed.
                  </Text>
                </div>
              )}

              <div style={{ ...panel, ...stack(10) }}>
                <Text weight="medium">Big but barely played</Text>
                <Text tone="muted" size="xs">
                  The largest albums with two listens or fewer - the first place to reclaim space.
                </Text>
                {r.rarelyPlayed.length === 0 && (
                  <Text tone="muted" size="sm">
                    Everything big gets played. Good sign.
                  </Text>
                )}
                {r.rarelyPlayed.map((a) => (
                  <div key={`${a.album} ${a.albumArtist}`} style={row(8)}>
                    <Text
                      size="sm"
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {a.album}
                      <Text as="span" tone="muted" size="xs">
                        {'  '}
                        {a.albumArtist}
                      </Text>
                    </Text>
                    <Text tone="muted" size="xs">
                      {a.plays} {a.plays === 1 ? 'play' : 'plays'}
                    </Text>
                    <Text tone="muted" size="xs" mono>
                      {prettyBytes(a.bytes)}
                    </Text>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      {loaded.phase === 'ready' && (
        <QuietNote>
          Numbers are measured on the server, so they cover the whole library - not just what this
          device has synced.
        </QuietNote>
      )}
    </ToolShell>
  );
}
