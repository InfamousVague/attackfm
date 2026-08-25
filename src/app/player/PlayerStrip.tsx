import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { ArtistLink } from '../ux/ArtistLink.tsx';
import { useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import {
  ContextMenu,
  CounterBadge,
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
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipForward,
} from '@glacier/icons';
import { SoundConsole } from './SoundConsole.tsx';
import { soundChangesLabel, useSoundChanges } from './soundChanges.ts';
import { PluginSlot } from '../../plugins/runtime.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { BeatWave } from './BeatWave.tsx';
import { VolumeControl } from './VolumeControl.tsx';
import { useTrackShape } from './waveform.ts';
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
  const live = useLiveLevels({ meter, progress, active: audible });
  /*
   * The track's own shape, when the hub has measured it.
   *
   * The kit's seek bar has always drawn whatever run of samples it is given;
   * what it was given was the LIVE meter, which draws the moment you are in
   * and says nothing about the moment you are dragging towards. The stored
   * shape answers the question a scrubber is actually asked - where does the
   * quiet part end, how long is the outro - and it is there before a note
   * plays, which is the whole point of it.
   *
   * `dispTrack`, not `track`: the bar shows the active device's song when
   * mirroring one, and a waveform belonging to a different song is worse than
   * none. The live meter stays the fallback for a local file, a track the
   * sweep has not reached, and a hub from before this shipped.
   */
  const shape = useTrackShape(dispTrack);
  const levels = shape ?? live;
  // The overflow popover opens on a chooser - Equalizer, Lyrics, Volume -
  // and each pick swaps the panel in behind a back row. Controlled, so every
  // open starts back at the chooser rather than wherever the last visit left
  // off.
  // The badge on ⋮ and on the Equalizer row behind it. Same number on both:
  // the row alone would need the menu open to be read, which is the state the
  // badge exists to save you from opening.
  const changes = useSoundChanges();
  const [moreOpen, setMoreOpen] = useState(false);
  /*
   * The artwork's own hold. The kit opens the art-view chooser at 500ms and
   * leaves the release alone - and the release bubbles to the shell's tap,
   * which lifts the full-screen sheet ON TOP of the chooser the hold just
   * summoned. Same defect, same cure as every song tile: swallow the click
   * that ends a hold. The find() scopes it to presses that started on the
   * artwork, so the rest of the strip's dead space stays a plain handle.
   */
  const artHold = useHoldToMenu((from) => from.closest('.artViewTarget'));
  // 'lyrics' and 'volume' are the phone's views; 'devices' is the desktop's -
  // one state serves both because only one trailing branch renders at a time.
  const [moreView, setMoreView] = useState<'menu' | 'eq' | 'lyrics' | 'volume' | 'devices'>('menu');
  // Whether the overflow offers the device hand-off row at all.
  const devicesAvailable = useDevicesAvailable();

  /*
   * The wide strip's own controls.
   *
   * On a desktop window the bar reads as three columns - the disc and title,
   * then the seek with its clocks and the options under it, then the transport
   * out on the right - and two of those pieces cannot come from the kit where
   * they are needed.
   *
   * The kit builds one `_transport_` holding shuffle, the skips, play and
   * repeat as siblings, in the middle of the row UNDER the seek. Splitting it
   * (skips and play to the right, shuffle and repeat into the options) is not
   * something CSS can do, because a child cannot leave its parent's box. So
   * the wide strip asks the kit for neither: it drops the shuffle, repeat and
   * skip props (each of those controls is gated on its own prop, verified in
   * the kit's TransportControls) and renders its own.
   *
   * `playing` is still handed over. The kit's play button is the one control
   * it renders UNGATED, so it arrives whatever we pass - the stylesheet takes
   * the leftover `_transport_` out of the layout rather than pretending a prop
   * could.
   *
   * The labels are deliberately the kit's own strings. Chapter 19 hides the
   * touch strip's shuffle and repeat by `[aria-label="Shuffle"]` and
   * `[aria-label^="Repeat"]`, and a reworded label here would walk straight
   * out from behind that rule.
   */
  /*
   * The transport, for the kit's `actions` slot - which renders into the bar's
   * trailing column, the one this app has always left empty because it passes
   * no output or quality props.
   *
   * This is the COMPACT strip's transport. The kit puts play and the skips in
   * the middle of the row under the seek, between the two rails; the compact
   * bar wants them out on the right, big enough to hit without looking, with
   * the row under the seek left to the clocks and the couple of icons that
   * belong there. A child cannot leave its parent's box, so the strip does not
   * ask the kit for these at all - each is gated on its own prop - and renders
   * its own here instead.
   *
   * `role="group"` because the kit's `_transport_` carried one and this
   * replaces it. Its own note calls that a contract rather than an accident -
   * the transport and the fader are each labelled so the two are told apart
   * without inferring it from the button names - and hiding the kit's div
   * without relabelling here would leave a reader with one undifferentiated
   * run of buttons from the heart to the volume.
   *
   * A missing handler means the control cannot act - a remote whose socket has
   * dropped - and that is said with `aria-disabled` rather than `disabled`.
   * The native attribute BLURS a focused button, so a socket dropping while a
   * keyboard user stood on play would throw them silently back to the top of
   * the document. The click is already a no-op without the handler.
   */
  const compactTransport = (
    <div className="stripTransport" role="group" aria-label="Playback controls">
      {/* No back skip on the condensed bar. Going BACK a track is the rarer
          of the two by a distance, and it is the one that is still a tap away
          on the full player this strip lifts - where the width it costs here
          is width the seek bar and the clocks are short of. Forward stays:
          skipping on is what people do to a strip in passing. */}
      <IconButton
        variant="solid"
        className="stripTransport__play"
        aria-label={dispPlaying ? 'Pause' : 'Play'}
        aria-disabled={!onPlayingChangeDisp || undefined}
        data-off={!onPlayingChangeDisp || undefined}
        skeleton={listLoading}
        onClick={() => onPlayingChangeDisp?.(!dispPlaying)}
      >
        {dispPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </IconButton>
      <IconButton
        variant="ghost"
        aria-label="Next track"
        aria-disabled={!onSkipForwardDisp || undefined}
        data-off={!onSkipForwardDisp || undefined}
        skeleton={listLoading}
        onClick={onSkipForwardDisp}
      >
        <SkipForward size={20} fill="currentColor" />
      </IconButton>
    </div>
  );

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
        /*
         * Compact is a phone's answer to a phone's problem - a strip stealing
         * screen from the page above it. A desktop window has room to spare and
         * was wearing the cramped setting anyway, which is why the shape with
         * the most room read as the most squeezed. Density is only the kit's
         * padding token (`--bar-pad`: space-2 compact, space-3 comfortable), so
         * this is a breathing change and not a re-layout - but it does make the
         * plate taller, and `--app-player-height` reserves that space for every
         * page, so the two move together (chapter 19).
         */
        density={mobileControls ? 'compact' : 'comfortable'}
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
          activeElsewhere ? (
            <>
              <ArtistLink artist={dispTrack?.artist} />
              {activeDeviceName ? ` · on ${activeDeviceName}` : ''}
            </>
          ) : track?.artist ? (
            // A door on desktop, where the strip is the only chrome and the
            // dock may be dismissed; on mobile its stopPropagation simply
            // beats the shell's open-the-sheet tap, and the page appears.
            <ArtistLink artist={track.artist} />
          ) : (
            'Kevin MacLeod'
          )
        }
        /*
         * The seek bar has to be a shape that READS the samples it is given.
         * The kit's default paints a plain run and ignores `levels` entirely,
         * which is why the stored shape arrived and drew nothing: the data was
         * there, the drawing was not asked for it.
         */
        shape="waveform"
        duration={dispDuration}
        value={dispPosition}
        onValueChange={onScrubDisp}
        onSeekEnd={onSeekEndDisp}
        playing={dispPlaying}
        onPlayingChange={onPlayingChangeDisp}
        // Skip moves between tracks in the list, not within the current one.
        //
        // Withheld on the COMPACT strip, whose skips are rendered by this file
        // instead so they can sit out on the right rather than in the middle of
        // the row under the seek. Each is gated on its own prop, so not passing
        // them is how they are dropped. The desktop bar is untouched and keeps
        // the kit's own.
        onSkipBack={mobileControls ? undefined : onSkipBackDisp}
        onSkipForward={mobileControls ? undefined : onSkipForwardDisp}
        shuffle={shuffle}
        onShuffleChange={setShuffle}
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
        // The vacant trailing column, finally spent: the kit renders whatever
        // this holds into `_output_`, out past the seek and the icons.
        actions={mobileControls ? compactTransport : undefined}
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
                  has nowhere at all to appear on desktop: installed, enabled,
                  and invisible.
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
                className="popoverSheet eqPopoverPanel"
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  if (open) setMoreView('menu');
                }}
                trigger={
                  <IconButton
                    className="soundTrigger"
                    variant="ghost"
                    size="sm"
                    aria-label={
                      changes.total > 0
                        ? `Player options — ${soundChangesLabel(changes).replace('Sound — ', '')}`
                        : 'Player options'
                    }
                  >
                    <EllipsisVertical size={18} />
                    {changes.total > 0 && (
                      <CounterBadge
                        className="soundTrigger__badge"
                        count={changes.total}
                        max={99}
                        size="sm"
                        tone="accent"
                      />
                    )}
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
                        {changes.total > 0 && (
                          <CounterBadge
                            className="moreMenuItem__badge"
                            count={changes.total}
                            max={99}
                            size="sm"
                            tone="accent"
                          />
                        )}
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
