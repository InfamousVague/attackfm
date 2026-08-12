/**
 * The rule model and its evaluator: a smart playlist is a saved query over
 * the library plus the id of the ordinary playlist it materializes into.
 * Evaluation is pure - tracks in, paths out - so the page can preview a rule
 * before it ever touches a playlist, and a refresh is just re-running the
 * same function against today's library.
 */
import type { Track } from '@attackfm/app/tauri';

export type Condition =
  | { kind: 'genre'; value: string }
  | { kind: 'artist'; value: string }
  | { kind: 'album'; value: string }
  | { kind: 'title'; value: string }
  | { kind: 'addedWithinDays'; days: number }
  | { kind: 'shorterThanMin'; minutes: number }
  | { kind: 'longerThanMin'; minutes: number };

export interface SmartRule {
  id: string;
  name: string;
  /** all = every condition must hold; any = one is enough. */
  match: 'all' | 'any';
  conditions: Condition[];
  /** Newest-first cap, null for everything that matches. */
  limit: number | null;
  sort: 'newest' | 'title' | 'artist';
  /** The ordinary playlist this rule fills, once materialized. */
  playlistId: string | null;
}

const KEY = 'attackfm-smart-playlists';

export function readRules(): SmartRule[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as SmartRule[]).filter((r) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeRules(rules: SmartRule[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rules));
  } catch {
    // Storage refused it; the rules still apply this session.
  }
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.trim().toLowerCase());

function holds(track: Track, c: Condition, now: number): boolean {
  switch (c.kind) {
    case 'genre':
      return has(track.genre, c.value);
    case 'artist':
      return has(track.artist, c.value);
    case 'album':
      return has(track.album, c.value);
    case 'title':
      return has(track.title, c.value);
    case 'addedWithinDays':
      return now - track.addedAt < c.days * 24 * 60 * 60 * 1000;
    case 'shorterThanMin':
      return track.duration !== null && track.duration < c.minutes * 60;
    case 'longerThanMin':
      return track.duration !== null && track.duration > c.minutes * 60;
  }
}

/** Runs a rule against the library. Pure; the page previews with this too. */
export function evaluate(rule: SmartRule, tracks: readonly Track[], now: number): Track[] {
  const usable = rule.conditions.filter((c) => !('value' in c) || c.value.trim() !== '');
  let matched =
    usable.length === 0
      ? [...tracks]
      : tracks.filter((t) =>
          rule.match === 'all' ? usable.every((c) => holds(t, c, now)) : usable.some((c) => holds(t, c, now)),
        );
  if (rule.sort === 'newest') matched.sort((a, b) => b.addedAt - a.addedAt);
  if (rule.sort === 'title') matched.sort((a, b) => a.title.localeCompare(b.title));
  if (rule.sort === 'artist') matched.sort((a, b) => a.artist.localeCompare(b.artist));
  if (rule.limit !== null && rule.limit > 0) matched = matched.slice(0, rule.limit);
  return matched;
}

export function describe(rule: SmartRule): string {
  const parts = rule.conditions
    .map((c) => {
      switch (c.kind) {
        case 'genre':
          return c.value && `genre has "${c.value}"`;
        case 'artist':
          return c.value && `artist has "${c.value}"`;
        case 'album':
          return c.value && `album has "${c.value}"`;
        case 'title':
          return c.value && `title has "${c.value}"`;
        case 'addedWithinDays':
          return `added in the last ${c.days}d`;
        case 'shorterThanMin':
          return `under ${c.minutes}m`;
        case 'longerThanMin':
          return `over ${c.minutes}m`;
      }
    })
    .filter(Boolean);
  const glue = rule.match === 'all' ? ' and ' : ' or ';
  const what = parts.length > 0 ? parts.join(glue) : 'everything';
  return rule.limit ? `${what} · newest ${rule.limit}` : what;
}
