# Translating a string in this app

Read this before converting anything. It exists because the sweep is being done
by many hands across many files, and the ways of getting it *subtly* wrong all
compile, pass typecheck, and only show up in a language nobody here reads.

## The call

```tsx
const t = useT();                       // src/app/i18n/LocaleShell.tsx
<Text>{t('library.likedSongs')}</Text>
```

Outside a component — a notification body, a helper in a `.ts` file:

```ts
import { translate } from '../i18n/LocaleShell.tsx';
translate('notices.aSong')
```

`translate` is **not reactive**. It reads the language at the moment it is
called and nothing re-runs when that changes. Right for a string handed to the
OS, wrong for one on screen. Anything inside a render uses `useT()`.

## Keys

`namespace.camelCaseName` — namespace is the app area (`player`, `settings`,
`library`, `profile`, `servers`, `downloads`, `playlists`, `notices`, `nav`,
`common`, `booth`, `search`, `discover`, `books`). Name the string by what it
MEANS, not what it says: `library.empty`, not `library.noMusicInYourLibrary`.
A key survives a copy edit; a key made of the words does not.

`common.*` is for words that genuinely recur with one meaning — Cancel, Done,
Remove, Undo. Do not put a word there because it is short. "Play" on a button
and "Play" as a column heading can need different words in German.

## Counting things — never a ternary

```tsx
n === 1 ? 'song' : 'songs'      // NO
t('library.songCount', { count: n })   // yes
```

The ternary is English grammar written in TypeScript: it asserts a language has
two number forms with the boundary at one. Arabic has six forms with boundaries
at 0, 1, 2, 3–10 and 11–99; Japanese has one. Write `_one`/`_other` in
`en.json` and i18next picks the form through `Intl.PluralRules`.

There is already `useSongCount()` for the commonest case.

## Sentences with a hole in them

```tsx
Still reading your library — {count} songs.     // NO: three fragments
<Trans i18nKey="library.stillReading" values={{ count }} />   // yes: one entry
```

Fragments cannot be reordered, and word order is the first thing that differs
between languages. One sentence, one key, the hole named inside it:
`"stillReading": "Still reading your library — {{count}} songs."`

## Numbers, dates, sizes, "3 days ago"

Never through the catalogue — `ux/format.ts`. `formatNumber`, `formatBytes`,
`formatTotal`, `formatDate`, `formatAgo`. Intl already knows the unit names in
every locale, and it knows things a catalogue entry gets wrong: which side of
the number the unit sits, how thousands are grouped, and that Arabic counts
"3 days" with a different word than "11 days".

`formatClock` (mm:ss) stays in Latin digits on purpose — see the comment there.

## Tables at module scope are a trap

```ts
export const ROWS = [{ label: 'Crossfade' }];      // NO
```

Evaluated at import, before any provider exists. Translate it there and the app
is stuck in whatever language it booted in, and the picker silently does
nothing. Two ways out:

```ts
export const ROWS = [{ labelKey: 'settings.crossfade' }];   // resolve at render
export const buildRows = (t) => [{ label: t('settings.crossfade') }];
```

Prefer the key. It keeps the table a plain data structure.

## Strings that must stay English

Some strings are **matched on** — they are identifiers wearing a label's
clothes, and translating one breaks the app silently in a language nobody is
testing.

- station `filter` syntax: `artist:…`, `genre:…`, `unplayed`
- DJ mood `seed` values (the `label` beside them IS translatable)
- the `Charts` and `New music` folder and playlist names
- `src/app/api/**` — request shapes, header names
- `src/app/core/tauri.ts` — command names
- `src/app/diag/**` — developer log lines, never on screen
- anything compared with `===`, used as an object key, or written to storage

The rule: **if any code anywhere compares the string, it is not prose.**

`CHANGELOG.md` also stays English. It ships in-app (`settings/WhatsNew.tsx`),
but it is release notes — ~800 lines of historical product copy that grows
every ship, and translating it means re-opening translation on every release.

## Checking your work

```
npm run typecheck
npm run i18n:scan -- --file src/app/whatever/File.tsx    # should print nothing
npm run i18n:check                                        # catalogue parity
```
