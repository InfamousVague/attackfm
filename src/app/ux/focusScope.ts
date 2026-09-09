/**
 * The other half of `aria-modal="true"`.
 *
 * The search palette says it is a modal dialog, and against the pointer it
 * mostly is one: on a desktop window `.searchSummon__scrim` covers the room at
 * z 59 and the sheet stands at 60, so a click outside lands on the scrim and
 * closes. The keyboard was never told. Nothing carried `inert`, nothing held
 * Tab, and the palette's own key listener minds ⌘K and Escape only - so one
 * Tab out of the search field landed on the top bar's Notifications button,
 * whose centre hit-tests to the scrim: focus on a control the finger cannot
 * reach. Three more Tabs reached the nav rail, where Discover navigated the
 * page with the palette still standing over it - verbatim the failure the
 * scrim was added to close.
 *
 * So: a ring rather than a wall. This never marks anything outside the sheet;
 * it only ever moves focus. That matters, because the things outside are not a
 * subtree - `.selectBar` and `.djToast` portal to the body, as does every kit
 * modal and toast, and `inert` on the palette's siblings would miss all of
 * them and go stale the moment the app grows another. A ring encloses whatever
 * exists.
 *
 * WHERE THE RING'S BOUNDARY IS, which is the whole of this file: focus may
 * stand exactly where a finger could land. Inside the palette, or on any
 * control with NOTHING IN FRONT OF IT - and Tab walks that set in document
 * order. It is one question asked of the page as it is actually painted, and
 * it is deliberately not three guesses about other components, because three
 * guesses is what this file used to be and each of them was wrong:
 *
 *   - it guessed from a ROLE, and stood down for any `[role="dialog"]` on the
 *     assumption those bring their own trap. The kit's dialogs do (its `Zr`
 *     hook installs a document keydown over a layer stack, and Modal, Drawer
 *     and AlertDialog all use it). Every FIRST-PARTY `role="dialog"` in this
 *     app carries an Escape listener and nothing else: GlassSheet, the Now
 *     Playing sheet full-screen AND docked, its lyrics view, QueuePanel,
 *     MobileSettings, DatePage's intro, and NavMoreMenu's `role="menu"`. The
 *     docked card is the one that hurt - it wears the role for as long as the
 *     dock stands, so on a docked desktop this scope never installed at all,
 *     and one Tab out of the card reached Notifications (measured: hit
 *     `searchSummon__scrim`, unreachable) where activating it opened the
 *     notifications popover over a still-open palette.
 *   - it guessed from a SELECTOR, and called every match a tab stop. Matching
 *     `button:not([disabled])` is not being in the tab order: `tabindex="-1"`
 *     parks a roving member (settingsKit.tsx, HeaderChrome.tsx), an `[inert]`
 *     subtree is out of the order entirely (settingsKit.tsx), and
 *     `visibility: hidden` still has client rects. One such element at the end
 *     of the palette made itself `last`, so the ring never closed - measured,
 *     five presses gave three escapes.
 *   - it applied a BLANKET the pointer contract does not apply. On a phone the
 *     palette covers eleven of the twelve focusables outside it, but the
 *     twelfth is the header's bell, which sits above the palette's top edge
 *     and is plainly tappable - and it was keyboard-dead while the palette was
 *     up.
 *
 * One predicate answers all three, and answers them on shapes nobody has to
 * enumerate here. On a docked tablet - where the sheet contract resolves
 * `--app-sheet-scrim: none`, so there is no dimmer at all and the palette is a
 * 634.883px panel in a 1024px window - the ring comes out as the six controls
 * the finger can already reach, without this file knowing anything about the
 * contract, the platform stamp or the pointer.
 *
 * WHAT THIS DOES NOT DO, and must not: it does not enforce a modality the
 * paint does not have. Where a takeover has no dimmer, letting the keyboard
 * out to the same controls the finger can press is the honest answer; making
 * the keyboard stricter than the pointer is the same mistake as the role
 * guess, mirrored. The missing dimmer is a question for the sheet contract.
 *
 * It is unconditional, with no window gate. The scrim is gated because it is a
 * BOX and on a phone the box would be wrong; this is not a box. It listens for
 * one key and moves focus, so it changes no geometry and no touch path - and
 * unconditional is the only honest match for an `aria-modal` the markup sets
 * at every width.
 */

/**
 * What could be a stop. The selector is the wide net; `isStop` below is what
 * decides. `iframe` is here because the app has one (SpotifyPreview) and this
 * ring now OWNS the walk - every Tab is prevented - so a focusable kind this
 * selector fails to name is a control nobody can reach while the palette is
 * up. The app has no `<summary>` and no media element with `controls`; the day
 * one appears, its name comes here.
 */
const STOPS =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),iframe,[contenteditable],' +
  '[tabindex]:not([tabindex="-1"])';

/**
 * In the sequential focus order, and painted. No `[tabindex]` above 0 exists
 * anywhere in this app, so document order IS tab order and this list needs no
 * sorting - that half of the old comment was true and still is.
 *
 * `isContentEditable` beside the arithmetic, and not for tidiness: a
 * `contenteditable` div reports `tabIndex === -1` while Tab reaches it
 * perfectly well, so `tabIndex >= 0` alone would have made that entry in the
 * selector above dead code from the day it was written.
 */
const isStop = (el: HTMLElement) =>
  (el.tabIndex >= 0 || el.isContentEditable) &&
  !el.closest('[inert]') &&
  (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) &&
  getComputedStyle(el).visibility !== 'hidden';

/**
 * Is anything in front of this? A hit test at the control's own centre, which
 * is the same question the pointer asks. The hit counts as the control itself,
 * as something inside it (its icon, its label) or as something containing it
 * (a wrapper that paints nothing) - anything else is a layer on top.
 */
const underNothing = (el: HTMLElement) => {
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && (el.contains(hit) || hit.contains(el));
};

export function installFocusScope(sheet: HTMLElement): () => void {
  /* Read fresh on every Tab. The palette's stops ARE its results and they
     change with every keystroke - and what is in front of what changes with
     every layer the app raises, so the reachable half is just as perishable as
     the list itself. */
  const stops = () =>
    [...document.querySelectorAll<HTMLElement>(STOPS)].filter(
      (el) => isStop(el) && (sheet.contains(el) || underNothing(el)),
    );

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const list = stops();
    /* An empty ring is not a ring: with nothing focusable at all, let Tab do
       whatever it was going to do rather than swallow the key. */
    if (!list.length) return;
    event.preventDefault();
    const here = document.activeElement;
    const at = here instanceof HTMLElement ? list.indexOf(here) : -1;
    const step = event.shiftKey ? -1 : 1;
    /* Focus that is nowhere in the ring - a click on a covered control, a
       script that moved it - is put back at whichever end this press was
       heading for, rather than carrying on out of the room. */
    const next =
      at === -1
        ? event.shiftKey
          ? list[list.length - 1]
          : list[0]
        : list[(at + step + list.length) % list.length];
    /* The index is provably in range - the list is non-empty and the modulo
       wraps - but this file reads the DOM at every step and would rather do
       nothing than throw inside a key handler. */
    next?.focus();
  };

  /* On the document in CAPTURE, not on the sheet: a listener on the sheet only
     hears Tab while focus is already inside, which is the one case that needs
     no help. Capture also puts it ahead of the palette's own Escape/⌘K
     listener, which it never contends with - that one ignores Tab.

     AND IT DOES NOT STOP PROPAGATION, which is load-bearing. A kit dialog's
     own trap listens on the document in the BUBBLE phase and re-takes focus
     that has left its panel. That is the safety net for the one place this
     ring is deliberately looser than the kit's - the palette's own stops stay
     in our list even when they are covered, because a result scrolled out of
     its scroller must still be walkable. Measured with a kit Modal open over
     the palette: our ring moves first, the kit reasserts within the same
     press, and Tab still advances inside the modal. */
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
