import { createContext, useContext } from 'react';
import type { Plugin } from './types.ts';

/**
 * What the runtime knows about the plugins: the registry, the user's switches,
 * and this session's crashes. Split from runtime.tsx the way downloadsContext
 * is split from its provider, so React Fast Refresh can update the components
 * in place.
 */
export interface PluginsContextValue {
  /** Every registered plugin, in registration order. */
  all: readonly Plugin[];
  /** The plugins currently running: enabled by the user and not crashed. */
  enabled: readonly Plugin[];
  /**
   * Changes exactly when `enabled` changes. Everything that calls plugin
   * hooks inline is keyed on it, so a toggle remounts rather than reorders
   * hooks within a live component instance.
   */
  enabledKey: string;
  /** The user's switch, ignoring crash state. */
  isEnabled: (id: string) => boolean;
  /** Flip a switch. Either direction also clears a crash - it is the retry. */
  setEnabled: (id: string, on: boolean) => void;
  /** Plugins pulled this session after a crash, with the message that did it. */
  failures: ReadonlyMap<string, string>;
  /** Pulls a plugin until toggled or relaunch. */
  reportCrash: (id: string, error: unknown) => void;
}

export const PluginsContext = createContext<PluginsContextValue | null>(null);

export function usePlugins(): PluginsContextValue {
  const value = useContext(PluginsContext);
  if (!value) throw new Error('usePlugins must be used within a PluginsProvider');
  return value;
}
