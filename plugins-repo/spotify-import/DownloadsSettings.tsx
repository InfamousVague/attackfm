import { Button, Field, Label, MultiSelect, NumberInput, Select, Switch, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { canPickFolder } from '@attackfm/app/tauri';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import {
  getMusicSettings,
  installSpotiflac,
  setMusicSettings,
  spotiflacStatus,
  type MusicSettings,
  type SpotiFlacStatus,
} from './musicImport.ts';

const QUALITY_OPTIONS = [
  { label: 'Lossless', value: 'LOSSLESS' },
  { label: 'Hi-Res Lossless', value: 'HI_RES_LOSSLESS' },
  { label: 'High (lossy)', value: 'HIGH' },
  { label: 'Low (lossy)', value: 'LOW' },
];

// Every provider the bundled SpotiFLAC accepts for --service, mirroring
// SPOTIFLAC_SERVICES in music.rs. The selected order is the priority order.
const PROVIDER_OPTIONS = [
  { label: 'Tidal', value: 'tidal' },
  { label: 'Qobuz', value: 'qobuz' },
  { label: 'Deezer', value: 'deezer' },
  { label: 'Amazon', value: 'amazon' },
  { label: 'JOOX', value: 'joox' },
  { label: 'NetEase', value: 'netease' },
  { label: 'Migu', value: 'migu' },
  { label: 'Kuwo', value: 'kuwo' },
  { label: 'SoundCloud', value: 'soundcloud' },
  { label: 'YouTube', value: 'youtube' },
  { label: 'Apple Music', value: 'apple' },
  { label: 'Pandora', value: 'pandora' },
  { label: 'FLAC Downloader', value: 'flacdownloader' },
];

/**
 * Download settings: the SpotiFLAC-backed importer's providers, quality, and
 * retry behaviour. Loaded from and saved to the Rust engine, which reads them
 * fresh for every download so changes apply to the queue too. Contributed to
 * the settings modal as the plugin's Downloads tab.
 */
export function DownloadsSettings() {
  const { source, musicDir } = useLibrary();
  const { session } = useServerSession();
  // Same rule as the provider: only a local library's musicDir is a folder.
  const statusDir = source === 'local' ? musicDir : undefined;
  const [settings, setSettings] = useState<MusicSettings | null>(null);
  const [status, setStatus] = useState<SpotiFlacStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!canPickFolder) return;
    void (async () => {
      try {
        setSettings(await getMusicSettings());
        setStatus(await spotiflacStatus(statusDir));
      } catch {
        // Backend unavailable - the section shows its desktop-only note.
      }
    })();
  }, [statusDir]);

  // The backend write happens beside the state set, not inside the updater:
  // React is free to run an updater twice (StrictMode does), and a write in
  // one would fire per run rather than per change.
  const save = (patch: Partial<MusicSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void setMusicSettings(next);
  };

  const onInstall = async () => {
    setInstalling(true);
    try {
      await installSpotiflac();
      setStatus(await spotiflacStatus(statusDir));
    } catch {
      // Surfaced via the status line staying "unavailable".
    } finally {
      setInstalling(false);
    }
  };

  if (!canPickFolder) {
    // No local engine here. With a server, imports run on the box - and its
    // provider and quality settings are the box's own (set on the server),
    // not this device's. Without one, there is nothing to import with.
    return (
      <Text tone="muted">
        {session
          ? 'Imports run on your server, which downloads and files them into the shared library. Paste a link in the command palette to import from this device.'
          : 'Music downloading is available in the desktop app, or on any device connected to a server.'}
      </Text>
    );
  }
  if (!settings) {
    return <Text tone="muted">Loading…</Text>;
  }

  return (
    <div className="prefsBody">
      {status && !status.available && (
        <div className="prefsSection">
          <Field label="SpotiFLAC" hint={status.hint ?? 'SpotiFLAC is required to download music.'}>
            <div className="prefsActions">
              <Button variant="outline" size="sm" disabled={installing} onClick={() => void onInstall()}>
                {installing ? 'Installing…' : 'Install SpotiFLAC'}
              </Button>
            </div>
          </Field>
        </div>
      )}
      <div className="prefsSection">
        <Label>Quality</Label>
        <Select
          aria-label="Download quality"
          value={settings.quality}
          options={QUALITY_OPTIONS}
          onValueChange={(v) => save({ quality: v })}
        />
      </div>
      <div className="prefsSection">
        <Field label="Providers" hint="Sources to try, in the order you add them. Leave empty to use every provider.">
          <MultiSelect
            aria-label="Providers"
            options={PROVIDER_OPTIONS}
            value={settings.services.split(/\s+/).filter(Boolean)}
            onValueChange={(v) => save({ services: v.join(' ') })}
            placeholder="Add a provider…"
            fullWidth
          />
        </Field>
      </div>
      <div className="prefsSection">
        <Label>Retries per track</Label>
        <NumberInput
          aria-label="Retries per track"
          value={settings.retries}
          min={0}
          max={10}
          onValueChange={(v) => save({ retries: v })}
        />
      </div>
      <div className="prefsSection">
        <Field label="Per-track timeout" hint="Seconds before skipping a track. 0 means no limit.">
          <NumberInput
            aria-label="Per-track timeout"
            value={settings.timeout}
            min={0}
            max={3600}
            step={10}
            onValueChange={(v) => save({ timeout: v })}
          />
        </Field>
      </div>
      <div className="prefsSection">
        <Switch label="Embed synced lyrics" checked={settings.lyrics} onCheckedChange={(v) => save({ lyrics: v })} />
        <Switch label="Enrich metadata" checked={settings.enrich} onCheckedChange={(v) => save({ enrich: v })} />
      </div>
    </div>
  );
}
