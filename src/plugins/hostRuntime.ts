/**
 * The module table a remotely-loaded plugin builds against.
 *
 * A plugin fetched from a repository is compiled elsewhere, against import
 * specifiers like `react` and `@glacier/react`. It cannot bring its own copies
 * - a second React cannot share hooks or contexts with the app's - so its
 * bundle compiles every one of those imports down to a lookup in this table,
 * which the host installs on the global before any bundle is evaluated.
 *
 * The table is a CONTRACT. Adding a module or an export is free; removing or
 * renaming one breaks every published plugin built against it, so the app
 * modules exposed here are the curated seam (`importsBridge`, the library and
 * session hooks), not the whole of `src/app`. The `api` number is bumped only
 * for breaking shape changes, and a bundle declares the api it needs in its
 * repository manifest.
 */

import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as glacierReact from '@glacier/react';
import * as glacierIcons from '@glacier/icons';

import * as tauriBridge from '../app/core/tauri.ts';
import * as platform from '../app/core/platform.ts';
import * as importsBridge from './importsBridge.ts';
import { openExternal } from '../app/core/openExternal.ts';
import { useNowPlayingMotion } from '../app/player/nowPlayingMotion.tsx';
import { deckHeld, holdDeck } from '../app/player/deckHold.ts';
import { useLibrary } from '../app/library/library.tsx';
import { useLibrarySync } from '../app/library/librarySync.tsx';
import { useServerSession } from '../app/servers/serverSession.tsx';
import { usePlaylists } from '../app/playlists/playlists.tsx';
import { EQ_BANDS, EQ_PRESETS, useEqualizer } from '../app/player/equalizer.tsx';
import * as fxChain from '../app/player/fxChain.ts';

export const HOST_API_VERSION = 1;

/** What `globalThis.__ATTACKFM_HOST__` holds while the app runs. */
export interface PluginHost {
  api: number;
  modules: Record<string, unknown>;
}

/**
 * Installs the table. Idempotent, and called before the first remote bundle
 * is evaluated (module-load order guarantees it: the plugins runtime imports
 * this file before it touches any stored bundle).
 */
export function installHostRuntime(): PluginHost {
  const host: PluginHost = {
    api: HOST_API_VERSION,
    modules: {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      '@glacier/react': glacierReact,
      '@glacier/icons': glacierIcons,
      // The curated app seam. Namespaced under @attackfm/ so a plugin's
      // imports say plainly they are host modules, not npm packages.
      '@attackfm/app/tauri': tauriBridge,
      '@attackfm/app/platform': platform,
      '@attackfm/app/importsBridge': importsBridge,
      '@attackfm/app/openExternal': { openExternal },
      '@attackfm/app/library': { useLibrary },
      // What is playing right now, read-only. A plugin acting on the current
      // song needs to know which song that is, and the sheet passes everything
      // as props rather than through a context, so this is the seam.
      '@attackfm/app/nowPlaying': { useNowPlayingMotion },
      // The hi-fi chain: read, edit, toggle. Core owns the console that edits
      // it; this is the seam that lets a plugin put its own nodes in the same
      // signal path - the Pedals board is the one that does.
      '@attackfm/app/fxChain': fxChain,
      '@attackfm/app/librarySync': { useLibrarySync },
      '@attackfm/app/serverSession': { useServerSession },
      // The output claim: a plugin whose page IS the sound - the sampler, the
      // karaoke stage - takes the deck off before it starts, so the two are
      // never playing at once. Read the module for why releasing it does not
      // start the deck back up.
      '@attackfm/app/deckHold': { holdDeck, deckHeld },
      // Added for the 2026-08 plugin batch (additive - the table only grows).
      '@attackfm/app/playlists': { usePlaylists },
      '@attackfm/app/equalizer': { EQ_BANDS, EQ_PRESETS, useEqualizer },
    },
  };
  (globalThis as { __ATTACKFM_HOST__?: PluginHost }).__ATTACKFM_HOST__ = host;
  return host;
}
