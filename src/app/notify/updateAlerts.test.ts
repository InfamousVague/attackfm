/**
 * What the page tells the native update-alerts job, and when.
 *
 * The job runs with no page, so everything it will ever know about the switch,
 * the running version and the words arrives through this one bridge call. The
 * failures worth guarding are all silent ones: a switch shown on a binary that
 * cannot act on it, a start that forgets to re-send (so a reinstall leaves the
 * schedule and the switch disagreeing), words sent as raw catalogue keys, and a
 * bridge that throws into the settings screen.
 */
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureOsNotifyPermission } = vi.hoisted(() => ({ ensureOsNotifyPermission: vi.fn() }));

vi.mock('./osNotify.ts', () => ({ ensureOsNotifyPermission }));
vi.mock('../i18n/translate.ts', () => ({
  translate: (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key,
}));

import {
  VERSION_HOLE,
  startUpdateAlerts,
  switchUpdateAlerts,
  updateAlertsAvailable,
  updateAlertsMessage,
} from './updateAlerts.ts';
import { updateAlertsEnabled } from '../settings/behaviourPrefs.ts';

const KEY = 'attackfm-update-alerts';

function withBridge(impl: (json: string) => void = () => {}) {
  const setUpdateAlerts = vi.fn(impl);
  window.AFMNative = { setPlaying: () => {}, setUpdateAlerts };
  return setUpdateAlerts;
}

function sent(spy: ReturnType<typeof vi.fn>, call = -1) {
  const calls = spy.mock.calls;
  const args = calls[call < 0 ? calls.length + call : call] as [string];
  return JSON.parse(args[0]) as ReturnType<typeof updateAlertsMessage>;
}

beforeEach(() => {
  localStorage.clear();
  ensureOsNotifyPermission.mockReset();
});

afterEach(() => {
  delete window.AFMNative;
  delete window.__afmNativeGeneration;
});

describe('the message', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key;

  it('carries the switch, the baseline, the generation and the manifest the page uses', () => {
    const m = updateAlertsMessage(true, { version: '0.6.8', nativeGeneration: 3, registryUrl: 'https://registry.attack.fm/' }, t);
    expect(m.enabled).toBe(true);
    expect(m.version).toBe('0.6.8');
    expect(m.nativeGeneration).toBe(3);
    expect(m.manifestUrl).toBe('https://registry.attack.fm/v1/app/bundle');
  });

  it('leaves the version as a hole for the worker to fill, in every language', () => {
    // The worker finds the version hours later; the sentence around it has to
    // be translated now. Passing the hole as the value is what lets a language
    // put the number anywhere in its sentence.
    const m = updateAlertsMessage(false, { version: '0.6.8', registryUrl: 'https://r' }, t);
    expect(m.copy.title).toBe(`notices.updateAlertTitle(${JSON.stringify({ version: VERSION_HOLE })})`);
    expect(m.copy.channel).toBe('notices.updateAlertChannel');
    expect(m.copy.channelHint).toBe('notices.updateAlertChannelHint');
    expect(m.copy.body).toBe('notices.updateAlertBody');
  });

  it('says 0 for a generation it does not know, which the worker reads as "do not gate"', () => {
    expect(updateAlertsMessage(true, { version: '1', registryUrl: 'https://r' }, t).nativeGeneration).toBe(0);
    expect(updateAlertsMessage(true, { version: '1', nativeGeneration: Number.NaN, registryUrl: 'https://r' }, t).nativeGeneration).toBe(0);
  });
});

describe('where the switch exists', () => {
  it('is only where the bridge has the method', () => {
    expect(updateAlertsAvailable()).toBe(false);
    window.AFMNative = { setPlaying: () => {} };
    // An older Android binary running this bundle over the air.
    expect(updateAlertsAvailable()).toBe(false);
    withBridge();
    expect(updateAlertsAvailable()).toBe(true);
  });
});

describe('every start', () => {
  it('re-sends the stored switch, off by default, with the running version', () => {
    const bridge = withBridge();
    window.__afmNativeGeneration = 3;
    const stop = startUpdateAlerts();
    expect(bridge).toHaveBeenCalledTimes(1);
    const m = sent(bridge);
    expect(m.enabled).toBe(false);
    expect(m.version).toEqual(expect.any(String));
    expect(m.version.length).toBeGreaterThan(0);
    expect(m.nativeGeneration).toBe(3);
    stop();
  });

  it('re-sends ON when it was left on - the reinstall and restore case', () => {
    localStorage.setItem(KEY, 'on');
    const bridge = withBridge();
    const stop = startUpdateAlerts();
    expect(sent(bridge).enabled).toBe(true);
    stop();
  });

  it('re-sends when the language changes, and stops once cleaned up', () => {
    localStorage.setItem(KEY, 'on');
    const bridge = withBridge();
    const stop = startUpdateAlerts();
    i18next.emit('languageChanged', 'fr');
    expect(bridge).toHaveBeenCalledTimes(2);
    stop();
    i18next.emit('languageChanged', 'de');
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it('does nothing, and throws nothing, without the bridge', () => {
    expect(() => startUpdateAlerts()()).not.toThrow();
  });

  it('swallows a bridge that throws', () => {
    withBridge(() => {
      throw new Error('bridge gone');
    });
    expect(() => startUpdateAlerts()()).not.toThrow();
  });
});

describe('the switch', () => {
  it('turning on stores it, asks for permission, then schedules', async () => {
    const order: string[] = [];
    ensureOsNotifyPermission.mockImplementation(async () => {
      order.push('permission');
      return true;
    });
    const bridge = withBridge(() => order.push('bridge'));
    await expect(switchUpdateAlerts(true)).resolves.toBe(true);
    expect(updateAlertsEnabled()).toBe(true);
    expect(order).toEqual(['permission', 'bridge']);
    expect(sent(bridge).enabled).toBe(true);
  });

  it('schedules even when refused, and says it was refused', async () => {
    ensureOsNotifyPermission.mockResolvedValue(false);
    const bridge = withBridge();
    await expect(switchUpdateAlerts(true)).resolves.toBe(false);
    expect(sent(bridge).enabled).toBe(true);
  });

  it('turning off stores it and cancels without asking for anything', async () => {
    localStorage.setItem(KEY, 'on');
    const bridge = withBridge();
    await expect(switchUpdateAlerts(false)).resolves.toBe(true);
    expect(ensureOsNotifyPermission).not.toHaveBeenCalled();
    expect(updateAlertsEnabled()).toBe(false);
    // Off is the default, so the key is removed rather than written.
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sent(bridge).enabled).toBe(false);
  });

  it('lets an off-flip made during the permission prompt win', async () => {
    let answer: (ok: boolean) => void = () => {};
    ensureOsNotifyPermission.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    const bridge = withBridge();
    const on = switchUpdateAlerts(true);
    await switchUpdateAlerts(false);
    answer(true);
    await on;
    expect(sent(bridge).enabled).toBe(false);
  });
});
