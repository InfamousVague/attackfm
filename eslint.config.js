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

  /* WARN, with 12 findings. Every one is a defensive initialiser that both
     arms of the branch below it overwrite - `let url: string | null = null`,
     `let r = -1`, `let h = 0`. Whether the sentinel is dead weight or is the
     line telling the reader what "not found" looks like here is a judgement
     per site, and it belongs with the person reading that module, not with
     the commit that installs the linter. */
  'no-useless-assignment': 'warn',

  /* WARN, with a backlog. `noUnusedLocals` has never been on, so nothing has
     ever said these out loud. The `_` prefixes are the house's own way of
     saying "named for the reader, not for the code".

     This rule must NEVER be extended to unreferenced EXPORTS. Around 207 of
     those exist and they are almost all over-exports used inside their own
     file - plus a handful that are parked on purpose and carry a header
     saying so. A sweep there deletes working, deliberately-kept code. */
  '@typescript-eslint/no-unused-vars': [
    'warn',
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
     - a track id, a room id, a beat's timestamp. Most findings here want an
     annotated disable, not a longer dep array; a few are real. */
  'react-hooks/exhaustive-deps': 'warn',
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
      /* WARN. ~32 files export a component beside something else. The fix is
         usually to move the non-component export into a `.ts` sibling, which
         is a testability win rather than lint appeasement - a pure helper
         that lives beside a 900-line component is a helper nobody can test.
         Context hooks and constants get named exemptions instead. */
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
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
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
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

  /* Scripts that run INSIDE a headless browser page (`page.evaluate` bodies
     and the built-bundle probes) see browser globals, not Node's. */
  {
    files: ['build/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
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
