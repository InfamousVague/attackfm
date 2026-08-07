import type { ComponentType, ReactNode } from 'react';
import type { Track } from '../app/tauri.ts';

/**
 * The contract between the app's chrome and the plugins that extend it.
 *
 * A plugin is a plain object: no lifecycle, no base class, no manifest file.
 * Mounting and unmounting its contributions IS the lifecycle, and React
 * already owns that. Every field must be stable for the life of the app -
 * dynamism lives inside the components and hooks a plugin hands over, never
 * in the shape of the object itself.
 *
 * Layering: plugin code imports this file, `src/app/*`, and its own modules -
 * never `runtime.tsx` or the registry in `index.ts`, so no cycle is possible.
 */

/**
 * The fixed chrome mount points a plugin can render into: the title bar's end
 * cluster (between search and the settings button) and the player bar's
 * trailing rail (ahead of the equalizer). One component per plugin per slot -
 * a plugin wanting two buttons wraps them in a fragment - and a slot renders
 * enabled plugins in registration order. Playlist tiles are deliberately NOT
 * a slot: they are a data contract (PluginPlaylistTile) so the showcase keeps
 * the house tile look and wires play-through itself.
 */
export type PluginSlotId = 'titlebar-end' | 'player-trailing';

/** One tab a plugin adds to the settings modal's rail. */
export interface PluginSettingsSection {
  /** Unique within the plugin; the runtime prefixes it with the plugin id. */
  id: string;
  label: string;
  icon?: ReactNode;
  /**
   * The pane. Rendered behind a fence: a crash here pulls the whole plugin
   * for the session - tab, buttons, provider and all - and the settings modal
   * falls back to the Plugins pane, where the crash notice explains why.
   */
  Content: ComponentType;
}

/** What the palette hands a plugin's command hook on every render. */
export interface PaletteContext {
  /** The live query, exactly as typed - it changes on every keystroke. */
  query: string;
  /** Closes the palette. A command that acts and leaves should call it. */
  close: () => void;
}

/** A command a plugin offers the palette for the current query. */
export interface PluginCommand {
  /** Unique within the plugin; the runtime namespaces it before merging. */
  id: string;
  label: string;
  group?: string;
  keywords?: string;
  /**
   * When true the song results stand aside and only plugin commands show -
   * for queries that are an action rather than a search, like a pasted link.
   * Two exclusive plugins show the union of their commands, in registration
   * order.
   */
  exclusive?: boolean;
  run: () => void;
}

/**
 * A playlist tile for the showcase strip. A data contract rather than a
 * component: the showcase renders it with its own Tile and PlaylistModal and
 * wires play-through, so a plugin says what the playlist IS, not what a tile
 * looks like.
 */
export interface PluginPlaylistTile {
  /** Unique within the plugin. */
  id: string;
  /**
   * A hook, run inside a dedicated per-tile component instance while the tile
   * is mounted, so it may read any context - the library, the plugin's own -
   * and recompute as state changes. Like every plugin hook: its own hooks
   * must be called unconditionally, in fixed order, before any early return.
   */
  usePlaylist: () => {
    name: string;
    /** The squircle's contents, e.g. a glyph or a cover mosaic. */
    cover: ReactNode;
    tracks: readonly Track[];
    emptyLabel: string;
  };
}

export interface Plugin {
  /** Stable kebab-case id: registry key, storage key, crash attribution. */
  id: string;
  /** The name on the marketplace card and its detail dialog. */
  name: string;
  /** One sentence on the card, saying what turning it on gets you. */
  description: string;
  /**
   * The listing, beyond the card line. All optional: a plugin without them
   * still lists, it just wears less. What the plugin ADDS to the app is never
   * declared here - the detail dialog derives it from the contributions
   * themselves (slots, sections, tiles, commands), which cannot go stale.
   */
  /** The card's glyph, sized for a squircle - an icon, not a wordmark. */
  icon?: ReactNode;
  /** Who made it, shown under the name. */
  author?: string;
  /** Version string shown beside the author, e.g. '1.2.0'. */
  version?: string;
  /** Short labels the card wears as tags, e.g. 'Importer'. */
  tags?: readonly string[];
  /**
   * True for a plugin that cannot work off a desktop - one that shells out to
   * a subprocess, walks the machine's own filesystem, or wants a browser
   * redirect back. It is left out of the registry entirely on a phone rather
   * than listed and switched off: a marketplace card offering something the
   * platform cannot do is worse than no card.
   */
  desktopOnly?: boolean;
  /**
   * The detail dialog's prose - a paragraph or two, where description is one
   * line. Falls back to description when absent.
   */
  details?: string;
  /**
   * Mounted around the app content, inside LibraryProvider and the other
   * core providers, so it may call useLibrary. Enabled plugins' providers
   * nest in registration order, first registered outermost. This is where a
   * plugin runs background work - subscriptions, queues - via ordinary
   * effects that stop when the plugin is switched off and unmounts.
   */
  Provider?: ComponentType<{ children: ReactNode }>;
  /** Components for the chrome's fixed mount points. */
  slots?: Partial<Record<PluginSlotId, ComponentType>>;
  /** Tabs appended to the settings modal after the core sections. */
  settingsSections?: readonly PluginSettingsSection[];
  /** Tiles appended to the playlist showcase after the built-in three. */
  playlistTiles?: readonly PluginPlaylistTile[];
  /**
   * A React hook returning the plugin's commands for the current query. It
   * may call other hooks, but must call them unconditionally and in a fixed
   * order BEFORE any early return - the ordinary rule every hook lives by.
   * Called on every palette render from inside a PluginHookScope; see the
   * hook-order note on usePluginCommands in runtime.tsx.
   */
  usePaletteCommands?: (ctx: PaletteContext) => readonly PluginCommand[];
}
