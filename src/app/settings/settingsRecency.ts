//! Which settings panes were opened last.
//!
//! Ten panes is fine when the two or three you actually touch float to the
//! top. There is no central settings store to observe writes through - every
//! domain module owns its own key - so recency is recorded where intent is
//! unambiguous and cheap: the moment a pane is opened. Three chips, newest
//! first, and a pane already charted just moves up rather than duplicating.

const KEY = 'attackfm-settings-recent';
const CAP = 3;

export interface RecentPane {
  id: string;
  label: string;
}

export function recentPanes(): RecentPane[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as RecentPane[]) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.id && p.label).slice(0, CAP) : [];
  } catch {
    return [];
  }
}

export function noteSettingsPane(id: string, label: string): void {
  try {
    const next = [{ id, label }, ...recentPanes().filter((p) => p.id !== id)].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Then the chips simply don't learn; the list still works.
  }
}
