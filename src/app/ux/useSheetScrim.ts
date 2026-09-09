import { useEffect, useState } from 'react';

/**
 * Does a takeover on this shape get a DIMMER?
 *
 * `--app-sheet-scrim` is chapter 71's answer, and it is not a copy of the
 * question - it IS the scrim's `display` (`71-glass-sheet.css:45`), the single
 * place the contract decides this. So read the token, never a second
 * hand-written media query: a rule that drifted from the stylesheet would put
 * the markup and the paint back into exactly the disagreement this hook was
 * added to end.
 *
 * The media query here is only the TRIGGER, not the answer. Two branches set
 * the token: `:root[data-platform='desktop']` (`71:248`), stamped once at boot
 * and unable to change; and `(min-width: 60rem) and (pointer: fine)`
 * (`71:224`), which CAN change while the app runs - a browser window is
 * resized, a laptop is docked to a monitor, a pointer type changes. Watching
 * the second is enough to catch every transition the first cannot make.
 *
 * NOT `useDesktopLayout()`, which is textually the same query and a different
 * question: it ORs `isDesktopApp`, so in a desktop BROWSER narrower than 60rem
 * it answers false while `data-platform='desktop'` gives that window a real
 * scrim and real modality. Same string, opposite answer, and the token is the
 * only thing that knows which.
 *
 * What reads it: the search palette's `aria-modal`. `role="dialog"` stays
 * unconditional - the palette is always announced as a dialog - but
 * `aria-modal="true"` is a claim that everything outside the dialog is
 * unavailable, and on a phone and a docked tablet that claim is false three
 * ways at once: the header's bell outside it is tappable, it is deliberately
 * the focus ring's own first stop, and it carries neither `inert` nor
 * `aria-hidden` (measured at 375x812: `[inert]` 0, empty aria-hidden chain).
 */
const CONTRACT_SHAPE = '(min-width: 60rem) and (pointer: fine)';

const read = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--app-sheet-scrim').trim() !== 'none';

export function useSheetScrim(): boolean {
  const [has, setHas] = useState(read);
  useEffect(() => {
    const query = window.matchMedia?.(CONTRACT_SHAPE);
    if (!query) return;
    // Re-READ the token rather than trusting the event: the query is the
    // trigger, the custom property is the fact, and only the second knows
    // about the platform branch.
    const onChange = () => setHas(read());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return has;
}
