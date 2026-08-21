import { Banner, Button, Label, ProgressBar, Switch, Text } from '@glacier/react';
import { Upload } from '@glacier/icons';
import { useState } from 'react';
import { uploadFile } from '../server.ts';
import { useLibrary } from '../library/library.tsx';
import { useLibrarySync } from '../library/librarySync.tsx';
import { useServerSession } from './serverSession.tsx';
import { isTauri } from '../core/tauri.ts';
import { autoUploadEnabled, setAutoUpload } from '../settings/behaviourPrefs.ts';
import { SettingRow } from '../settings/kit/settingsKit.tsx';

/**
 * Sending music up to the server.
 *
 * Desktop only, and deliberately: it reaches for the native file picker and
 * reads files off the disk, neither of which a phone has in the way this needs.
 * The phone is the thing you listen on; the desktop is where the library
 * already lives and where a bulk upload is worth starting.
 */
export function UploadSection() {
  const { session } = useServerSession();
  const { rescan } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [current, setCurrent] = useState('');
  const [report, setReport] = useState<string | null>(null);

  if (!isTauri() || !session) return null;

  const pickAndUpload = async () => {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const picked = await dialog.open({
      multiple: true,
      title: 'Choose music to upload',
      filters: [
        {
          name: 'Audio',
          extensions: ['flac', 'mp3', 'm4a', 'wav', 'aiff', 'aif', 'ogg', 'opus', 'wv', 'ape'],
        },
      ],
    });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (files.length === 0) return;

    const fs = await import('@tauri-apps/plugin-fs');
    setBusy(true);
    setTotal(files.length);
    setDone(0);
    setReport(null);
    let failed = 0;

    for (const [index, path] of files.entries()) {
      const name = path.split(/[\\/]/).pop() ?? 'track';
      setCurrent(name);
      setFraction(0);
      try {
        // Read once, slice in memory: these are single tracks, and the chunking
        // that matters is the network's, not the disk's.
        const bytes = await fs.readFile(path);
        await uploadFile(
          session,
          {
            name,
            size: bytes.byteLength,
            slice: async (start, end) => bytes.slice(start, end),
          },
          { onProgress: setFraction },
        );
      } catch {
        failed += 1;
      }
      setDone(index + 1);
    }

    setBusy(false);
    setCurrent('');
    setReport(
      failed === 0
        ? `Uploaded ${files.length} ${files.length === 1 ? 'track' : 'tracks'}.`
        : `Uploaded ${files.length - failed} of ${files.length}; ${failed} failed.`,
    );
    // The server indexes each upload as it lands, so this only pulls the new
    // rows down rather than asking for a fresh walk.
    await rescan();
  };

  return (
    <div data-setting="auto-upload" className="prefsSection">
      <Label>Add music</Label>
      <Text tone="muted" size="sm">
        Sends files from this machine to the server. They are filed by their own tags and
        indexed as they arrive.
      </Text>
      {busy && (
        <>
          <Text tone="muted" size="sm">
            {current} — {done} of {total}
          </Text>
          <ProgressBar value={fraction * 100} />
        </>
      )}
      {report && !busy && <Banner tone="success">{report}</Banner>}
      <div className="prefsActions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void pickAndUpload()}>
          <Upload size={14} /> {busy ? 'Uploading…' : 'Upload files…'}
        </Button>
      </div>
      <FolderSyncRow />
    </div>
  );
}

/**
 * The standing arrangement, beside the one-off picker above: this machine's
 * music folder reconciles with the server on its own - on connect and after
 * every finished download - and this row shows where that stands and offers
 * a push. Everything in the folder that the server lacks goes up; nothing is
 * ever sent twice.
 */
function FolderSyncRow() {
  const { status, syncNow } = useLibrarySync();
  const { session } = useServerSession();
  const running = status.state === 'checking' || status.state === 'uploading';
  /*
   * The standing arrangement's OWN switch. librarySync has consulted this
   * pref on every run all along (librarySync.tsx:279), but its writer -
   * setAutoUpload - had no UI anywhere: the toggle was lost in a past
   * settings shuffle, leaving a setting that could be read and never
   * changed. Admin defaults on, guests off, exactly as the pref's own
   * default logic says.
   */
  const isAdmin = session?.isAdmin === true;
  const [auto, setAuto] = useState(() => autoUploadEnabled(session?.url ?? null, isAdmin));

  const line =
    status.state === 'checking'
      ? 'Comparing the music folder with the server…'
      : status.state === 'uploading'
        ? `Uploading ${status.current ?? '…'} — ${status.done} of ${status.total}`
        : status.state === 'unsupported'
          ? 'This server predates folder sync; update it to sync automatically.'
          : status.state === 'error'
            ? status.error ?? 'Sync hit a problem; it will retry.'
            : status.lastSyncedAt
              ? `Folder is in sync (checked ${new Date(status.lastSyncedAt).toLocaleTimeString()}).`
              : 'The music folder syncs to the server automatically.';

  return (
    <>
      {session && (
        <SettingRow
          label="Send new music automatically"
          hint="Anything that lands in this machine's music folder goes up to the server on its own - on connect, and after every finished download."
          control={
            <Switch
              aria-label="Send new music automatically"
              checked={auto}
              onCheckedChange={(on) => {
                setAutoUpload(session.url, isAdmin, on);
                setAuto(on);
              }}
            />
          }
        />
      )}
      <Text tone={status.state === 'error' ? 'danger' : 'muted'} size="sm">
        {line}
      </Text>
      {status.state === 'uploading' && status.total > 0 && (
        <ProgressBar value={(status.done / status.total) * 100} />
      )}
      <div className="prefsActions">
        <Button
          variant="outline"
          size="sm"
          disabled={running || status.state === 'unsupported'}
          onClick={syncNow}
        >
          {running ? 'Syncing…' : 'Sync folder now'}
        </Button>
      </div>
    </>
  );
}
