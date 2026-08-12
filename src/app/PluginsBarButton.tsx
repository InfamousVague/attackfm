import { useEffect, useRef, useState } from 'react';
import { Blocks } from '@glacier/icons';
import { usePluginPages } from '../plugins/runtime.tsx';

/**
 * The plugins' door on the phone bar: a tab on the bar's right that, tapped,
 * cascades its pages UP out of the bar - one row per enabled plugin page. It
 * replaces the old floating fan; plugin pages still keep out of the core tabs'
 * hair, but their entrance now lives on the bar itself rather than drifting
 * over the content.
 *
 * The button wears the active page's icon while you are on one (so it doubles
 * as "where am I") and the generic mark otherwise, and it is absent entirely
 * when no enabled plugin contributes a page - an empty menu is worse than none.
 *
 * Closing is a document-level click-outside rather than a full-screen scrim:
 * the bar carries a backdrop-filter, which would trap a `position: fixed`
 * scrim inside the bar's box instead of the viewport.
 */
export function PluginsBarButton({ tab, onTab }: { tab: string; onTab: (tab: string) => void }) {
  const pages = usePluginPages();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on a tap anywhere outside, or on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = pages.find((pg) => pg.key === tab) ?? null;

  return (
    <div className="appNavBarPlugins" ref={root}>
      {open && (
        <div className="appNavBarPlugins__menu" role="menu" aria-label="Plugin pages">
          {pages.length === 0 && (
            <span className="appNavBarPlugins__empty">
              No plugin pages yet — add some in Settings → Plugins.
            </span>
          )}
          {pages.map((pg, i) => (
            <button
              key={pg.key}
              type="button"
              role="menuitem"
              className="appNavBarPlugins__item"
              data-active={tab === pg.key || undefined}
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => {
                setOpen(false);
                onTab(pg.key);
              }}
            >
              <span className="appNavBarPlugins__itemIcon" aria-hidden>
                {pg.icon}
              </span>
              <span className="appNavBarPlugins__itemLabel">{pg.label}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="appNavBarTab appNavBarPlugins__trigger"
        data-active={!!active || open || undefined}
        aria-current={active && !open ? 'page' : undefined}
        aria-expanded={open}
        aria-label="Plugins"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="appNavBarTab__icon">
          {active && !open ? active.icon : <Blocks size={20} />}
        </span>
        <span className="appNavBarTab__label">Plugins</span>
      </button>
    </div>
  );
}
