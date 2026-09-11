import { useEffect, useId, useRef } from 'react';
import { underNothing } from './focusScope.ts';

/**
 * The pointer sibling of focusScope's rule: A POPOVER MAY STAND ONLY WHERE A
 * FINGER COULD REACH THE CONTROL IT HANGS OFF.
 *
 * The kit's Popover portals its panel to the body at an INLINE `z-index: 200`
 * (written in a layout effect and again in the React style object), which is
 * above every takeover this app raises: the shared scrim at 59, the sheets at
 * 60, the kit's own overlays at 100, and chapter 05's band over the docked
 * card. So the notifications panel - the one popover reachable from every page
 * - stood lit and clickable over an open, dimmed search palette. Measured at
 * 1280x720: panel 901,56,317.5 x 132.8 at z 200, `.searchSummon.contains(it)`
 * false, and a real click on its "Clear all" ran `clearNotices()` (1 notice ->
 * 0) with the palette still open and focus dropped to BODY.
 *
 * MOST OF THAT WAS ALREADY CLOSED, and by the kit. Its Popover registers a
 * `document` pointerdown while open and shuts on any press outside its panel
 * and trigger - the behaviour core/overlayGuard.ts exists to hold back from
 * portalled listboxes - so a takeover raised BY A PRESS closes it on the way
 * up. Measured: bell popover open, a real press on the nav rail's Settings,
 * `popoverOpen: false` before the overlay paints. What is left is every route
 * with no press in it, and the first shape of this rule answered for one of
 * them: App.tsx called a sweep in the commit that opened the search palette,
 * and nothing else ever called it. That is not the rule this file's title
 * states. Measured at 1280x720 on the shipped build, with a real click on the
 * real bell and then the app's own `window.__AFM_SHARED_LINK__` entry point:
 * kit Modal `_overlay_1r4l3_1` at `0,0,1280,720` z 100, title "From Spotify",
 * and the notifications panel still standing at
 * `860.476,55.734,357.025x180.106` z 200 with `aria-expanded="true"` and
 * `underNothing(bell)` FALSE - the gate below would have closed it, and was
 * never asked. A press inside that panel left both open; a press on the plain
 * dimmer closed both. So it was a 357x180 live island in a room where every
 * other pixel dismissed, carrying "Clear all" and an "Open downloads" that
 * navigates.
 *
 * THE PRESSLESS ROUTES ARE NOT A LIST ANYBODY CAN KEEP. They are the ⌘K chord
 * (nav/useSearchSummon.ts), the `onOpenSearchPage` seam, `openSearch()` from
 * the nav stack, a system-back restore, and every bridge that raises a kit
 * Modal off a link rather than a finger - servers/SpotifyPreview.tsx,
 * servers/InviteBridge.tsx, playlists/SharedPlaylistBridge.tsx,
 * profile/ProfileLinkBridge.tsx, player/JamLinkBridge.tsx,
 * player/GrooveHearSheet.tsx, player/NearbyGrooveSheet.tsx - all fed by
 * `servers/deepLink.ts`'s `deliver()` or by a room arriving over the wire.
 * A call site per takeover is a list that goes stale the next time the app
 * grows a bridge, which is how this one shipped with two of them uncovered.
 *
 * SO IT IS A WATCH, AND IT NAMES NO TAKEOVER: while ANY popover stands, a
 * `MutationObserver` re-judges all of them on any node ADDED UNDER
 * `document.body`, which is how every takeover in this app arrives - our own
 * scrim is `{searchOpen && ...}` in App.tsx and the kit's overlays mount and
 * unmount with their dialogs. It is armed only while the map is non-empty, so
 * the app pays nothing for it the rest of the time, and each sweep is one
 * `querySelector`, one `getElementById`, one box read and one
 * `elementFromPoint` per open popover - plus, for the one popover that is
 * actually closing, a second hit test to ask where focus may go. WHAT THAT
 * COSTS, measured rather than asserted: one commit of 200
 * fresh nodes into `.appBody` at 1280x720 takes 1.2-2.3 ms with a popover
 * standing and 0.1-0.2 ms without (medians of five, three parties, same
 * machine on different days - so read the ORDER, not the digits). The
 * millisecond or two is the layout the hit test forces on a tree that has just
 * changed - one sweep per commit, not one per node, because the observer
 * batches - and it is only ever paid while a panel is open.
 *
 * THAT COVERS THE OPENING EDGE TOO, with no second rule and no call site: a
 * popover's OWN PANEL is a node added under the body. The kit portals it a
 * commit after it marks the trigger - measured at 1280x720, `aria-expanded`
 * "true" and `aria-controls="_r_7_"` at t=3.4 ms, the positioner inserted at
 * t=22.7 ms - and this file arms the watch in between, so a popover that opens
 * itself over a takeover already standing is judged the moment its panel
 * arrives, by the same gate that judges everything else. There is such a
 * popover: player/JamBadge.tsx opens the groove deck from a timer (120 ms at
 * the strip, 340 ms in the sheet) armed by `armGrooveDeck()`, which
 * player/jam.tsx calls when somebody ELSE's groove arrives over the wire.
 * Nothing in that route is a press. Measured with the equivalent shape - a
 * programmatic `.click()` on the real bell with the palette open, which
 * dispatches no pointerdown and so is deaf to the kit's own outside-press
 * dismissal, a faithful stand-in for a self-open - the panel stood at
 * `863.58,54,350.817x176.974` over 160.42px of the palette's trailing edge,
 * palette still `aria-modal="true"`.
 *
 * WAITING FOR THE PANEL IS NOT A CONCESSION; it is the only instant at which
 * the question can be both answered and acted on, and `judge` below refuses to
 * run before it. Asked one commit earlier the panel does not exist, so there
 * is no `own` to ignore - and closing there does not stop the kit mounting
 * that panel and FOCUSING it a beat later, with our registration already torn
 * down and nothing left to take focus back. Measured at 1280x720 with the
 * palette open on "beatles": judging on the way up left `aria-expanded`
 * "false" and focus parked on `DIV#_r_7_._positioner_3pg0t_1` - still there a
 * second and two forced paints later - with the field still holding its text
 * and not focused. Judged when the panel arrives instead, the same run puts
 * focus back in the field, caret at 7 of 7, three times on three fresh loads.
 * See `rehome` below.
 *
 * WHAT THE WATCH DOES NOT SEE, and it is a childList watch under the body on
 * purpose. A layer that is already in the document and merely becomes visible
 * - a class or a style toggled - moves no nodes and raises no record. No
 * takeover in this app does that today; they mount and unmount. Watching
 * attributes too would put a sweep behind every inline style the player writes
 * while a panel is open, which is a real cost for a case that does not exist.
 * Nor does it see a node appended OUTSIDE the body: measured, a
 * `position:fixed;inset:0;z-index:9999` div on `document.documentElement` left
 * the bell's popover standing with the bell's centre hit-testing to that
 * cover, where the identical node under the body closed it. Every portal in
 * this app lands under the body - the kit's `_viewport_1nbns_1` is a body
 * child and our own scrim is inside `#root` - so the wider root would buy
 * nothing but a sweep behind every `<style>` the bundler injects into the
 * head. The day a takeover appears by class alone, or outside the body, this
 * is the line that has to grow.
 *
 * WHY BEING THE `open` PROP, rather than any of the three shorter answers:
 *   - a synthetic `pointerdown` at the document does close the kit, and it
 *     also consumes `player/Player.tsx:2181`'s `{ once: true }` primer, which
 *     builds the AudioContext on the first real gesture. A context built
 *     outside a gesture is suspended on WebKit and the meter reads silence -
 *     the exact failure that comment describes. `core/haptics.ts:211` arms its
 *     tap detector on a capture-phase window pointerdown too, so a synthetic
 *     press also leaves a bogus start point for the next real pointerup.
 *   - a synthetic Escape hits the same primer (`keydown` is the other
 *     once-listener) and is a far broader hammer: it would close kit Modals,
 *     Selects and menus as well.
 *   - `trigger.click()` goes through the kit's own toggle and touches neither
 *     of those - but `player/VolumeControl.tsx:131` gives its trigger an
 *     `onClick` that toggles MUTE, so it would silence the player. An
 *     exception list for one trigger is a landmine, not a rule.
 * What is left is the seam the kit actually offers: hold `open` ourselves.
 * That is what ux/Popover.tsx is for, and it is why every popover in this app
 * imports `Popover` from there rather than from `@glacier/react`.
 *
 * NOT A CSS ANSWER, and the two obvious ones were measured before this was
 * written; the numbers are in 05-the-dock-contract-a.css beside the absence
 * they explain. Narrowing the positioner the way that chapter narrows the kit
 * overlays ERASES it (337.734px wide -> 9.883px at 1024x768 docked, because
 * the kit writes `left` inline and the panel has no author width, so the extra
 * inset over-constrains the box). Ducking it below the scrim leaves it
 * half-dead over the docked card and hides it entirely behind the palette on a
 * PHONE, where the scrim computes `display: none` and the bell is deliberately
 * live. Its anchoring is the one thing that must not be disturbed, and this
 * file disturbs none of it: no z-index, no inset, no style written anywhere.
 */

/** The attribute a registered popover's trigger wears, so the sweep can find
 *  it. Not a ref: the kit clones the trigger with its OWN ref, so a ref put on
 *  that element is replaced. `aria-controls` would serve for a single open
 *  popover but cannot say which registered closer owns which portalled panel;
 *  a cloned-in attribute can, so two open at once are judged one at a time. */
export const STAND_MARK = 'data-popover-stand';

/**
 * What one registered popover is, from this file's side: how to close it, and
 * who held focus when it opened.
 *
 * The second half is not bookkeeping. The kit FOCUSES the panel as it mounts
 * (vendor/@glacier/react/dist/index.js, the Popover's mount effect:
 * `i === "press" && m.current?.focus()`, where `i` is `openOn` and NOT how the
 * panel came to be open - it defaults to press, so twelve of the thirteen
 * sites focus their panel even when nothing pressed anything). Its only
 * restore paths are its two Escape handlers, which put focus on the trigger;
 * closing one from outside through `onOpenChange` restores nothing at all. So
 * whatever dismisses a focused panel has to say where focus goes, or it rides
 * a node the user can no longer see.
 */
type Stand = { close: () => void; before: Element | null };

/** Every open popover, by the mark its trigger wears. */
const stands = new Map<string, Stand>();

/**
 * Where focus goes when the gate dismisses a panel that is holding it.
 *
 * NOT the trigger, which is where Escape goes. This rule only ever fires
 * because a layer has COVERED that trigger, so focusing it would put focus
 * exactly where a finger cannot land - the one thing ux/focusScope.ts exists
 * to prevent, reached by the file that shares its predicate. Where focus was
 * BEFORE the panel took it instead, and only while a finger could still reach
 * THAT, asked with `underNothing` so the two channels cannot start disagreeing
 * about reachability here either. Otherwise nowhere in particular: the blur
 * puts focus on `document.body`, which is exactly where the kit's own unmount
 * would have left it a beat later anyway (measured: focus the panel, remove the
 * node the way `onAnimationComplete` does, and `document.activeElement` is the
 * body), and where focusScope's out-of-ring branch picks the next Tab up.
 *
 * Focus that is NOT inside this panel is left exactly where it is. The
 * takeover that covered the trigger has usually taken it already - measured
 * with the app's own `__AFM_SHARED_LINK__` over a standing bell popover, focus
 * lands on the kit Modal's own panel - and that is a better answer than
 * anything this file could compute.
 */
function rehome(panel: HTMLElement, before: Element | null): void {
  const here = document.activeElement;
  if (!(here instanceof HTMLElement) || !panel.contains(here)) return;
  if (before instanceof HTMLElement && before.isConnected && underNothing(before)) before.focus();
  else here.blur();
}

/**
 * Judge ONE popover: close it unless a finger could still reach the control it
 * hangs off.
 *
 * The gate is the whole of the rule, and it is why this is not "close every
 * popover when anything opens". A popover whose trigger the finger can still
 * press is not covered by anything and has no business closing: the phone's
 * header bell is deliberately live above the palette's top edge, and the
 * docked Now Playing card is deliberately live beside a takeover, with seven
 * popovers of its own (equalizer, chapters, reading speed, volume, devices,
 * the DJ, groove). Both keep theirs. The desktop title bar's bell, which the
 * scrim and chapter 05's band cover, loses its.
 *
 * `underNothing` is focusScope's, deliberately shared rather than copied: the
 * keyboard rule and the pointer rule must not be able to disagree about what
 * is reachable. The panel it is told to ignore is this popover's OWN, found
 * through the `aria-controls` the kit puts on the trigger while it is open
 * (measured: `aria-controls="_r_7_"`, resolving to the portalled
 * `DIV._positioner_3pg0t_1`). Without that, a popover whose panel the kit had
 * to anchor over its own trigger would close itself the moment it opened. It
 * is live at every judgement this file makes, because of the next paragraph.
 *
 * NO PANEL, NO JUDGEMENT, and that is the line that keeps the header's promise
 * rather than an optimisation. Between the commit that marks the trigger and
 * the commit that portals the panel there is nothing to hit-test against and
 * nothing to take focus back from; the panel's own arrival is the record the
 * watch is armed for, so the question is asked a beat later with both in hand.
 * The one case this DOES answer on the way up is a re-open before the kit's
 * exit animation has finished. The kit unmounts the panel from that animation's
 * `onAnimationComplete` and not from the open flag, so until it lands the node
 * is still mounted and a re-open reuses it: no node is inserted, no record is
 * raised, and the only chance to judge is this call. Measured - the panel was
 * already in the document when the effect ran, and the same node id came back.
 *
 * A trigger the DOM cannot produce - unmounted while its panel was still on
 * screen - leaves that popover alone, which is today's behaviour rather than a
 * break.
 */
function judge(mark: string, stand: Stand): void {
  const trigger = document.querySelector<HTMLElement>(`[${STAND_MARK}="${mark}"]`);
  if (!trigger) return;
  const owned = trigger.getAttribute('aria-controls');
  const panel = owned ? document.getElementById(owned) : null;
  if (!panel) return;
  if (underNothing(trigger, panel)) return;
  rehome(panel, stand.before);
  stand.close();
}

/** Judge every open popover, one at a time - the marks are what keep two of
 *  them apart. */
function sweep(): void {
  for (const [mark, stand] of stands) judge(mark, stand);
}

/**
 * The layer watch: armed while any popover stands, disarmed when the last one
 * goes. See the header for what it does and does not see.
 */
let layers: MutationObserver | null = null;

function arm(): void {
  if (layers) return;
  layers = new MutationObserver((records) => {
    if (records.some((record) => record.addedNodes.length > 0)) sweep();
  });
  layers.observe(document.body, { childList: true, subtree: true });
}

function disarm(): void {
  if (stands.size) return;
  layers?.disconnect();
  layers = null;
}

/**
 * Registers a popover's own close while it is open, and returns the mark to
 * put on its trigger.
 */
export function usePopoverStand(open: boolean, close: () => void): string {
  const mark = useId();
  /* Held in a ref so re-registering is not a consequence of a new callback
     identity every render: the entry must be stable for as long as the panel
     is open, and what it closes must be the LATEST handler. */
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    /* `document.activeElement` read HERE, which is the last instant it is still
       the user's: this effect belongs to the wrapper, the parent of the kit's
       Popover, and the kit focuses its panel from a child effect one commit
       later. Measured on the route that matters - palette open, caret in the
       search field, a pressless self-open - this reads
       `INPUT#searchPageField`, which is exactly where `rehome` puts it back. */
    const stand: Stand = { close: () => closeRef.current(), before: document.activeElement };
    stands.set(mark, stand);
    arm();
    /* Armed BEFORE this, so the panel's own arrival is caught. This call is
       almost always a no-op - there is no panel yet - and exists for the one
       open that inserts no node: a re-open inside the kit's exit animation.
       See `judge`. A popover a finger opened cannot fail the gate either way:
       if the trigger were covered the press could not have landed on it. */
    judge(mark, stand);
    return () => {
      stands.delete(mark);
      disarm();
    };
  }, [open, mark]);
  return mark;
}

