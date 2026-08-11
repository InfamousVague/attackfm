/**
 * The Duplicate finder: the server clusters probable same-recordings (same
 * normalized title and artist, durations within 2s) and this page lets the
 * user pick which copy survives. The default keep is the largest lossless
 * file - the copy you would re-rip toward - falling back to the largest file
 * when nothing in the cluster is lossless.
 *
 * Resolving is deliberately ceremonial: a modal spells out that the dropped
 * files MOVE to the server's trash folder, never deleted, and that playlists,
 * favorites, and play history follow the kept copy. The endpoint re-points
 * those rows before the move, so nothing a listener built goes dangling.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Radio, Text, useHaptics } from '@glacier/react';
import { RefreshCw } from '@glacier/icons';
import {
  MissingEndpointError,
  fetchDuplicates,
  resolveDuplicates,
  type DuplicateCluster,
  type RemoteTrack,
  type ServerSession,
} from './api.ts';
import {
  AdminNote,
  BusyRow,
  Chip,
  ErrorNote,
  MissingNote,
  QuietNote,
  ToolShell,
  panel,
  row,
  stack,
} from './ui.tsx';
import { prettyBitrate, prettyBytes, prettyDuration } from './format.ts';

const TOOL = 'Duplicate finder';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; clusters: DuplicateCluster[] };

/** The copy worth keeping by default: lossless beats lossy, then size. */
function bestOf(tracks: RemoteTrack[]): number | undefined {
  let best: RemoteTrack | undefined;
  for (const t of tracks) {
    if (!best) best = t;
    else if (t.lossless !== best.lossless) best = t.lossless ? t : best;
    else if ((t.sizeBytes ?? 0) > (best.sizeBytes ?? 0)) best = t;
  }
  return best?.id;
}

export function DuplicateFinder({ session, onBack }: { session: ServerSession; onBack: () => void }) {
  const haptic = useHaptics();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);
  // keep[i] = the surviving track id for cluster i; seeded on load.
  const [keep, setKeep] = useState<Record<number, number>>({});
  const [confirming, setConfirming] = useState<number | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolvedNote, setResolvedNote] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoaded({ phase: 'loading' });
    setResolveError(null);
    fetchDuplicates(session)
      .then((clusters) => {
        if (stale) return;
        setLoaded({ phase: 'ready', clusters });
        const seeded: Record<number, number> = {};
        clusters.forEach((c, i) => {
          const id = bestOf(c.tracks);
          if (id != null) seeded[i] = id;
        });
        setKeep(seeded);
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

  const clusters = loaded.phase === 'ready' ? loaded.clusters : [];
  const confirmCluster = confirming !== null ? clusters[confirming] : null;

  const dropList = useMemo(() => {
    if (confirming === null || !confirmCluster) return [];
    const kept = keep[confirming];
    return confirmCluster.tracks.filter((t) => t.id !== kept);
  }, [confirming, confirmCluster, keep]);

  const resolve = (index: number) => {
    const cluster = clusters[index];
    const kept = keep[index];
    if (!cluster || kept == null) return;
    const drop = cluster.tracks.filter((t) => t.id !== kept).map((t) => t.id);
    setConfirming(null);
    setResolving(index);
    setResolveError(null);
    setResolvedNote(null);
    resolveDuplicates(session, kept, drop)
      .then((reply) => {
        haptic('success');
        setResolvedNote(
          `Merged - ${reply.dropped} ${reply.dropped === 1 ? 'file' : 'files'} moved to the ` +
            "server's trash folder.",
        );
        // Drop the cluster locally; re-fetching would renumber the rest under
        // the user's feet.
        setLoaded((prev) =>
          prev.phase === 'ready'
            ? { phase: 'ready', clusters: prev.clusters.filter((_, i) => i !== index) }
            : prev,
        );
        setKeep((prev) => {
          const next: Record<number, number> = {};
          for (const [k, v] of Object.entries(prev)) {
            const i = Number(k);
            if (i < index) next[i] = v;
            else if (i > index) next[i - 1] = v;
          }
          return next;
        });
      })
      .catch((e: unknown) => {
        if (e instanceof MissingEndpointError) setLoaded({ phase: 'missing' });
        else setResolveError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setResolving(null));
  };

  return (
    <ToolShell
      title={TOOL}
      blurb="Same recording, more than one file. Keep the best copy; the rest move to trash."
      onBack={onBack}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw size={14} /> Rescan
        </Button>
      }
    >
      {!session.isAdmin && loaded.phase === 'ready' && clusters.length > 0 && (
        <AdminNote verb="merge duplicates" />
      )}
      {loaded.phase === 'loading' && <BusyRow label="Comparing every track against every other…" />}
      {loaded.phase === 'missing' && <MissingNote tool={TOOL} />}
      {loaded.phase === 'error' && (
        <ErrorNote message={loaded.message} onRetry={() => setNonce((n) => n + 1)} />
      )}
      {resolvedNote && (
        <Text tone="success" size="sm">
          {resolvedNote}
        </Text>
      )}
      {resolveError && <ErrorNote message={resolveError} />}
      {loaded.phase === 'ready' && clusters.length === 0 && (
        <QuietNote>No duplicates found. The library is clean.</QuietNote>
      )}
      {loaded.phase === 'ready' &&
        clusters.map((cluster, index) => (
          <div key={cluster.tracks.map((t) => t.id).join('-')} style={{ ...panel, ...stack(10) }}>
            <Text weight="medium">
              {cluster.tracks[0]?.title || 'Untitled'}{' '}
              <Text as="span" tone="muted" size="sm">
                · {cluster.tracks[0]?.artist}
              </Text>
            </Text>
            {cluster.tracks.map((t) => (
              <label key={t.id} style={{ ...row(10), cursor: 'pointer' }}>
                <Radio
                  name={`dupe-${index}`}
                  checked={keep[index] === t.id}
                  onChange={() => setKeep((prev) => ({ ...prev, [index]: t.id }))}
                  label=""
                />
                <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                  <Text
                    size="sm"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {t.album || 'Unknown album'}
                    {t.year != null ? ` (${t.year})` : ''}
                  </Text>
                  <span style={row(6)}>
                    <Chip accent={t.lossless}>{t.lossless ? 'Lossless' : t.codec.toUpperCase() || 'Lossy'}</Chip>
                    {t.lossless && t.codec && <Chip>{t.codec.toUpperCase()}</Chip>}
                    {prettyBitrate(t.bitrate) && <Chip>{prettyBitrate(t.bitrate)}</Chip>}
                    <Chip>{prettyBytes(t.sizeBytes)}</Chip>
                    <Chip>{prettyDuration(t.duration)}</Chip>
                  </span>
                </span>
                {keep[index] === t.id && (
                  <Text tone="accent" size="xs" weight="medium">
                    keep
                  </Text>
                )}
              </label>
            ))}
            <div style={row(10)}>
              <Button
                variant="outline"
                size="sm"
                disabled={!session.isAdmin || resolving !== null}
                loading={resolving === index}
                onClick={() => setConfirming(index)}
              >
                Resolve · keep 1, drop {cluster.tracks.length - 1}
              </Button>
            </div>
          </div>
        ))}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Merge these duplicates?"
        description="Nothing is deleted."
        size="sm"
        footer={
          <div style={row(10)}>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => confirming !== null && resolve(confirming)}
            >
              Move {dropList.length} to trash
            </Button>
          </div>
        }
      >
        <Text size="sm" tone="muted">
          Playlists, favorites, and play history move to the copy you kept. The{' '}
          {dropList.length === 1 ? 'dropped file moves' : `${dropList.length} dropped files move`} into
          the server&rsquo;s <code>.attackfm-trash</code> folder - not deleted - so you can pull
          {dropList.length === 1 ? ' it' : ' them'} back by hand if this was wrong.
        </Text>
      </Modal>
    </ToolShell>
  );
}
