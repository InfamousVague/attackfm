import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * The lint gate.
 *
 * One base, four scopes. The app, the marketing site, the build scripts and
 * the plugin repository share an author and a house style; three separate
 * configs would drift apart within a month, so the rules live here once and
 * the scopes only say which globals are in the room.
 *
 * Two tiers, on purpose. A rule at `error` is one the tree already satisfies,
 * so turning it on costs nothing today and stops the regression tomorrow. A
 * rule at `warn` is one with a real backlog behind it: it is on so the count
 * is visible and shrinking, and it is not `error` so that a gate exists at all
 * while the backlog is worked off. Warnings ratchet to errors one directory at
 * a time; nothing here is meant to stay a warning.
 *
 * The options below marked LOAD-BEARING are not taste. Each one is the
 * difference between a gate that runs and a gate demanding hundreds of edits
 * to correct code - the counts beside them were measured against this tree.
 */

/* Everything that is not ours to judge. Generated output, vendored dist, and
   build artefacts: linting them says nothing about this repo and editing them
   is lost on the next build.

   `vendor/@glacier` is the sharp one. It is the design kit's PREBUILT dist,
   installed through a `file:` dependency, and any edit there is overwritten
   the next time the kit is rebuilt and copied in. It must never be linted,
   because a lint finding there invites exactly that lost edit. */
const IGNORED = [
  'node_modules/**',
  'vendor/**',
  'dist/**',
  'dist-home/**',
  'dist-plugins/**',
  'dist-plugins-public/**',
  'dist-site/**',
  'src-tauri/gen/**',
  'src-tauri/target/**',
  'server/target/**',
  'site/public/demo-hub/**',
  'site/public/**',
  /* The registry's landing page, minified: built from `src/landing/` by
     `vite.landing.config.ts` and copied in. The source is linted; the copy is
     a 152 kB single line that only costs time to parse. */
  'server/crates/registry/assets/**',
  'store/**',
  'capture/**',
  /* Vitest's coverage output. Belt-and-braces beside the reporter choice in
     `vitest.config.ts`: a stray `coverage/` from an older run must not be
     able to add findings to this gate. */
  'coverage/**',
  'public/**',
  'music/**',
  'docs/**',
];

/**
 * The rules the whole repo keeps, whatever it is written for.
 */
const house = {
  /* NOT load-bearing, and the option is deliberately absent. The 435 empty
     catch blocks in `src/` all carry a comment saying why the failure is the
     expected outcome, and `no-empty` already ignores any block containing a
     comment - measured both ways: with the option removed the whole tree
     still reports 0. Leaving `allowEmptyCatch` on would only have permitted
     an UNcommented empty catch, which is the one thing this house does not
     write. So the rule stands bare and keeps its teeth. */
  'no-empty': 'error',

  /* LOAD-BEARING: 83 `.catch(() => {})`. Fire-and-forget is the house idiom
     for a call whose failure is already handled by not happening. */
  '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],

  /* LOAD-BEARING, and the least obvious of the four. `tsconfig.json` sets
     `noUncheckedIndexedAccess`, which FORCES a `!` on every array and
     regex-group index the surrounding code has already proved safe -
     `named[1]!`, `chapters[i]!`, `full[lo]!`. MEASURED, not estimated:
     turning this rule on yields 208 findings, of which ~168 are exactly that
     index idiom. The other ~40 are not index expressions at all
     (`getElementById('root')!`, `connect.session!`, ~20 `map.get(k)!` - Map
     returns `T | undefined` whatever the compiler flag says), so this rule is
     off for the 168, not for the 40. If the gate is ever tightened, turn it
     on at `warn` and fix those 40; the honest number is 208. */
  '@typescript-eslint/no-non-null-assertion': 'off',

  /* Free: zero `any` in the tree today, in 105,000 lines. */
  '@typescript-eslint/no-explicit-any': 'error',

  /* The two `== null` sites in the tree are deliberate null-or-undefined
     checks, which is the one comparison `==` says better than `===`. */
  eqeqeq: ['error', 'always', { null: 'ignore' }],

  'no-debugger': 'error',
  'no-alert': 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  'no-duplicate-case': 'error',

  /* ERROR, and it was WARN with 12 findings when the linter arrived. Every
     one was a defensive initialiser that both arms of the branch below it
     overwrote - `let url: string | null = null`, `let r = -1`, `let h = 0` -
     and whether a sentinel is dead weight or the line telling the reader what
     "not found" looks like was a judgement per site, made by the people
     reading those modules rather than by the commit that installed the
     linter. They were made; the count is zero; the rule holds it there. */
  'no-useless-assignment': 'error',

  /* ERROR, and the backlog behind it is gone. `noUnusedLocals` has never been
     on, so nothing had ever said these out loud until the linter arrived. The
     `_` prefixes are the house's own way of saying "named for the reader, not
     for the code", and they still are.

     This rule must NEVER be extended to unreferenced EXPORTS. Around 207 of
     those exist and they are almost all over-exports used inside their own
     file - plus a handful that are parked on purpose and carry a header
     saying so. A sweep there deletes working, deliberately-kept code. */
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
};

/**
 * The React rules.
 *
 * LOAD-BEARING: the glob is `**\/*.{ts,tsx}`, not `**\/*.tsx`. The Vite React
 * template scopes this plugin to `.jsx,.tsx`, and copying that here would
 * silently check nothing: 67 plain `.ts` files in `src/` define custom hooks -
 * `useNavStack.ts`, `usePlayerConnect.ts`, `loudness.ts`, `fxChain.ts`,
 * `roomTrack.ts`, `stemsReady.ts`, `navSeats.ts` and dozens more. More than
 * half this app's hooks live outside a `.tsx` file.
 */
const reactRules = {
  /* An error from the day it is switched on. Breaking it is not a style
     opinion - React counts the hooks a component calls and tears the whole
     app down when the number changes between renders. */
  'react-hooks/rules-of-hooks': 'error',

  /* WARN, with the largest backlog in the repo and the most judgement in it.
     The house pattern is deliberate: state is read through a mutable ref
     reassigned every render, and the dep array names only the discontinuities
     - a track id, a room id, a beat's timestamp. Most of the findings wanted
     an annotated disable rather than a longer dep array; a few were real and
     were fixed. At ERROR now the two answers are still both available - what
     is no longer available is leaving one un-made, which is how the hub-switch
     bug in useHomeFeed got in. */
  'react-hooks/exhaustive-deps': 'error',
};

export default tseslint.config(
  { ignores: IGNORED },

  /* The app: browser, React, no type-aware rules.

     Type-aware linting is deliberately OFF - see the note at the foot of this
     file. */
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...house,
      ...reactRules,
      /* ERROR, and this is the one that took the work. 113 findings across 52
         files when the linter arrived: every pure helper living beside a
         900-line component, where no test could reach it. They were moved into
         `.ts` siblings and tested on the way past - ~250 cases came out of that
         move alone - and the context hooks and constant tables that remain get
         the named exemptions below. Zero findings, so it holds the line. */
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          /* The named exemptions the note above promises: a context's own hook,
             and the tables a component is built FROM. Both are the pattern this
             codebase chose - a provider and the hook that reads it are one
             contract and belong in one file, and splitting them would buy a
             faster hot reload with a worse module. Everything NOT on this list
             is a pure helper still to be moved into a `.ts` sibling, which is
             the testability win, and the remaining warnings are that backlog. */
          allowExportNames: [
          'EQ_BANDS', 'EQ_BANDS_NARROW', 'EQ_NARROW_INDICES', 'EQ_PRESETS',
          'EQ_PRESETS_NARROW', 'FACE_GEOMETRY', 'GENRE_DOT', 'GENRE_TONES',
          'HookScopeContext', 'LYRIC_WAYS', 'MOODS', 'SongSelectionContext', 'useAcquire',
          'useAppLocale', 'useAppearance', 'useBuy', 'useConnect', 'useDevicesAvailable',
          'useDiscoverFeed', 'useDiscoverFeedOptional', 'useDjChat', 'useDjPlay',
          'useEqualizer', 'useHasDownloadQueue', 'useIncoming', 'useIncomingFor',
          'useInstaller', 'useJam', 'useJamOptional', 'useJustLanded', 'useLibrary',
          'useLibrarySync', 'useNowPlayingMotion', 'useOwnedTrack', 'usePendingPlay',
          'usePlayNowOptional', 'usePlayback', 'usePlaylists', 'usePluginCommands',
          'usePluginDownloadSources', 'usePluginPages', 'usePluginSettingsSections',
          'usePlugins', 'usePrefetchStatus', 'useQueueControls', 'useRadioOptional',
          'useRefreshNonce', 'useRegistry', 'useRegistryOptional', 'useRepoFeeds', 'useSayNo',
          'useServerSession', 'useSongCount', 'useStemsOut', 'useT',
          ],
        },
      ],
    },
  },

  /* The marketing site. Same shape as the app; its own tsconfig is a later
     phase, so nothing type-aware can run here yet. */
  {
    files: ['site/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...house,
      ...reactRules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },

  /* The plugin repository. Browser and React like the app, but compiled
     straight by esbuild with no `tsc` pass anywhere - so this is the first
     automated check these files have ever had. */
  {
    files: ['plugins-repo/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...house,
      ...reactRules,
      /* A plugin entry file exports its manifest beside its page component by
         design; that is the format, not a mistake. */
      'react-refresh/only-export-components': 'off',
    },
  },

  /* The build and deploy scripts, and the Vite configs. Node, no React, and
     `console` is the whole point of a build script. */
  {
    files: ['scripts/**/*.{mjs,js,ts}', 'build/**/*.mjs', '*.config.{ts,mjs,js}', 'vite.*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      ...house,
      /* tseslint's `eslint-recommended` turns these OFF everywhere, because
         for TypeScript the COMPILER catches them. These scopes are plain
         JS/JSX that `tsc` has never covered (tsconfig `include` is
         ["src", "vite.config.ts"]), so switching them off here would leave
         them checked by nothing at all. Handed back deliberately. */
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-import-assign': 'error',
    },
  },

  /*
   * The end-to-end suite.
   *
   * Node code (it starts a hub, a registry and a static server) that also
   * hands strings to a browser, so it gets Node globals and the same house
   * rules as everything else. It has its own `tsconfig.e2e.json` because the
   * root tsconfig's `include` stops at `src`, and without a scope here the
   * suite would be the one directory in the repo no gate reads at all.
   *
   * Nothing is turned off for it: the one rule that fights Playwright's own
   * `async ({}, use) =>` fixture signature is answered by an annotated
   * disable at the two places that need it, which says more than a blanket
   * exemption would.
   */
  {
    files: ['e2e/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: { ...house },
  },

  /* Scripts that run INSIDE a headless browser page (`page.evaluate` bodies
     and the built-bundle probes) see browser globals, not Node's. */
  {
    files: ['build/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },

  /* The unit-test harness: `src/**\/*.test.{ts,tsx}` and `src/test/`.
     Everything the `src/**` scope above says still applies - this block only
     lifts the three rules that are asking a test file to behave like an
     application file.

     NOTE WHAT IS *NOT* HERE: no `describe`/`it`/`expect` globals. The suite
     runs with `globals: false` (see the note in `vitest.config.ts`), so those
     names are imported from 'vitest' in every test file, and declaring them
     here would only make it possible to write a file that lints clean and
     then dies at run time with "describe is not defined". */
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      /* A stub is allowed to do nothing, and it is not always an arrow: an
         event-listener pair on a fake `MediaQueryList`, a `class` method
         standing in for an API the module only calls, a no-op passed where
         production would pass work. In application code an empty function is
         a question; in a fixture it is the answer. */
      '@typescript-eslint/no-empty-function': 'off',

      /* Fast refresh has no meaning in a file the dev server never loads. A
         test that exports a wrapper component beside a `renderWith()` helper
         is a well-organised test, not a refresh hazard. */
      'react-refresh/only-export-components': 'off',

      /* `renderHook(() => useNavStack())` is the standard way to test a hook,
         and this rule cannot see that Testing Library renders that arrow
         function AS a component - it reads it as a hook called from a plain
         callback and errors. Off here rather than a disable comment on every
         `renderHook` in the suite. */
      'react-hooks/rules-of-hooks': 'off',
    },
  },

  /*
   * The DJ's surfaces use the kit, and only the kit.
   *
   * This was `scripts/check-ai-glacier.mjs`: a lint rule written as a grep,
   * run by hand, over four files. The rule it enforces is real - every
   * control on an AI surface has to be a Glacier component so the theme, the
   * focus ring, the disabled state and the reduced-motion behaviour come from
   * one place rather than being reinvented per button - so it moves here,
   * where it runs on every commit and reads the syntax tree instead of the
   * characters.
   *
   * The script's other half, "the file must import @glacier/react", is not
   * ported: a file with no controls in it has nothing to import, and it was
   * only ever a proxy for the check above.
   */
  {
    files: [
      'src/app/booth/BoothPage.tsx',
      'src/app/booth/DjLauncher.tsx',
      'src/app/booth/DjPage.tsx',
      'src/app/booth/DjTraitSheet.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name=/^(button|input|textarea|select)$/]',
          message:
            'AI surfaces use GlacierUI primitives: Button, TextField, Textarea, Select - not a raw control.',
        },
        {
          selector: "JSXAttribute[name.name='role'][value.value='progressbar']",
          message: 'AI surfaces use the kit\'s Progress rather than a hand-rolled progressbar.',
        },
      ],
    },
  },

  /* DELIBERATELY UNCHANGED for tests: `@typescript-eslint/no-explicit-any`
     stays at `error`. A fixture is the one place `any` does real damage - it
     silently stops the compiler checking the fixture against the shape it is
     pretending to be, so the test goes on passing after the type it models
     has moved on. A test that genuinely needs a malformed input writes
     `as unknown as Track`, which says the same thing, is greppable, and is
     already the house idiom. */
);

/*
 * Type-aware linting: measured, and left off.
 *
 * `@typescript-eslint/no-floating-promises` and its neighbours need a full
 * TypeScript program across ~450 files, one of which is 4,400 lines. That is
 * the single biggest wall-clock cost available to this gate, and it buys
 * roughly four findings here: the house already writes `void` in front of a
 * deliberately unawaited promise in 965 places, so the rule's whole job is
 * already done by convention and by `tsc --noEmit`, which runs beside this in
 * `npm run build`.
 *
 * The measurement is in the Phase 0 report; the short version is that the
 * untyped run finishes in seconds and the typed one does not. If a type-aware
 * rule is ever wanted, scope it to `src/**` alone and re-measure first.
 */
