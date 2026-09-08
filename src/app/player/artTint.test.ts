import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artTint } from './artTint.ts';

/**
 * The album's colour.
 *
 * The rule this module exists to keep is not "find the average colour" - it
 * is find the colour a PERSON would name for this cover. The difference is
 * the vote weight: with a linear weight the vote measures population, and a
 * sleeve that is mostly skin tone and tan backdrop reads as peach even when
 * the one thing your eye goes to is a saturated purple jacket. Cubing the
 * saturation collapses the muted acres (0.3 -> 0.027) while barely denting
 * the vivid patch (0.9 -> 0.73).
 *
 * That is a claim about a specific failing cover, so the suite builds that
 * cover: a 40x40 read that is four-fifths muted tan and one-fifth vivid
 * purple. It is the one test here that would pass under a wrong
 * implementation if it were written any other way.
 *
 * jsdom has no canvas and no `createImageBitmap`, so the read path is
 * stubbed down to "here are the pixels" - which is exactly where this
 * module's own logic starts.
 */

const SIDE = 40;
const PIXELS = SIDE * SIDE;

/** A cover, as a run-length list of [r, g, b] and how many pixels each. */
type Patch = [rgb: [number, number, number], share: number];

function coverOf(patches: Patch[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PIXELS * 4);
  let at = 0;
  for (const [[r, g, b], share] of patches) {
    for (let n = 0; n < share && at < PIXELS; n += 1, at += 1) {
      data[at * 4] = r;
      data[at * 4 + 1] = g;
      data[at * 4 + 2] = b;
      data[at * 4 + 3] = 255;
    }
  }
  return data;
}

/** Stand the whole fetch -> bitmap -> canvas path up over one pixel buffer. */
function serve(data: Uint8ClampedArray) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ blob: () => Promise.resolve(new Blob()) })),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ close: vi.fn() })),
  );
  const getImageData = vi.fn(() => ({ data }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData,
  } as unknown as CanvasRenderingContext2D);
  return { getImageData };
}

/** The hue the ramp settled on, read back off the solid. */
function hueOf(tint: Record<string, string> | null): number | null {
  const solid = tint?.['--glacier-accent-solid'];
  const named = solid ? /hsl\((\d+)/.exec(solid) : null;
  return named ? Number(named[1]) : null;
}

/** Each URL is cached for the life of the module, so every test needs a new one. */
let n = 0;
const freshUrl = () => `https://art.example/cover-${(n += 1)}.jpg`;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('what the vote is measuring', () => {
  it('names the VIVID patch, not the muted acres around it', () => {
    /*
     * The failing cover, rebuilt. Four-fifths of it is a muted tan (hue ~30,
     * saturation ~0.3); one-fifth is a vivid purple (hue ~280, saturation
     * ~0.8). Population says tan. The eye says purple.
     *
     * With a LINEAR weight the tan wins 0.3 x 1280 = 384 against the purple's
     * 0.8 x 320 = 256. Cubed, the tan collapses to 0.027 x 1280 = 34.6 and
     * the purple holds 0.51 x 320 = 164. That reversal is the test.
     */
    const tan: [number, number, number] = [196, 154, 122];
    const purple: [number, number, number] = [138, 41, 224];
    serve(coverOf([[tan, PIXELS * 0.8], [purple, PIXELS * 0.2]]));
    return artTint(freshUrl()).then((tint) => {
      const hue = hueOf(tint);
      expect(hue).not.toBeNull();
      // Purple sits around 275; tan around 30. A generous band either way,
      // because the answer is a circular mean across three buckets.
      expect(hue!).toBeGreaterThan(240);
      expect(hue!).toBeLessThan(310);
    });
  });

  it('still names the tan when the tan is the only colour there', async () => {
    // The third case: the test above must not be passing because the module
    // always says purple.
    const tan: [number, number, number] = [196, 154, 122];
    serve(coverOf([[tan, PIXELS]]));
    const hue = hueOf(await artTint(freshUrl()));
    expect(hue).not.toBeNull();
    expect(hue!).toBeGreaterThan(10);
    expect(hue!).toBeLessThan(60);
  });

  it('declines to invent a hue for a greyscale cover', async () => {
    // Art with no hue to speak of returns null and the sheet keeps the kit
    // accent - because a hue invented from quantisation noise dresses the
    // screen in a colour the album never was.
    serve(coverOf([[[20, 20, 20], PIXELS * 0.5], [[200, 200, 200], PIXELS * 0.5]]));
    expect(await artTint(freshUrl())).toBeNull();
  });

  it('declines when there is only a whisper of colour', async () => {
    // A near-black cover with a couple of barely-tinted pixels: under the
    // vote floor, so no opinion.
    serve(coverOf([[[10, 10, 12], PIXELS - 4], [[80, 40, 90], 4]]));
    expect(await artTint(freshUrl())).toBeNull();
  });

  it('gathers a hue family rather than snapping to one 30-degree slice', async () => {
    // Two shades either side of a bucket edge. A winner-takes-the-bucket
    // rule would answer with one of them; the circular mean across the
    // winner and its neighbours lands between them.
    serve(coverOf([[[255, 60, 0], PIXELS * 0.5], [[255, 120, 0], PIXELS * 0.5]]));
    const hue = hueOf(await artTint(freshUrl()));
    expect(hue!).toBeGreaterThan(10);
    expect(hue!).toBeLessThan(25);
  });
});

describe('the ramp it dresses the hue as', () => {
  it('publishes the WHOLE accent ramp, not just the three the sheet names', async () => {
    // Kit components on the sheet drink from the numbered steps and the
    // -soft/-contrast/-border aliases directly; a partial override leaves
    // them kit-blue in a sea of pastel.
    serve(coverOf([[[138, 41, 224], PIXELS]]));
    const tint = (await artTint(freshUrl()))!;
    for (let step = 1; step <= 12; step += 1) {
      expect(tint[`--glacier-accent-${step}`]).toMatch(/^hsl\(/);
    }
    expect(Object.keys(tint)).toEqual(
      expect.arrayContaining([
        '--glacier-accent-solid',
        '--glacier-accent-text',
        '--glacier-accent-contrast',
        '--glacier-on-accent',
        '--glacier-accent-soft',
        '--glacier-accent-border',
      ]),
    );
  });

  it('pins saturation and lightness - only the hue comes from the art', async () => {
    // A black-metal cover and a neon one land in the same band, told apart
    // by hue alone. That is what "match the album but keep it light" means.
    serve(coverOf([[[138, 41, 224], PIXELS]]));
    const moody = (await artTint(freshUrl()))!;
    serve(coverOf([[[0, 255, 128], PIXELS]]));
    const neon = (await artTint(freshUrl()))!;
    const band = (tint: Record<string, string>) =>
      tint['--glacier-accent-solid']!.replace(/hsl\(\d+/, 'hsl(H');
    expect(band(moody)).toBe(band(neon));
    expect(band(moody)).toBe('hsl(H 78% 64%)');
    expect(hueOf(moody)).not.toBe(hueOf(neon));
  });

  it('puts LIGHT ink on a deep hue and DARK ink on a blazing one', async () => {
    // The solid's HSL lightness is pinned at 64%, but 64%-yellow blazes while
    // 64%-blue broods. Luma is what the eye gets, so it is what the ink
    // answers to.
    serve(coverOf([[[40, 60, 220], PIXELS]]));
    const blue = (await artTint(freshUrl()))!;
    serve(coverOf([[[230, 230, 20], PIXELS]]));
    const yellow = (await artTint(freshUrl()))!;
    const lightness = (tint: Record<string, string>) =>
      Number(/(\d+)%\)$/.exec(tint['--glacier-accent-contrast']!)![1]);
    expect(lightness(blue)).toBeGreaterThan(90);
    expect(lightness(yellow)).toBeLessThan(20);
  });

  it('gives the two ink tokens the same value', async () => {
    // `--glacier-accent-contrast` and `--glacier-on-accent` are two names the
    // kit uses for one thing; letting them drift gives a glyph one colour and
    // its neighbour another.
    serve(coverOf([[[138, 41, 224], PIXELS]]));
    const tint = (await artTint(freshUrl()))!;
    expect(tint['--glacier-on-accent']).toBe(tint['--glacier-accent-contrast']);
  });
});

describe('the cache', () => {
  it('reads a cover once', async () => {
    const { getImageData } = serve(coverOf([[[138, 41, 224], PIXELS]]));
    const url = freshUrl();
    const first = await artTint(url);
    const again = await artTint(url);
    expect(getImageData).toHaveBeenCalledTimes(1);
    expect(again).toBe(first);
  });

  it('remembers a NULL too - an unreadable cover is asked about once', async () => {
    const { getImageData } = serve(coverOf([[[20, 20, 20], PIXELS]]));
    const url = freshUrl();
    expect(await artTint(url)).toBeNull();
    expect(await artTint(url)).toBeNull();
    expect(getImageData).toHaveBeenCalledTimes(1);
  });

  it('never throws for a cover that will not fetch - it simply has no say', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('404'))),
    );
    await expect(artTint(freshUrl())).resolves.toBeNull();
  });

  it('never throws for a cover that will not decode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ blob: () => Promise.resolve(new Blob()) })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('not an image'))),
    );
    await expect(artTint(freshUrl())).resolves.toBeNull();
  });

  it('gives up on a canvas it cannot get a context from', async () => {
    serve(coverOf([[[138, 41, 224], PIXELS]]));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(artTint(freshUrl())).resolves.toBeNull();
  });
});
