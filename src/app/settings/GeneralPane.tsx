import { Button, Field, Input, Label, StatTile, Text } from '@glacier/react';
import { Cloud, Compass, Disc3, FolderOpen, LogOut, Mic2, Music, Timer } from '@glacier/icons';
import { useMemo } from 'react';
import { canPickFolder } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { startTour } from '../tour/tourControl.ts';

/**
 * The General controls. For now that is where music lives: the app resolves a
 * default AttackFM folder under the OS audio directory, and this lets the user
 * point it somewhere else. The chosen folder is the global source the library
 * is built from and played through.
 */
export function General() {
  const { source, musicDir, loading, isDefault, choose, reset, tracks } = useLibrary();
  const { session, disconnect } = useServerSession();

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

  // "Online metadata lookups" moved to the Privacy pane, where it sits with the
  // other three switches about what leaves this device. It had been here under
  // a literal <Label>Privacy</Label>, which was the pane asking to exist.

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

  const tourSection = (
    <div className="prefsSection">
      <Label>Show me around</Label>
      {/* The way back into the tour. It runs once by itself on a first launch
          and then never again, so without a door here it would be a thing you
          could only ever see by accident and never on purpose. Starting it
          closes this modal and walks the app itself - see tourControl. */}
      <Button variant="soft" size="sm" onClick={startTour}>
        <Compass size={15} />
        Take the tour
      </Button>
      <Text tone="muted" size="sm">
        A short walk through the library, the booth and the player. You can stop it at any
        point.
      </Text>
    </div>
  );

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
        {tourSection}
        {statsGrid}
        <div className="prefsSection">
          <Field
            label="Music library"
            hint="The library is coming from a server. Change or disconnect it under Server."
          >
            <Input readOnly value={musicDir} aria-label="Music library" leadingIcon={<Cloud size={16} />} />
          </Field>
        </div>
        {accountSection}
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {tourSection}
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
      {accountSection}
    </div>
  );
}
