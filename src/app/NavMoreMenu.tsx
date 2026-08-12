import { useEffect, useRef, useState } from 'react';
import { ChartNoAxesColumn, Download, EllipsisVertical, Settings } from '@glacier/icons';
import { usePluginPages } from '../plugins/runtime.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';

/**
 * The bar's overflow: a vertical-ellipsis tab that cascades UP the app's "rest
 * of the options" - every enabled plugin's page (the Books shelf among them,
 * now that it is a compiled-in plugin), then the secondary destinations that no
 * longer earn a permanent seat: Stats, the download queue while one is running,
 * and Settings. It keeps the core tabs to five and puts everything else one tap
 * away, out of the way.
 *
 * Closing is a document-level click-outside, not a scrim: the bar's
 * backdrop-filter would trap a `position: fixed` scrim inside the bar.
 */
export function NavMoreMenu({
  tab,
  onTab,
  onSettings,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
}) {
  const pages = usePluginPages();
  const dl = useDownloadsOptional();
  const dlActive = dl?.active.length ?? 0;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  // The ⋮ lights when what is on screen lives in this menu.
  const onMenuDest =
    pages.some((pg) => pg.key === tab) || tab === 'stats' || tab === 'downloads';

  const go = (next: string) => {
    setOpen(false);
    onTab(next);
  };

  return (
    <div className="appNavBarPlugins" ref={root}>
      {open && (
        <div className="appNavBarPlugins__menu" role="menu" aria-label="More">
          {pages.map((pg, i) => (
            <button
              key={pg.key}
              type="button"
              role="menuitem"
              className="appNavBarPlugins__item"
              data-active={tab === pg.key || undefined}
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => go(pg.key)}
            >
              <span className="appNavBarPlugins__itemIcon" aria-hidden>
                {pg.icon}
              </span>
              <span className="appNavBarPlugins__itemLabel">{pg.label}</span>
            </button>
          ))}

          {pages.length > 0 && <span className="appNavBarPlugins__divider" aria-hidden />}

          <button
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            data-active={tab === 'stats' || undefined}
            onClick={() => go('stats')}
          >
            <span className="appNavBarPlugins__itemIcon" aria-hidden>
              <ChartNoAxesColumn size={18} />
            </span>
            <span className="appNavBarPlugins__itemLabel">Stats</span>
          </button>

          {dl && (
            <button
              type="button"
              role="menuitem"
              className="appNavBarPlugins__item"
              data-active={tab === 'downloads' || undefined}
              onClick={() => go('downloads')}
            >
              <span className="appNavBarPlugins__itemIcon" aria-hidden>
                <Download size={18} />
              </span>
              <span className="appNavBarPlugins__itemLabel">
                Downloads{dlActive > 0 ? ` (${dlActive})` : ''}
              </span>
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <span className="appNavBarPlugins__itemIcon" aria-hidden>
              <Settings size={18} />
            </span>
            <span className="appNavBarPlugins__itemLabel">Settings</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="appNavBarTab appNavBarPlugins__trigger"
        data-active={onMenuDest || open || undefined}
        aria-expanded={open}
        aria-label="More"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="appNavBarTab__icon">
          <EllipsisVertical size={20} />
        </span>
        <span className="appNavBarTab__label">More</span>
      </button>
    </div>
  );
}
