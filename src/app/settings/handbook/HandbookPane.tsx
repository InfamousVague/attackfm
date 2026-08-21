import { IconButton, Menu, MenuItem } from '@glacier/react';
import { ChevronLeft, ChevronRight, TableOfContents } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import {
  HANDBOOK_CHAPTERS,
  HANDBOOK_PAGES,
} from './handbookPages.tsx';

/** The reader's place, kept across sessions - a manual that forgets where you
 *  were is a manual read once. */
const PAGE_KEY = 'attackfm-handbook-page';

/** How far a sideways drag must travel to turn the page. */
const TURN = 56;
/** Drag slop before the gesture picks an axis - same figure the edge-swipe
 *  uses, so the two feel like one hand. */
const SLOP = 12;
/** Leave the screen's left strip to the app's own back gesture. */
const EDGE = 28;

/**
 * The handbook: a full-height reader inside Settings. The page fills the room
 * between the chapter bar and the pager - no card around it, the pane IS the
 * page - with the arrows pinned along the bottom where thumbs live. Pages
 * turn by button, arrow key, or a sideways swipe on the page itself; the
 * counter between the arrows opens the whole index, so any page is two taps
 * from any other.
 */
export function HandbookPane() {
  const pages = HANDBOOK_PAGES;
  const [index, setIndex] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(PAGE_KEY));
      return Number.isInteger(raw) && raw >= 0 && raw < pages.length ? raw : 0;
    } catch {
      return 0;
    }
  });
  // Which way the page slides in - forward pages enter from the right.
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');

  // The scroller the page lives in, so a turn starts the new page at its top -
  // arriving halfway down a page you have not read yet reads as broken.
  const hostRef = useRef<HTMLDivElement | null>(null);

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    if (clamped === index) return;
    setDir(clamped > index ? 'fwd' : 'back');
    setIndex(clamped);
    hostRef.current?.scrollTo({ top: 0 });
    try {
      localStorage.setItem(PAGE_KEY, String(clamped));
    } catch {
      // The reader just starts from the cover next time.
    }
  };

  /** Turn by so many pages - what the keys and the swipe both speak. */
  const turn = (delta: number) => go(index + delta);

  // Arrow keys while the pane is showing. Held in a ref so the one listener
  // always sees the current page; the listener itself attaches once, which is
  // safe here because this pane renders its content unconditionally.
  const liveTurn = useRef(turn);
  liveTurn.current = turn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      liveTurn.current(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The sideways swipe. Attached as React handlers with pointer capture, so
  // there are no manual listeners to re-home; the card translates under the
  // finger and either commits past TURN or eases home.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null } | null>(null);

  const paint = (dx: number, animate: boolean) => {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 0.2s var(--glacier-ease-out, ease-out)' : 'none';
    el.style.transform = dx !== 0 ? `translate3d(${(dx * 0.35).toFixed(1)}px,0,0)` : '';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || drag.current) return;
    if (e.clientX <= EDGE) return; // the app's own back gesture owns the strip
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No capture just means a drag that leaves the page stops following.
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.axis === null) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (d.axis !== 'x') return;
    paint(dx, false);
  };

  const settle = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    drag.current = null;
    paint(0, true);
    if (commit && d.axis === 'x' && Math.abs(dx) >= TURN) {
      // Drag left → next page, like turning paper.
      go(dx < 0 ? index + 1 : index - 1);
    }
  };

  const page = pages[index]!;
  const chapter = HANDBOOK_CHAPTERS.find(
    (c) => index >= c.start && index < c.start + c.count,
  )!;

  // Controlled so picking a page closes the map - a menu that stays open
  // over the page it just turned to is covering its own answer.
  const [indexOpen, setIndexOpen] = useState(false);

  return (
    <div className="handbook">
      <div className="handbook__progress" role="tablist" aria-label="Chapters">
        {HANDBOOK_CHAPTERS.map((c) => {
          const done = Math.max(0, Math.min(c.count, index - c.start + 1));
          return (
            <button
              key={c.title}
              type="button"
              role="tab"
              aria-selected={c === chapter}
              aria-label={`${c.title} — ${c.count} pages`}
              className="handbook__seg"
              style={{ flexGrow: c.count }}
              onClick={() => go(c.start)}
            >
              <span
                className="handbook__segFill"
                style={{ width: `${(done / c.count) * 100}%` }}
              />
            </button>
          );
        })}
      </div>

      <div
        ref={hostRef}
        className="handbook__pageHost"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => settle(e, true)}
        onPointerCancel={(e) => settle(e, false)}
      >
        <div key={page.id} ref={cardRef} className="handbook__page" data-dir={dir}>
          <span className="handbook__glyph" aria-hidden="true">
            {page.icon}
          </span>
          <span className="handbook__kicker">{page.chapter}</span>
          <h3 className="handbook__title">{page.title}</h3>
          <div className="handbook__prose">{page.body}</div>
          {index === 0 && (
            <nav className="handbook__toc" aria-label="Contents">
              {HANDBOOK_CHAPTERS.filter((c) => c.start > 0).map((c) => (
                <button
                  key={c.title}
                  type="button"
                  className="handbook__tocRow"
                  onClick={() => go(c.start)}
                >
                  <span className="handbook__tocIcon" aria-hidden="true">
                    {c.icon}
                  </span>
                  <span className="handbook__tocTitle">{c.title}</span>
                  <span className="handbook__tocPages">
                    {c.count} {c.count === 1 ? 'page' : 'pages'}
                  </span>
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>

      <div className="handbook__controls">
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Previous page"
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        {/* The counter is the index: every page of every chapter, one tap
            away, so the bar's chapter jumps are the shortcut and this is the
            whole map. */}
        <Menu
          aria-label="Handbook index"
          className="handbookIndex"
          placement="top"
          open={indexOpen}
          onOpenChange={setIndexOpen}
          trigger={
            <button type="button" className="handbook__where" title="Open the index">
              <TableOfContents size={14} aria-hidden="true" />
              <span>
                {chapter.title} · {index + 1} / {pages.length}
              </span>
            </button>
          }
        >
          {HANDBOOK_CHAPTERS.map((c) => (
            <div key={c.title} className="handbookIndex__chapter">
              <div className="handbookIndex__head" aria-hidden="true">
                {c.title}
              </div>
              {pages.slice(c.start, c.start + c.count).map((p, i) => (
                <MenuItem
                  key={p.id}
                  icon={<span className="handbookIndex__icon">{p.icon}</span>}
                  onSelect={() => {
                    setIndexOpen(false);
                    go(c.start + i);
                  }}
                >
                  <span
                    className="handbookIndex__label"
                    data-here={c.start + i === index || undefined}
                  >
                    {p.title}
                  </span>
                </MenuItem>
              ))}
            </div>
          ))}
        </Menu>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Next page"
          disabled={index === pages.length - 1}
          onClick={() => go(index + 1)}
        >
          <ChevronRight size={18} />
        </IconButton>
      </div>
    </div>
  );
}
