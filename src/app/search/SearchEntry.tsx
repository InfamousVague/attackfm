import type { Filter } from './searchModel.tsx';

/**
 * The door to the search page, as a call rather than a control.
 *
 * Search has been a tab, then a pull-down summons, then a nav icon, then a bar
 * standing on the pages it searched. It is a SEAT IN THE NAV now, which is
 * where it started and where it belongs: a page you go to, not a box that
 * follows you. The bar that used to sit on Library came off with that move -
 * two doors to one room, one of them a picture of the other's field, and the
 * page underneath paying for the inch.
 *
 * What is left is the ask itself. It travels as an event rather than a prop
 * because the callers are a nav bar and a plugin page, and widening the plugin
 * page contract so one button could reach App would make every future plugin
 * carry a search dependency it does not use.
 */

const OPEN_EVENT = 'afm-open-search';

/**
 * Ask for the search page, optionally scoped.
 *
 * The scope is the whole difference between the two bars. Library's asks
 * "which of mine is this", so it opens on `mine` and never offers a song you
 * would have to fetch first. Discover's asks the opposite, so it opens on
 * `all`. Same page, same rows, same art - one chip apart, because a person
 * searching their own shelves and a person shopping are not doing the same
 * thing and should not have to filter their way out of the wrong one.
 */
export function openSearchPage(open: OpenSearch = {}): void {
  window.dispatchEvent(new CustomEvent<OpenSearch>(OPEN_EVENT, { detail: open }));
}

/** What the bar hands the page: its scope, and its own words. The placeholder
 *  travels because the bar you tapped and the bar you land on are meant to
 *  read as the same bar - swapping the text mid-open is the tell that they
 *  are two components. */
export interface OpenSearch {
  scope?: Filter;
  placeholder?: string;
}

/** App listens once and owns the overlay, as it always has. */
export function onOpenSearchPage(handler: (open: OpenSearch) => void): () => void {
  const fire = (e: Event) => handler((e as CustomEvent<OpenSearch>).detail ?? {});
  window.addEventListener(OPEN_EVENT, fire);
  return () => window.removeEventListener(OPEN_EVENT, fire);
}
