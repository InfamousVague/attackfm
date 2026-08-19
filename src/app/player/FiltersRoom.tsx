import { useMemo, useState } from 'react';
import { Input, SegmentedControl, Switch, Text } from '@glacier/react';
import { CircleOff, Search, X } from '@glacier/icons';
import { setFxChain, useFxChain, useServerFxNodes, type FxNode } from './fxChain.ts';
import { FAMILIES, FILTERS, kindsUsed, signature, type Filter } from './filters.ts';
import { scrollOwner } from './fxEditing.tsx';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * Filters: one tap, one whole sound.
 *
 * The room beside this one asks you to build something - the HiFi rack is a
 * chain you dial box by box. This is the opposite move: a shelf of finished
 * looks, chosen by what they sound like rather than by what they are made of.
 * Underneath they are the same fx-chain nodes rendered by the same encoder,
 * which is exactly why a filter REPLACES the chain rather than layering onto
 * it - there is one signal path, and two ideas of what is on it would be a lie
 * whichever one you believed.
 *
 * This is the popover's third room because it is the one people actually reach
 * for mid-song. A pedalboard is somewhere you go to build a sound; "make this
 * slowed" is a thing you want between one chorus and the next.
 */

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The segment that means "do not filter the shelf". Leading space keeps it
 *  from colliding with a real family name. */
const ALL = ' all';

export function FiltersRoom() {
  const chain = useFxChain();
  const { session } = useServerSession();
  const [family, setFamily] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  /**
   * What this server's encoder actually implements.
   *
   * Null means unknown - a server not reached yet, or one that answered oddly -
   * and unknown reads as SUPPORTED. Marking every filter dead because a fetch
   * failed would be a worse lie than the one this is here to prevent.
   */
  const supported = useServerFxNodes(session?.url);

  /**
   * Which filter the chain currently IS, if any.
   *
   * Compared by recipe fingerprint rather than by remembering what was last
   * tapped: the chain is shared with the HiFi room and the Pedals plugin, so it
   * can change under this room entirely. Turning one knob over there should
   * stop a filter claiming to be on, and this is what makes that automatic.
   */
  const activeId = useMemo(() => {
    if (chain.nodes.length === 0) return null;
    const now = signature(chain.nodes.map((n) => ({ t: n.t, params: n.params })));
    return FILTERS.find((f) => signature(f.nodes) === now)?.id ?? null;
  }, [chain]);

  /** Kinds a filter needs that the server has said it cannot render. */
  const missingFor = (filter: Filter): string[] =>
    supported ? kindsUsed(filter).filter((t) => !supported.has(t)) : [];

  const apply = (filter: Filter, root: HTMLElement | null) => {
    const nodes: FxNode[] = filter.nodes.map((n) => ({
      t: n.t,
      on: true,
      params: { ...n.params },
      key: freshKey(),
    }));
    setFxChain(nodes);
    // Back to the top, where the row that is now lit lives. The shelf runs to
    // thirty-five and tapping from the bottom of it would otherwise leave you
    // with no sign anything happened.
    scrollOwner(root)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of FILTERS) counts.set(f.family, (counts.get(f.family) ?? 0) + 1);
    return [
      { value: ALL, label: `All ${FILTERS.length}` },
      ...FAMILIES.filter((f) => counts.has(f)).map((f) => ({ value: f, label: f })),
    ];
  }, []);

  const searching = query.trim().length > 0;

  /** A query beats the family rather than narrowing it: searching inside one
   *  drawer is how you get "no results" for a filter sitting in the next. */
  const shelf = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return FILTERS.filter(
        (f) => f.name.toLowerCase().includes(q) || f.blurb.toLowerCase().includes(q),
      );
    }
    return family === ALL ? FILTERS : FILTERS.filter((f) => f.family === family);
  }, [family, query]);

  return (
    <div className="fxRoom">
      <div className="fxRoom__head">
        <Text weight="bold" size="sm">
          Filters
        </Text>
        <Text tone="muted" size="xs">
          {activeId ? (FILTERS.find((f) => f.id === activeId)?.name ?? 'on') : 'none'}
        </Text>
      </div>

      {!session && (
        <Text tone="muted" size="xs">
          Filters colour the stream your server encodes, so sign in to hear one.
        </Text>
      )}

      {/* Said once, at the top, because it is the one genuinely surprising
          thing about this room: it does not add to what you built next door. */}
      <div className="fxFilters__clearRow">
        <button
          type="button"
          className="fxFilters__clear"
          disabled={chain.nodes.length === 0}
          onClick={() => setFxChain([])}
        >
          <CircleOff size={14} />
          No filter
        </button>
        <Text tone="muted" size="xs">
          A filter replaces the chain — there is only one signal path.
        </Text>
      </div>

      <div className="fxShelf">
        <div className="fxShelf__filters">
          <div className="fxShelf__search">
            <Search size={14} />
            <Input
              aria-label="Search filters"
              placeholder={`Search ${FILTERS.length} filters`}
              value={query}
              size="sm"
              onChange={(e: { target: { value: string } }) => setQuery(e.target.value)}
            />
            {searching && (
              <button
                type="button"
                className="fxShelf__clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {!searching && (
            <div className="fxShelf__rail">
              <SegmentedControl
                aria-label="Family"
                size="sm"
                value={family}
                options={options}
                onValueChange={setFamily}
              />
            </div>
          )}
        </div>

        {shelf.length === 0 ? (
          <Text tone="muted" size="xs">
            Nothing here matches “{query.trim()}”.
          </Text>
        ) : (
          <ul className="fxShelf__list">
            {shelf.map((filter) => {
              const active = filter.id === activeId;
              const missing = missingFor(filter);
              const unavailable = missing.length > 0;
              const Icon = filter.icon;
              return (
                <li key={filter.id}>
                  <button
                    type="button"
                    className="fxShelf__item"
                    data-active={active ? 'true' : undefined}
                    aria-pressed={active}
                    disabled={unavailable}
                    title={
                      unavailable
                        ? `This server's encoder cannot do ${missing.join(', ')} yet`
                        : undefined
                    }
                    onClick={(e) => apply(filter, e.currentTarget)}
                  >
                    <span className="fxShelf__icon" data-active={active ? 'true' : undefined}>
                      <Icon size={16} />
                    </span>
                    <span className="fxShelf__text">
                      <span className="fxShelf__name">{filter.name}</span>
                      <span className="fxShelf__blurb">
                        {unavailable ? 'Needs a newer server' : filter.blurb}
                      </span>
                    </span>
                    {active && <span className="fxShelf__on">on</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
