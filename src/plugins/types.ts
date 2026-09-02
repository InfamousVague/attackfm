import type { ComponentType, ReactNode } from 'react';
import type { Track } from '../app/core/tauri.ts';

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
export type PluginSlotId =
  | 'titlebar-end'
  | 'player-trailing'
  /**
   * The row of secondary controls on the Now Playing screen, beside the queue
   * and the equaliser. For a plugin that acts on the song you are listening to
   * RIGHT NOW rather than one you go and find - the
   * distinction is the whole point: it belongs where the song is, not in a menu
   * of destinations.
   *
   * TWO homes, because "where the song is" differs by platform: the Now Playing
   * sheet on touch, and the player strip's trailing cluster on desktop, which
   * has no such sheet. It rendered only in the sheet for a while, and since the
   * sheet is gated behind `mobileControls` that made every plugin living here
   * invisible on desktop rather than merely differently placed. Anything added
   * to this slot needs both.
   */
  | 'now-playing-actions'
  /**
   * The Now Playing art square - the spot where the CD spins. Rendered ONLY
   * while the listener has chosen the 'visualizer' art view (Artwork style
   * menu), which the chrome offers only when some enabled plugin fills this
   * slot. The plugin owns the whole square: it reads the audio graph through
   * useNowPlayingMotion and draws what it likes; the chrome keeps the square's
   * size, corner radius and the long-press menu around it.
   */
  | 'now-playing-art';

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
 * A thing a surface offers to pull in - a single song, a whole album, or a
 * playlist - handed to whatever plugins can "get" it. Carries what a handler
 * needs: a title (and, for a song or album, its artist) to search a store or
 * tag a download, and the source URL an importer downloads from when the
 * surface has one (a Discover card does; a bare title from elsewhere may not).
 */
export interface AcquireTarget {
  kind: 'track' | 'album' | 'playlist';
  title: string;
  artist?: string;
  /** The source link an importer pulls from, when the surface has one. */
  url?: string;
}

/**
 * A way to acquire a target, contributed by a plugin: the importer's download,
 * the Buy plugin's store finder, anything else answering "get this". The chrome
 * gathers every enabled plugin's handlers, keeps the ones that can service a
 * given target, and - when more than one can - lets the user choose. None that
 * can service it means the surface's Add control stays inert.
 */
export interface AcquireHandler {
  /** Unique within the plugin; the runtime namespaces it before merging. */
  id: string;
  /** The verb shown in the chooser (and, when it is the only handler, what the
   *  surface's own control means): 'Download', 'Buy'. */
  label: string;
  /** The chooser row's glyph. */
  icon?: ReactNode;
  /** Whether this handler can service the target. Absent means always. A
   *  download handler needs a URL; Buy wants a song or album, not a playlist. */
  canHandle?: (target: AcquireTarget) => boolean;
  /** Do it. Fire-and-forget - the handler owns its own feedback. */
  run: (target: AcquireTarget) => void;
}

/**
 * A playlist tile for the showcase strip. A data contract rather than a
 * component: the showcase renders it with its own Tile, and opening one pushes
 * a mix PAGE - the same rendering a playlist gets - so a plugin says what the
 * playlist IS, not what a tile looks like or how a list should be drawn.
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

/**
 * How a download stands. Four states, because they are the four questions a
 * queue can answer - waiting, working, landed, lost - and every downloader
 * ends up expressing itself in them however many stages it runs internally.
 * A source with finer stages says so in `stage`.
 */
export type DownloadState = 'queued' | 'downloading' | 'done' | 'error';

/**
 * One thing coming down, in the only shape the Downloads page knows.
 *
 * The page renders these and nothing else, so a queue of songs, a queue of
 * books and whatever a future plugin queues all read as the same card and sort
 * into the same three sections. The shape is deliberately the LOOSER of the
 * two it had to cover: a music import counts songs and can name the one in
 * flight, an Audible book is a single file that goes through stages, so
 * everything past identity is optional and a card wears only what its source
 * actually knows.
 *
 * The verbs are functions rather than ids because a source owns its own queue:
 * the page offers a Retry button when - and only when - the source handed it
 * something to call.
 */
export interface DownloadItem {
  /** Who or what asked for this download, in words - shown on the card so a
   *  shared box's queue says whose errand each row is. */
  via?: string | null;
  /** Unique within its source; the page namespaces it with the source key. */
  id: string;
  title: string;
  /** The line under the title - an artist, an author, a store. */
  subtitle?: string | null;
  /** What this IS, worn as a chip: 'album', 'playlist', 'book'. */
  kind?: string;
  /** Cover art, full size - the page asks for the thumbnail variant itself. */
  artworkUrl?: string | null;
  state: DownloadState;
  /**
   * The source's own word for where it is, when 'downloading' is coarser than
   * what it knows: Audible decrypts and files after the bytes land, and a card
   * saying "Decrypting" beats a bar that looks stuck.
   */
  stage?: string | null;
  /** Why it failed, shown on the card when state is 'error'. */
  error?: string | null;
  /** A short remark the card wears as a chip - what a source wants said about
   *  a job that numbers cannot say: '12 already yours'. */
  note?: string | null;
  /** Parts finished, for a job made of parts (songs, sections). */
  completed?: number;
  /** How many parts in total; null/absent means "not countable", which draws
   *  an indeterminate bar rather than a false percentage. */
  total?: number | null;
  /** The part in flight, by name - a song title, a chapter. */
  current?: string | null;
  /** Every part in order, for the card's disclosure list. Absent means the
   *  job has nothing to unfold and the toggle does not render. */
  parts?: readonly string[];
  /** The parts with what else is known about each - who it is by, how long -
   *  aligned with `parts` by index. A source that only knows names leaves it
   *  out and the list draws names. */
  partItems?: readonly { title: string; artist: string; durationMs?: number | null }[];
  /** 0-based index of the part in flight within `parts`. */
  currentIndex?: number | null;
  /** When it was queued (epoch ms), for newest-first ordering across sources. */
  createdAt?: number;
  /** Offered as a button only when the source provides it. */
  retry?: () => void;
  cancel?: () => void;
  remove?: () => void;
}

/** What a source hands back on every render: its queue, and whatever controls
 *  over that queue it actually has. */
export interface DownloadFeed {
  items: readonly DownloadItem[];
  /** Whether the source is holding off starting new work. Omit if it has no
   *  such notion - the page then offers no Pause for it. */
  paused?: boolean;
  setPaused?: (paused: boolean) => void;
  /** Drop this source's finished and failed cards. */
  clearFinished?: () => void;
}

/**
 * A queue a plugin puts on the Downloads page.
 *
 * The page is the one place downloads live, whoever is doing the downloading -
 * so a plugin does not render its own queue inside its own page, it hands the
 * queue over and the page shows it beside everything else that is coming down.
 * A user watching a playlist and a book arrive should not have to know which
 * plugin owns which, or visit two pages to find out.
 */
export interface PluginDownloadSource {
  /** Unique within the plugin; the page namespaces it with the plugin id. */
  id: string;
  /** What this queue is called where a card has to say who owns it: 'Books'. */
  label: string;
  /** The chip's glyph, sized small (11-13px). */
  icon?: ReactNode;
  /**
   * A hook returning the live queue. Run from inside a PluginHookScope on the
   * Downloads page, like every other plugin hook: its own hooks must be called
   * unconditionally and in fixed order before any early return. This is where
   * a source polls - the page is mounted for as long as anyone is watching,
   * and a source that wants to keep polling with the page closed does that in
   * its Provider and reads the result here.
   */
  useDownloads: () => DownloadFeed;
}

/**
 * What a plugin's page is handed when it mounts: the same two doors the core
 * pages (Home, the artist page) are given, and no more. A page starts playback
 * by handing the player a track and the list it came from, and opens an artist
 * by name - which lands as an artist view stacked inside the plugin's own tab,
 * so Back returns to the page. Everything else a page needs (a server session,
 * the library, another plugin's context) it reads from the providers it renders
 * under, exactly as a core page does.
 */
export interface PluginPageProps {
  /** Play a track, with the list it belongs to as the queue to walk. */
  onPlay: (track: Track, queue?: Track[]) => void;
  /** Open an artist's page, stacked inside the current tab. */
  onOpenArtist: (artist: string) => void;
  /**
   * Open one of the library's own collections.
   *
   * Both optional, and both additive: a page written before these existed
   * compiles and runs unchanged, and a host that does not pass them leaves a
   * page to fall back rather than crash. Added so a plugin that puts a song
   * INTO a collection can then take you to it - which is the difference
   * between "added" and "added, here it is".
   */
  onOpenPlaylist?: ((id: string) => void) | undefined;
  onOpenSongs?: ((collection: 'liked' | 'all' | 'onrepeat' | 'recent') => void) | undefined;
}

/**
 * A full-screen destination a plugin adds to the primary navigation: one nav
 * item (its icon and label) that, when chosen, replaces the main content area
 * with the plugin's page. It is a first-class sibling of Home and Library, not
 * a panel bolted onto one of them - the app's back/forward history walks
 * through it, an artist opened from it stacks on top of it, and the nav bar
 * lights its item while it is showing.
 *
 * The runtime keys each page by the plugin id and this id together, so two
 * plugins may both call their page 'main' without colliding. The page renders
 * behind the plugin's crash fence: a throw here pulls the whole plugin for the
 * session and the nav snaps back to Home, rather than taking the app down.
 */
export interface PluginPage {
  /** Unique within the plugin; the runtime namespaces it into a route key. */
  id: string;
  /** The nav item's text - a tooltip on the icon-only phone bar, a label on
   *  the desktop rail. */
  label: string;
  /** The nav item's glyph, sized for the rail like the core items (18px). */
  icon: ReactNode;
  /** The destination itself, rendered in the content area while its nav item
   *  is active and fenced against crashes. */
  Content: ComponentType<PluginPageProps>;
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
   * A plugin that runs off a desktop ONLY when signed into a server - the work
   * it needs (a subprocess, a redirect) lives on the hub instead of the
   * device. On the phone or the browser it appears when a server is connected
   * and vanishes when it is not; the desktop always has it (local engine or
   * server, whichever). Ignored when `desktopOnly` is set. The registry reads
   * this against the live session, so the list re-filters on connect.
   */
  serverBacked?: boolean;
  /**
   * A plugin whose whole value is a server feature - its data or engine lives
   * on the hub and nowhere else - so it is absent on EVERY platform until a
   * server is connected, the desktop included. Where `serverBacked` says "a
   * local engine will do if there is one", this says "there is no local
   * equivalent": the discover feed, for instance, is built and cached on the
   * server, so a desktop with no hub has nothing to show. Filtered against the
   * live session, so the card appears on connect and leaves on disconnect.
   * Takes precedence over `serverBacked` when both are set.
   */
  requiresServer?: boolean;
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
   * Navigable pages this plugin adds to the primary navigation, each its own
   * nav item and destination. Appended after the core tabs (Home, Library) in
   * registration order, on the desktop rail and the phone's bottom bar alike.
   */
  pages?: readonly PluginPage[];
  /**
   * Download queues this plugin contributes to the Downloads page. Rendered
   * alongside the music importer's queue and any other plugin's, merged into
   * the same what-is-happening-now sections.
   */
  downloads?: readonly PluginDownloadSource[];
  /**
   * A React hook returning the plugin's commands for the current query. It
   * may call other hooks, but must call them unconditionally and in a fixed
   * order BEFORE any early return - the ordinary rule every hook lives by.
   * Called on every palette render from inside a PluginHookScope; see the
   * hook-order note on usePluginCommands in runtime.tsx.
   */
  usePaletteCommands?: (ctx: PaletteContext) => readonly PluginCommand[];
  /**
   * A React hook returning the plugin's acquire handlers - the ways it can
   * "get this" for a track, album, or playlist a surface offers. Same rules as
   * usePaletteCommands: called from a PluginHookScope, its own hooks
   * unconditional and in fixed order before any early return, so it may read
   * the plugin's own provider (an importer's queue, the Buy modal's opener).
   */
  useAcquireHandlers?: () => readonly AcquireHandler[];
}
