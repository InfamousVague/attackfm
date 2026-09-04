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
 */

/** Longest edge, and the quality, for each of the two pictures. */
const SHAPES = {
  avatar: { max: 512, quality: 0.86 },
  banner: { max: 1600, quality: 0.82 },
} as const;

export type ImageKind = keyof typeof SHAPES;

/**
 * Decode, scale to fit, re-encode as JPEG. Rejects with a sentence worth
 * showing when the file is not an image the browser can read.
 */
/**
 * Decode by whatever route this browser has.
 *
 * `createImageBitmap` is the good one - it decodes off the main thread and
 * honours the EXIF rotation, which is what stops a portrait photograph
 * arriving on its side. But it does not accept every format every browser can
 * actually draw: an iPhone hands over HEIC, and WebKit will happily render
 * that in an `<img>` in versions where the bitmap decoder refuses it.
 *
 * So the element is the fallback rather than the failure. Both paths end in
 * something drawImage accepts, and only when both refuse is the file really
 * not a picture this device can read.
 */
async function decode(file: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  done: () => void;
}> {
  try {
    // `from-image` explicitly: the default has changed under us across
    // browsers, and a sideways face is the one failure nobody reports as a
    // bug - they just pick a different photo.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      done: () => bitmap.close(),
    };
  } catch {
    // Fall through to the element.
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('decode produced nothing');
    return { source: img, width, height, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    const what = file.type ? ` (${file.type})` : '';
    throw new Error(`That file is not a picture this app can read${what}.`);
  }
}

export async function prepareImage(file: Blob, kind: ImageKind): Promise<Blob> {
  const { max, quality } = SHAPES[kind];
  const { source, width: w, height: h, done } = await decode(file);
  try {
    // Never upscale: a small picture stays its own size rather than being
    // blown up into a bigger file that shows the same detail.
    const scale = Math.min(1, max / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This device would not draw the picture.');
    ctx.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) throw new Error('That picture could not be prepared.');
    return blob;
  } finally {
    done();
  }
}
