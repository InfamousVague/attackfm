/**
 * Types for the plain-JavaScript helper beside this file.
 *
 * `vite.config.ts` imports it, and the root tsconfig checks that file - so
 * without a declaration the build fails on an implicit `any` rather than on
 * anything real. The helper stays `.mjs` because the two scripts that share it
 * are scripts, and nothing in `scripts/` is compiled.
 */
export declare const REPORT_PATH: string;

/** The short SHA the report should carry, or null outside a git checkout. */
export declare function reportCommit(cwd?: string): string | null;
