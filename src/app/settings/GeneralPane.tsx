import { Button, Input, StatTile } from '@glacier/react';
import { Cloud, Disc3, FolderOpen, Mic2, Music, Timer } from '@glacier/icons';
import { useMemo } from 'react';
import { canPickFolder } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';
import { UploadSection } from '../servers/ServerUpload.tsx';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';

/**
 * The Library pane (the section id stays `general` - ids are the contract
 * recency and deep links hold). What used to be a junk drawer - a tour
 * button, library stats, the folder, your account - now has one job: YOUR
 * MUSIC. What it amounts to, where it comes from, and how more of it gets in.
 * The tour lives on the Handbook's cover with the other "learn the app"
 * material; the account went to Account & devices with the rest of the
 * identity.
 */
export function General() {
  const { source, musicDir, loading, isDefault, choose, reset, tracks } = useLibrary();

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

  return (
    <div className="prefsBody">
      <PaneSection title="Your library">
        <div className="setk-row">
          <div className="libraryStats">
            <StatTile icon={<Music size={16} />} value={tracks.length.toLocaleString()} label="Songs" />
            <StatTile icon={<Mic2 size={16} />} value={libStats.artists.toLocaleString()} label="Artists" />
            <StatTile icon={<Disc3 size={16} />} value={libStats.albums.toLocaleString()} label="Albums" />
            <StatTile icon={<Timer size={16} />} value={libStats.hours.toLocaleString()} label="Hours" />
          </div>
        </div>
      </PaneSection>

      {source === 'server' ? (
        // A connected server IS the library, so the folder picker would be
        // pointing at something nothing is playing from. Say where the music
        // is coming from instead; changing it lives under Servers.
        <PaneSection title="Music source">
          <SettingRow
            label="Music library"
            hint="The library is coming from a server. Change or disconnect it under Servers."
            layout="stacked"
            control={
              <Input readOnly value={musicDir} aria-label="Music library" leadingIcon={<Cloud size={16} />} />
            }
          />
        </PaneSection>
      ) : (
        <PaneSection title="Music source">
          <SettingRow
            label="Music folder"
            hint={
              canPickFolder
                ? 'Where AttackFM looks for music to build the library from.'
                : 'The folder can only be changed in the desktop app.'
            }
            layout="stacked"
            control={
              <Input
                readOnly
                value={loading ? 'Locating…' : musicDir}
                aria-label="Music folder"
                leadingIcon={<FolderOpen size={16} />}
              />
            }
          />
          {canPickFolder && (
            <div className="setk-row">
              <div className="prefsActions">
                <Button variant="outline" size="sm" onClick={() => void choose()}>
                  Choose folder…
                </Button>
                <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => void reset()}>
                  Reset to default
                </Button>
              </div>
            </div>
          )}
        </PaneSection>
      )}

      {/* How more music gets in, moved from the server dashboard: sending
          songs UP is something you do to your library, not a fact about the
          box. Self-gated - it renders nothing off Tauri or signed out. */}
      <UploadSection />
    </div>
  );
}
