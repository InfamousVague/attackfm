/**
 * The plugin runtime: who is running, where their pieces mount, and what
 * happens when one of them breaks. Core imports this; plugins never do (they
 * import types.ts), so the dependency arrow only points one way.
 *
 * The implementation lives in runtime/: pluginsProvider.tsx (the provider and
 * the boot-time registry validation), pluginBoundaries.tsx (fences, scopes,
 * providers, slots), pluginHooks.tsx (the enabled-set collection hooks), and
 * pluginAcquire.tsx (the acquire machinery). This file is the one import path
 * the app uses.
 */

export { usePlugins } from './pluginsContext.ts';
export { PluginsProvider } from './runtime/pluginsProvider.tsx';
export {
  PluginFence,
  PluginHookScope,
  PluginProviders,
  PluginSlot,
} from './runtime/pluginBoundaries.tsx';
export {
  usePluginCommands,
  usePluginPages,
  useHasDownloadQueue,
  usePluginDownloadSources,
  usePluginSettingsSections,
  type PaletteCommandRow,
  type PalettePluginCommands,
  type ResolvedPluginPage,
  type ResolvedDownloadSource,
  type ResolvedSettingsSection,
} from './runtime/pluginHooks.tsx';
export {
  IMPORTER_PLUGIN_ID,
  AcquireProvider,
  useAcquire,
  type AcquireValue,
  type ResolvedAcquireHandler,
} from './runtime/pluginAcquire.tsx';
