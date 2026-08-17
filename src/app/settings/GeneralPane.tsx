import { Button, Field, Input, Label, StatTile, Switch, Text } from '@glacier/react';
import { Cloud, Disc3, FolderOpen, LogOut, Mic2, Music, Timer } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { canPickFolder } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';
import { onlineMetadataEnabled, setOnlineMetadata } from './netPrefs.ts';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The General controls. For now that is where music lives: the app resolves a
 * default AttackFM folder under the OS audio directory, and this lets the user
 * point it somewhere else. The chosen folder is the global source the library
 * is built from and played through.
 */
export function General() {
  const { source, musicDir, loading, isDefault, choose, reset, tracks } = useLibrary();
  const { session, disconnect } = useServerSession();
  // A module-level pref rather than context: the two consumers are plain
  // async functions, so the switch just re-reads on each render.
  const [online, setOnline] = useState(onlineMetadataEnabled);

  // The library, counted: what the folder (or the server) amounts to.
  const libStats = useMemo(() => {
    const artists = new Set<string>();
    const albums = new Set<string>();
    let seconds = 0;
    for (const t of tracks) {
      if (t.artist) artists.add(t.artist);
      if (t.album) albums.add(`${t.artist}\u0000${t.album}`);
      seconds += t.duration ?? 0;
    }
    return { artists: artists.size, albums: albums.size, hours: Math.round(seconds / 3600) };
  }, [tracks]);

  const onlineSwitch = (
    <div className="prefsSection">
      <Label>Privacy</Label>
      <Switch
        label="Online metadata lookups"
        checked={online}
        onCheckedChange={(on) => {
          setOnlineMetadata(on);
          setOnline(on);
        }}
      />
      <Text tone="muted" size="sm">
        Fetches lyrics from LRCLIB and album art from Apple, keyed by track titles.
        Off keeps the app entirely between your devices and your own server.
      </Text>
    </div>
  );

  // Remove the signed-in account from this device. `disconnect` clears the
  // stored session (so the app is signed out here) and best-effort tells the
  // server to drop the token — the library, downloads and playlists all stay
  // on the server, so signing back in restores them.
  const accountSection = session ? (
    <div className="prefsSection">
      <Label>Account</Label>
      <Text tone="muted" size="sm">
        Signed in as {session.username} on {session.url.replace(/^https?:\/\//, '')}.
      </Text>
      <div className="prefsActions">
        <Button variant="outline" size="sm" onClick={() => void disconnect()}>
          <LogOut size={14} /> Log out
        </Button>
      </div>
      <Text tone="muted" size="sm">
        Removes this account from this device. Your music stays on the server —
        sign in again to reach it here.
      </Text>
    </div>
  ) : null;

  const statsGrid = (
    <div className="prefsSection">
      <Label>Your library</Label>
      <div className="libraryStats">
        <StatTile icon={<Music size={16} />} value={tracks.length.toLocaleString()} label="Songs" />
        <StatTile icon={<Mic2 size={16} />} value={libStats.artists.toLocaleString()} label="Artists" />
        <StatTile icon={<Disc3 size={16} />} value={libStats.albums.toLocaleString()} label="Albums" />
        <StatTile icon={<Timer size={16} />} value={libStats.hours.toLocaleString()} label="Hours" />
      </div>
    </div>
  );

  // A connected server IS the library, so the folder picker would be pointing
  // at something nothing is playing from. Say where the music is coming from
  // instead, and send the user to the pane that can change it.
  if (source === 'server') {
    return (
      <div className="prefsBody">
        {statsGrid}
        <div className="prefsSection">
          <Field
            label="Music library"
            hint="The library is coming from a server. Change or disconnect it under Server."
          >
            <Input readOnly value={musicDir} aria-label="Music library" leadingIcon={<Cloud size={16} />} />
          </Field>
        </div>
        {onlineSwitch}
        {accountSection}
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {statsGrid}
      <div className="prefsSection">
        <Field
          label="Music folder"
          hint={
            canPickFolder
              ? 'Where AttackFM looks for music to build the library from.'
              : 'The folder can only be changed in the desktop app.'
          }
        >
          <Input
            readOnly
            value={loading ? 'Locating…' : musicDir}
            aria-label="Music folder"
            leadingIcon={<FolderOpen size={16} />}
          />
        </Field>
        {canPickFolder && (
          <div className="prefsActions">
            <Button variant="outline" size="sm" onClick={() => void choose()}>
              Choose folder…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isDefault}
              onClick={() => void reset()}
            >
              Reset to default
            </Button>
          </div>
        )}
      </div>
      {onlineSwitch}
      {accountSection}
    </div>
  );
}
