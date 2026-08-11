/**
 * Backup: the library's people-made structure - playlists and favorites - out
 * to files and back. Export is a fetch-with-auth into a blob and an <a
 * download> click, because the export endpoints sit behind the bearer token
 * and a plain link cannot carry one. Import parses client-side (M3U's EXTINF
 * lines, or this tool's own JSON shape) and hands the server name+entries per
 * playlist; the server does the matching - exact path first, then
 * case-insensitive title+artist - and reports what it could not find.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Text, useHaptics } from '@glacier/react';
import { FileDown, FileUp } from '@glacier/icons';
import {
  MissingEndpointError,
  fetchPlaylists,
  importPlaylist,
  saveBlob,
  serverBlob,
  type ImportEntry,
  type RemotePlaylist,
  type ServerSession,
} from './api.ts';
import {
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

const TOOL = 'Backup';

type Playlists =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; playlists: RemotePlaylist[] };

type ImportRun =
  | { phase: 'idle' }
  | { phase: 'parsing' }
  | { phase: 'importing'; done: number; total: number }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; results: { name: string; matched: number; missed: ImportEntry[] }[] };

/** One playlist parsed out of a dropped file, ready for the import endpoint. */
interface ParsedList {
  name: string;
  entries: ImportEntry[];
}

/**
 * M3U, as this tool exports it and most players write it: an EXTINF line
 * carrying "artist - title", then the path on the next non-comment line. A
 * bare path with no EXTINF still imports - the server can match on path.
 */
export function parseM3u(text: string, name: string): ParsedList {
  const entries: ImportEntry[] = [];
  let pending: { title?: string; artist?: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const meta = line.slice(line.indexOf(',') + 1).trim();
      const dash = meta.indexOf(' - ');
      pending =
        dash === -1
          ? { title: meta || undefined }
          : { artist: meta.slice(0, dash).trim(), title: meta.slice(dash + 3).trim() };
      continue;
    }
    if (line.startsWith('#')) continue;
    entries.push({ path: line, ...(pending ?? {}) });
    pending = null;
  }
  return { name, entries };
}

/** The backup JSON's own shape, straight back into per-playlist imports. */
function parseBackupJson(text: string): ParsedList[] {
  const parsed = JSON.parse(text) as {
    playlists?: { name?: string; tracks?: { path?: string; title?: string; artist?: string }[] }[];
  };
  if (!Array.isArray(parsed.playlists)) throw new Error('Not an AttackFM backup file.');
  return parsed.playlists.map((p, i) => ({
    name: p.name || `Playlist ${i + 1}`,
    entries: (p.tracks ?? []).map((t) => ({
      path: t.path || undefined,
      title: t.title || undefined,
      artist: t.artist || undefined,
    })),
  }));
}

/** Filesystem-hostile characters out of a playlist-named download. */
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'playlist';
}

export function BackupTool({ session, onBack }: { session: ServerSession; onBack: () => void }) {
  const haptic = useHaptics();
  const fileRef = useRef<HTMLInputElement>(null);
  const [playlists, setPlaylists] = useState<Playlists>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupMissing, setBackupMissing] = useState(false);
  const [m3uBusy, setM3uBusy] = useState<number | null>(null);
  const [m3uError, setM3uError] = useState<string | null>(null);
  const [m3uMissing, setM3uMissing] = useState(false);
  const [run, setRun] = useState<ImportRun>({ phase: 'idle' });

  useEffect(() => {
    let stale = false;
    setPlaylists({ phase: 'loading' });
    fetchPlaylists(session)
      .then((lists) => {
        if (!stale) setPlaylists({ phase: 'ready', playlists: lists });
      })
      .catch((e: unknown) => {
        if (stale) return;
        if (e instanceof MissingEndpointError) setPlaylists({ phase: 'missing' });
        else setPlaylists({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      stale = true;
    };
  }, [session, nonce]);

  const downloadBackup = () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    setBackupMissing(false);
    serverBlob(session, '/api/export/backup')
      .then((blob) => {
        const date = new Date().toISOString().slice(0, 10);
        saveBlob(blob, `attackfm-backup-${date}.json`);
        haptic('success');
      })
      .catch((e: unknown) => {
        if (e instanceof MissingEndpointError) setBackupMissing(true);
        else setBackupError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBackupBusy(false));
  };

  const downloadM3u = (list: RemotePlaylist) => {
    if (m3uBusy !== null) return;
    setM3uBusy(list.id);
    setM3uError(null);
    setM3uMissing(false);
    serverBlob(session, `/api/playlists/${list.id}/export.m3u`)
      .then((blob) => {
        saveBlob(blob, `${safeFilename(list.name)}.m3u`);
        haptic('success');
      })
      .catch((e: unknown) => {
        if (e instanceof MissingEndpointError) setM3uMissing(true);
        else setM3uError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setM3uBusy(null));
  };

  const importFile = async (file: File) => {
    setRun({ phase: 'parsing' });
    let lists: ParsedList[];
    try {
      const text = await file.text();
      if (/\.m3u8?$/i.test(file.name)) {
        lists = [parseM3u(text, file.name.replace(/\.m3u8?$/i, ''))];
      } else {
        lists = parseBackupJson(text);
      }
    } catch (e: unknown) {
      setRun({ phase: 'error', message: e instanceof Error ? e.message : 'Could not read that file.' });
      return;
    }
    lists = lists.filter((l) => l.entries.length > 0);
    if (lists.length === 0) {
      setRun({ phase: 'error', message: 'No playlist entries in that file.' });
      return;
    }
    const results: { name: string; matched: number; missed: ImportEntry[] }[] = [];
    setRun({ phase: 'importing', done: 0, total: lists.length });
    let done = 0;
    for (const list of lists) {
      try {
        const reply = await importPlaylist(session, list.name, list.entries);
        results.push({ name: list.name, matched: reply.matched, missed: reply.missed });
      } catch (e: unknown) {
        if (e instanceof MissingEndpointError) {
          setRun({ phase: 'missing' });
          return;
        }
        setRun({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
        return;
      }
      done += 1;
      setRun({ phase: 'importing', done, total: lists.length });
    }
    haptic('success');
    setRun({ phase: 'done', results });
    // New playlists exist now; the export list should know.
    setNonce((n) => n + 1);
  };

  const onFilePicked = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void importFile(file);
    // Allow re-picking the same file after a fix.
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <ToolShell
      title={TOOL}
      blurb="Playlists and favorites, out to files and back in."
      onBack={onBack}
    >
      <div style={{ ...panel, ...stack(10) }}>
        <Text weight="medium">Export</Text>
        <div style={row(10)}>
          <Button variant="solid" size="md" loading={backupBusy} onClick={downloadBackup}>
            <FileDown size={15} /> Download backup (JSON)
          </Button>
          <Text tone="subtle" size="xs">
            Every playlist plus favorites, portable by file path.
          </Text>
        </div>
        {backupMissing && <MissingNote tool={TOOL} />}
        {backupError && <ErrorNote message={backupError} onRetry={downloadBackup} />}

        {playlists.phase === 'loading' && <BusyRow label="Listing playlists…" />}
        {playlists.phase === 'missing' && <MissingNote tool={TOOL} />}
        {playlists.phase === 'error' && (
          <ErrorNote message={playlists.message} onRetry={() => setNonce((n) => n + 1)} />
        )}
        {playlists.phase === 'ready' && playlists.playlists.length === 0 && (
          <Text tone="muted" size="sm">
            No playlists on the server yet.
          </Text>
        )}
        {playlists.phase === 'ready' &&
          playlists.playlists.map((list) => (
            <div key={list.id} style={row(10)}>
              <span style={{ ...stack(0), flex: 1, minWidth: 0 }}>
                <Text
                  size="sm"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {list.name}
                </Text>
              </span>
              <Chip>{list.tracks.length} tracks</Chip>
              <Button
                variant="outline"
                size="sm"
                loading={m3uBusy === list.id}
                disabled={m3uBusy !== null && m3uBusy !== list.id}
                onClick={() => downloadM3u(list)}
              >
                M3U
              </Button>
            </div>
          ))}
        {m3uMissing && <MissingNote tool={TOOL} />}
        {m3uError && <ErrorNote message={m3uError} />}
      </div>

      <div style={{ ...panel, ...stack(10) }}>
        <Text weight="medium">Import</Text>
        <Text tone="muted" size="sm">
          Bring a playlist back from an M3U, or restore every playlist from a backup JSON. Tracks
          are matched by path first, then by title and artist.
        </Text>
        <div style={row(10)}>
          <Button
            variant="outline"
            size="md"
            loading={run.phase === 'parsing' || run.phase === 'importing'}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp size={15} /> Choose a .m3u or .json file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".m3u,.m3u8,.json"
            style={{ display: 'none' }}
            onChange={(e) => onFilePicked(e.target.files)}
          />
        </div>
        {run.phase === 'importing' && (
          <BusyRow label={`Importing playlists… ${run.done}/${run.total}`} />
        )}
        {run.phase === 'missing' && <MissingNote tool={TOOL} />}
        {run.phase === 'error' && <ErrorNote message={run.message} />}
        {run.phase === 'done' && (
          <div style={stack(8)}>
            {run.results.map((result) => (
              <div key={result.name} style={stack(4)}>
                <div style={row(8)}>
                  <Text size="sm" weight="medium" style={{ flex: 1 }}>
                    {result.name}
                  </Text>
                  <Chip accent>{result.matched} matched</Chip>
                  {result.missed.length > 0 && <Chip>{result.missed.length} missed</Chip>}
                </div>
                {result.missed.slice(0, 5).map((miss, i) => (
                  <Text key={i} tone="subtle" size="xs">
                    Not in the library: {miss.title || miss.path || 'unknown'}
                    {miss.artist ? ` - ${miss.artist}` : ''}
                  </Text>
                ))}
                {result.missed.length > 5 && (
                  <Text tone="subtle" size="xs">
                    …and {result.missed.length - 5} more.
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
        <QuietNote>
          Favorites travel inside the backup JSON but restore is playlists-only for now - the
          server has no favorites-import endpoint yet.
        </QuietNote>
      </div>
    </ToolShell>
  );
}
