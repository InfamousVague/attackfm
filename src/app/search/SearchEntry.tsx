import { SearchField } from '@glacier/react';
import type { Filter } from './searchModel.tsx';

/**
 * The way into search, sitting on the page it searches.
 *
 * Search has been a tab, then a pull-down summons, then a nav icon. Each move
 * was a smaller version of the same question - where does a person look when
 * they want to look something up - and the answer they all missed is that they
 * look at the page they are already on. So the bar lives at the top of Library
 * and Discover: not a place to navigate to, just there, the way it is in every
 * app that gets this right.
 *
 * The field is a picture of a field. It never takes a keystroke - tapping the
 * wrapper hands the whole thing to the search page, where a real one is
 * waiting. That keeps ONE search implementation rather than a small one here
 * and a big one there, and it means a tap cannot raise the keyboard over a
 * page that is about to be replaced.
 *
 * It opens through a listener rather than a prop because Discover is a PLUGIN
 * page - its props are the plugin page contract (onPlay, onOpenArtist), and
 * widening that contract so one button can reach App would make every future
 * plugin page carry a search dependency it does not use.
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

export function SearchEntry({ placeholder, scope }: { placeholder?: string; scope?: Filter }) {
  const text = placeholder ?? 'Search your library';
  return (
    <div
      className="searchEntry"
      role="button"
      tabIndex={0}
      aria-label={text}
      onClick={() => openSearchPage({ scope, placeholder: text })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openSearchPage({ scope, placeholder: text });
        }
      }}
    >
      <SearchField
        className="pageSearch"
        placeholder={text}
        tabIndex={-1}
        aria-hidden="true"
        readOnly
      />
    </div>
  );
}
