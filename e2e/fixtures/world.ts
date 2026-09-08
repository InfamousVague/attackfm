/**
 * What global-setup hands the suites.
 *
 * One JSON file, written once per run, read by every worker. Nothing here is
 * a constant: the ports are whatever was free, the tokens are whatever the hub
 * minted, and the run root is wherever `AFM_E2E_ROOT` said. A suite that
 * hard-codes 8788 is a suite that fails the first time two runs overlap.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LibraryManifest } from './media.ts';

/** `<repo>/e2e`. */
export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `<repo>`. */
export const REPO_ROOT = resolve(E2E_DIR, '..');

/**
 * Everything a run puts on disk: the hub's database, the generated library,
 * the process logs, the storage states. Deleting it is what "a cold e2e
 * directory" means, and the harness must rebuild all of it from nothing.
 */
export function runRoot(): string {
  return resolve(process.env.AFM_E2E_ROOT ?? join(E2E_DIR, '.run'));
}

export function worldFile(): string {
  return process.env.AFM_E2E_WORLD ?? join(runRoot(), 'world.json');
}

export interface WorldUser {
  /** The hub's own user id, which is what /api/friends and the groove wire speak. */
  id: number;
  username: string;
  /** Registered with it, in case a suite wants to sign in through the UI. */
  password: string;
  /** A hub session bearer. The first user registered is the admin. */
  token: string;
  /** `user.epoch.expiry.sig` - what a media URL carries as `?t=`. */
  streamToken: string;
  isAdmin: boolean;
  /** A Playwright storageState file that boots the app signed in as this user. */
  statePath: string;
}

export interface World {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  hubUrl: string;
  registryUrl: string;
  /** Where the BUILT bundle is served from. This is the app under test. */
  appUrl: string;
  users: Record<string, WorldUser>;
  /** Bearer per username, the shape §3.3 asks for. */
  tokens: Record<string, string>;
  userIds: Record<string, number>;
  library: LibraryManifest;
  root: string;
  musicDir: string;
  /** Everything global-teardown has to kill, and nothing it did not start. */
  pids: { hub: number; registry: number; app: number };
  startedAt: number;
}

let cached: World | null = null;

/** The world this run stood up. Throws if global-setup has not run. */
export function readWorld(): World {
  if (cached) return cached;
  const file = worldFile();
  try {
    cached = JSON.parse(readFileSync(file, 'utf8')) as World;
  } catch (e) {
    throw new Error(
      `e2e: no world at ${file}. global-setup writes it; run through ` +
        `\`npx playwright test\` rather than importing a spec directly.\n${String(e)}`,
    );
  }
  return cached;
}
