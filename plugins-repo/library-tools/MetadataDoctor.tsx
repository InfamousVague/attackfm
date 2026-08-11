/**
 * The Metadata doctor: tag surgery on the files themselves. Track mode edits
 * one row's full tag set; album mode edits the shared fields (album, album
 * artist, genre, year) and writes them through every track sequentially, so
 * a half-tagged compilation can be straightened out in one pass. The server
 * writes the FILE's tags and re-reads it into the db, so the edit is what a
 * fresh scan would have found - and the rev bump carries it to every device.
 *
 * Only the fields the user actually changed are sent: the endpoint writes
 * exactly what it is given, and an untouched field should stay whatever the
 * file already says.
 */
import { useMemo, useState } from 'react';
import { Button, Input, Label, SegmentedControl, Text, useHaptics } from '@glacier/react';
import { Search } from '@glacier/icons';
import {
  MissingEndpointError,
  groupAlbums,
  writeTags,
  useLibraryRows,
  type AlbumGroup,
  type RemoteTrack,
  type ServerSession,
  type TagPatch,
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
  rowButton,
  stack,
} from './ui.tsx';
import { prettyDuration } from './format.ts';

const TOOL = 'Metadata doctor';
const LIST_CAP = 100;

/** The full tag set, in form order. Numeric fields parse on save. */
const TRACK_FIELDS = [
  { key: 'title', label: 'Title', numeric: false },
  { key: 'artist', label: 'Artist', numeric: false },
  { key: 'albumArtist', label: 'Album artist', numeric: false },
  { key: 'album', label: 'Album', numeric: false },
  { key: 'genre', label: 'Genre', numeric: false },
  { key: 'year', label: 'Year', numeric: true },
  { key: 'trackNo', label: 'Track #', numeric: true },
  { key: 'discNo', label: 'Disc #', numeric: true },
] as const;

/** Album mode's shared subset. */
const ALBUM_FIELDS = TRACK_FIELDS.filter((f) =>
  ['album', 'albumArtist', 'genre', 'year'].includes(f.key),
);

type FieldKey = (typeof TRACK_FIELDS)[number]['key'];
type Form = Record<FieldKey, string>;

function fieldOf(row: RemoteTrack, key: FieldKey): string {
  const value = row[key];
  return value == null ? '' : String(value);
}

function formFrom(row: RemoteTrack): Form {
  const form = {} as Form;
  for (const f of TRACK_FIELDS) form[f.key] = fieldOf(row, f.key);
  return form;
}

/**
 * The changed fields as a wire patch, or an error naming the field that will
 * not parse. Empty numeric input means "clear the tag" (null); empty text
 * writes an empty string, which is what clearing a text frame is.
 */
function patchFrom(
  base: Form,
  form: Form,
  fields: readonly { key: FieldKey; label: string; numeric: boolean }[],
): { patch: TagPatch; changed: number } | { invalid: string } {
  const patch: TagPatch = {};
  let changed = 0;
  for (const f of fields) {
    const next = form[f.key].trim();
    if (next === base[f.key].trim()) continue;
    if (f.numeric) {
      if (next === '') {
        patch[f.key as 'year' | 'trackNo' | 'discNo'] = null;
      } else {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 0) return { invalid: f.label };
        patch[f.key as 'year' | 'trackNo' | 'discNo'] = n;
      }
    } else {
      patch[f.key as 'title' | 'artist' | 'albumArtist' | 'album' | 'genre'] = next;
    }
    changed += 1;
  }
  return { patch, changed };
}

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving'; done?: number; total?: number }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; note: string };

export function MetadataDoctor({ session, onBack }: { session: ServerSession; onBack: () => void }) {
  const haptic = useHaptics();
  const { rows, error: rowsError, reload, patch } = useLibraryRows(session);
  const [mode, setMode] = useState<'track' | 'album'>('track');
  const [filter, setFilter] = useState('');
  const [trackId, setTrackId] = useState<number | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
  // The form and its pristine baseline, captured when an editor opens.
  const [form, setForm] = useState<Form | null>(null);
  const [base, setBase] = useState<Form | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });

  const albums = useMemo(
    () =>
      groupAlbums(rows ?? []).sort(
        (a, b) => a.albumArtist.localeCompare(b.albumArtist) || a.album.localeCompare(b.album),
      ),
    [rows],
  );
  // \u0000 so two albums whose names bleed into each other cannot share a key.
  const keyOf = (a: AlbumGroup) => `${a.album}\u0000${a.albumArtist}`;

  const track = rows?.find((r) => r.id === trackId) ?? null;
  const album = albums.find((a) => keyOf(a) === albumKey) ?? null;

  const shownTracks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = rows ?? [];
    const matched = q
      ? all.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.artist.toLowerCase().includes(q) ||
            r.album.toLowerCase().includes(q),
        )
      : all;
    return matched.slice(0, LIST_CAP);
  }, [rows, filter]);

  const shownAlbums = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? albums.filter(
          (a) => a.album.toLowerCase().includes(q) || a.albumArtist.toLowerCase().includes(q),
        )
      : albums;
    return matched.slice(0, LIST_CAP);
  }, [albums, filter]);

  const openTrack = (row: RemoteTrack) => {
    const f = formFrom(row);
    setTrackId(row.id);
    setForm({ ...f });
    setBase(f);
    setSave({ phase: 'idle' });
  };

  /** Album mode prefills a field only when every track agrees on its value -
   *  a mixed field starts blank and untouched-blank means "leave alone". */
  const openAlbum = (group: AlbumGroup) => {
    const f = {} as Form;
    for (const field of ALBUM_FIELDS) {
      const values = new Set(group.tracks.map((r) => fieldOf(r, field.key).trim()));
      f[field.key] = values.size === 1 ? ([...values][0] ?? '') : '';
    }
    for (const field of TRACK_FIELDS) if (!(field.key in f)) f[field.key] = '';
    setAlbumKey(keyOf(group));
    setForm({ ...f });
    setBase(f);
    setSave({ phase: 'idle' });
  };

  const closeEditor = () => {
    setTrackId(null);
    setAlbumKey(null);
    setForm(null);
    setBase(null);
    setSave({ phase: 'idle' });
  };

  const saveTrack = () => {
    if (!track || !form || !base) return;
    const built = patchFrom(base, form, TRACK_FIELDS);
    if ('invalid' in built) {
      setSave({ phase: 'error', message: `${built.invalid} must be a whole number.` });
      return;
    }
    if (built.changed === 0) {
      setSave({ phase: 'done', note: 'Nothing changed.' });
      return;
    }
    setSave({ phase: 'saving' });
    writeTags(session, track.id, built.patch)
      .then((updated) => {
        haptic('success');
        patch((all) => all.map((r) => (r.id === updated.id ? updated : r)));
        setBase(formFrom(updated));
        setForm(formFrom(updated));
        setSave({
          phase: 'done',
          note: 'Tags written into the file - every device sees them on its next sync.',
        });
      })
      .catch((e: unknown) => {
        if (e instanceof MissingEndpointError) setSave({ phase: 'missing' });
        else setSave({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  };

  /** Album mode: the same patch, written through every track one at a time -
   *  sequential on purpose, so a big album cannot stampede the server and the
   *  progress count means something. */
  const saveAlbum = async () => {
    if (!album || !form || !base) return;
    const built = patchFrom(base, form, ALBUM_FIELDS);
    if ('invalid' in built) {
      setSave({ phase: 'error', message: `${built.invalid} must be a whole number.` });
      return;
    }
    if (built.changed === 0) {
      setSave({ phase: 'done', note: 'Nothing changed.' });
      return;
    }
    const targets = [...album.tracks];
    setSave({ phase: 'saving', done: 0, total: targets.length });
    let failures = 0;
    let done = 0;
    for (const target of targets) {
      try {
        const updated = await writeTags(session, target.id, built.patch);
        patch((all) => all.map((r) => (r.id === updated.id ? updated : r)));
      } catch (e: unknown) {
        if (e instanceof MissingEndpointError) {
          setSave({ phase: 'missing' });
          return;
        }
        failures += 1;
      }
      done += 1;
      setSave({ phase: 'saving', done, total: targets.length });
    }
    if (failures === 0) {
      haptic('success');
      setSave({
        phase: 'done',
        note: `Tags written to all ${targets.length} files - syncing everywhere now.`,
      });
    } else {
      setSave({
        phase: 'error',
        message: `${failures} of ${targets.length} files failed to write - try again for the rest.`,
      });
    }
    // The album may have moved under a new name/artist; drop back to the list
    // rather than pointing at a key that no longer exists.
    setAlbumKey(null);
    setForm(null);
    setBase(null);
  };

  const editorFields = (fields: readonly { key: FieldKey; label: string; numeric: boolean }[]) =>
    form && (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {fields.map((f) => (
          <div key={f.key} style={stack(4)}>
            <Label htmlFor={`meta-${f.key}`}>{f.label}</Label>
            <Input
              id={`meta-${f.key}`}
              size="md"
              inputMode={f.numeric ? 'numeric' : undefined}
              value={form[f.key]}
              placeholder={base && base[f.key] === '' && albumKey ? '(mixed or empty)' : undefined}
              onChange={(e) => setForm((prev) => (prev ? { ...prev, [f.key]: e.target.value } : prev))}
            />
          </div>
        ))}
      </div>
    );

  const saveFeedback = (
    <>
      {save.phase === 'saving' && save.total != null && (
        <BusyRow label={`Writing tags… ${save.done}/${save.total}`} />
      )}
      {save.phase === 'missing' && <MissingNote tool={TOOL} />}
      {save.phase === 'error' && <ErrorNote message={save.message} />}
      {save.phase === 'done' && (
        <Text tone="success" size="sm">
          {save.note}
        </Text>
      )}
    </>
  );

  // --- single-track editor --------------------------------------------------
  if (track && form) {
    return (
      <ToolShell
        title={track.title || 'Untitled'}
        blurb={`${track.artist} · ${track.album} · ${prettyDuration(track.duration)}`}
        onBack={closeEditor}
      >
        {!session.isAdmin && <AdminNote verb="write tags" />}
        <div style={{ ...panel, ...stack(14) }}>
          {editorFields(TRACK_FIELDS)}
          <div style={row(10)}>
            <Button
              variant="solid"
              size="md"
              disabled={!session.isAdmin}
              loading={save.phase === 'saving'}
              onClick={saveTrack}
            >
              Save tags
            </Button>
            <Text tone="subtle" size="xs">
              Written into the file itself, then re-scanned.
            </Text>
          </div>
          {saveFeedback}
        </div>
      </ToolShell>
    );
  }

  // --- whole-album editor ---------------------------------------------------
  if (album && form) {
    return (
      <ToolShell
        title={album.album}
        blurb={`${album.albumArtist} · ${album.tracks.length} tracks · shared fields only`}
        onBack={closeEditor}
      >
        {!session.isAdmin && <AdminNote verb="write tags" />}
        <div style={{ ...panel, ...stack(14) }}>
          <QuietNote>
            A blank field you leave blank is left alone; anything you type is written to every
            track in the album.
          </QuietNote>
          {editorFields(ALBUM_FIELDS)}
          <div style={row(10)}>
            <Button
              variant="solid"
              size="md"
              disabled={!session.isAdmin}
              loading={save.phase === 'saving'}
              onClick={() => void saveAlbum()}
            >
              Apply to {album.tracks.length} tracks
            </Button>
          </div>
          {saveFeedback}
        </div>
      </ToolShell>
    );
  }

  // --- the picker: track search or album list -------------------------------
  return (
    <ToolShell
      title={TOOL}
      blurb="Fix a track's tags, or retag a whole album at once. Edits land in the files."
      onBack={onBack}
    >
      <SegmentedControl
        aria-label="Edit mode"
        options={[
          { value: 'track', label: 'One track' },
          { value: 'album', label: 'Whole album' },
        ]}
        value={mode}
        onValueChange={(v) => setMode(v as 'track' | 'album')}
        size="sm"
      />
      <Input
        size="md"
        leadingIcon={<Search size={15} />}
        placeholder={mode === 'track' ? 'Search tracks…' : 'Search albums…'}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {rows === null && <BusyRow label="Reading the library…" />}
      {rowsError && <ErrorNote message={rowsError} onRetry={reload} />}
      {rows !== null && !rowsError && (
        <div style={{ ...panel, padding: 4 }}>
          {mode === 'track' &&
            shownTracks.map((r) => (
              <button key={r.id} type="button" style={rowButton} onClick={() => openTrack(r)}>
                <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                  <Text
                    weight="medium"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {r.title || 'Untitled'}
                  </Text>
                  <Text tone="muted" size="sm">
                    {r.artist} · {r.album}
                  </Text>
                </span>
                {r.year == null && <Chip>No year</Chip>}
                {!r.genre && <Chip>No genre</Chip>}
              </button>
            ))}
          {mode === 'album' &&
            shownAlbums.map((a) => (
              <button key={keyOf(a)} type="button" style={rowButton} onClick={() => openAlbum(a)}>
                <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                  <Text
                    weight="medium"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {a.album}
                  </Text>
                  <Text tone="muted" size="sm">
                    {a.albumArtist} · {a.tracks.length} {a.tracks.length === 1 ? 'track' : 'tracks'}
                  </Text>
                </span>
              </button>
            ))}
          {((mode === 'track' && shownTracks.length === 0) ||
            (mode === 'album' && shownAlbums.length === 0)) && (
            <div style={{ padding: 12 }}>
              <Text tone="muted" size="sm">
                Nothing matches.
              </Text>
            </div>
          )}
        </div>
      )}
    </ToolShell>
  );
}
