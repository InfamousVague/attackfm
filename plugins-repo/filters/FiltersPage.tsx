import { useMemo, type CSSProperties } from 'react';
import { Button, Switch, Text } from '@glacier/react';
import { CircleOff, Sparkles } from '@glacier/icons';
import {
  setFxChain,
  setFxChainOn,
  useFxChain,
  type FxNode,
} from '@attackfm/app/fxChain';
import { useServerSession } from '@attackfm/app/serverSession';
import { FAMILIES, FILTERS, PENDING, signature, type Filter } from './filters.ts';

/**
 * Filters: one tap, one whole sound.
 *
 * The other two faces on this chain ask you to build something - Pedals is a
 * board you stack, HiFi Lab is a rack you dial. This one is the opposite move:
 * a shelf of finished looks, chosen by what they sound like rather than by what
 * they are made of. Underneath they are the same fx-chain nodes, so a filter
 * and a pedalboard cannot both be true at once, which is why applying one
 * REPLACES the chain rather than layering on top of it. The page says so.
 */

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

const card = (active: boolean): CSSProperties => ({
  borderRadius: 14,
  border: `1px solid ${active ? 'var(--glacier-accent-9)' : 'var(--glacier-border)'}`,
  background: active
    ? 'color-mix(in oklch, var(--glacier-accent-9) 14%, var(--glacier-bg-surface))'
    : 'var(--glacier-bg-surface)',
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
  transition: 'border-color 160ms ease, background 160ms ease',
});

const iconTile = (active: boolean): CSSProperties => ({
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  width: 34,
  height: 34,
  borderRadius: 10,
  color: active ? 'var(--glacier-accent-contrast)' : 'var(--glacier-accent-11)',
  background: active
    ? 'var(--glacier-accent-9)'
    : 'color-mix(in oklch, var(--glacier-accent-9) 14%, transparent)',
});

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 8,
};

export function FiltersPage() {
  const chain = useFxChain();
  const { session } = useServerSession();

  /**
   * Which filter the chain currently IS, if any.
   *
   * Compared by recipe fingerprint rather than by remembering what was last
   * tapped: the chain is shared with Pedals and HiFi Lab, so it can change
   * under this page entirely. Editing one knob elsewhere should stop the filter
   * claiming to be on, and this is what makes that automatic.
   */
  const activeId = useMemo(() => {
    if (!chain.on || chain.nodes.length === 0) return null;
    const now = signature(chain.nodes.map((n) => ({ t: n.t, params: n.params })));
    return FILTERS.find((f) => signature(f.nodes) === now)?.id ?? null;
  }, [chain]);

  const apply = (filter: Filter) => {
    const nodes: FxNode[] = filter.nodes.map((n) => ({
      t: n.t,
      on: true,
      params: { ...n.params },
      key: freshKey(),
    }));
    setFxChain(nodes, true);
  };

  const clear = () => setFxChain([], false);

  return (
    <div className="homePage">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'var(--glacier-space-4)', maxWidth: 860 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Sparkles size={22} aria-hidden />
          <div style={{ flex: 1 }}>
            <Text weight="bold" size="lg">Filters</Text>
            <Text tone="muted" size="sm">
              One tap puts a whole sound on. Your server renders it; the limiter is always on.
            </Text>
          </div>
          <Switch
            aria-label="Filters on"
            checked={chain.on}
            onCheckedChange={(v: boolean) => setFxChainOn(v)}
          />
        </header>

        {!session && (
          <Text tone="muted" size="sm">
            Filters colour the stream your server encodes. Sign in to a server to hear them.
          </Text>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" onClick={clear} disabled={chain.nodes.length === 0}>
            <CircleOff size={15} />
            No filter
          </Button>
          <Text tone="muted" size="xs">
            A filter replaces whatever is on the board, because there is only one signal path.
          </Text>
        </div>

        {FAMILIES.map((family) => {
          const inFamily = FILTERS.filter((f) => f.family === family);
          if (inFamily.length === 0) return null;
          return (
            <section key={family} aria-label={family} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Text weight="bold" size="sm">{family}</Text>
              <div style={grid}>
                {inFamily.map((filter) => {
                  const active = filter.id === activeId;
                  const Icon = filter.icon;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      style={card(active)}
                      aria-pressed={active}
                      onClick={() => apply(filter)}
                    >
                      <span style={iconTile(active)} aria-hidden>
                        <Icon size={17} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <Text weight="bold" size="sm">{filter.name}</Text>
                        <Text tone="muted" size="xs">{filter.blurb}</Text>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        {/* Named rather than hidden: these are the filters people ask for first,
            and "not yet, and here is why" is more useful than their absence. */}
        <section aria-label="Not yet" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Text weight="bold" size="sm">Not yet</Text>
          <Text tone="muted" size="xs">
            Speed filters need the encoder to change playback rate, which it cannot do yet. The
            player also has to be told the rate, or the seek bar and the time remaining would both
            be wrong.
          </Text>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {PENDING.map((p) => (
              <span
                key={p.name}
                title={p.blurb}
                style={{
                  borderRadius: 999,
                  border: '1px dashed var(--glacier-border)',
                  padding: '4px 10px',
                  opacity: 0.6,
                }}
              >
                <Text tone="muted" size="xs">{p.name}</Text>
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
