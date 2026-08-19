/**
 * Whether this device is on a connection that charges by the byte.
 *
 * Two sources, because no single one covers the platforms this app runs on:
 *
 *   - `navigator.connection`, the Network Information API. Chromium only,
 *     which in practice means the Android build and a desktop browser. It is
 *     the better answer where it exists: the OS tells the engine directly, and
 *     it fires a `change` event instead of being polled.
 *   - `network_kind`, the native command, which walks the interface list. This
 *     is the ONLY answer on iOS, where WKWebView ships no Network Information
 *     API at all - and iOS is precisely where mobile data is a real bill.
 *
 * And a third state that is not a source: `unknown`. A browser tab, a desktop
 * build on Windows, an older native binary without the command, a device
 * mid-handover. Every caller must treat unknown as "do not block", because a
 * download that silently stops is a worse failure than one that costs a few
 * megabytes - the first reads as the feature being broken and gives nobody a
 * clue why, the second shows up somewhere a person can act on it.
 */

import { isTauri, tauriCall } from './tauri.ts';

export type NetworkKind = 'wifi' | 'cellular' | 'unknown';

/**
 * The shape of `navigator.connection` we actually read.
 *
 * Typed here rather than pulled from lib.dom: the Network Information API is
 * not in TypeScript's DOM types, because it has never been more than a draft
 * that one engine shipped.
 */
interface NetworkInformation extends EventTarget {
  /** 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown' | ... */
  type?: string;
}

function connection(): NetworkInformation | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { connection?: NetworkInformation };
  return nav.connection ?? null;
}

/** The web answer, where the engine has one worth reading. */
function fromWeb(): NetworkKind {
  const type = connection()?.type;
  if (type === 'cellular') return 'cellular';
  // Ethernet counts as Wi-Fi here for the same reason the native side folds
  // them together: the switch is about the bill, not the radio.
  if (type === 'wifi' || type === 'ethernet') return 'wifi';
  // 'none', 'unknown', 'other', 'mixed', or the property missing entirely.
  // None of those is evidence, and 'none' in particular must not read as
  // cellular - a device with no network needs no protecting from a download
  // that cannot start anyway.
  return 'unknown';
}

/**
 * The last native answer, refreshed rather than awaited at the point of use.
 *
 * The native probe is one IPC round trip over an interface walk - cheap, but
 * not free, and not synchronous. Callers that must be right (the sweep) await
 * a fresh one; callers that only draw (the settings row) read this.
 */
let nativeKind: NetworkKind = 'unknown';
let probing: Promise<NetworkKind> | null = null;

async function fromNative(): Promise<NetworkKind> {
  if (!isTauri()) return 'unknown';
  // Single-flight: the settings pane mounting while a sweep is deciding
  // should be one interface walk, not two.
  probing ??= tauriCall<string>('network_kind')
    .then((answer) => {
      // A null is an older binary without the command, and reads as unknown -
      // the contract tauriCall exists for.
      const kind: NetworkKind =
        answer === 'wifi' || answer === 'cellular' ? answer : 'unknown';
      nativeKind = kind;
      return kind;
    })
    .catch(() => 'unknown' as NetworkKind)
    .finally(() => {
      probing = null;
    });
  return probing;
}

/**
 * What this device is on, freshly asked.
 *
 * The web answer wins when it is definite: it comes from the engine's own
 * connectivity monitor rather than a name-matching heuristic, so where both
 * can speak it is the more trustworthy of the two.
 */
export async function networkKind(): Promise<NetworkKind> {
  const web = fromWeb();
  if (web !== 'unknown') return web;
  return fromNative();
}

/** The last known answer, without waiting. For drawing, not for deciding. */
export function networkKindNow(): NetworkKind {
  const web = fromWeb();
  return web !== 'unknown' ? web : nativeKind;
}

/**
 * Whether downloading right now would spend somebody's mobile data.
 *
 * Deliberately NOT `kind !== 'wifi'`. Unknown has to fall on the permissive
 * side, and writing the test this way makes that visible at every call site
 * instead of hiding it behind an inverted comparison.
 */
export async function onMeteredConnection(): Promise<boolean> {
  return (await networkKind()) === 'cellular';
}

// --- staying current --------------------------------------------------------

const watchers = new Set<(kind: NetworkKind) => void>();

function announce(kind: NetworkKind): void {
  for (const w of watchers) w(kind);
}

async function recheck(): Promise<void> {
  const before = networkKindNow();
  // Always re-probe natively rather than trusting the cache: this runs on the
  // events that mean the connection may have just changed, which is exactly
  // when the cached value is the stale one.
  await fromNative();
  const after = networkKindNow();
  if (after !== before) announce(after);
}

let wired = false;

/**
 * Watch for the connection changing kind.
 *
 * Three signals, none of which is reliable alone: the Network Information
 * API's own `change` (Chromium only), `online` (fires on a reconnect, not on a
 * Wi-Fi-to-cellular handover), and coming back to the foreground - which is
 * the one that actually catches walking out of the house with the app open,
 * since the webview is frozen while the phone is in a pocket.
 */
export function onNetworkChange(fn: (kind: NetworkKind) => void): () => void {
  watchers.add(fn);

  if (!wired && typeof window !== 'undefined') {
    wired = true;
    const bump = () => void recheck();
    connection()?.addEventListener('change', bump);
    window.addEventListener('online', bump);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) bump();
    });
    // Prime it, so the first reader is not looking at the 'unknown' this
    // module starts life holding.
    bump();
  }

  return () => {
    watchers.delete(fn);
  };
}
