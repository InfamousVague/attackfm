import { useCallback, useState } from 'react';
import { installSheetDismiss } from './playerDismiss.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import {
  ContextMenu,
  IconButton,
  MenuItem,
  Popover,
  SeekBar,
  Switch,
  useBeat,
  useLiveLevels,
} from '@glacier/react';
import type { LoudnessMeter, PlayerRepeat } from '@glacier/react';
import {
  AudioLines,
  Check,
  ChevronDown,
  Disc3,
  EyeOff,
  Heart,
  Image as ImageIcon,
  ListMusic,
  ListPlus,
  Mic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  Sparkles,
  SkipBack,
  SkipForward,
  Volume2,
} from '@glacier/icons';
import { isMobile } from '../core/platform.ts';
import { EqPanel } from './EqPanel.tsx';
import { setFxChainOn, useFxChain } from './fxChain.ts';
import { MarqueeText } from './MarqueeText.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { NowPlayingBackdrop } from './NowPlayingBackdrop.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { DevicePicker } from './DevicePicker.tsx';
import { VolumeRow } from './VolumeControl.tsx';
import { LyricsPanel } from './LyricsPanel.tsx';
import type { PauseStyle } from './playback.tsx';
import {
  FADE_DOWN_MS,
  FADE_UP_MS,
  IDLE_TRACK,
  SPIN_DOWN_MS,
  SPIN_UP_MS,
  beatIntensity,
  formatClock,
  type ArtView,
} from './deckShared.ts';
import npPlaceholderArt from '../../assets/attack-wave.png';
import type { Track } from '../core/tauri.ts';

/**
 * One menu, three doorways: the strip's square, the sheet's art, and the
 * Canvas clip itself all open this same chooser, so the setting stays one
 * setting no matter where the press lands.
 */
export function npArtMenuItems(artView: ArtView, chooseArtView: (next: ArtView) => void) {
  return (
    <>
      <MenuItem
        icon={<Disc3 size={15} />}
        shortcut={artView === 'cd' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cd')}
      >
        Spinning CD
      </MenuItem>
      <MenuItem
        icon={<ImageIcon size={15} />}
        shortcut={artView === 'cover' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cover')}
      >
        Album cover
      </MenuItem>
      <MenuItem
        icon={<EyeOff size={15} />}
        shortcut={artView === 'hidden' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('hidden')}
      >
        Hidden
      </MenuItem>
    </>
  );
}

/**
 * The full-screen Now Playing surface, on touch only. Portalled to the
 * body so its stacking is the viewport's, not the mini-strip's plate
 * (which sits below the nav bar) - otherwise the nav would paint over
 * it. It reuses every handler the strip does, so the two never diverge.
 * Pure presentation, extracted from Player.tsx: every value and handler
 * arrives through props from the deck core.
 */
export function NowPlayingSheet({
  npOpen,
  npDocked,
  npDimmed,
  setNpDimmed,
  pokeNpDim,
  npCanvas,
  npLyrics,
  setNpLyrics,
  npQueue,
  setNpQueue,
  setNpOpen,
  npArtMenu,
  artView,
  track,
  artwork,
  dispArtwork,
  activeElsewhere,
  dispPlaying,
  playing,
  audible,
  buffering,
  downloading,
  meter,
  progress,
  pauseStyle,
  onScratchBegin,
  onScratch,
  onScratchEnd,
  onOpenArtist,
  chapterLabel,
  favorite,
  toggleFavoriteFelt,
  duration,
  position,
  volume,
  muted,
  systemVolume,
  onScrub,
  commitSeek,
  shuffle,
  smart,
  cycleShuffle,
  canSkip,
  skipBack,
  skipForward,
  setPlayingState,
  repeat,
  cycleRepeat,
  narrowEq,
  setVolumeState,
  setMutedState,
  queue,
  onQueueChange,
  onTrackChange,
  setFiling,
}: {
  npOpen: boolean;
  npDocked: boolean;
  npDimmed: boolean;
  setNpDimmed: (next: boolean) => void;
  pokeNpDim: () => void;
  npCanvas: string | null;
  npLyrics: boolean;
  setNpLyrics: (next: boolean) => void;
  npQueue: boolean;
  setNpQueue: (next: boolean) => void;
  setNpOpen: (next: boolean) => void;
  npArtMenu: ReactNode;
  artView: ArtView;
  track: Track | null;
  artwork: string | null;
  dispArtwork: string | null;
  activeElsewhere: boolean;
  dispPlaying: boolean;
  playing: boolean;
  audible: boolean;
  buffering: boolean;
  downloading: boolean;
  /** The deck's loudness meter; the sheet runs its own beat/levels off it so
   *  the 60fps pulse re-renders this surface, never the whole Player. */
  meter: LoudnessMeter | null;
  /** Playhead as a 0-1 fraction, so ripples leave the playhead. */
  progress: number;
  pauseStyle: PauseStyle;
  onScratchBegin: () => void;
  onScratch: (deltaSeconds: number) => void;
  onScratchEnd: () => void;
  onOpenArtist?: (artist: string) => void;
  chapterLabel: string | null;
  favorite: boolean;
  toggleFavoriteFelt: () => void;
  duration: number;
  position: number;
  volume: number;
  muted: boolean;
  systemVolume: number;
  onScrub: (to: number) => void;
  commitSeek: (to: number) => void;
  shuffle: boolean;
  /** Smart shuffle: enhancers mixed in. Only meaningful while shuffle is on. */
  smart: boolean;
  /** off -> shuffle -> smart shuffle -> off. */
  cycleShuffle: () => void;
  canSkip: boolean;
  skipBack: () => void;
  skipForward: () => void;
  setPlayingState: (next: boolean) => void;
  repeat: PlayerRepeat;
  cycleRepeat: () => void;
  narrowEq: boolean;
  setVolumeState: (next: number) => void;
  setMutedState: (next: boolean) => void;
  queue: Track[];
  onQueueChange?: (tracks: Track[]) => void;
  onTrackChange?: (track: Track) => void;
  setFiling: (track: Track | null) => void;
}) {
  // Subscribed HERE rather than handed down - same reasoning as the strip:
  // whichever component calls useBeat re-renders per animation frame, and it
  // should be the surface drawing the pulse, not the whole deck core.
  /*
   * Whether the clip on screen is actually showing frames.
   *
   * Keyed off the clip's own URL so a track change puts it straight back to
   * false - otherwise the next song's video would inherit the last one's
   * "ready" and flash its empty box at full opacity, which is the bug this
   * gate exists to remove, only faster.
   */
  /*
   * The sheet's own way out.
   *
   * It rose from the strip and the only way back was a chevron in the top-LEFT
   * corner - the one corner a thumb holding a phone cannot reach. Pushing it
   * back where it came from is how every full-screen player on the platform
   * closes, and it was the one gesture this one did not have.
   */
  const sheetRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      return installSheetDismiss(node, {
        onDismiss: () => {
          fireNativeHaptic('light');
          setNpOpen(false);
          setNpLyrics(false);
        },
      });
    },
    [setNpOpen, setNpLyrics],
  );

  const [readyCanvas, setReadyCanvas] = useState<string | null>(null);
  const canvasReady = readyCanvas !== null && readyCanvas === npCanvas;
  const setCanvasReady = (on: boolean) => setReadyCanvas(on ? npCanvas : null);

  const beat = useBeat({ meter, active: audible, at: progress });
  const levels = useLiveLevels({ meter, progress, active: audible });
  return createPortal(
    <>
      {/* What is behind the sheet, while the sheet is being pushed off it.

          A sibling rather than a child: the sheet paints its own opaque
          background, and nothing inside it can sit behind that. Mounted only
          while a drag is live, because a full-screen backdrop-filter is not
          something to leave running under an opaque surface for the hours a
          player is open. */}
      <div className="npScreen__behind" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="npScreen"
      role="dialog"
      aria-label="Now playing"
      // Always the dark palette, whatever the app wears: this surface lives
      // over album art and its own backdrop, where light-theme ink is
      // unreadable and the lyric layers (white + screen-blend) vanish.
      // The token layer scopes [data-theme] on any element, so one
      // attribute re-themes the whole subtree.
      data-theme="dark"
      data-open={npOpen || undefined}
      data-docked={npDocked || undefined}
      // Capture phase, so ANY touch on the sheet - a control, the art, the
      // veil itself - counts as activity: the dim lifts and its clock
      // restarts. The veil below swallows its own tap so a wake-up touch
      // never also presses whatever sat under it.
      onPointerDownCapture={() => {
        setNpDimmed(false);
        if (playing) pokeNpDim();
      }}
    >
      {/* The song's own cover, blown up and blurred, as the surface behind
          the controls - the same move the mini-strip's backdrop makes,
          scoped to this sheet. */}
      <div
        className="npScreen__bg"
        aria-hidden="true"
        style={artwork ? { backgroundImage: `url(${JSON.stringify(artwork)})` } : undefined}
      />
      {/* The Spotify Canvas, when the track has one: a muted loop over this
          sheet's blurred cover, keyed on its URL so a new clip restarts
          cleanly. Absent - the common case - it is simply not rendered and
          the cover shows instead. Wrapped in the same artwork-style
          chooser the art carries, so a press-and-hold on the clip itself
          offers the switch - the one that matters most here, since
          'hidden' leaves the clip as the only thing to press. */}
      {npCanvas ? (
        <ContextMenu
          aria-label="Artwork style"
          className="npScreen__canvasWrap"
          content={npArtMenu}
        >
          {/* Hidden until it is genuinely running.

              The fade used to start when the ELEMENT mounted, which is a
              promise about the network the network had not made: for the
              second or so the clip spent arriving, a transparent video box
              faded up over the sheet and whatever sat behind it - the cover
              still loading, the app's own mark blown up to fill a phone -
              showed through, warped by the backdrop's motion. Waiting for
              `playing` means the first thing anyone sees of a Canvas is the
              Canvas. Until then the blurred cover holds, which is what the
              no-clip case looks like anyway. */}
          <video
            key={npCanvas}
            className="npScreen__canvas"
            data-ready={canvasReady || undefined}
            src={npCanvas}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
            onPlaying={() => setCanvasReady(true)}
          />
        </ContextMenu>
      ) : artView === 'hidden' ? (
        // No clip and no art: the sheet's open middle still answers the
        // press-and-hold, so 'hidden' is never a state you need the mini
        // strip to climb back out of.
        <ContextMenu
          aria-label="Artwork style"
          className="npScreen__canvasWrap"
          content={npArtMenu}
        />
      ) : null}
      {/* The lyric words run the full height of the sheet, behind the
          controls. Drawn AFTER the clip on purpose: a canvas is a backdrop,
          not a cover, and the words are the thing worth reading over it. */}
      <NowPlayingBackdrop wordsOnly artwork={artwork ?? npPlaceholderArt} seed={track?.path ?? 'np'} />
      {/* A blur that rises through the bottom third, so the transport, the
          times and the title read against something settled instead of
          against whatever frame the clip happens to be on. Sits over the
          canvas and the words, under every control. */}
      <div className="npScreen__veil" aria-hidden="true" />
      <header className="npScreen__head">
        <IconButton
          variant="ghost"
          aria-label="Close now playing"
          onClick={() => {
            setNpOpen(false);
            setNpLyrics(false);
          }}
        >
          <ChevronDown size={22} />
        </IconButton>
        <span className="npScreen__source">{track?.album || 'Now playing'}</span>
        {/* Where the close button's counterweight was: filing the song is
            the one action worth a permanent seat up here, and this sheet
            has the room the mini-strip's rail does not. */}
        {track ? (
          <IconButton
            variant="ghost"
            aria-label="Add to playlist"
            onClick={() => setFiling(track)}
          >
            <ListPlus size={20} />
          </IconButton>
        ) : (
          <span className="npScreen__headSpacer" aria-hidden="true" />
        )}
      </header>

      {/* The artwork, per the chosen face - and no longer standing down
          for a Canvas: the disc turns OVER the clip now, because the
          platter is an instrument (scratch, flick) and an instrument that
          vanishes when a video shows up is a broken promise. Anyone who
          prefers the clip unobstructed picks Hidden - the third face. */}
      {artView !== 'hidden' && (
      <div className="npScreen__art">
        {/* The hero art follows the same artView the mini-strip does, so the
            choice is one setting in two places. A press (long-press on
            touch) opens the chooser. */}
        <ContextMenu
          aria-label="Artwork style"
          className="npScreen__coverTarget"
          content={npArtMenu}
        >
          {artView === 'cd' ? (
            <SpinningDisc
              art={dispArtwork}
              spinning={activeElsewhere ? dispPlaying : audible}
              spooling={buffering || downloading}
              beat={beat}
              onScratchStart={onScratchBegin}
              onScratch={onScratch}
              onScratchEnd={onScratchEnd}

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
          ) : (
            <img
              className="npScreen__cover"
              src={artwork ?? npPlaceholderArt}
              alt=""
            />
          )}
        </ContextMenu>
      </div>
      )}

      <div className="npScreen__meta">
        <div className="npScreen__lines">
          <MarqueeText className="npScreen__title" text={track?.title ?? ''} />
          {onOpenArtist && track ? (
            <button
              type="button"
              className="npScreen__artist npScreen__artistLink"
              onClick={() => {
                // The page opens under the sheet, so the sheet steps aside.
                setNpOpen(false);
                onOpenArtist(track.artist);
              }}
            >
              {track.artist}
            </button>
          ) : (
            <span className="npScreen__artist">{track?.artist ?? ''}</span>
          )}
          {chapterLabel && <span className="npScreen__chapter">{chapterLabel}</span>}
          {/* A downloading placeholder says so; otherwise only while the
              buffer is actually dry - silence with the transport still
              showing play is the mystery this whole path exists to end. */}
          {(downloading || buffering) && (
            <span className="npScreen__buffering" role="status">
              {downloading ? 'Downloading…' : 'Buffering…'}
            </span>
          )}
        </div>
        <IconButton
          variant="ghost"
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={favorite}
          className="npScreen__heart"
          onClick={toggleFavoriteFelt}
        >
          <Heart size={22} fill={favorite ? 'currentColor' : 'none'} />
        </IconButton>
      </div>

      {/* No scrubber while downloading - there is no timeline yet. */}
      {!downloading && (
      <div className="npScreen__scrub">
        {/* The kit's live bar, not a plain slider: the same waveform the
            mini strip wears, driven by the same levels and beat, so the
            now-playing screen deforms in time with the music. Pushed toward
            the hero end of the intensity range (max 3) since this bar IS
            the surface's focus, and set on a raised-card rail so the run
            ahead stays legible over the blurred cover behind it. */}
        <SeekBar
          duration={Math.max(1, duration)}
          value={position}
          aria-label="Seek"
          shape="swell"
          tone="accent"
          fill="solid"
          rail="contrast"
          levels={levels}
          beat={beat}
          tracer
          intensity={Math.min(3, beatIntensity(volume, muted, systemVolume) * 1.6)}
          onValueChange={onScrub}
          onSeekEnd={commitSeek}
        />
        <div className="npScreen__times">
          <span>{formatClock(position)}</span>
          <span>-{formatClock(Math.max(0, duration - position))}</span>
        </div>
      </div>
      )}

      <div className="npScreen__transport">
        {/* Three states in one control: off, shuffle, smart shuffle. The
            sparkle only appears on the third, because it is the only one that
            adds anything to the queue - a badge that lit for ordinary shuffle
            would be decoration promising a feature. */}
        <IconButton
          variant="ghost"
          aria-label={smart ? 'Smart shuffle' : 'Shuffle'}
          aria-pressed={shuffle}
          data-on={shuffle || undefined}
          data-smart={(shuffle && smart) || undefined}
          onClick={cycleShuffle}
        >
          <span className="shuffleGlyph">
            <Shuffle size={20} />
            {shuffle && smart && <Sparkles className="shuffleGlyph__spark" size={11} />}
          </span>
        </IconButton>
        <IconButton variant="ghost" aria-label="Previous" disabled={!canSkip} onClick={skipBack}>
          <SkipBack size={26} fill="currentColor" />
        </IconButton>
        <button
          type="button"
          className="npScreen__play"
          aria-label={downloading ? 'Downloading' : playing ? 'Pause' : 'Play'}
          disabled={downloading}
          onClick={() => setPlayingState(!playing)}
        >
          {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
        </button>
        <IconButton variant="ghost" aria-label="Next" disabled={!canSkip} onClick={skipForward}>
          <SkipForward size={26} fill="currentColor" />
        </IconButton>
        <IconButton
          variant="ghost"
          aria-label={`Repeat: ${repeat}`}
          data-on={repeat !== 'off' || undefined}
          onClick={cycleRepeat}
        >
          {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
        </IconButton>
      </div>

      {/* The secondary controls the strip has no room for: lyrics, the
          device hand-off (only when there is somewhere to send it), the
          equalizer, and the volume fader. The transport above already
          carries shuffle/repeat/skip, and favourite and filing sit on the
          meta and header rows. */}
      <div className="npScreen__actions">
        <IconButton variant="ghost" aria-label="Queue" onClick={() => setNpQueue(true)}>
          <ListMusic size={20} />
        </IconButton>
        <IconButton variant="ghost" aria-label="Lyrics" onClick={() => setNpLyrics(true)}>
          <Mic size={20} />
        </IconButton>
        <DevicePicker />
        <Popover
          placement="top"
          aria-label="Equalizer"
          className="eqPopoverPanel"
          trigger={
            <IconButton variant="ghost" aria-label="Equalizer">
              <AudioLines size={20} />
            </IconButton>
          }
        >
          <div className="eqPopover">
            <EqPanel narrow={narrowEq} />
            <FxChainRow />
          </div>
        </Popover>
        {/* No fader on a phone: volume is pinned at unity there and the
            handset's own buttons are the control, so a slider that cannot
            move would be a lie. Desktop, which has no hardware keys of its
            own, keeps it. */}
        {!isMobile && (
          <Popover
            placement="top"
            aria-label="Volume"
            className="morePopoverPanel"
            trigger={
              <IconButton variant="ghost" aria-label="Volume">
                <Volume2 size={20} />
              </IconButton>
            }
          >
            <VolumeRow
              value={volume}
              muted={muted}
              onValueChange={setVolumeState}
              onMutedChange={setMutedState}
            />
          </Popover>
        )}
      </div>

      {/* Lyrics fill the whole sheet rather than a low popover: a header to
          step back to the art, and the words scrolling below it. */}
      {npLyrics && (
        <div
          className="npScreen__lyricsScrim"
          aria-hidden="true"
          onPointerDown={() => setNpLyrics(false)}
        />
      )}
      {npLyrics && (
        <div className="npScreen__lyricsView" role="dialog" aria-label="Lyrics">
          <header className="npScreen__lyricsHead">
            <span className="npScreen__lyricsTitle">{track?.title ?? 'Lyrics'}</span>
            <IconButton variant="ghost" aria-label="Close lyrics" onClick={() => setNpLyrics(false)}>
              <ChevronDown size={22} />
            </IconButton>
          </header>
          <div className="npScreen__lyricsBody">
            <LyricsPanel
              key={(track ?? IDLE_TRACK).path}
              track={track ?? IDLE_TRACK}
              position={position}
              onSeek={commitSeek}
            />
          </div>
        </div>
      )}
      {/* The queue, over the same sheet the same way: what plays next, drag-
          reorderable, each row a jump. */}
      {npQueue && (
        <div
          className="npScreen__lyricsScrim"
          aria-hidden="true"
          onPointerDown={() => setNpQueue(false)}
        />
      )}
      {npQueue && (
        <div className="npScreen__queueView">
          <QueuePanel
            queue={queue}
            current={track}
            onQueueChange={(next) => onQueueChange?.(next)}
            onPlayTrack={(t) => onTrackChange?.(t)}
            onClose={() => setNpQueue(false)}
          />
        </div>
      )}
      {/* The inactivity veil: near-black, fading in over everything on
          this sheet. It takes pointer events only while dimmed, so the
          waking tap lands here and nowhere else. */}
      <div
        className="npScreen__dim"
        data-dim={npDimmed || undefined}
        aria-hidden="true"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      </div>
    </>,
    document.body,
  );
}

/**
 * The hi-fi chain's presence in CORE chrome, beside the EQ it composes with.
 *
 * The chain is edited in the HiFi Lab plugin, but its state persists and
 * plugins can be removed - and a persistent audio process with no visible
 * switch is the exact trap the old effects rack solved by purging itself.
 * This row is the other solution: as long as a chain is coloring playback,
 * the player itself says so and can turn it off, plugin or no plugin.
 */
function FxChainRow() {
  const chain = useFxChain();
  if (chain.nodes.length === 0) return null;
  const live = chain.nodes.filter((n) => n.on).length;
  return (
    <div className="eqFxChainRow">
      <span className="eqFxChainRow__label">
        HiFi chain · {chain.on && live > 0 ? `${live} node${live === 1 ? '' : 's'}` : 'off'}
      </span>
      <Switch
        checked={chain.on && live > 0}
        onCheckedChange={(v: boolean) => setFxChainOn(v)}
        aria-label="HiFi chain"
      />
    </div>
  );
}
