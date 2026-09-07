import { Button, Input, StatTile } from '@glacier/react';
import { Cloud, Disc3, FolderOpen, Mic2, Music, Timer } from '@glacier/icons';
import { useMemo } from 'react';
import { canPickFolder } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';
import { UploadSection } from '../servers/ServerUpload.tsx';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

/**
 * The Library pane (the section id stays `general` - ids are the contract
 * recency and deep links hold). What used to be a junk drawer - library stats,
 * the folder, your account - now has one job: YOUR MUSIC. What it amounts to,
 * where it comes from, and how more of it gets in. The account went to Account
 * & devices with the rest of the identity, and the Handbook carries the "learn
 * the app" material.
 */
export function General() {
  const t = useT();
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
      <PaneSection title={t('settings.yourLibrary')}>
        <div className="setk-row">
          <div className="libraryStats">
            <StatTile icon={<Music size={16} />} value={formatNumber(tracks.length)} label={t('settings.statSongs')} />
            <StatTile icon={<Mic2 size={16} />} value={formatNumber(libStats.artists)} label={t('settings.statArtists')} />
            <StatTile icon={<Disc3 size={16} />} value={formatNumber(libStats.albums)} label={t('settings.statAlbums')} />
            <StatTile icon={<Timer size={16} />} value={formatNumber(libStats.hours)} label={t('settings.statHours')} />
          </div>
        </div>
      </PaneSection>

      {source === 'server' ? (
        // A connected server IS the library, so the folder picker would be
        // pointing at something nothing is playing from. Say where the music
        // is coming from instead; changing it lives under Servers.
        <PaneSection title={t('settings.musicSource')}>
          <SettingRow
            label={t('settings.musicLibrary')}
            hint={t('settings.musicLibraryFromServer')}
            layout="stacked"
            control={
              <Input readOnly value={musicDir} aria-label={t('settings.musicLibrary')} leadingIcon={<Cloud size={16} />} />
            }
          />
        </PaneSection>
      ) : (
        <PaneSection title={t('settings.musicSource')}>
          <SettingRow
            label={t('settings.musicFolder')}
            hint={
              // Not a plural - two different sentences for two different
              // platforms, so each is its own entry.
              canPickFolder
                ? t('settings.musicFolderHint')
                : t('settings.musicFolderDesktopOnly')
            }
            layout="stacked"
            control={
              <Input
                readOnly
                value={loading ? t('settings.musicFolderLocating') : musicDir}
                aria-label={t('settings.musicFolder')}
                leadingIcon={<FolderOpen size={16} />}
              />
            }
          />
          {canPickFolder && (
            <div className="setk-row">
              <div className="prefsActions">
                <Button variant="outline" size="sm" onClick={() => void choose()}>
                  {t('settings.chooseFolder')}
                </Button>
                <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => void reset()}>
                  {t('settings.resetFolder')}
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
