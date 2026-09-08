import { afterEach, describe, expect, it } from 'vitest';
import { detectPlatform, PLATFORM_NAMES } from './platform.ts';

/**
 * Which installer a landing page offers.
 *
 * The failure this guards is invisible from here: a wrong answer sends
 * somebody a file their machine cannot open, and it happens on THEIR device,
 * on a page they arrived at from a link, which is the last place anybody
 * looks. Every case below is a real user agent string.
 */

/** jsdom's navigator is read-only; these define over it for one test. */
function saying(ua: string, touchPoints = 0, hint?: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: touchPoints,
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'userAgentData', {
    value: hint === undefined ? undefined : { platform: hint },
    configurable: true,
  });
}

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

afterEach(() => {
  saying(MAC, 0, undefined);
});

describe('detectPlatform', () => {
  it('reads a phone, a Mac, a PC, an Android and everything else', () => {
    saying(IPHONE);
    expect(detectPlatform()).toBe('ios');
    saying(MAC);
    expect(detectPlatform()).toBe('macos');
    saying(WINDOWS);
    expect(detectPlatform()).toBe('windows');
    saying(ANDROID);
    expect(detectPlatform()).toBe('android');
    saying(LINUX);
    expect(detectPlatform()).toBe('linux');
  });

  it('an iPad is an iPhone, not a Mac', () => {
    // Since iPadOS 13 an iPad sends a DESKTOP Mac user agent, and the only
    // thing separating it from a real Mac is that it has touch points. Read
    // in the wrong order, every iPad owner is offered a .dmg.
    saying(MAC, 5);
    expect(detectPlatform()).toBe('ios');
  });

  it('a Mac stays a Mac, touch bar and all', () => {
    saying(MAC, 0);
    expect(detectPlatform()).toBe('macos');
    saying(MAC, 1);
    expect(detectPlatform()).toBe('macos');
  });

  it('believes the client hint when the agent string is scrubbed', () => {
    // A privacy-reduced agent says "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    // whatever the machine is; userAgentData is what is left to read.
    saying('Mozilla/5.0 (Unknown)', 0, 'Android');
    expect(detectPlatform()).toBe('android');
    saying('Mozilla/5.0 (Unknown)', 0, 'macOS');
    expect(detectPlatform()).toBe('macos');
    saying('Mozilla/5.0 (Unknown)', 0, 'Windows');
    expect(detectPlatform()).toBe('windows');
  });

  it('falls back to Linux rather than to nothing', () => {
    // A door with no platform has no download at all, which is worse than a
    // download the visitor can see is for the wrong machine.
    saying('Mozilla/5.0 (Fridge; SmartDisplay 2.0)');
    expect(detectPlatform()).toBe('linux');
  });
});

describe('PLATFORM_NAMES', () => {
  it('names every platform detect can return', () => {
    for (const key of ['macos', 'windows', 'linux', 'android', 'ios'] as const) {
      expect(PLATFORM_NAMES[key]).toBeTruthy();
    }
    // Product names, not keys: the button says "Download for Mac".
    expect(PLATFORM_NAMES.macos).toBe('Mac');
    expect(PLATFORM_NAMES.ios).toBe('iPhone');
  });
});
