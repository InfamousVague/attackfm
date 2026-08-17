import { useContext, type ReactNode } from 'react';
import { useDownloadsOptional } from '../importsBridge.ts';
import { usePlugins } from '../pluginsContext.ts';
import { HookScopeContext, PluginCrashError, PluginFence } from './pluginBoundaries.tsx';
import type {
  DownloadItem,
  PaletteContext,
  PluginCommand,
  PluginPageProps,
} from '../types.ts';

/** A palette row as the runtime hands it to the search page: id already namespaced. */
export interface PaletteCommandRow {
  id: string;
  label: string;
  group?: string;
  keywords?: string;
}

export interface PalettePluginCommands {
  commands: PaletteCommandRow[];
  /** True when some plugin claimed the query outright (a pasted link, say). */
  exclusive: boolean;
  /** Runs a plugin command by palette id; false when the id is not a plugin's. */
  run: (id: string) => boolean;
}

/**
 * Collects every enabled plugin's palette commands for the current query.
 *
 * Hook order: this loops over `enabled` calling plugin hooks, which is only
 * legal because the caller sits under a PluginHookScope - `enabled` cannot
 * change without changing the scope's key, so the sequence of hook calls is
 * fixed for the life of any instance. The scope check below turns a call
 * site that forgot the scope into an immediate render error instead of a
 * latent hook-corruption bug. A plugin hook that throws has already spent
 * hook slots, so the render is not salvageable past it: the error is tagged
 * and rethrown for the scope's boundary, which pulls the plugin and remounts
 * the scope with a clean slate.
 */
export function usePluginCommands(ctx: PaletteContext): PalettePluginCommands {
  const { enabled } = usePlugins();
  const inScope = useContext(HookScopeContext);
  if (!inScope) throw new Error('usePluginCommands must render under a PluginHookScope');

  const commands: PaletteCommandRow[] = [];
  const runs = new Map<string, { pluginId: string; fn: () => void }>();
  let exclusive = false;
  for (const p of enabled) {
    if (!p.usePaletteCommands) continue;
    let cmds: readonly PluginCommand[];
    try {
      // A fixed sequence per mount - the scope's key sees to it; see above.
      cmds = p.usePaletteCommands(ctx);
    } catch (error) {
      throw new PluginCrashError(p.id, error);
    }
    for (const c of cmds) {
      const id = `plugin:${p.id}:${c.id}`;
      // A repeated id would show two rows and run one handler; name the
      // plugin now rather than letting the collision pass as flakiness.
      if (runs.has(id)) console.warn(`[plugins] "${p.id}" repeated palette command id "${c.id}"`);
      commands.push({ id, label: c.label, group: c.group, keywords: c.keywords });
      runs.set(id, { pluginId: p.id, fn: c.run });
      if (c.exclusive) exclusive = true;
    }
  }
  return {
    commands,
    exclusive,
    run: (id) => {
      const entry = runs.get(id);
      if (!entry) return false;
      try {
        entry.fn();
      } catch (error) {
        // Boundaries never see handler throws; contain the dispatch so a bad
        // command cannot strand the palette, and name the plugin in the log.
        console.error(`[plugins] "${entry.pluginId}" palette command failed`, error);
      }
      return true;
    },
  };
}

/** A plugin page resolved for the nav host: its route key, its nav item, and a
 *  render that seats the page behind the plugin's crash fence. */
export interface ResolvedPluginPage {
  /** `${plugin.id}:${page.id}` - what the nav's current-tab value matches on. */
  key: string;
  pluginId: string;
  label: string;
  icon: ReactNode;
  /** Renders the page's content, fenced, with the core play/navigation doors. */
  render: (props: PluginPageProps) => ReactNode;
}

/**
 * The enabled plugins' navigable pages, in registration order, shaped for the
 * nav host. Like usePluginSettingsSections this maps over static data and calls
 * no plugin hooks, so it is safe anywhere below PluginsProvider with no scope -
 * the nav bar and the content switch both read it and stay in agreement because
 * they see the same enabled set. A page whose plugin is switched off mid-view
 * simply drops out of this list, and the host falls back to Home.
 */
export function usePluginPages(): ResolvedPluginPage[] {
  const { enabled } = usePlugins();
  return enabled.flatMap((p) =>
    (p.pages ?? []).map((page) => ({
      key: `${p.id}:${page.id}`,
      pluginId: p.id,
      label: page.label,
      icon: page.icon,
      render: (props: PluginPageProps) => (
        <PluginFence pluginId={p.id}>
          <page.Content {...props} />
        </PluginFence>
      ),
    })),
  );
}

/**
 * Whether ANYTHING in this build can download - the one question the three
 * gates around the Downloads surface (the rail item, the ⋮ row, the content
 * switch) all used to answer for themselves by asking whether the music
 * importer was running. It is a plural page now, so a hub with only a book
 * downloader on has a queue worth showing and a tab worth offering.
 *
 * Reads declarations, not queues: it must be callable from a nav bar, and
 * asking a source what it holds means calling its hook, which is legal only
 * inside a PluginHookScope. Deliberately NOT folded into the `canDiscover`
 * test beside it - Discover is about acquiring MUSIC, and a books-only build
 * should not grow a music feed because it can pull an audiobook.
 */
export function useHasDownloadQueue(): boolean {
  const { enabled } = usePlugins();
  const bridge = useDownloadsOptional();
  return bridge !== null || enabled.some((p) => p.downloads?.length);
}

/** One plugin's queue, resolved for the Downloads page: the source's own
 *  identity, the items it is carrying, and whatever controls it offered. */
export interface ResolvedDownloadSource {
  /** `${plugin.id}:${source.id}` - stable across renders, unique across
   *  plugins, and the prefix every item's key is built from. */
  key: string;
  pluginId: string;
  label: string;
  icon?: ReactNode;
  items: readonly DownloadItem[];
  paused?: boolean;
  setPaused?: (paused: boolean) => void;
  clearFinished?: () => void;
}

/**
 * Every enabled plugin's download queue, for the one page that shows them.
 *
 * Hook order: like usePluginCommands this loops over `enabled` calling plugin
 * hooks, legal only because the caller sits under a PluginHookScope whose key
 * changes with the enabled set - so the sequence of hook calls is fixed for
 * the life of any instance. A source that throws has already spent hook slots,
 * so the render cannot continue past it: the error is tagged for the scope's
 * boundary, which pulls that plugin and remounts the scope clean. That is also
 * why one plugin's broken queue cannot take the page down with it.
 */
export function usePluginDownloadSources(): ResolvedDownloadSource[] {
  const { enabled } = usePlugins();
  const inScope = useContext(HookScopeContext);
  if (!inScope) throw new Error('usePluginDownloadSources must render under a PluginHookScope');

  const sources: ResolvedDownloadSource[] = [];
  for (const p of enabled) {
    for (const source of p.downloads ?? []) {
      let feed;
      try {
        // A fixed sequence per mount - the scope's key sees to it; see above.
        feed = source.useDownloads();
      } catch (error) {
        throw new PluginCrashError(p.id, error);
      }
      sources.push({
        key: `${p.id}:${source.id}`,
        pluginId: p.id,
        label: source.label,
        icon: source.icon,
        items: feed.items,
        paused: feed.paused,
        setPaused: feed.setPaused,
        clearFinished: feed.clearFinished,
      });
    }
  }
  return sources;
}

/** What SettingsModal spreads into TabbedModal's sections. */
export interface ResolvedSettingsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

/**
 * The enabled plugins' settings tabs, shaped for TabbedModal. This maps over
 * static data - it calls no plugin hooks - so it is safe anywhere below the
 * PluginsProvider with no scope needed, and the modal survives a toggle
 * without remounting out from under the user.
 */
export function usePluginSettingsSections(): ResolvedSettingsSection[] {
  const { enabled } = usePlugins();
  return enabled.flatMap((p) =>
    (p.settingsSections ?? []).map((s) => ({
      id: `${p.id}:${s.id}`,
      label: s.label,
      icon: s.icon,
      content: (
        <PluginFence pluginId={p.id}>
          <s.Content />
        </PluginFence>
      ),
    })),
  );
}
