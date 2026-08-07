/**
 * @glacier/icons - React Native binding, TEMPORARY PROXY over lucide-react-native.
 *
 * Mirror of `index.ts` for the `react-native` export condition: Metro (device
 * builds) resolves this file, so `import { Search } from '@glacier/icons'` gives
 * the same named glyph, same `size`/`color`/`strokeWidth` API, drawn through
 * react-native-svg instead of the DOM. The web docs never load this file - their
 * resolver has no `react-native` condition, so they stay on `index.ts`.
 *
 * When the generated original icon pack lands, both bindings swap their internals
 * in lockstep and nothing downstream changes.
 */
export * from 'lucide-react-native';
export type { LucideProps as IconProps } from 'lucide-react-native';

// The 212-icon set the kit is building (see ICON-PROMPTS.md), shared verbatim
// with the web binding so the docs gallery previews the same pack on both.
export { ICON_NAMES } from './names.ts';
