import { SearchField } from '@glacier/react';

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

/** Ask for the search page. Safe anywhere; nothing happens if App is not up. */
export function openSearchPage(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** App listens once and owns the overlay, as it always has. */
export function onOpenSearchPage(handler: () => void): () => void {
  const fire = () => handler();
  window.addEventListener(OPEN_EVENT, fire);
  return () => window.removeEventListener(OPEN_EVENT, fire);
}

export function SearchEntry({ placeholder }: { placeholder?: string }) {
  return (
    <div
      className="searchEntry"
      role="button"
      tabIndex={0}
      aria-label={placeholder ?? 'Search your library'}
      onClick={openSearchPage}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openSearchPage();
        }
      }}
    >
      <SearchField
        className="pageSearch"
        placeholder={placeholder ?? 'Search your library'}
        tabIndex={-1}
        aria-hidden="true"
        readOnly
      />
    </div>
  );
}
