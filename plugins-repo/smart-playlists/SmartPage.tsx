import { useMemo, useState, type CSSProperties } from 'react';
import { Button, IconButton, Input, Select, Text } from '@glacier/react';
import { ListChecks, Play, Plus, RefreshCw, Trash2, Wand2 } from '@glacier/icons';
import { useLibrary } from '@attackfm/app/library';
import { usePlaylists } from '@attackfm/app/playlists';
import type { PluginPageProps } from '../../src/plugins/types.ts';
import {
  describe,
  evaluate,
  readRules,
  writeRules,
  type Condition,
  type SmartRule,
} from './rules.ts';

const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const row = (gap: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap });
const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 14,
};

const CONDITION_KINDS = [
  { value: 'genre', label: 'Genre has' },
  { value: 'artist', label: 'Artist has' },
  { value: 'album', label: 'Album has' },
  { value: 'title', label: 'Title has' },
  { value: 'addedWithinDays', label: 'Added within (days)' },
  { value: 'shorterThanMin', label: 'Shorter than (min)' },
  { value: 'longerThanMin', label: 'Longer than (min)' },
] as const;

function blankCondition(kind: string): Condition {
  if (kind === 'addedWithinDays') return { kind, days: 30 };
  if (kind === 'shorterThanMin') return { kind, minutes: 4 };
  if (kind === 'longerThanMin') return { kind, minutes: 6 };
  return { kind: kind as 'genre' | 'artist' | 'album' | 'title', value: '' };
}

let counter = 0;
const freshId = () => `sr-${Date.now().toString(36)}-${(counter += 1)}`;

/**
 * The page: existing rules as refreshable cards, and one editor for the rule
 * being written. A rule previews live against the library before it becomes
 * a playlist, so writing one is watching the answer change under your hands.
 */
export function SmartPage({ onPlay }: PluginPageProps) {
  const { tracks } = useLibrary();
  const { playlists, create, addTrack, removeTrack, reorder } = usePlaylists();
  const [rules, setRules] = useState<SmartRule[]>(() => readRules());
  const [draft, setDraft] = useState<SmartRule | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = (next: SmartRule[]) => {
    setRules(next);
    writeRules(next);
  };

  /** Materializes one rule: diffs its playlist to today's answer. */
  const refresh = async (rule: SmartRule): Promise<SmartRule> => {
    const want = evaluate(rule, tracks, Date.now()).map((t) => t.path);
    const existing = rule.playlistId ? playlists.find((p) => p.id === rule.playlistId) : undefined;
    if (!existing) {
      const id = await create(rule.name, want);
      return { ...rule, playlistId: id };
    }
    const wantSet = new Set(want);
    for (const path of existing.paths) if (!wantSet.has(path)) removeTrack(existing.id, path);
    const haveSet = new Set(existing.paths);
    for (const path of want) if (!haveSet.has(path)) addTrack(existing.id, path);
    reorder(existing.id, want);
    return rule;
  };

  const refreshAll = async () => {
    const next: SmartRule[] = [];
    for (const rule of rules) next.push(await refresh(rule));
    save(next);
    setNote(`Refreshed ${next.length} ${next.length === 1 ? 'list' : 'lists'}.`);
  };

  const preview = useMemo(
    () => (draft ? evaluate(draft, tracks, Date.now()) : []),
    [draft, tracks],
  );

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 860, margin: '0 auto' }}>
      <div style={row(10)}>
        <Wand2 size={20} />
        <div style={{ ...stack(2), flex: 1 }}>
          <Text as="h1" size="lg" weight="bold">
            Smart lists
          </Text>
          <Text tone="muted" size="sm">
            Rules that keep playlists current. Refresh re-checks every rule against the library.
          </Text>
        </div>
        {rules.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => void refreshAll()}>
            <RefreshCw size={14} /> Refresh all
          </Button>
        )}
      </div>

      {note && (
        <Text tone="muted" size="sm" role="status">
          {note}
        </Text>
      )}

      {rules.map((rule) => {
        const count = evaluate(rule, tracks, Date.now()).length;
        return (
          <div key={rule.id} style={{ ...panel, ...row(12) }}>
            <ListChecks size={18} />
            <div style={{ ...stack(2), flex: 1, minWidth: 0 }}>
              <Text weight="semibold">{rule.name}</Text>
              <Text tone="muted" size="xs">
                {describe(rule)} · {count} {count === 1 ? 'song' : 'songs'} now
              </Text>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const set = evaluate(rule, tracks, Date.now());
                const first = set[0];
                if (first) onPlay(first, set);
              }}
              disabled={count === 0}
            >
              <Play size={14} /> Play
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh(rule).then((r) => save(rules.map((x) => (x.id === r.id ? r : x))))}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Delete rule ${rule.name}`}
              onClick={() => save(rules.filter((x) => x.id !== rule.id))}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        );
      })}

      {draft ? (
        <div style={{ ...panel, ...stack(12) }}>
          <Input
            value={draft.name}
            placeholder="Name this list"
            aria-label="Rule name"
            onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          />
          <div style={row(8)}>
            <Text size="sm" tone="muted">
              Match
            </Text>
            <Select
              aria-label="Match"
              value={draft.match}
              options={[
                { value: 'all', label: 'every condition' },
                { value: 'any', label: 'any condition' },
              ]}
              onValueChange={(v) => setDraft({ ...draft, match: v === 'any' ? 'any' : 'all' })}
            />
          </div>

          {draft.conditions.map((c, i) => (
            <div key={i} style={row(8)}>
              <Select
                aria-label="Condition kind"
                value={c.kind}
                options={CONDITION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    conditions: draft.conditions.map((x, j) => (j === i ? blankCondition(v) : x)),
                  })
                }
              />
              {'value' in c ? (
                <Input
                  value={c.value}
                  placeholder="…"
                  aria-label="Condition value"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      conditions: draft.conditions.map((x, j) =>
                        j === i ? { ...c, value: e.currentTarget.value } : x,
                      ),
                    })
                  }
                />
              ) : (
                <Input
                  type="number"
                  value={String('days' in c ? c.days : c.minutes)}
                  aria-label="Condition number"
                  onChange={(e) => {
                    const n = Math.max(1, Number.parseInt(e.currentTarget.value, 10) || 1);
                    setDraft({
                      ...draft,
                      conditions: draft.conditions.map((x, j) =>
                        j === i ? ('days' in c ? { ...c, days: n } : { ...c, minutes: n }) : x,
                      ),
                    });
                  }}
                />
              )}
              <IconButton
                variant="ghost"
                size="sm"
                aria-label="Remove condition"
                onClick={() =>
                  setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })
                }
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
          <div style={row(8)}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, blankCondition('genre')] })}
            >
              <Plus size={14} /> Condition
            </Button>
            <div style={{ flex: 1 }} />
            <Text size="sm" tone="muted">
              Keep newest
            </Text>
            <Input
              type="number"
              aria-label="Limit"
              value={draft.limit === null ? '' : String(draft.limit)}
              placeholder="all"
              onChange={(e) => {
                const n = Number.parseInt(e.currentTarget.value, 10);
                setDraft({ ...draft, limit: Number.isFinite(n) && n > 0 ? n : null });
              }}
            />
          </div>

          <Text tone="muted" size="sm">
            Catches {preview.length} {preview.length === 1 ? 'song' : 'songs'} right now
            {preview.length > 0 ? ` — first: ${preview[0]!.title} by ${preview[0]!.artist}` : ''}.
          </Text>

          <div style={row(8)}>
            <Button
              variant="solid"
              disabled={draft.name.trim() === ''}
              onClick={() => {
                void refresh({ ...draft, name: draft.name.trim() }).then((made) => {
                  save([...rules, made]);
                  setDraft(null);
                  setNote(`"${made.name}" is live.`);
                });
              }}
            >
              Create list
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={() =>
            setDraft({
              id: freshId(),
              name: '',
              match: 'all',
              conditions: [blankCondition('genre')],
              limit: 50,
              sort: 'newest',
              playlistId: null,
            })
          }
        >
          <Plus size={15} /> New smart list
        </Button>
      )}
    </div>
  );
}
