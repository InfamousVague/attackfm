import { describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { hostOf, jamQrDataUrl } from './jamShare.ts';

/**
 * The address on the share card.
 *
 * A hub URL as people say it out loud. The fallback branch is the load-
 * bearing one: `new URL()` throws on anything that is not a full URL, and a
 * hub can be typed as a bare host - so a card that showed nothing at all
 * for those would be the common local-network case, not an edge case.
 */

describe('hostOf', () => {
  it('drops the scheme and the path from a real URL', () => {
    expect(hostOf('https://matt.attack.fm/')).toBe('matt.attack.fm');
    expect(hostOf('http://matt.attack.fm/some/where')).toBe('matt.attack.fm');
  });

  it('keeps a port, which is how a hub on the local network is named', () => {
    expect(hostOf('http://192.168.1.20:8787')).toBe('192.168.1.20:8787');
  });

  it('falls back for a bare host that is not a URL at all', () => {
    // `new URL('matt.attack.fm')` throws; without the catch the card would
    // show nothing for a hub typed the way people actually type one.
    expect(hostOf('matt.attack.fm')).toBe('matt.attack.fm');
  });

  it('answers EMPTY for a bare host:port - a trap, not a supported input', () => {
    /*
     * `new URL('matt.attack.fm:8787')` does not throw: it parses
     * `matt.attack.fm:` as a SCHEME with an opaque path of `8787`, so the
     * catch never runs and `.host` is empty. The share card would show a
     * blank where the hub's name goes.
     *
     * Not a live bug: every caller passes `session.url`, and
     * `normalizeServerUrl` has already put `https://` on the front of
     * anything typed bare. Pinned because the fallback branch reads as
     * "handles a bare host", and this is the bare host it does not handle -
     * so anyone who starts feeding hostOf raw user input finds out here
     * rather than on a share card.
     */
    expect(hostOf('matt.attack.fm:8787')).toBe('');
    // What the app actually hands it, for contrast.
    expect(hostOf('https://matt.attack.fm:8787')).toBe('matt.attack.fm:8787');
  });

  it('strips the scheme in the fallback too', () => {
    expect(hostOf('https://')).toBe('');
  });

  it('gives an empty string back rather than throwing', () => {
    expect(hostOf('')).toBe('');
  });
});

/**
 * The QR on the card.
 *
 * A tile a stranger's camera has to read across a room, on a phone whose
 * theme this code has no say over - which is why the colours are literals
 * and not tokens. Dark modules on a white ground is the contrast every
 * scanner is built for, and "make the card match the theme" is the edit that
 * would quietly stop it working in the dark.
 */

/** The PNG's own header: width and height live at bytes 16 and 20 of the
 *  decoded image, right after the IHDR marker. */
function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('jamQrDataUrl', () => {
  it('draws a real PNG, not a promise of one', async () => {
    const url = await jamQrDataUrl('https://attack.fm/g/abc123', 320);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('draws the tile at the size the caller asked for', async () => {
    // The share card asks for 320 and the deck's invite card for 192; a
    // dropped `width` gives whatever the library defaults to, which the card
    // then stretches.
    expect(pngSize(await jamQrDataUrl('https://attack.fm/g/abc123', 320))).toEqual({
      width: 320,
      height: 320,
    });
    expect(pngSize(await jamQrDataUrl('https://attack.fm/g/abc123', 192)).width).toBe(192);
  });

  it('keeps dark modules on a white ground, whatever the theme', async () => {
    const spy = vi.spyOn(QRCode, 'toDataURL');
    await jamQrDataUrl('https://attack.fm/g/abc123', 320);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      color: { dark: '#101014', light: '#ffffff' },
    });
  });

  it('leaves one quiet module of margin round the code', async () => {
    // Zero margin is a code a scanner will not lock onto; the kit's own
    // default is four, which on a 192px tile spends most of it on nothing.
    const spy = vi.spyOn(QRCode, 'toDataURL');
    await jamQrDataUrl('https://attack.fm/g/abc123', 192);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ margin: 1 });
  });

  it('encodes the link it was handed, verbatim', async () => {
    const spy = vi.spyOn(QRCode, 'toDataURL');
    await jamQrDataUrl('https://attack.fm/g/abc123', 192);
    expect(spy.mock.calls[0]?.[0]).toBe('https://attack.fm/g/abc123');
  });

  it('rejects rather than resolving to a broken tile for a link it cannot draw', async () => {
    // A QR has a capacity; past it the library throws. The sheet's `.catch`
    // then leaves the printed link on the card, which still works - so this
    // must be a rejection and never a resolved empty string.
    await expect(jamQrDataUrl('x'.repeat(10_000), 320)).rejects.toThrow();
  });
});
