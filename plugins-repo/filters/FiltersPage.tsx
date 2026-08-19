import { useMemo, type CSSProperties } from 'react';
import { Button, Switch, Text } from '@glacier/react';
import { CircleOff, Sparkles } from '@glacier/icons';
import {
  setFxChain,
  setFxChainOn,
  useFxChain,
  useServerFxNodes,
  type FxNode,
} from '@attackfm/app/fxChain';
import { useServerSession } from '@attackfm/app/serverSession';
import { FAMILIES, FILTERS, kindsUsed, signature, type Filter } from './filters.ts';

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

const card = (active: boolean, unavailable = false): CSSProperties => ({
  opacity: unavailable ? 0.45 : 1,
  cursor: unavailable ? 'not-allowed' : 'pointer',
  borderRadius: 14,
  border: `1px solid ${active ? 'var(--glacier-accent-9)' : 'var(--glacier-border)'}`,
  background: active
    ? 'color-mix(in oklch, var(--glacier-accent-9) 14%, var(--glacier-bg-surface))'
    : 'var(--glacier-bg-surface)',
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
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
   * What this server's encoder actually implements.
   *
   * null means unknown - a server not reached yet, or one that answered oddly -
   * and unknown reads as SUPPORTED. Marking every filter dead because a fetch
   * failed would be a worse lie than the one this is here to prevent.
   */
  const supported = useServerFxNodes(session?.url);

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

  /** Kinds this filter needs that the server has told us it cannot render. */
  const missingFor = (filter: Filter): string[] =>
    supported ? kindsUsed(filter).filter((t) => !supported.has(t)) : [];

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
                  const missing = missingFor(filter);
                  const unavailable = missing.length > 0;
                  const Icon = filter.icon;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      style={card(active, unavailable)}
                      aria-pressed={active}
                      disabled={unavailable}
                      title={
                        unavailable
                          ? `This server's encoder cannot do ${missing.join(', ')} yet`
                          : undefined
                      }
                      onClick={() => apply(filter)}
                    >
                      <span style={iconTile(active)} aria-hidden>
                        <Icon size={17} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <Text weight="bold" size="sm">{filter.name}</Text>
                        <Text tone="muted" size="xs">
                          {unavailable ? 'Needs a newer server' : filter.blurb}
                        </Text>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}


      </div>
    </div>
  );
}
