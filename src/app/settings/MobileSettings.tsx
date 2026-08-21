import { SearchField, Text } from '@glacier/react';
import { ChevronLeft, ChevronRight, X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { setSettingsBack } from './settingsBack.ts';
import { createPortal } from 'react-dom';
import { noteSettingsPane, recentPanes, type RecentPane } from './settingsRecency.ts';
import {
  paneMatches,
  revealSetting,
  settingsGroupLabel,
  settingsMatching,
  SettingsNavContext,
  type SettingsSection,
} from './settingsShared.ts';

/**
 * The touch settings surface: a full-screen sheet portalled over everything.
 * It opens on the section list (the "sidebar"); tapping a row pushes into that
 * section's pane, and a back arrow at the top returns to the list. Portalled to
 * the body so it escapes the app's stacking context, exactly like Now Playing.
 */
export function MobileSettings({
  open,
  onClose,
  sections,
  initialId = null,
}: {
  open: boolean;
  onClose: () => void;
  sections: SettingsSection[];
  /** Land straight on one pane when told to (the network dot's Manage). */
  initialId?: string | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Read once per open: the panes this hand reaches for. Opening one below
  // rewrites the store, but the row keeps this open's order - chips that
  // reshuffle under a thumb read as a glitch, not a feature.
  const [recents, setRecents] = useState<RecentPane[]>([]);
  // Every fresh open lands on the list (or the pane it was aimed at), with a
  // clean query - never mid-drill on a stale section.
  useEffect(() => {
    if (!open) {
      setActiveId(null);
      setQuery('');
    } else {
      setRecents(recentPanes());
      if (initialId) setActiveId(initialId);
    }
  }, [open, initialId]);
  const drill = (id: string) => {
    const s = sections.find((x) => x.id === id);
    if (s) noteSettingsPane(id, s.label);
    setActiveId(id);
  };
  // A section pulled from under us (a plugin crash) drops us back to the list
  // rather than onto a pane that no longer exists.
  const active = sections.find((s) => s.id === activeId) ?? null;

  /*
   * Lend the app one step back.
   *
   * Registered only while open, and re-registered whenever the depth changes,
   * so the closure never answers about a pane that has since been left. The
   * boolean is the whole contract: true when a drill was undone, false when we
   * are already at the list and the caller should close instead.
   */
  useEffect(() => {
    if (!open) return;
    setSettingsBack(() => {
      if (activeId === null) return false;
      setActiveId(null);
      return true;
    });
    return () => setSettingsBack(null);
  }, [open, activeId]);
  useEffect(() => {
    if (activeId && !sections.some((s) => s.id === activeId)) setActiveId(null);
  }, [activeId, sections]);

  if (!open) return null;

  return createPortal(
    <SettingsNavContext.Provider value={drill}>
    <div
      className="settingsScreen"
      role="dialog"
      aria-label="Settings"
      data-view={active ? 'detail' : 'list'}
    >
      {active ? (
        <>
          <header className="settingsScreen__head">
            <button
              type="button"
              className="settingsScreen__icon"
              onClick={() => setActiveId(null)}
              aria-label="Back to settings"
            >
              <ChevronLeft size={22} />
            </button>
            <span className="settingsScreen__title">{active.label}</span>
            <span className="settingsScreen__headSpacer" aria-hidden="true" />
          </header>
          <div className="settingsScreen__pane">{active.content}</div>
        </>
      ) : (
        <>
          <header className="settingsScreen__head">
            <span className="settingsScreen__headSpacer" aria-hidden="true" />
            <span className="settingsScreen__title">Settings</span>
            <button
              type="button"
              className="settingsScreen__icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X size={22} />
            </button>
          </header>
          <nav className="settingsScreen__list">
            {/* The hunt-killer pair: a field that matches each pane's own
                vocabulary, and the panes this hand touched last as chips. */}
            <SearchField
              className="settingsScreen__search"
              value={query}
              onValueChange={setQuery}
              placeholder="Find a setting"
              aria-label="Find a setting"
            />
            {!query.trim() && recents.length > 0 && (
              <div className="settingsScreen__recents" aria-label="Recently opened">
                {recents
                  .filter((r) => sections.some((s) => s.id === r.id))
                  .map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="settingsScreen__recentChip"
                      onClick={() => drill(r.id)}
                    >
                      {/* Re-resolved, not read from the store: a chip written
                          before a pane was renamed would otherwise say
                          "General" and open "Library". */}
                      {sections.find((s) => s.id === r.id)?.label ?? r.label}
                    </button>
                  ))}
              </div>
            )}
            {/* Rows cluster into cards by their group - the iOS-settings shape:
                appearance and behaviour together, the server pair, the plugin
                pair, then About on its own. A live query flattens the clusters
                to just what matches. */}
            {sections
              .filter((s) => paneMatches(s, query))
              .reduce<SettingsSection[][]>((clusters, s) => {
                const last = clusters[clusters.length - 1];
                if (!query.trim() && last && (last[0]!.group ?? 99) === (s.group ?? 99)) last.push(s);
                else if (query.trim() && last) last.push(s);
                else clusters.push([s]);
                return clusters;
              }, [])
              .map((cluster) => (
                <div key={cluster[0]!.id} className="settingsScreen__cluster">
                  {/* The card's name. Only while browsing - a search's flat
                      result list is not four half-empty clusters. */}
                  {!query.trim() && settingsGroupLabel(cluster[0]!.group) && (
                    <div className="settingsScreen__groupLabel">
                      {settingsGroupLabel(cluster[0]!.group)}
                    </div>
                  )}
                  <div className="settingsScreen__group">
                  {cluster.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="settingsScreen__row"
                      onClick={() => drill(s.id)}
                    >
                      {s.icon ? (
                        <span
                          className="settingsScreen__rowIcon"
                          data-tint={s.tint ?? 'slate'}
                        >
                          {s.icon}
                        </span>
                      ) : null}
                      <span className="settingsScreen__rowText">
                        <span className="settingsScreen__rowLabel">{s.label}</span>
                        {s.summary && (
                          <span className="settingsScreen__rowSummary">{s.summary}</span>
                        )}
                      </span>
                      <ChevronRight size={18} className="settingsScreen__rowChevron" />
                    </button>
                  ))}
                  </div>
                </div>
              ))}
            {/* Individual rows the query found, under the pane hits: the
                index knows what every pane holds even before it has ever
                mounted, which is what makes "crossfade" findable from cold.
                Tapping one opens its pane and lights the row. */}
            {query.trim() &&
              (() => {
                const hits = settingsMatching(query).filter((e) =>
                  sections.some((s) => s.id === e.pane),
                );
                if (hits.length === 0) return null;
                const nameOf = (id: string) => sections.find((s) => s.id === id)?.label ?? id;
                return (
                  <div className="settingsScreen__cluster">
                    <div className="settingsScreen__groupLabel">Settings</div>
                    <div className="settingsScreen__rowHits">
                      {hits.map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          className="settingsScreen__rowHit"
                          onClick={() => {
                            drill(e.pane);
                            revealSetting(e.id);
                          }}
                        >
                          <span className="settingsScreen__rowHitLabel">{e.label}</span>
                          <span className="settingsScreen__rowHitWhere">{nameOf(e.pane)}</span>
                          <span className="settingsScreen__rowHitDesc">{e.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            {query.trim() &&
              sections.every((s) => !paneMatches(s, query)) &&
              settingsMatching(query).length === 0 && (
                <Text tone="muted" size="sm" className="settingsScreen__none">
                  Nothing matches “{query.trim()}”.
                </Text>
              )}
          </nav>
        </>
      )}
    </div>
    </SettingsNavContext.Provider>,
    document.body,
  );
}
