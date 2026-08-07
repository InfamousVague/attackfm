import {
  HapticsProvider,
  IconButton,
  Kbd,
  LocaleProvider,
  SearchField,
  TitleBar,
  ToastProvider,
} from '@glacier/react';
import { ChevronLeft, ChevronRight, Search, Settings } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { AppearanceProvider } from './appearance.tsx';
import { LibraryProvider, useLibrary } from './library.tsx';
import { EqualizerProvider } from './equalizer.tsx';
import { PlaybackProvider } from './playback.tsx';
import { NowPlayingMotionProvider } from './nowPlayingMotion.tsx';
import { NowPlayingBackdrop } from './NowPlayingBackdrop.tsx';
import { PluginHookScope, PluginProviders, PluginSlot, PluginsProvider } from '../plugins/runtime.tsx';
import { isTauri } from './tauri.ts';
import type { Track } from './tauri.ts';
import { Player } from './Player.tsx';
import { ArtistPage } from './ArtistPage.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { SongSearch } from './SongSearch.tsx';
import { PlaylistShowcase } from './PlaylistShowcase.tsx';
import { SongTable } from './SongTable.tsx';
import wordmark from '../assets/attack-white.png';

const APP_NAME = 'AttackFM';

// Window chrome only makes sense as a desktop window, so the title bar is off
// in the browser and on under Tauri.
const DESKTOP = isTauri();

// The palette answers to both chords everywhere; the hint shows the one this
// machine's users reach for.
const SUMMON_HINT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

/**
 * Puts the library's top row on the deck at launch, once and paused: the app
 * opens holding the song the table opens on (newest first, the table's own
 * default order) rather than the demo sample. Headless, and a separate
 * component because App itself renders the LibraryProvider and so cannot read
 * the library; this runs below it.
 */
function StartupSeed({
  current,
  onSeed,
}: {
  current: Track | null;
  onSeed: (track: Track, queue: Track[]) => void;
}) {
  const { tracks } = useLibrary();
  const seeded = useRef(false);
  useEffect(() => {
    // Only ever before the first song: a user already holding a track - or a
    // seed already placed - is never overridden by a scan landing late.
    if (seeded.current || current || tracks.length === 0) return;
    seeded.current = true;
    const ordered = [...tracks].sort((a, b) => b.addedAt - a.addedAt);
    const first = ordered[0];
    if (first) onSeed(first, ordered);
  }, [tracks, current, onSeed]);
  return null;
}

/**
 * A slim strip along the bottom that reports the background indexer's progress,
 * shown only while it is still reading tags. It sits above the floating player
 * and disappears the moment the library is fully indexed.
 */
function IndexingStatus() {
  const { indexing, indexed, indexTotal } = useLibrary();
  if (!indexing || indexTotal === 0) return null;
  const percent = Math.min(100, Math.round((indexed / indexTotal) * 100));
  return (
    <div className="indexingBar" role="status" aria-live="polite">
      <span className="indexingBar__dot" aria-hidden="true" />
      <span className="indexingBar__label">
        Indexing {indexed.toLocaleString()} of {indexTotal.toLocaleString()} songs
      </span>
      <span className="indexingBar__track" aria-hidden="true">
        <span className="indexingBar__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
    </div>
  );
}


/**
 * The app root: a small square window carrying the cross-cutting Glacier
 * providers and, for now, a single centered placeholder screen.
 */
export function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The track the list handed to the player; null until one is opened.
  const [current, setCurrent] = useState<Track | null>(null);
  // The list that track was opened from, in the order it was showing - what
  // the player's skips and autoplay walk through. Snapshotted at open, the
  // way a play context should be: re-sorting the table later reorders the
  // table, not the record already spinning.
  const [queue, setQueue] = useState<Track[]>([]);

  // Every surface that starts playback comes through here: the track to play
  // and the list it came from. A surface with no list (a lone hit) plays the
  // one track and the strip drops its skip buttons. Re-selecting the track
  // already loaded hands the player a fresh object: its load effect is keyed
  // on identity, and the same object again would make the click do nothing -
  // where the convention is a restart from the top. Everything downstream
  // compares tracks by path, so the clone changes nothing else.
  // False until the user picks something themselves: the launch seed loads
  // the deck without dropping the needle.
  const [autoplay, setAutoplay] = useState(false);

  const playFrom = (track: Track, context?: Track[]) => {
    setAutoplay(true);
    setCurrent((prev) => (prev === track ? { ...track } : track));
    setQueue(context ?? [track]);
  };
  // Page history as a stack with a cursor, so back and forward move through the
  // places visited rather than just toggling home. A view is an artist name, or
  // null for the main library.
  const [nav, setNav] = useState<{ stack: (string | null)[]; index: number }>({ stack: [null], index: 0 });
  const artist = nav.stack[nav.index] ?? null;
  const canBack = nav.index > 0;
  const canForward = nav.index < nav.stack.length - 1;

  // Opening a place truncates any forward history and pushes the new view, the
  // way a browser does. Reopening the current view is a no-op.
  const go = (next: string | null) =>
    setNav((s) => {
      if (s.stack[s.index] === next) return s;
      const stack = s.stack.slice(0, s.index + 1);
      stack.push(next);
      return { stack, index: stack.length - 1 };
    });
  const back = () => setNav((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  const forward = () => setNav((s) => (s.index < s.stack.length - 1 ? { ...s, index: s.index + 1 } : s));

  // The chord the field advertises: Cmd/Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <LocaleProvider locale="en">
      <HapticsProvider enabled={false}>
        <ToastProvider>
          <AppearanceProvider>
            {/* Who is running sits above the library - it needs nothing from
                the app - while the plugins' own providers mount inside it, so
                a plugin (the importer, say) can read and rescan the library. */}
            <PluginsProvider>
            <LibraryProvider>
            <PluginProviders>
            <EqualizerProvider>
            {/* The playback settings - crossfade, shuffle manners, the sleep
                timer - read by the player below and by the settings modal. */}
            <PlaybackProvider>
            {/* The loudness reading the player publishes and the header moves
                to. It wraps both, which is the whole reason it exists. */}
            <NowPlayingMotionProvider>
            <div className="appWindow">
            {/* The playing track's cover, blurred and faded, sits behind the top
                of the window so the header reads against the album rather than a
                flat panel. */}
            {current?.artwork && (
              // Keyed on the path so a track change starts the new cover's own
              // drift from the top rather than picking up the last one's phase.
              <NowPlayingBackdrop key={current.path} artwork={current.artwork} seed={current.path} />
            )}
            {DESKTOP && (
              // The title bar doubles as the window drag region; the inset
              // reserves the gutter the macOS traffic lights are painted into,
              // and the wordmark sits in the start slot right beside them.
              <TitleBar
                className="appTitleBar"
                data-tauri-drag-region
                surface
                border
                trafficLightInset
                start={
                  // Back and forward live left of the wordmark in a reserved
                  // slot that is always present, so the top bar's layout - and
                  // the logo's position - is identical on every page. The
                  // controls disable rather than disappear at the ends of the
                  // history, keeping the width fixed.
                  <>
                    <span className="titleBarNav">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Back"
                        disabled={!canBack}
                        onClick={back}
                      >
                        <ChevronLeft size={18} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Forward"
                        disabled={!canForward}
                        onClick={forward}
                      >
                        <ChevronRight size={18} />
                      </IconButton>
                    </span>
                    <img
                      className="titleBarLogo"
                      src={wordmark}
                      alt={APP_NAME}
                      // Carries the attribute itself so pressing the logo still
                      // drags the window rather than dead-zoning the bar.
                      data-tauri-drag-region
                    />
                  </>
                }
                // Search is the one thing reached from anywhere, so it lives
                // in the chrome rather than in a screen. The end slot keeps it
                // off the wordmark and out of the drag region, so a press
                // lands in the field instead of moving the window.
                end={
                  <>
                    <SearchField
                      className="titleBarSearch"
                      size="sm"
                      glass
                      placeholder="Search"
                      aria-label="Search"
                      // The field is a doorway, not a place to type: the query
                      // is taken by the palette, which is where the results are
                      // going to appear.
                      readOnly
                      shortcut={<Kbd glass>{SUMMON_HINT}</Kbd>}
                      onClick={() => setSearchOpen(true)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        setSearchOpen(true);
                      }}
                    />
                    {/* The same doorway with its frame taken off, for a window
                        too narrow to hold a field beside the wordmark. Only one
                        of the two is ever displayed - the CSS decides which -
                        so search never leaves the bar, it just stops spelling
                        itself out. */}
                    <IconButton
                      className="titleBarSearchButton"
                      variant="ghost"
                      size="sm"
                      aria-label="Search"
                      onClick={() => setSearchOpen(true)}
                    >
                      <Search size={16} />
                    </IconButton>
                    {/* Plugin actions (the importer's queue button, say) sit
                        between search and settings, where the downloads
                        button always has. */}
                    <PluginSlot id="titlebar-end" />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Settings"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings size={16} />
                    </IconButton>
                  </>
                }
              />
            )}
            <main className="appContent">
              {artist ? (
                <ArtistPage artist={artist} onPlay={playFrom} onOpenArtist={go} />
              ) : (
                <>
                  <PlaylistShowcase onPlay={playFrom} />
                  <div className="libraryBody">
                    <SongTable onPlay={playFrom} onOpenArtist={go} />
                  </div>
                </>
              )}
            </main>
            {/* Puts the newest song on the deck at launch, paused. */}
            <StartupSeed
              current={current}
              onSeed={(track, ordered) => {
                setCurrent(track);
                setQueue(ordered);
              }}
            />
            <div className="appPlayer">
              {/* The player walks the queue itself; it only reports where it
                  landed, and `current` follows. */}
              <Player track={current} queue={queue} onTrackChange={setCurrent} autoplay={autoplay} />
            </div>
            <IndexingStatus />
            {/* Searches the library - titles, artists, albums, genres, lyrics -
                and plays what is chosen. The palette calls plugin hooks, so it
                lives under a scope that remounts it when the running set
                changes - that remount is what keeps hook order legal. */}
            <PluginHookScope>
              <SongSearch open={searchOpen} onOpenChange={setSearchOpen} onPlay={playFrom} />
            </PluginHookScope>
            <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </div>
            </NowPlayingMotionProvider>
            </PlaybackProvider>
            </EqualizerProvider>
            </PluginProviders>
            </LibraryProvider>
            </PluginsProvider>
          </AppearanceProvider>
        </ToastProvider>
      </HapticsProvider>
    </LocaleProvider>
  );
}
