/**
 * A picture of the app's own interface, for a surface that cannot run it.
 *
 * An Android home-screen widget is drawn by the LAUNCHER's process from a
 * RemoteViews tree: no WebView, no React, no CSS, no custom views. Everything
 * the player looks like - the kit's components, the accent the listener chose,
 * the type, the corner radii - is therefore unreachable there, and a widget
 * built out of the handful of primitives RemoteViews does offer can only ever
 * be an imitation of this app rather than a piece of it.
 *
 * So the page draws the face itself and hands the launcher a photograph.
 *
 * HOW: an SVG `foreignObject` containing the real DOM subtree plus the real
 * stylesheet is loaded into an `Image` and painted onto a canvas. That is Blink
 * doing its own layout and painting with the app's own CSS, so a Glacier
 * component renders in the widget exactly as it renders on the screen - not
 * approximately.
 *
 * WHAT DOES NOT CROSS THE BOUNDARY, and is dealt with here:
 *
 *  - Anything the document merely REFERENCES. A foreignObject cannot fetch: no
 *    font file, no image URL, no stylesheet link. Unhandled, the type silently
 *    falls back to a serif and every cover becomes a broken-image box, which is
 *    exactly what the first attempt produced.
 *  - `backdrop-filter`, which has no backdrop to filter inside an SVG. The face
 *    is designed on solid surfaces for that reason; a home screen has nothing
 *    behind the plate to show through anyway.
 *  - Markup that is not well-formed XML. `outerHTML` is HTML - unclosed `<img>`
 *    and `<br>` and the whole image refuses to load with no error worth
 *    reading. XMLSerializer is the one that produces XML.
 */

/** The stylesheet, gathered once. Same-origin in every shell we ship; a sheet
 *  that refuses to be read is skipped rather than failing the shot. */
let sheetText: string | null = null;

function styleSheetText(): string {
  if (sheetText !== null) return sheetText;
  let out = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out += rule.cssText + '\n';
    } catch {
      // A cross-origin sheet cannot be read. Nothing we ship is one, and a
      // missing rule is a worse-looking picture rather than no picture.
    }
  }
  sheetText = out;
  return out;
}

/**
 * The app's typeface, as bytes.
 *
 * The face is declared by `@fontsource-variable/inter` as a run of @font-face
 * rules, one per unicode subset, each pointing at a woff2 the page fetched
 * long ago. Inside the SVG none of those URLs resolve, so the file is read back
 * out and re-declared as a data URI.
 *
 * Only the subsets a widget can actually print are taken: a book title is latin
 * and the clocks are digits, and carrying Cyrillic and Vietnamese would add
 * several hundred kilobytes to every picture for glyphs no face uses.
 */
let fontCss: Promise<string> | null = null;

function embeddedFontCss(): Promise<string> {
  if (fontCss) return fontCss;
  fontCss = (async () => {
    const wanted: CSSFontFaceRule[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.constructor.name !== 'CSSFontFaceRule') continue;
          const face = rule as CSSFontFaceRule;
          const src = face.style.getPropertyValue('src');
          // The latin subset, and not latin-ext: `-latin-` appears in every
          // fontsource filename, so the exclusion is what narrows it.
          if (!/latin/.test(src) || /latin-ext|cyrillic|greek|vietnamese/.test(src)) continue;
          wanted.push(face);
        }
      } catch {
        // See styleSheetText.
      }
    }
    const parts = await Promise.all(
      wanted.map(async (face) => {
        const src = face.style.getPropertyValue('src');
        const url = /url\(["']?([^"')]+)["']?\)/.exec(src)?.[1];
        if (!url) return '';
        try {
          const blob = await (await fetch(url)).blob();
          const data = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => rej(r.error);
            r.readAsDataURL(blob);
          });
          const family = face.style.getPropertyValue('font-family');
          const weight = face.style.getPropertyValue('font-weight') || 'normal';
          const style = face.style.getPropertyValue('font-style') || 'normal';
          return `@font-face{font-family:${family};font-weight:${weight};font-style:${style};src:url(${data}) format('woff2');}`;
        } catch {
          return '';
        }
      }),
    );
    return parts.join('\n');
  })();
  return fontCss;
}

/** Every `<img>` in the clone, turned into bytes. A cover is a blob URL from
 *  the art cache and a blob URL is this document's alone - inside the SVG it
 *  is nothing at all. */
async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      try {
        const blob = await (await fetch(src)).blob();
        const data = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(blob);
        });
        img.setAttribute('src', data);
      } catch {
        // A cover that will not load leaves the slot empty, which the face
        // already has to handle for a track that has no artwork.
        img.removeAttribute('src');
      }
    }),
  );
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Draw one element, at one size, to a PNG data URL.
 *
 * `node` is cloned before anything is done to it, so the live tree is never
 * touched - the caller's face can stay mounted and keep updating.
 */
export async function shoot(
  node: HTMLElement,
  width: number,
  height: number,
  /**
   * Device pixels per CSS pixel in the finished picture.
   *
   * The face is DESIGNED in CSS pixels - 15px type, a 46px cover - and a phone
   * wants those same proportions rendered into three times as many device
   * pixels. Laying the face out at the device size instead makes every fixed
   * size proportionally tiny, which is what the first attempt did: a title set
   * at 15px across a thousand-pixel face is a rumour.
   *
   * So the svg carries a viewBox at the CSS size and a width/height at the
   * device size. Blink lays out in the small space and rasterises into the
   * large one, which is a sharp picture rather than a scaled-up one.
   */
  scale = 1,
): Promise<string | null> {
  try {
    const clone = node.cloneNode(true) as HTMLElement;
    await inlineImages(clone);
    const [font] = await Promise.all([embeddedFontCss()]);
    const css = escapeXml(font + '\n' + styleSheetText());
    // The custom properties are set on the document element at runtime - the
    // accent, the theme, the type scale - and none of them are in a rule.
    const vars = document.documentElement.getAttribute('style') ?? '';
    const xml = new XMLSerializer().serializeToString(clone);

    /*
     * THE TOKENS GO ON THE SVG ELEMENT, NOT ON A DIV INSIDE IT.
     *
     * Inside this document `:root` is the `<svg>`, and the kit's stylesheet
     * defines its aliases there - `--glacier-accent-solid: var(--glacier-accent-9)`
     * among them. An alias computes once, at the element that declares it, and
     * descendants inherit the RESULT. Overriding the ramp further down therefore
     * arrives too late to change anything already aliased above it, and the
     * picture comes out in the kit's default blue while the app on screen is
     * pink. Setting the ramp inline on the svg puts it on the same element the
     * aliases resolve at, where an inline declaration wins.
     */
    const pxW = Math.round(width * scale);
    const pxH = Math.round(height * scale);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" ` +
      `viewBox="0 0 ${width} ${height}" style="${escapeXml(vars)}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="${escapeXml(vars)};width:${width}px;height:${height}px;overflow:hidden">` +
      `<style>${css}</style>${xml}</div>` +
      `</foreignObject></svg>`;

    const img = new Image();
    const ok = await new Promise<boolean>((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    if (!ok) return null;

    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, pxW, pxH);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
