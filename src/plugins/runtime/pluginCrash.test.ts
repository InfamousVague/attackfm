import { describe, expect, it } from 'vitest';
import { PluginCrashError } from './pluginCrash.ts';

/**
 * The tag that decides which plugin gets pulled.
 *
 * A plugin's hook throwing takes the whole subtree down; the boundary above
 * reads `pluginId` off the error to know whose fault it was, and disabling the
 * wrong plugin is a bug that looks like the right one worked - the screen
 * comes back, and a plugin nobody complained about is off.
 */
describe('PluginCrashError', () => {
  it('carries the plugin that threw', () => {
    const err = new PluginCrashError('fm.attack.discover', new Error('boom'));
    expect(err.pluginId).toBe('fm.attack.discover');
  });

  it('keeps the original error as its cause', () => {
    // The boundary shows its fallback; the console still has to be able to
    // say what actually went wrong inside the plugin.
    const cause = new TypeError('undefined is not a function');
    expect(new PluginCrashError('p', cause).cause).toBe(cause);
  });

  it('survives a non-Error cause, because a plugin can throw anything', () => {
    expect(new PluginCrashError('p', 'a string').cause).toBe('a string');
    expect(new PluginCrashError('p', undefined).cause).toBeUndefined();
  });

  it('names the plugin in the message, for the line that reaches a log', () => {
    expect(new PluginCrashError('fm.attack.lyrics', null).message).toContain('fm.attack.lyrics');
  });

  it('is an Error, and answers instanceof across module boundaries', () => {
    // The boundary's whole test is `error instanceof PluginCrashError`, and
    // it runs in a different module from the three that construct one.
    const err: unknown = new PluginCrashError('p', new Error('x'));
    expect(err).toBeInstanceOf(PluginCrashError);
    expect(err).toBeInstanceOf(Error);
  });
});
