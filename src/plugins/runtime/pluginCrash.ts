/**
 * An error rethrown out of a plugin's hook, tagged with the plugin that threw
 * so the boundary above knows exactly which plugin to pull.
 *
 * Its own module rather than a passenger in `pluginBoundaries.tsx`: three
 * files construct one and a fourth tests `instanceof` against it, and a class
 * that decides which plugin gets disabled is worth being able to test on its
 * own. The boundary file keeps the components.
 */
export class PluginCrashError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(`Plugin "${pluginId}" crashed`, { cause });
  }
}
