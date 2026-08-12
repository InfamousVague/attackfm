import { useEffect, useRef, useState } from 'react';
import { Blocks } from '@glacier/icons';
import { usePluginPages } from '../plugins/runtime.tsx';

/**
 * The plugins' own door: a floating button riding the screen edge, draggable
 * anywhere along either side, that fans out one button per plugin page.
 *
 * Plugin pages used to take seats in the primary nav - fine at one, crowding
 * the core tabs by three. Here they live in a place that is theirs: the fan
 * only exists when at least one plugin contributes a page, wears the active
 * page's icon while you are on one, and the whole affordance can be dragged
 * out of the way of whatever it happens to cover - the position (side + how
 * far down) persists per device.
 *
 * Interaction: a tap opens the fan (a vertical run of icon buttons, labels
 * toward the screen's centre); a drag moves the button, snapping to the
 * nearer edge on release. The two never blur: a press only counts as a tap
 * while movement stays under a thumb-wobble threshold.
 */

const POS_KEY = 'attackfm-plugin-fan';

interface FanPos {
  side: 'left' | 'right';
  /** Fraction of viewport height, so the spot survives rotation and resize. */
  y: number;
}

/** Clear of the header above and the player strip / tab bar below. */
const Y_MIN = 0.1;
const Y_MAX = 0.78;

function readPos(): FanPos {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? '') as FanPos;
    if ((raw.side === 'left' || raw.side === 'right') && typeof raw.y === 'number') {
      return { side: raw.side, y: Math.min(Y_MAX, Math.max(Y_MIN, raw.y)) };
    }
  } catch {
    // First run, or storage said no - the default corner below.
  }
  return { side: 'right', y: 0.62 };
}

export function PluginFan({ tab, onTab }: { tab: string; onTab: (tab: string) => void }) {
  const pages = usePluginPages();
  const [pos, setPos] = useState<FanPos>(readPos);
  const [open, setOpen] = useState(false);
  /** Live pointer position while a drag is in flight; null when parked. */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<{ id: number; startX: number; startY: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      // The spot just will not survive a relaunch.
    }
  }, [pos]);

  // A page-set change can orphan the open fan (plugin toggled off from
  // Settings while it is out); fold it quietly.
  useEffect(() => {
    if (pages.length === 0) setOpen(false);
  }, [pages.length]);

  if (pages.length === 0) return null;
  const active = pages.find((pg) => pg.key === tab) ?? null;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the platform will not capture still taps fine.
    }
    gesture.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 6) return;
    g.moved = true;
    setDrag({ x: e.clientX, y: e.clientY });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.moved) {
      // Park: the nearer edge takes it, the height fraction remembers.
      setPos({
        side: e.clientX < window.innerWidth / 2 ? 'left' : 'right',
        y: Math.min(Y_MAX, Math.max(Y_MIN, e.clientY / window.innerHeight)),
      });
      setDrag(null);
    } else {
      setOpen((o) => !o);
    }
  };

  return (
    <>
      {open && (
        <button
          type="button"
          className="pluginFanScrim"
          aria-label="Close plugins"
          onClick={() => setOpen(false)}
        />
      )}
      <div
        className="pluginFan"
        data-side={drag ? undefined : pos.side}
        data-open={open || undefined}
        data-dragging={drag ? '' : undefined}
        style={
          drag
            ? { top: drag.y, left: drag.x, right: 'auto', transform: 'translate(-50%, -50%)' }
            : { top: `${pos.y * 100}%` }
        }
      >
        {open && (
          <div className="pluginFan__items" role="menu" aria-label="Plugin pages">
            {pages.map((pg, i) => (
              <button
                key={pg.key}
                type="button"
                role="menuitem"
                className="pluginFan__item"
                data-active={tab === pg.key || undefined}
                style={{ '--fan-i': i } as React.CSSProperties}
                onClick={() => {
                  setOpen(false);
                  onTab(pg.key);
                }}
              >
                <span className="pluginFan__itemIcon" aria-hidden>
                  {pg.icon}
                </span>
                <span className="pluginFan__itemLabel">{pg.label}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="pluginFan__fab"
          aria-label="Plugins"
          aria-expanded={open}
          data-active={(!!active && !open) || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* Wears the page you are on, so the button doubles as "where am I"
              - and the generic mark everywhere else. */}
          {active && !open ? active.icon : <Blocks size={20} />}
        </button>
      </div>
    </>
  );
}
