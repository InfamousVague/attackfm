import { CounterBadge } from '@glacier/react';
import type { NavDest } from './navSeats.ts';

/**
 * The count a destination wears - hung off the seat wherever that seat has
 * room for it (the corner of a bar glyph, the trailing end of a rail or menu
 * row), which is the only thing the class decides.
 *
 * OUT OF THE BUTTON'S NAME, ON PURPOSE. The kit's badge is a role="status"
 * span with the sentence as its aria-label, and a labelled descendant joins
 * its button's accessible NAME: "Profile" would read as "3 things waiting for
 * you on your profile Profile" - a worse announcement, and a button whose
 * name changes with the mail, which nothing that finds a seat by its name
 * (a reader's rotor, every spec in e2e/) can be asked to follow. aria-hidden
 * takes it out of the name; the seat points at it with aria-describedby,
 * which puts the same sentence back as the button's DESCRIPTION - where a
 * count belongs: "Profile, button, 3 things waiting for you on your profile".
 * A hidden node is still read when something references it by id; that is
 * the one exception the accessible-name algorithm makes, and it is for this.
 *
 * Renders nothing for nothing, on the same test the seat uses to decide
 * whether to point at it at all - `describedBy` in navSeats - so a seat never
 * describes itself by an id that is not in the document.
 */
export function WaitingBadge({
  id,
  waiting,
  className,
}: {
  id: string;
  waiting: NavDest['waiting'];
  className: 'appNavBadge--corner' | 'appNavBadge--row';
}) {
  if (!waiting || waiting.count <= 0) return null;
  return (
    <CounterBadge
      id={id}
      className={className}
      count={waiting.count}
      max={99}
      size="sm"
      // The same tone the bell's count wears: attention, not alarm.
      tone="accent"
      aria-label={waiting.label}
      aria-hidden
    />
  );
}
