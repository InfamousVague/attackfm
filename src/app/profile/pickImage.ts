/**
 * A picture off the camera roll, made small enough to send.
 *
 * Phones hand over four-thousand-pixel photographs, and what these are
 * displayed at is a face the size of a thumbnail and a band across the top of
 * a page. Sending the original would be megabytes uploaded, stored and
 * downloaded again by every friend who sees the row - so the canvas does the
 * work here, before anything leaves the device.
 *
 * Drawing through a canvas also strips what a photograph carries and a
 * profile picture has no business carrying: the EXIF block, which on a phone
 * routinely holds the coordinates the picture was taken at. The one part of
 * EXIF worth keeping is the rotation, which is applied to the pixels here
 * rather than discarded with the rest - see `decode`.
 *
 * Every format the browser can DRAW is accepted, whatever it is called: an
 * iPhone hands over HEIC, and this re-encodes to JPEG regardless, so the
 * question is only ever "can this device decode it", never "is it on a list".
 *
 * Decoding goes through an `<img>` rather than `createImageBitmap`, which is
 * both simpler and more permissive here: the cropper needs a URL to display
 * anyway, WebKit renders formats in an element that its bitmap decoder
 * refuses, and an element applies the EXIF rotation itself - so what is cut
 * out is exactly what was on screen when it was chosen.
 */

/**
 * Longest edge, quality, and the shape each picture is cut to.
 *
 * The aspects are not a preference - they are what the page already draws. A
 * face is a circle, so it is cropped square; the banner is a band across the
 * top of the hero card, so it is cropped to roughly that band. Cutting to the
 * shape the picture will be SHOWN in is the whole reason this is worth doing:
 * before, a portrait photograph became a banner by having its middle third
 * shown and the rest silently discarded, and nobody could say which third.
 */
const SHAPES = {
  avatar: { max: 512, quality: 0.86, aspect: 1 },
  banner: { max: 1600, quality: 0.82, aspect: 3 },
} as const;

export type ImageKind = keyof typeof SHAPES;

/** The shape this kind is cut to, for the cropper to match. */
export function aspectOf(kind: ImageKind): number {
  return SHAPES[kind].aspect;
}

/** A rectangle in the SOURCE image's own pixels - what the cropper reports. */
export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Decode, scale to fit, re-encode as JPEG. Rejects with a sentence worth
 * showing when the file is not an image the browser can read.
 */
/**
 * Load an image by URL, for the cropper's own output pass.
 *
 * `crossOrigin` matters and is easy to miss: repositioning a picture already on
 * the registry means drawing THAT image into a canvas, and without the
 * attribute the canvas is tainted and `toBlob` throws a SecurityError with no
 * useful message. The registry answers `access-control-allow-origin: *` on the
 * image route, so asking anonymously is all it takes - but it has to be asked
 * before the load starts, which is why this cannot reuse an <img> already on
 * the page.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That picture could not be opened.'));
    img.src = src;
  });
}

/**
 * Cut the chosen rectangle out and re-encode it at the size this picture is
 * actually used at.
 *
 * The output is the crop's own shape rather than the source's, so a banner is
 * a banner whatever was photographed, and never larger than it needs to be: a
 * crop smaller than the target is left at its own size rather than upscaled
 * into a bigger file showing the same detail.
 */
export async function cropToBlob(src: string, area: CropArea, kind: ImageKind): Promise<Blob> {
  const { max, quality, aspect } = SHAPES[kind];
  const img = await loadImage(src);

  /*
   * A whole number of pixels, or the picture's own size.
   *
   * `Math.max(1, NaN)` is NaN, and a canvas assigned NaN sizes itself to zero
   * and then `toBlob` hands back null - which surfaced as "that picture could
   * not be prepared", a sentence that describes nothing. The cropper reports
   * NaN when it is measured before it has been laid out (a dialog confirmed in
   * the same frame it opened, a web view that was backgrounded mid-choice), so
   * this is a real state and not only a test artefact. Falling back to the
   * whole image is the right answer for it: the picture is used, uncropped,
   * rather than refused.
   */
  const whole = (v: number, fallback: number) =>
    Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback;

  const sw = whole(area.width, img.naturalWidth || 1);
  const sh = whole(area.height, img.naturalHeight || 1);
  const sx = Number.isFinite(area.x) ? Math.round(area.x) : 0;
  const sy = Number.isFinite(area.y) ? Math.round(area.y) : 0;
  // The long edge of the FINISHED picture, capped by both the target and what
  // was actually selected.
  const longEdge = Math.max(1, Math.min(max, aspect >= 1 ? sw : sh));
  const width = whole(aspect >= 1 ? longEdge : longEdge * aspect, 1);
  const height = whole(aspect >= 1 ? longEdge / aspect : longEdge, 1);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device would not draw the picture.');
  // A photograph scaled down in one step through a smoothing context; good
  // enough at these sizes and far simpler than a mip chain.
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('That picture could not be prepared.');
  return blob;
}
