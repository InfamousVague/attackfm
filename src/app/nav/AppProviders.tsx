import { HapticsProvider, LocaleProvider, ToastProvider } from '@glacier/react';
import type { ReactNode } from 'react';
import { AppearanceProvider } from '../settings/appearance.tsx';
import { LibraryProvider } from '../library/library.tsx';
import { ServerSessionProvider } from '../servers/serverSession.tsx';
import { RegistrySessionProvider } from '../servers/registrySession.tsx';
import { EqualizerProvider } from '../player/equalizer.tsx';
import { PlaybackProvider } from '../player/playback.tsx';
import { PlaybackSyncProvider } from '../player/playbackSync.tsx';
import { NowPlayingMotionProvider } from '../player/nowPlayingMotion.tsx';
import {
  AcquireProvider,
  PluginProviders,
  PluginsProvider,
} from '../../plugins/runtime.tsx';
import { QueueControlsBridge } from '../player/queueControls.tsx';
import { PlayNowBridge } from '../player/playNow.tsx';
import { NotificationTapBridge } from '../notify/NotificationTapBridge.tsx';
import { RadioProvider } from '../player/radio.tsx';
import { PlaylistsProvider } from '../playlists/playlists.tsx';
import { LibrarySyncProvider } from '../library/librarySync.tsx';
import { JamProvider } from '../player/jam.tsx';
import { MobileAuthGate } from '../servers/MobileAuthGate.tsx';
import { hapticsImpl } from '../core/haptics.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The provider pyramid App renders inside, extracted whole. The nesting ORDER
 * is load-bearing - each layer's comment says why it sits where it does - so
 * this component must reproduce it exactly. The queue callbacks
 * (QueueControlsBridge, RadioProvider) are App's; they thread through props.
 */
export function AppProviders({
  queue,
  extendQueue,
  playNext,
  addToQueue,
  playNow,
  children,
}: {
  queue: Track[];
  extendQueue: (more: Track[]) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  /** App's own playFrom, published so any surface can start a song without
   *  having been handed an onPlay - see playNow.tsx. */
  playNow: (track: Track, context?: Track[]) => void;
  children: ReactNode;
}) {
  return (
    <LocaleProvider locale="en">
      {/* The provider's delegated per-press tick is OFF: a buzz on every tap
          and on cards rippling in read as force feedback, not feel. The
          semantic moments that stay (favourite, transport, disc physics,
          swipe-back) fire fireNativeHaptic directly, gated by the haptics
          preference - so `enabled={false}` silences only the kit's own listener,
          not those. The impl stays for any kit surface that asks via useHaptics.

          The app-wide tap tick is OURS instead (installTapHaptics, in App): the
          kit fires on pointerdown, and a scroll starts with a pointerdown, so
          its version buzzed the whole way down a flicked shelf. Ours waits for
          the finger to lift near where it landed, which is the only moment a
          tap can be told apart from a drag. */}
      <HapticsProvider enabled={false} impl={hapticsImpl}>
        <ToastProvider>
          <AppearanceProvider>
            {/* Which server (if any) is connected sits above the library,
                because which library the app is showing is downstream of that
                answer - and a connect or disconnect should rebuild the list
                below rather than blend two libraries together. It also sits
                above the plugin registry, which filters server-backed plugins
                (the importer on a phone) on the live session. */}
            {/* Identity is the outer layer: who you are (a central registry
                account) sits above which library you are playing from (a
                server session), because an account can exist with no server
                and a server is reached by an account. */}
            <RegistrySessionProvider>
            <ServerSessionProvider>
            {/* The phone's front door: with no local library of its own, a
                mobile build gates the whole app behind a server sign-in and
                shows nothing else until one is connected. Desktop keeps its
                local library and passes straight through. */}
            <MobileAuthGate>
            {/* Who is running sits above the library while the plugins' own
                providers mount inside it, so a plugin (the importer, say) can
                read and rescan the library. */}
            <PluginsProvider>
            <LibraryProvider>
            {/* The user's own playlists: storage only, so it sits beside the
                library rather than inside it - the showcase and the song
                table resolve its paths against whichever library is live. */}
            <PlaylistsProvider>
            {/* Keeps the local music folder reconciled with the connected
                server - the up half of the hub model. Above the plugins so
                the importer can kick a pass when a download lands. */}
            <LibrarySyncProvider>
            <PluginProviders>
            <EqualizerProvider>
            {/* The playback settings - crossfade, shuffle manners, the sleep
                timer - read by the player below and by the settings modal. */}
            <PlaybackProvider>
            {/* AttackFM Connect: the device registry and shared playback
                session, so any signed-in device can see and drive what is
                playing on any other. Inert (no socket) off a server. Wraps the
                player, which registers as this device's executor. */}
            <PlaybackSyncProvider>
            <JamProvider>
            {/* The loudness reading the player publishes and the header moves
                to. It wraps both, which is the whole reason it exists. */}
            <NowPlayingMotionProvider>
            {/* The acquire hub: gathers every enabled plugin's "get this"
                handlers so any Add control gates on whether one exists, fires
                the lone one, or lets the user choose among several. Inside the
                plugin providers (a handler reads its own plugin's context) and
                above the content that carries Add controls. */}
            <AcquireProvider>
            {/* Queue editing (Play next / Add to queue) for every track surface
                below - onto this deck's queue, or, when following a jam, into
                the room the host folds it into. */}
            <QueueControlsBridge localPlayNext={playNext} localAddToQueue={addToQueue}>
            {/* Just-play-it, for every track surface below. Inside the queue
                bridge so a row can offer both verbs from one place. */}
            <PlayNowBridge play={playNow}>
            {/* The station feeds the one queue rather than keeping its own -
                see radio.tsx. It wraps the CONTENT as well as the deck: a
                song offers to start a station wherever it is drawn, and a
                menu outside this provider would silently lack the item. */}
            <RadioProvider queue={queue} onExtend={extendQueue}>
            {/* Turns a tap on a "New music" tray entry into playback - it
                needs the play verb and the library, so it lives here inside
                both. Renders nothing. */}
            <NotificationTapBridge />
            {children}
            </RadioProvider>
            </PlayNowBridge>
            </QueueControlsBridge>
            </AcquireProvider>
            </NowPlayingMotionProvider>
            </JamProvider>
            </PlaybackSyncProvider>
            </PlaybackProvider>
            </EqualizerProvider>
            </PluginProviders>
            </LibrarySyncProvider>
            </PlaylistsProvider>
            </LibraryProvider>
            </PluginsProvider>
            </MobileAuthGate>
            </ServerSessionProvider>
            </RegistrySessionProvider>
          </AppearanceProvider>
        </ToastProvider>
      </HapticsProvider>
    </LocaleProvider>
  );
}
