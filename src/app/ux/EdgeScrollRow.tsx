import type { ReactNode } from 'react';
import { useEdgeFade } from './edgeFade.ts';

/**
 * A row of controls that scrolls sideways instead of wrapping, faded at
 * whichever end still has something on it.
 *
 * The class carries the behaviour (styles/04 `.edgeScroll`) and the hook
 * carries the fade; this pairs them so a caller cannot take one without the
 * other and end up with a row cut off at a hard edge.
 */
export function EdgeScrollRow({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const ref = useEdgeFade<HTMLDivElement>();
  return (
    <div ref={ref} className={className ? `${className} edgeScroll` : 'edgeScroll'} {...rest}>
      {children}
    </div>
  );
}
