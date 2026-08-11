/**
 * The Art fixer: albums with no cover float to the top, picking one asks the
 * server for candidates (iTunes, Deezer, Cover Art Archive - the search runs
 * server-side, so no CORS fight here), and choosing a candidate embeds it
 * into every file of the album. The write happens on the hub and bumps the
 * library rev, so the new cover ripples to every device through the normal
 * delta sync - the note under the button says as much.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner, Text, useHaptics } from '@glacier/react';
import { Image, Search } from '@glacier/icons';
import {
  MissingEndpointError,
  fetchArtCandidates,
  applyAlbumArt,
  groupAlbums,
  rowArtUrl,
  useLibraryRows,
  type AlbumGroup,
  type ArtCandidate,
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
  coverBox,
  coverImg,
  panel,
  row,
  rowButton,
  stack,
} from './ui.tsx';

const TOOL = 'Art fixer';

/** How many albums to render at once; a filter narrows past this. */
const LIST_CAP = 200;

type Candidates =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; candidates: ArtCandidate[] };

const SOURCE_LABEL: Record<ArtCandidate['source'], string> = {
  itunes: 'iTunes',
  deezer: 'Deezer',
  caa: 'Cover Art Archive',
};

export function ArtFixer({ session, onBack }: { session: ServerSession; onBack: () => void }) {
  const haptic = useHaptics();
  const { rows, error: rowsError, reload, patch } = useLibraryRows(session);
  const [filter, setFilter] = useState('');
  // The selection is the album's identity, not the group object - the groups
  // are recomputed whenever a write patches the rows underneath them.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  const albums = useMemo(() => {
    const groups = groupAlbums(rows ?? []);
    // Coverless first - they are what this tool is for - then alphabetical so
    // the list reads the same on every visit.
    return groups.sort((a, b) => {
      if (!a.artId !== !b.artId) return a.artId ? 1 : -1;
      return (
        a.albumArtist.localeCompare(b.albumArtist) || a.album.localeCompare(b.album)
      );
    });
  }, [rows]);

  const keyOf = (a: AlbumGroup) => `${a.album}\u0000${a.albumArtist}`;
  const selected = albums.find((a) => keyOf(a) === selectedKey) ?? null;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? albums.filter(
          (a) => a.album.toLowerCase().includes(q) || a.albumArtist.toLowerCase().includes(q),
        )
      : albums;
    return matched.slice(0, LIST_CAP);
  }, [albums, filter]);

  const missingCount = useMemo(() => albums.filter((a) => !a.artId).length, [albums]);

  // Selecting an album asks the server for candidates; reselecting refetches,
  // which doubles as the retry path.
  const [fetchNonce, setFetchNonce] = useState(0);
  useEffect(() => {
    if (!selected) {
      setCandidates(null);
      return;
    }
    let stale = false;
    setCandidates({ phase: 'loading' });
    setApplyError(null);
    setAppliedNote(null);
    fetchArtCandidates(session, selected.albumArtist, selected.album)
      .then((found) => {
        if (!stale) setCandidates({ phase: 'ready', candidates: found });
      })
      .catch((e: unknown) => {
        if (stale) return;
        if (e instanceof MissingEndpointError) setCandidates({ phase: 'missing' });
        else setCandidates({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      stale = true;
    };
    // selectedKey rather than selected: the group object churns with rows.
  }, [session, selectedKey, fetchNonce]);

  const apply = (candidate: ArtCandidate) => {
    if (!selected || applying) return;
    const { album, albumArtist } = selected;
    setApplying(candidate.url);
    setApplyError(null);
    setAppliedNote(null);
    applyAlbumArt(session, album, albumArtist, candidate.url)
      .then((reply) => {
        haptic('success');
        setAppliedNote(
          `Cover applied to ${reply.updated} ${reply.updated === 1 ? 'file' : 'files'} - every ` +
            'device picks it up on its next sync.',
        );
        // Reflect the new art id locally; the delta sync will confirm it.
        if (reply.artId) {
          patch((all) =>
            all.map((r) =>
              (r.album || 'Unknown album') === album &&
              (r.albumArtist || r.artist || 'Unknown artist') === albumArtist
                ? { ...r, artId: reply.artId }
                : r,
            ),
          );
        }
      })
      .catch((e: unknown) => {
        if (e instanceof MissingEndpointError) setCandidates({ phase: 'missing' });
        else setApplyError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setApplying(null));
  };

  // --- the album detail: current art beside the candidates ------------------
  if (selected) {
    return (
      <ToolShell
        title={selected.album}
        blurb={`${selected.albumArtist} · ${selected.tracks.length} ${selected.tracks.length === 1 ? 'track' : 'tracks'}`}
        onBack={() => setSelectedKey(null)}
      >
        {!session.isAdmin && <AdminNote verb="write album art" />}
        <div style={{ ...row(16), alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={stack(6)}>
            <Text tone="muted" size="xs">
              Current cover
            </Text>
            <div style={{ ...coverBox, width: 160, height: 160 }}>
              {selected.artId ? (
                <img src={rowArtUrl(session, selected.artId, 640)} alt="" style={coverImg} />
              ) : (
                <Image size={34} />
              )}
            </div>
            {!selected.artId && <Chip>No art</Chip>}
          </div>
          <div style={{ flex: 1, minWidth: 260, ...stack(10) }}>
            <Text tone="muted" size="xs">
              Candidates
            </Text>
            {candidates?.phase === 'loading' && <BusyRow label="Searching iTunes, Deezer, and the Cover Art Archive…" />}
            {candidates?.phase === 'missing' && <MissingNote tool={TOOL} />}
            {candidates?.phase === 'error' && (
              <ErrorNote message={candidates.message} onRetry={() => setFetchNonce((n) => n + 1)} />
            )}
            {candidates?.phase === 'ready' && candidates.candidates.length === 0 && (
              <QuietNote>
                None of the sources knows this album - check the album and artist tags first
                (the Metadata doctor can fix them).
              </QuietNote>
            )}
            {candidates?.phase === 'ready' && candidates.candidates.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: 12,
                }}
              >
                {candidates.candidates.map((candidate) => (
                  <button
                    key={candidate.url}
                    type="button"
                    disabled={!session.isAdmin || applying !== null}
                    onClick={() => apply(candidate)}
                    style={{
                      ...panel,
                      ...stack(6),
                      padding: 8,
                      cursor: session.isAdmin && !applying ? 'pointer' : 'default',
                      font: 'inherit',
                      color: 'var(--glacier-text)',
                      opacity: applying && applying !== candidate.url ? 0.5 : 1,
                      position: 'relative',
                    }}
                  >
                    <div style={{ ...coverBox, width: '100%', height: 'auto', aspectRatio: '1' }}>
                      <img src={candidate.url} alt="" loading="lazy" style={coverImg} />
                    </div>
                    {applying === candidate.url && (
                      <span
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'color-mix(in srgb, var(--glacier-bg) 55%, transparent)',
                          borderRadius: 'var(--glacier-radius-lg)',
                        }}
                      >
                        <Spinner size="md" aria-label="Applying cover" />
                      </span>
                    )}
                    <div style={row(6)}>
                      <Chip accent>{SOURCE_LABEL[candidate.source]}</Chip>
                      {candidate.width && candidate.height && (
                        <Chip>
                          {candidate.width}×{candidate.height}
                        </Chip>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {applyError && <ErrorNote message={applyError} />}
            {appliedNote && (
              <Text tone="success" size="sm">
                {appliedNote}
              </Text>
            )}
          </div>
        </div>
      </ToolShell>
    );
  }

  // --- the album list, coverless first --------------------------------------
  return (
    <ToolShell
      title={TOOL}
      blurb="Albums missing a cover come first. Pick one to search the art sources."
      onBack={onBack}
    >
      <Input
        size="md"
        leadingIcon={<Search size={15} />}
        placeholder="Filter albums…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {rows === null && <BusyRow label="Reading the library…" />}
      {rowsError && <ErrorNote message={rowsError} onRetry={reload} />}
      {rows !== null && !rowsError && (
        <>
          <Text tone="muted" size="xs">
            {missingCount === 0
              ? 'Every album has a cover. Nothing to fix.'
              : `${missingCount} ${missingCount === 1 ? 'album is' : 'albums are'} missing art.`}
          </Text>
          <div style={{ ...panel, padding: 4, ...stack(0) }}>
            {shown.map((album) => (
              <button
                key={keyOf(album)}
                type="button"
                style={rowButton}
                onClick={() => setSelectedKey(keyOf(album))}
              >
                <span style={coverBox}>
                  {album.artId ? (
                    <img
                      src={rowArtUrl(session, album.artId, 160)}
                      alt=""
                      loading="lazy"
                      style={coverImg}
                    />
                  ) : (
                    <Image size={20} />
                  )}
                </span>
                <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                  <Text weight="medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {album.album}
                  </Text>
                  <Text tone="muted" size="sm">
                    {album.albumArtist} · {album.tracks.length}{' '}
                    {album.tracks.length === 1 ? 'track' : 'tracks'}
                  </Text>
                </span>
                {!album.artId && <Chip accent>No art</Chip>}
              </button>
            ))}
            {shown.length === 0 && (
              <div style={{ padding: 12 }}>
                <Text tone="muted" size="sm">
                  No albums match.
                </Text>
              </div>
            )}
          </div>
          {albums.length > LIST_CAP && shown.length === LIST_CAP && (
            <Text tone="subtle" size="xs">
              Showing the first {LIST_CAP} - filter to narrow.
            </Text>
          )}
        </>
      )}
    </ToolShell>
  );
}
