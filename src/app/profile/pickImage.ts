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
 * routinely holds the coordinates the picture was taken at.
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
export async function prepareImage(file: Blob, kind: ImageKind): Promise<Blob> {
  const { max, quality } = SHAPES[kind];
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture this app can read.');
  });
  // Never upscale: a small picture stays its own size rather than being blown
  // up into a bigger file that shows the same detail.
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('This device would not draw the picture.');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('That picture could not be prepared.');
  return blob;
}
