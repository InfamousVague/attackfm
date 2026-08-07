/**
 * @glacier/icons - TEMPORARY PROXY over lucide-react.
 *
 * The kit's icon surface lives here so every component and app imports icons
 * from ONE place: `import { Search } from '@glacier/icons'`. Today those icons
 * are proxied from lucide-react; when the generated original icon pack lands,
 * we swap the internals of this file to re-export the generated components and
 * nothing downstream changes. Icons take a `size`/`color`, inherit `currentColor`,
 * and size from CSS - the lucide model.
 */
export * from 'lucide-react';
export type { LucideProps as IconProps } from 'lucide-react';

// The 212-icon set the kit is building (see ICON-PROMPTS.md). Used by the docs
// gallery so it previews the real pack, not all ~1500 lucide glyphs.
export { ICON_NAMES } from './names.ts';
