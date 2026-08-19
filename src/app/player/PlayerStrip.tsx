import { useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import {
  ContextMenu,
  IconButton,
  PlayerBar,
  Popover,
  useBeat,
  useLiveLevels,
} from '@glacier/react';
import type { LoudnessMeter, PlayerRepeat } from '@glacier/react';
import {
  AudioLines,
  ChevronLeft,
  EllipsisVertical,
  ListMusic,
  ListPlus,
  Mic,
  MonitorSpeaker,
} from '@glacier/icons';
import { SoundConsole } from './NowPlayingSheet.tsx';
import { PluginSlot } from '../../plugins/runtime.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { BeatWave } from './BeatWave.tsx';
import { VolumeControl } from './VolumeControl.tsx';
import { DeviceList, useDevicesAvailable } from './DevicePicker.tsx';
import { LyricsPanel } from './LyricsPanel.tsx';
import type { PauseStyle } from './playback.tsx';
import {
  FADE_DOWN_MS,
  FADE_UP_MS,
  IDLE_TRACK,
  SPIN_DOWN_MS,
  SPIN_UP_MS,
  beatIntensity,
  type ArtView,
} from './deckShared.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The docked strip along the bottom of the window: the kit's PlayerBar plus
 * the shell that hosts it. Pure presentation, extracted from Player.tsx -
 * every value and handler arrives through props from the deck core. The
 * disp* props swap between local playback and mirroring the active device.
 */
export function PlayerStrip({
  shellRef,
  dismissed,
  mobileControls,
  openNowPlaying,
  listLoading,
  npArtMenu,
  artView,
  track,
  artwork,
  dispArtwork,
  activeElsewhere,
  activeDeviceName,
  dispTrack,
  dispDuration,
  dispPosition,
  dispPlaying,
  audible,
  buffering,
  downloading,
  meter,
  progress,
  pauseStyle,
  onScrubDisp,
  onSeekEndDisp,
  onPlayingChangeDisp,
  onSkipBackDisp,
  onSkipForwardDisp,
  shuffle,
  smart,
  setShuffle,
  repeat,
  setRepeat,
  favorite,
  toggleFavoriteFelt,
  position,
  commitSeek,
  volume,
  muted,
  systemVolume,
  setVolumeState,
  setMutedState,
  setNpQueue,
  setNpOpen,
  setFiling,
}: {
  shellRef: MutableRefObject<HTMLDivElement | null>;
  dismissed: boolean;
  mobileControls: boolean;
  openNowPlaying: (event: React.MouseEvent) => void;
  listLoading: boolean;
  npArtMenu: ReactNode;
  artView: ArtView;
  track: Track | null;
  artwork: string | null;
  dispArtwork: string | null;
  activeElsewhere: boolean;
  activeDeviceName: string | null;
  dispTrack: Track | null;
  dispDuration: number;
  dispPosition: number;
  dispPlaying: boolean;
  audible: boolean;
  buffering: boolean;
  downloading: boolean;
  /** The deck's loudness meter; the strip runs its own beat/levels off it so
   *  the 60fps pulse re-renders this strip, never the whole Player. */
  meter: LoudnessMeter | null;
  /** Playhead as a 0-1 fraction, so ripples leave the playhead. */
  progress: number;
  pauseStyle: PauseStyle;
  onScrubDisp: (to: number) => void;
  onSeekEndDisp: (seconds: number) => void;
  /** Absent when the control cannot act - a remote whose socket is down. The
   *  kit disables the button, the same way it does for the skips. */
  onPlayingChangeDisp?: (playing: boolean) => void;
  onSkipBackDisp: (() => void) | undefined;
  onSkipForwardDisp: (() => void) | undefined;
  shuffle: boolean;
  /** Smart shuffle is on. The strip does not CYCLE the mode - its row of small
   *  targets is the wrong place for a three-state control, and one tap should
   *  still mean off - but it has to SHOW it: smart is the mode that changes
   *  what you hear, and the strip is the surface people actually look at. A
   *  sparkle here with no explanation is better than an unfamiliar song with
   *  no explanation. */
  smart: boolean;
  setShuffle: Dispatch<SetStateAction<boolean>>;
  repeat: PlayerRepeat;
  setRepeat: Dispatch<SetStateAction<PlayerRepeat>>;
  favorite: boolean;
  toggleFavoriteFelt: () => void;
  position: number;
  commitSeek: (to: number) => void;
  volume: number;
  muted: boolean;
  systemVolume: number;
  setVolumeState: (next: number) => void;
  setMutedState: (next: boolean) => void;
  setNpQueue: (open: boolean) => void;
  setNpOpen: (open: boolean) => void;
  setFiling: (track: Track | null) => void;
}) {
  // The pulse and the waveform, subscribed HERE rather than handed down:
  // useBeat sets fresh state every animation frame while music is audible,
  // and whichever component calls it re-renders at that rate. This strip is
  // the small surface that actually draws the beat; the Player it used to
  // live in is 2,500 lines mounted app-wide.
  const beat = useBeat({ meter, active: audible, at: progress });
  const levels = useLiveLevels({ meter, progress, active: audible });
  // The overflow popover opens on a chooser - Equalizer, Lyrics, Volume -
  // and each pick swaps the panel in behind a back row. Controlled, so every
  // open starts back at the chooser rather than wherever the last visit left
  // off.
  const [moreOpen, setMoreOpen] = useState(false);
  // 'lyrics' and 'volume' are the phone's views; 'devices' is the desktop's -
  // one state serves both because only one trailing branch renders at a time.
  const [moreView, setMoreView] = useState<'menu' | 'eq' | 'lyrics' | 'volume' | 'devices'>('menu');
  // Whether the overflow offers the device hand-off row at all.
  const devicesAvailable = useDevicesAvailable();

  // The strip's artwork square, defined once because both strips wear it: the
  // kit's bar on the desktop and the phone's own row. A right-click (or a long
  // press) offers the turning CD or the flat cover; a track without art gets
  // the station mark, so the square is never empty.
  const playerArtwork = (
        <ContextMenu
          aria-label="Artwork style"
          className="artViewTarget"
          content={npArtMenu}
        >
          {artView === 'cd' ? (
            <SpinningDisc
              art={dispArtwork}
              spinning={activeElsewhere ? dispPlaying : audible}
              // A dry buffer spins the platter up rather than stalling it.
              spooling={buffering || downloading}
              beat={beat}
              // The platter and the sound share a motor: the disc brakes and
              // catches up over the same stretch the audio does, whichever
              // stop the pause style buys - the turntable's ramp, the fade's
              // short fall, or the cut's plain halt.
              spinUpMs={
                pauseStyle === 'turntable'
                  ? SPIN_UP_MS
                  : pauseStyle === 'fade'
                    ? FADE_UP_MS
                    : 0
              }
              spinDownMs={
                pauseStyle === 'turntable'
                  ? SPIN_DOWN_MS
                  : pauseStyle === 'fade'
                    ? FADE_DOWN_MS
                    : 0
              }
            />
          ) : artwork ? (
            <img className="artViewCover" src={artwork} alt="" />
          ) : (
            <BeatWave className="artViewCover" beat={beat} />
          )}
        </ContextMenu>
  );

  return (
      /* On touch the strip's dead space is a handle: a tap lifts the
          full-screen Now Playing. display:contents keeps the wrapper out of
          the layout the kit and the shell CSS assume - it only catches the
          bubbling tap. */
      <div
        ref={shellRef}
        className="playerBarShell"
        data-dismissed={dismissed || undefined}
        onClick={mobileControls ? openNowPlaying : undefined}
      >
      <PlayerBar
        // The shell already insets the strip from the window edges, so it reads
        // as a plate lifted off the background rather than welded to the sill.
        position="floating"
        density="compact"
        // Until the list has loaded the strip stands as placeholders rather than
        // showing a track that is not settled yet.
        skeleton={listLoading}
        // The strip's artwork square wears the cover as a turning CD or as
        // the flat album art - a right-click on it offers the choice. A track
        // without art gets the station mark instead, so the square never
        // stands empty. The art itself is decorative: the title beside it
        // already names what is playing.
        artwork={playerArtwork}
        // disp* swap between local playback and mirroring the active device -
        // see the AttackFM Connect block in the core. Alone or active, these
        // are the local track and handlers; as a remote, the other device's
        // now-playing and controls that command it.
        title={dispTrack?.title ?? 'Funky Chunk'}
        subtitle={
          activeElsewhere
            ? `${dispTrack?.artist ?? ''}${activeDeviceName ? ` · on ${activeDeviceName}` : ''}`
            : (track?.artist ?? 'Kevin MacLeod')
        }
        duration={dispDuration}
        value={dispPosition}
        onValueChange={onScrubDisp}
        onSeekEnd={onSeekEndDisp}
        playing={dispPlaying}
        onPlayingChange={onPlayingChangeDisp}
        // Skip moves between tracks in the list, not within the current one.
        onSkipBack={onSkipBackDisp}
        onSkipForward={onSkipForwardDisp}
        shuffle={shuffle}
        onShuffleChange={setShuffle}
        // Renaming the control is the honest way to badge it: a screen reader
        // announces the mode, and the CSS sparkle hangs off the same name
        // rather than off a hashed kit class that could change under us.
        labels={shuffle && smart ? { shuffle: 'Smart shuffle' } : undefined}
        repeat={repeat}
        onRepeatChange={setRepeat}
        favorite={favorite}
        onFavoriteChange={toggleFavoriteFelt}
        // The mic sits just right of the heart, in the strip's leading rail:
        // the heart is how you feel about the song, the mic is the song's own
        // words. Synced lines light with playback and a press seeks to that
        // line - the seek goes through commitSeek, the same path the bar's
        // own scrubber lands on.
        // On touch the mic folds into the overflow chooser with the rest of
        // the options; the heart the kit renders keeps the leading rail.
        leading={
          mobileControls ? undefined : (
          <Popover
            placement="top"
            aria-label="Lyrics"
            className="lyricsPopoverPanel"
            trigger={
              <IconButton variant="ghost" size="sm" aria-label="Lyrics" skeleton={listLoading}>
                <Mic size={16} />
              </IconButton>
            }
          >
            <div className="lyricsPopover">
              {/* Keyed by the track, so a change of song while the popover is
                  open tears the panel down whole: no window where the old
                  song's lines sit clickable over the new song's audio, and no
                  scroll position inherited from a sheet that no longer exists. */}
              <LyricsPanel
                key={(track ?? IDLE_TRACK).path}
                track={track ?? IDLE_TRACK}
                position={position}
                onSeek={commitSeek}
              />
            </div>
          </Popover>
          )
        }
        levels={levels}
        beat={beat}
        // The equalizer and the custom volume fader share the trailing rail; the
        // kit's own volume is dropped (no volume props) since it stops at 100%.
        // On touch the pair folds behind one overflow button - the phone's
        // hardware buttons carry the volume moment to moment, so neither
        // deserves a permanent seat the transport could be spending.
        trailing={
          // iPhone folds into the same mobile overflow as everywhere else now
          // that the graph (and so the equalizer) always runs there.
          mobileControls ? (
            <>
              {/* No device picker on the strip: the "playing on" button lives on
                  the full-screen Now Playing sheet, which has the room for it. */}
              <PluginSlot id="player-trailing" />
              <Popover
                placement="top-end"
                aria-label="Player options"
                className="morePopoverPanel"
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  if (open) setMoreView('menu');
                }}
                trigger={
                  /* Where the ⋮ used to be. The strip's one trailing control is
                      now the thing you actually reach for mid-song on a phone -
                      where is this playing - rather than a menu of panels. The
                      equalizer moved to the Now Playing sheet with the other
                      playback controls; lyrics already open full-screen from
                      there; and volume belongs to the phone's own buttons (see
                      the mobile volume note). */
                  <IconButton variant="ghost" size="sm" aria-label="Playing on">
                    <MonitorSpeaker size={18} />
                  </IconButton>
                }
              >
                <div className="morePopover">
                  {moreView === 'menu' && <DeviceList />}
                  {/* The strip's popover is the device list and nothing else
                      now. Equalizer, lyrics and volume each left for a better
                      home: the first two to the Now Playing sheet, and volume
                      to the phone's own buttons. */}
                </div>
              </Popover>
              {/* What plays next, one press from the strip. It was reachable
                  only by opening Now Playing and then finding Queue inside it
                  - two steps to answer a question people ask constantly. This
                  lifts the sheet straight to the queue, so the panel and its
                  drag-reorder stay the one implementation. */}
              <IconButton
                variant="ghost"
                size="sm"
                aria-label="Queue"
                onClick={(event: React.MouseEvent) => {
                  // The strip's dead space opens Now Playing plain; this is a
                  // control, so it must not also ride that tap up.
                  event.stopPropagation();
                  setNpQueue(true);
                  setNpOpen(true);
                }}
              >
                <ListMusic size={18} />
              </IconButton>
            </>
          ) : (
            <>
              {/* Plugin controls lead the app's own cluster, mirroring how the
                  title bar seats plugins ahead of settings. Empty when none
                  contribute. */}
              <PluginSlot id="player-trailing" />
              {/* The song-scoped slot, which on the phone belongs to the Now
                  Playing sheet. Desktop has no such sheet - the strip IS where
                  the song is - and the sheet is gated behind `mobileControls`,
                  so without this line a plugin whose only surface is this slot
                  has nowhere at all to appear on desktop. Karaoke was exactly
                  that: installed, enabled, and invisible.
                  Deliberately NOT in the touch branch above, where the sheet
                  already renders it and a second copy would be a duplicate
                  button rather than a second home. */}
              <PluginSlot id="now-playing-actions" />
              {/* The equalizer, playlist filing, and device hand-off fold
                  behind one overflow: five trailing buttons were crowding the
                  bar, and none of the three is a moment-to-moment reach.
                  Volume is, so the fader keeps its own seat. */}
              <Popover
                placement="top-end"
                aria-label="Player options"
                className="eqPopoverPanel"
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  if (open) setMoreView('menu');
                }}
                trigger={
                  <IconButton variant="ghost" size="sm" aria-label="Player options">
                    <EllipsisVertical size={18} />
                  </IconButton>
                }
              >
                <div className="morePopover">
                  {moreView === 'menu' && (
                    <div className="moreMenu">
                      <button
                        type="button"
                        className="moreMenuItem"
                        onClick={() => setMoreView('eq')}
                      >
                        <AudioLines size={16} />
                        Equalizer
                      </button>
                      {/* Filing the song that is playing, without going to
                          find its row in the table first. The dialog wants the
                          whole sheet, so the pick leaves the popover. */}
                      {track && (
                        <button
                          type="button"
                          className="moreMenuItem"
                          onClick={() => {
                            setMoreOpen(false);
                            setFiling(track);
                          }}
                        >
                          <ListPlus size={16} />
                          Add to playlist
                        </button>
                      )}
                      {devicesAvailable && (
                        <button
                          type="button"
                          className="moreMenuItem"
                          onClick={() => setMoreView('devices')}
                        >
                          <MonitorSpeaker size={16} />
                          Connect to a device
                        </button>
                      )}
                    </div>
                  )}
                  {moreView !== 'menu' && (
                    <button
                      type="button"
                      className="moreBack"
                      onClick={() => setMoreView('menu')}
                    >
                      <ChevronLeft size={14} />
                      {moreView === 'devices' ? 'Devices' : 'Equalizer'}
                    </button>
                  )}
                  {moreView === 'eq' && (
                    <div className="eqPopover">
                      {/* The same console the sheet shows, so the two
                          surfaces cannot drift into different ideas of what
                          the sound controls are. */}
                      <SoundConsole narrow={false} />
                    </div>
                  )}
                  {moreView === 'devices' && <DeviceList />}
                </div>
              </Popover>
              <VolumeControl
                value={volume}
                muted={muted}
                onValueChange={setVolumeState}
                onMutedChange={setMutedState}
              />
            </>
          )
        }
        // The shadow trailing the beat under the played run; nothing is drawn
        // without a beat to trail, so it is safe to leave on.
        tracer
        // The bar moves as hard as the station is playing.
        intensity={beatIntensity(volume, muted, systemVolume)}
      />
      </div>
  );
}
