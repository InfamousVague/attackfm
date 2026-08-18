import { useEffect, useRef, useState, type ReactNode } from 'react';

interface RevealProps {
  children: ReactNode;
  /** Stagger within a group, in milliseconds. */
  delay?: number;
  variant?: 'up' | 'left' | 'right' | 'scale';
  as?: 'div' | 'section' | 'li' | 'article';
  className?: string;
}

/**
 * Reveal a block the first time it scrolls into view.
 *
 * One observer per element sounds wasteful and is not: IntersectionObserver
 * callbacks are batched off the main thread, which is the whole reason to use it
 * instead of a scroll listener measuring positions on every frame.
 *
 * It disconnects after firing - the animation is a one-shot, and an observer
 * left attached would keep reporting for the life of the page.
 */
export function Reveal({
  children,
  delay = 0,
  variant = 'up',
  as: Tag = 'div',
  className = '',
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Reduced motion: show it immediately and never animate. Checked here as
    // well as in CSS so the will-change hint is never applied either.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      setSettled(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShown(true);
        observer.disconnect();
        // Release the compositor hint once the transition has finished.
        window.setTimeout(() => setSettled(true), 750 + delay);
      },
      // Fire slightly before the element reaches the fold, so the motion is
      // already underway by the time the reader is looking at it.
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [delay]);

  const variantClass = variant === 'up' ? '' : ` reveal--${variant}`;

  return (
    <Tag
      ref={ref as never}
      className={`reveal${variantClass}${className ? ` ${className}` : ''}`}
      data-shown={shown || undefined}
      data-settled={settled || undefined}
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
