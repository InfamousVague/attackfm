/**
 * The walkthrough, as data.
 *
 * A step is a place in the app and a sentence about it. Everything else - the
 * cutout, the callout, the counter, Back and Next - is the kit's `Spotlight`,
 * so this file stays the part a person would actually want to edit.
 *
 * `target` is a CSS selector rather than a ref, and that is the whole reason
 * the tour can span the app. The kit takes a `RefObject`, which works when the
 * highlighted thing is a sibling; these targets are a nav tab, a shelf on one
 * page and the player on another, and threading refs out of five subtrees to
 * one component would be a worse tour than no tour. The host resolves the
 * selector when the step opens - see TourHost for why it has to wait.
 *
 * `tab` is where the step lives. The host switches to it before looking for
 * the target, which is what lets a tour walk from the library to the booth.
 */
export interface TourStep {
  id: string;
  /** Which tab to be on. Omitted means "wherever we already are". */
  tab?: string;
  /** CSS selector for the thing being pointed at. */
  target: string;
  title: string;
  body: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'library',
    tab: 'library',
    target: '.libChips',
    title: 'Your library, four doors',
    body: 'Everything you own, everything you liked, what you keep going back to, and a DJ that builds a set out of your taste.',
    placement: 'bottom',
  },
  {
    id: 'search',
    tab: 'library',
    target: '.searchEntry',
    title: 'Find anything',
    body: 'One search across songs, albums, artists and genres. It forgives typos, and it remembers what you looked for last.',
    placement: 'bottom',
  },
  {
    id: 'discover',
    target: '[data-tour="nav-discover"]',
    title: 'Discover',
    body: 'Mixes built from what you have been playing, plus anything your plugins bring in. Open one and you can save a copy to your own playlists.',
    placement: 'top',
  },
  {
    id: 'booth',
    target: '[data-tour="nav-booth"]',
    title: 'The booth',
    body: 'Where a song stops being a recording: stems you can pull out, effects, a platter you can scratch.',
    placement: 'top',
  },
  {
    id: 'player',
    target: '.playerBarShell',
    title: 'The player',
    body: 'Tap the artwork for the full screen. The sound console lives here too - levels, filters and the stem faders.',
    placement: 'top',
  },
  {
    id: 'more',
    target: '[data-tour="nav-more"]',
    title: 'Everything else',
    body: 'Downloads, stats, your plugins and settings. The tour lives in Settings too, if you want it again.',
    placement: 'top',
  },
];
