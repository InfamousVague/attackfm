/**
 * Which machine is asking, and what its build is called.
 *
 * Pulled out of `appDoors.tsx` so it can be tested: a landing page's door
 * points at the wrong installer only on somebody else's device, which is the
 * one place you never see it happen. The component that used to hold this is
 * a door with a network fetch in it; this half is a pure reading of the user
 * agent and answers the same way every time.
 */

export type PlatformKey = 'macos' | 'windows' | 'linux' | 'android' | 'ios';

/**
 * Which build this browser's machine runs, read off the user agent.
 *
 * iPadOS is why the Mac test is not first: since iPadOS 13 an iPad reports a
 * DESKTOP Mac user agent, and the only thing separating it from a real Mac is
 * that it has touch points. A Mac with a touch bar has none, so the pair of
 * conditions is the whole test - and getting the order wrong hands every iPad
 * owner a .dmg they cannot open.
 */
export function detectPlatform(): PlatformKey {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = nav.userAgentData?.platform ?? '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua) || /Android/i.test(hint)) return 'android';
  if (/Mac/.test(ua) || /macOS/i.test(hint)) return 'macos';
  if (/Win/.test(ua) || /Windows/i.test(hint)) return 'windows';
  return 'linux';
}

/** Product names, and so the same word in every language. */
export const PLATFORM_NAMES: Record<PlatformKey, string> = {
  macos: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone',
};
