import { createRoot, type Root } from 'react-dom/client';
import { WidgetFace, type WidgetFaceName, type WidgetFaceProps } from './WidgetFace.tsx';
import { shoot } from './shot.ts';

/**
 * Take the picture the Android widget wears.
 *
 * The face is mounted OFF-CANVAS in this page rather than in a second WebView.
 * A second WebView would need the frontend bundle on disk to load - which it is
 * not on a fresh install, the embedded one lives inside the Rust binary - and
 * booting a second copy of this app is the thing that produced a black screen
 * once already. Off-canvas costs one detached React root and nothing else.
 *
 * One root, reused. Mounting and unmounting per photograph would throw away the
 * kit's own layout work every ten seconds while a book plays.
 */

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function stage(): { host: HTMLDivElement; root: Root } {
  if (!host || !root) {
    host = document.createElement('div');
    host.id = 'afm-widget-stage';
    /*
     * Off-canvas, NOT `display:none` and NOT `visibility:hidden`.
     *
     * Either of those stops layout, and an element with no layout photographs
     * as an empty box - the kit's components need to have actually been laid
     * out for the picture to contain anything. Pushed off the left edge with
     * `pointer-events:none` it is laid out, painted, and unreachable.
     */
    host.style.cssText =
      'position:fixed;left:-10000px;top:0;pointer-events:none;contain:layout size style';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  return { host, root };
}

/*
 * Let React commit and the kit settle before the shutter.
 *
 * NOT requestAnimationFrame, which is the obvious choice and the wrong one: a
 * document that is not being presented never gets a frame, so rAF simply never
 * fires. That is the normal state for this - the widget is photographed while
 * the app is in the background, which is exactly when nobody is looking at it -
 * and it hangs the shot forever rather than failing. A macrotask turn is enough
 * for React to have committed and for layout to have run, and it happens
 * whether or not anything is on screen.
 */
const settled = () =>
  new Promise<void>((res) => {
    setTimeout(() => setTimeout(() => res(), 0), 0);
  });

/** Nothing here may hang the caller. A photograph that has not arrived in a few
 *  seconds is a photograph that is not coming. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ]);
}

export interface ShotRequest extends Omit<WidgetFaceProps, 'face'> {
  face: WidgetFaceName;
  /** The face's own size, in CSS pixels - the units it is designed in. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel. A phone's launcher hands us dp and a density;
   *  the picture is rasterised at their product so it is sharp on the screen it
   *  will actually hang on. */
  scale?: number;
}

/**
 * Render one face at one size and return it as a PNG data URL.
 *
 * Null when the picture could not be taken at all, which the caller reports as
 * "no shot" rather than pushing an empty image at the launcher.
 */
export async function widgetShot(req: ShotRequest): Promise<string | null> {
  const { width, height, scale = 1, ...face } = req;
  const { host: h, root: r } = stage();
  h.style.width = `${width}px`;
  h.style.height = `${height}px`;
  r.render(<WidgetFace {...face} />);
  return withDeadline(
    (async () => {
      await settled();
      const target = h.firstElementChild as HTMLElement | null;
      if (!target) return null;
      return shoot(target, width, height, scale);
    })(),
    8000,
  );
}
