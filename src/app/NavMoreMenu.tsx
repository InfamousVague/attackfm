import { useState } from 'react';
import { Popover } from '@glacier/react';
import { ChartNoAxesColumn, Download, EllipsisVertical, Settings } from '@glacier/icons';
import { useHasDownloadQueue, usePluginPages } from '../plugins/runtime.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';

/**
 * The bar's overflow: a vertical-ellipsis tab that opens the app's "rest of the
 * options" - every enabled plugin's page (the Books shelf among them), then the
 * secondary destinations that no longer earn a permanent seat: Stats, the
 * download queue while one is running, and Settings.
 *
 * Built on the kit's Popover so the panel is a real one: it PORTALS to the body,
 * which is what gives it the glass and the blur (a hand-rolled panel nested
 * inside the bar's own backdrop-filter cannot blur - the filter traps it), and
 * brings outside-press/Escape dismissal for free. Controlled only so a chosen
 * row can close it on the way out.
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
  // The page is worth offering the moment ANYTHING can download - the music
  // importer through its bridge, or any plugin that contributes a queue. Read
  // off the declarations rather than the live queues: asking every source what
  // it is carrying means calling its hook, and a menu must not mount a plugin
  // hook scope just to decide whether to draw a row. The consequence is that
  // the count beside the label is the importer's alone; books in flight open
  // the page, they just do not number it.
  const hasQueue = useHasDownloadQueue();
  const [open, setOpen] = useState(false);

  // The ⋮ lights when what is on screen lives in this menu.
  const onMenuDest =
    pages.some((pg) => pg.key === tab) || tab === 'stats' || tab === 'downloads';

  const go = (next: string) => {
    setOpen(false);
    onTab(next);
  };

  return (
    <Popover
      placement="top-end"
      aria-label="More"
      className="appNavMore"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="appNavBarTab appNavBarPlugins__trigger"
          data-active={onMenuDest || open || undefined}
          aria-label="More"
        >
          <span className="appNavBarTab__icon">
            <EllipsisVertical size={24} />
          </span>
          <span className="appNavBarTab__label">More</span>
        </button>
      }
    >
      <div className="appNavMore__menu" role="menu" aria-label="More">
        {pages.map((pg) => (
          <button
            key={pg.key}
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            data-active={tab === pg.key || undefined}
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

        {hasQueue && (
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
    </Popover>
  );
}
