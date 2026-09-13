import i18next from 'i18next';
import { APP_VERSION } from '../core/version.ts';
import { translate } from '../i18n/translate.ts';
import { REGISTRY_URL } from '../servers/registry.ts';
import { setUpdateAlertsEnabled, updateAlertsEnabled } from '../settings/behaviourPrefs.ts';
import { ensureOsNotifyPermission } from './osNotify.ts';

/**
 * "Tell me when a new AttackFM is out" - the page's half.
 *
 * The app already keeps itself current: the launch gate installs a newer
 * frontend before the first screen, and the session asks again every couple of
 * minutes while it is open. Both need the app RUNNING. This is for the person
 * who has not opened it in a week: a native job asks the registry a few times a
 * day and posts one notification when there is something new, and tapping it
 * opens the app - where the ordinary launch gate does the updating. The job,
 * the notification and every rule about when to stay quiet live on the native
 * side (UpdateAlerts.kt, UpdateAlertWorker.kt), because the whole point is that
 * none of this page is running when they happen.
 *
 * What the page owns is the switch, the version it is running, and the words.
 * It says all three on every start (and on every language change, and every
 * flip), which is what keeps the native schedule honest: after a reinstall, a
 * restored backup, or an update that skipped a step, the page's stored answer
 * is simply re-applied rather than trusted to still match.
 *
 * ANDROID ONLY, decided by the bridge rather than by a platform test: the
 * switch appears only where `AFMNative.setUpdateAlerts` exists, which is the
 * Android shell from the update-alerts build onwards. An OTA bundle carrying
 * this file onto an OLDER Android binary shows no switch, because there is no
 * worker underneath it to schedule.
 *
 * iOS, for the record, would need all of this and more, and none of it exists
 * yet: a BGAppRefreshTask registered at launch from native code (Info.plist's
 * BGTaskSchedulerPermittedIdentifiers, and `fetch` added to UIBackgroundModes,
 * which is `audio` alone today), a local notification through
 * UNUserNotificationCenter, and a bridge for this page to reach both. Even then
 * iOS decides when - or whether - a refresh runs, from how often the app is
 * used, and never runs one for an app the listener swiped away. The dependable
 * route on iOS is a server push when a version is published, which is push.rs
 * and its APNs keys rather than anything on the device.
 */

/** The token the native side swaps for the version it found. Handed through
 *  i18next as the value of `{{version}}`, so every language places the number
 *  wherever its sentence wants it and the worker needs no grammar of its own. */
export const VERSION_HOLE = '{version}';

/** What `AFMNative.setUpdateAlerts` receives. Mirrors UpdateAlerts.configure. */
export interface UpdateAlertsMessage {
  enabled: boolean;
  /** The frontend running now - the baseline a published version must beat. */
  version: string;
  /** What the binary can run (the boot loader's `__afmNativeGeneration`), so
   *  the worker never announces a bundle this binary would refuse. 0 = unknown. */
  nativeGeneration: number;
  /** The manifest the page itself installs from, so a build pointed at another
   *  registry is not told about the production one's releases. */
  manifestUrl: string;
  copy: {
    channel: string;
    channelHint: string;
    title: string;
    body: string;
  };
}

type Translator = (key: string, options?: Record<string, unknown>) => string;

/**
 * The sentence for the native side, built from plain facts. Pure, so what the
 * worker is told can be checked without a bridge or a phone.
 *
 * Translated NOW, at the moment of sending, with the non-reactive translator:
 * these words are handed to the OS and read back hours later by a job with no
 * page and no i18next, so there is no render to re-run them in. Keeping them
 * current is the caller's job, and `startUpdateAlerts` does it by re-sending
 * when the language changes.
 */
export function updateAlertsMessage(
  enabled: boolean,
  facts: { version: string; nativeGeneration?: number; registryUrl: string },
  t: Translator,
): UpdateAlertsMessage {
  return {
    enabled,
    version: facts.version,
    nativeGeneration:
      typeof facts.nativeGeneration === 'number' && Number.isFinite(facts.nativeGeneration)
        ? facts.nativeGeneration
        : 0,
    manifestUrl: `${facts.registryUrl.replace(/\/+$/, '')}/v1/app/bundle`,
    copy: {
      channel: t('notices.updateAlertChannel'),
      channelHint: t('notices.updateAlertChannelHint'),
      title: t('notices.updateAlertTitle', { version: VERSION_HOLE }),
      body: t('notices.updateAlertBody'),
    },
  };
}

/** Whether this binary can schedule the checks at all - and so whether the
 *  switch is shown. Asked at the call, not cached: the bridge is injected
 *  before the page runs and never changes, so there is nothing to save. */
export function updateAlertsAvailable(): boolean {
  try {
    return typeof window.AFMNative?.setUpdateAlerts === 'function';
  } catch {
    // A bridge that throws on property access is a bridge that cannot be used.
    return false;
  }
}

function send(enabled: boolean): void {
  const bridge = window.AFMNative;
  if (typeof bridge?.setUpdateAlerts !== 'function') return;
  try {
    const message = updateAlertsMessage(
      enabled,
      { version: APP_VERSION, nativeGeneration: window.__afmNativeGeneration, registryUrl: REGISTRY_URL },
      translate,
    );
    bridge.setUpdateAlerts(JSON.stringify(message));
  } catch {
    // The bridge is best-effort like every other call across it. The stored
    // answer stands, and the next start sends it again.
  }
}

/**
 * Re-apply the stored switch, now and whenever the language changes.
 *
 * Called once the app has mounted - not from a module top level, where i18next
 * has not started and every translated word would go across as its raw key.
 * The language listener covers the other half of that race: a non-English
 * catalogue arrives a moment AFTER the first render, and the change of language
 * it causes re-sends the copy in the right words. It also covers somebody
 * changing language in Settings, which is otherwise the one way the tray could
 * end up in a language the app is no longer in.
 *
 * Returns the unsubscribe, for an effect's cleanup.
 */
export function startUpdateAlerts(): () => void {
  if (!updateAlertsAvailable()) return () => {};
  send(updateAlertsEnabled());
  const onLanguage = () => send(updateAlertsEnabled());
  i18next.on('languageChanged', onLanguage);
  return () => i18next.off('languageChanged', onLanguage);
}

/**
 * The switch in Settings.
 *
 * Stored first, so the answer survives whatever happens next. Turning it ON
 * asks for the notification permission before scheduling, because a flip of
 * this switch is the clearest moment there will ever be to ask - and a refusal
 * found out now beats one found out by nothing arriving. The job is scheduled
 * EVEN IF refused: the worker checks the grant each time it has something to
 * say, so granting it later in the system settings is enough, with no second
 * trip back here.
 *
 * Resolves to whether notifications can currently be shown (always true when
 * turning off, which asks for nothing).
 */
export async function switchUpdateAlerts(on: boolean): Promise<boolean> {
  setUpdateAlertsEnabled(on);
  if (!on) {
    send(false);
    return true;
  }
  const allowed = await ensureOsNotifyPermission();
  // Read back rather than assumed: a quick off-flip while the permission
  // prompt was up has the last word.
  send(updateAlertsEnabled());
  return allowed;
}
