/**
 * The other half of `aria-modal="true"`.
 *
 * The attribute is the half that VARIES: App.tsx sets it only where
 * `--app-sheet-scrim` paints a dimmer, because on a phone and on a docked
 * tablet there is none and the claim would be false. This file is the half
 * that does not vary - and the two agree because they follow the same one
 * fact. Where the dimmer paints, the attribute stands and this ring is closed;
 * where it does not, the attribute is absent and this ring lets focus out to
 * exactly the controls a finger can already press.
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
 * stand exactly where a finger could land. Any control with NOTHING IN FRONT
 * OF IT - and inside the palette, anything with nothing FROM OUTSIDE THE
 * PALETTE in front of it, which is the same question asked in the frame the
 * sheet's own furniture can answer. Tab walks that set in document order. It
 * is one question asked of the page as it is actually painted, and it is
 * deliberately not three guesses about other components, because three guesses
 * is what this file used to be and each of them was wrong:
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
 * 634.883px panel in a 1024px window - the ring comes out as whatever the
 * finger can already reach, without this file knowing anything about the
 * contract, the platform stamp or the pointer. No count for that shape,
 * deliberately: every measurement of it so far was taken in a pane stamped
 * `data-platform='ios'`, which React never reads back, so the tree kept an
 * `.appTitleBar` the real shape cannot have (`DESKTOP` gates the bar -
 * App.tsx:179 and :678 - and a tablet is coarse, so it renders `.mobileHeader`
 * instead). Nobody has yet measured the shape that ships.
 *
 * WHAT THIS DOES NOT DO, and must not: it does not enforce a modality the
 * paint does not have. Where a takeover has no dimmer, letting the keyboard
 * out to the same controls the finger can press is the honest answer; making
 * the keyboard stricter than the pointer is the same mistake as the role
 * guess, mirrored. The missing dimmer is a question for the sheet contract -
 * and while it is missing, the MARKUP must not claim one either.
 *
 * It is unconditional, with no window gate. The scrim is gated because it is a
 * BOX and on a phone the box would be wrong; this is not a box. It listens for
 * one key and moves focus, so it changes no geometry and no touch path. What
 * varies instead is the attribute, which App.tsx now drops exactly where
 * `--app-sheet-scrim` is `none` - exactly where this ring lets focus out.
 * Before that the two halves contradicted each other on the two shapes with no
 * dimmer: the markup said the outside was unavailable while this file
 * deliberately kept the header's bell in the ring, because a finger can reach
 * it and a keyboard-dead lit control is the regression this ring was written
 * to end.
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
 * Where a press aimed at this control would land, in viewport coordinates, or
 * null if there is nowhere to aim - a zero-area box, or a centre off the
 * screen entirely.
 *
 * `within` CLAMPS the point onto another box, and that is the whole of what
 * makes the in-sheet question answerable. A result scrolled out of the
 * palette's scroller has a centre somewhere off past the sheet's edge, where
 * the only thing to hit is the scrim - so an unclamped probe would call every
 * such row covered and drop it from the ring. Clamped onto the sheet, the
 * question stops being "is this row covered" (it is not painted at all) and
 * becomes "is the PALETTE covered where that row arrives once focus scrolls it
 * in", which is the question the walk actually depends on.
 */
const pressPoint = (el: HTMLElement, within?: HTMLElement): [number, number] | null => {
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  let x = box.x + box.width / 2;
  let y = box.y + box.height / 2;
  if (within) {
    const on = within.getBoundingClientRect();
    if (on.width === 0 || on.height === 0) return null;
    x = Math.min(Math.max(x, on.x + 1), on.right - 1);
    y = Math.min(Math.max(y, on.y + 1), on.bottom - 1);
  }
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  return [x, y];
};

/**
 * OUTSIDE the sheet: is anything in front of this? A hit test at the control's
 * own centre, which is the same question the pointer asks. The hit counts as
 * the control itself, as something inside it (its icon, its label) or as
 * something containing it (a wrapper that paints nothing) - anything else is a
 * layer on top. Unanswerable means no: a control nobody can point at is not a
 * control focus may stand on.
 *
 * Exported, and shared rather than copied, because the POINTER rule now asks
 * the same question of a popover's trigger - see ux/popoverStand.ts, which
 * closes a popover whose trigger a takeover has just covered. One reachability
 * predicate for both channels, or the day somebody tightens one of them the
 * keyboard and the pointer start disagreeing about what is reachable, which is
 * the exact failure this file exists to end.
 */
export const underNothing = (el: HTMLElement) => {
  const at = pressPoint(el);
  if (!at) return false;
  const hit = document.elementFromPoint(at[0], at[1]);
  return !!hit && (el.contains(hit) || hit.contains(el));
};

/**
 * INSIDE the sheet: is a layer from OUTSIDE the sheet painted where this would
 * be pressed? A different question from the one above, and it has to be, or
 * the palette's own furniture answers it wrong. The kit's SegmentedControl -
 * the search scope switcher - is a 1x1 absolutely-positioned `input` behind
 * its own `SPAN` label, so the hit at its centre is a SIBLING: neither inside
 * it nor containing it, and `underNothing` says no with nothing painted over
 * the palette at all (measured, both radios, at 1100x720). The finger presses
 * the label and the switch works perfectly. So anything belonging to the sheet
 * counts as not covering it; only a layer the sheet does not contain does.
 *
 * `hit.contains(el)` keeps the same ancestor tolerance the outside branch has.
 * Unanswerable means NO here - the conservative direction on this side is to
 * keep the stop, so a palette caught mid-drag or mid-entry can never lose its
 * own ring.
 */
const buried = (sheet: HTMLElement, el: HTMLElement) => {
  const at = pressPoint(el, sheet);
  if (!at) return false;
  const hit = document.elementFromPoint(at[0], at[1]);
  return !!hit && !sheet.contains(hit) && !hit.contains(el);
};

export function installFocusScope(sheet: HTMLElement): () => void {
  /* Read fresh on every Tab. The palette's stops ARE its results and they
     change with every keystroke - and what is in front of what changes with
     every layer the app raises, so the reachable half is just as perishable as
     the list itself.

     TWO questions, not one, because "in front of" means something different on
     each side of the sheet's edge. Outside: is anything in front of it at all.
     Inside: is anything from outside the sheet in front of it - the palette's
     own labels, badges and wrappers stand in front of the palette's own
     controls constantly, and none of them is a layer. Asking the outside
     question of an in-sheet stop drops the search scope switcher on an
     ordinary search; not asking any question of one - which is what
     `sheet.contains(el) ||` used to mean - kept focus on controls buried under
     a popover, a kit Modal or the DJ's toast, which is the one thing this file
     exists to prevent. */
  const stops = () =>
    [...document.querySelectorAll<HTMLElement>(STOPS)].filter(
      (el) => isStop(el) && (sheet.contains(el) ? !buried(sheet, el) : underNothing(el)),
    );

  /* The fallback, and only ever that: every stop the sheet owns, reachable or
     not. See the empty-ring note in the handler. */
  const inside = () => [...sheet.querySelectorAll<HTMLElement>(STOPS)].filter(isStop);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const list = stops();
    /* An empty ring used to mean one thing - nothing focusable anywhere - and
       releasing Tab was the honest answer to that. It can now mean a second
       thing: everything reachable is covered. Releasing there would let the
       keyboard walk the page from under two takeovers, which is worse than
       standing still, so the sheet's own stops are the floor. If even that is
       empty there really is nothing to hold and Tab goes wherever it was
       going. No reachable state produces either branch today - a phone under a
       popover gives a ring of one, a kit Modal over the palette gives its own
       three - so this is insurance, not a fix. */
    const held = list.length ? list : inside();
    if (!held.length) return;
    event.preventDefault();
    const here = document.activeElement;
    const at = here instanceof HTMLElement ? held.indexOf(here) : -1;
    const step = event.shiftKey ? -1 : 1;
    /* Focus that is nowhere in the ring - a click on a covered control, a
       script that moved it - is put back at whichever end this press was
       heading for, rather than carrying on out of the room. */
    const next =
      at === -1
        ? event.shiftKey
          ? held[held.length - 1]
          : held[0]
        : held[(at + step + held.length) % held.length];
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
     that has left its panel: the kit's trap is the kit's to own, and swallowing
     the press would take it away. It is no longer a safety net for anything of
     ours, though, and the sentence that said so has gone: this ring used to
     hand the kit an out-of-modal stop to correct on every press, because every
     in-sheet stop stayed in our list however deeply it was buried. It does not
     any more - measured under the real Settings modal at 1100x720, the ring
     goes from eight stops (three of them pointer-dead palette controls) to
     five, all of them the modal's own. Nothing left to correct. The scrolled-
     out result that justified the old looseness is now handled where it
     belongs, by the clamp in `pressPoint`. */
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
