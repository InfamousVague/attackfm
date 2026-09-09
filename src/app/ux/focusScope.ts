/**
 * The other half of `aria-modal="true"`.
 *
 * The search palette says it is a modal dialog, and against the pointer it is
 * one: `.searchSummon__scrim` covers the window at z 59 and the sheet stands
 * at 60, so a click outside lands on the scrim and closes. The keyboard was
 * never told. Nothing carried `inert`, nothing held Tab, and the palette's own
 * key listener minds ⌘K and Escape only - so one Tab out of the search field
 * landed on the top bar's Notifications button, whose centre hit-tests to the
 * scrim: focus on a control the finger cannot reach. Three more Tabs reached
 * the nav rail, where Discover navigated the page with the palette still
 * standing over it - verbatim the failure the scrim was added to close.
 *
 * So: a ring rather than a wall. This never marks anything outside the sheet;
 * it only ever moves focus back INSIDE it. That matters, because the things
 * outside are not a subtree - `.selectBar` and `.djToast` portal to the body,
 * as does every kit modal and toast, and `inert` on the palette's siblings
 * would miss all of them and go stale the moment the app grows another. A
 * ring encloses whatever exists.
 *
 * It is unconditional, with no window gate. The scrim is gated because it is a
 * BOX and on a phone the box would be wrong; this is not a box. It listens for
 * one key and moves focus, so it changes no geometry and no touch path - and
 * unconditional is the only honest match for an `aria-modal` the markup sets
 * at every width. The phone is not the exception it looks like either: at
 * 390x844 the palette covers eleven of the twelve focusables outside it, all
 * of them Tab-reachable and none of them tappable.
 */

/**
 * What counts as a stop. No `[tabindex]` above 0 exists anywhere in this app,
 * so document order IS tab order and first/last are simply the ends of this
 * list.
 */
const STOPS =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Layers that bring their own trap and are ON TOP of the palette when they
 *  are up: a GlassSheet raised from a result, a kit Modal, a kit Menu or the
 *  listbox a Select drops. Two traps pulling at one focus is worse than none,
 *  so this one stands down until that layer goes. */
const OWNS_FOCUS = '[role="dialog"],[role="menu"],[role="listbox"]';

export function installFocusScope(sheet: HTMLElement): () => void {
  /* Read fresh on every Tab: the palette's stops ARE its results, and they
     change with every keystroke. */
  const stops = () =>
    [...sheet.querySelectorAll<HTMLElement>(STOPS)].filter(
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0,
    );

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const here = document.activeElement;
    if (here instanceof HTMLElement && !sheet.contains(here) && here.closest(OWNS_FOCUS)) return;
    const list = stops();
    const first = list[0];
    const last = list[list.length - 1];
    /* An empty ring is not a ring: with nothing focusable inside, let Tab do
       whatever it was going to do rather than swallow the key. */
    if (!first || !last) return;
    /* Focus that has already left comes back rather than carrying on: the
       palette is not merely the first stop, it is the whole ring. */
    if (!(here instanceof HTMLElement) || !sheet.contains(here)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (!event.shiftKey && here === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && here === first) {
      event.preventDefault();
      last.focus();
    }
  };

  /* On the document in CAPTURE, not on the sheet: a listener on the sheet only
     hears Tab while focus is already inside, which is the one case that needs
     no help. Capture also puts it ahead of the palette's own Escape/⌘K
     listener, which it never contends with - that one ignores Tab. */
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
