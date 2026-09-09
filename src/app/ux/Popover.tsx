import { cloneElement, useCallback, useState } from 'react';
import { Popover as KitPopover } from '@glacier/react';
import type { ComponentProps } from 'react';
import { STAND_MARK, usePopoverStand } from './popoverStand.ts';

type PopoverProps = ComponentProps<typeof KitPopover>;

/**
 * The kit's Popover, plus the stand-down rule. Every popover in this app comes
 * through here; the rule, and why it is this shape rather than a stylesheet or
 * a synthetic press, is in ux/popoverStand.ts.
 *
 * The wrapper does two things and nothing else: it makes the panel CONTROLLED,
 * because being the `open` prop is the only seam the kit offers for closing one
 * from outside, and it marks the trigger so the sweep can hit-test the control
 * this panel hangs off. Six of the thirteen sites were already controlled and
 * pass their own `open`/`onOpenChange` straight through, unchanged; the other
 * seven get their state from here. `openOn="hover"` is unaffected - the kit
 * calls `onOpenChange` on the hover open and close too.
 */
export function Popover({ trigger, open, onOpenChange, defaultOpen, ...rest }: PopoverProps) {
  const [own, setOwn] = useState(defaultOpen ?? false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : own;

  const change = useCallback(
    (next: boolean) => {
      if (!controlled) setOwn(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const mark = usePopoverStand(
    isOpen,
    useCallback(() => change(false), [change]),
  );

  return (
    <KitPopover
      {...rest}
      open={isOpen}
      onOpenChange={change}
      trigger={cloneElement(trigger, { [STAND_MARK]: mark } as Record<string, string>)}
    />
  );
}
