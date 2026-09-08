/**
 * Stands the world up: a hub, a registry, a library, three accounts, and the
 * built app on a Range-capable static server.
 *
 * Every E2E suite in this repo runs against REAL binaries. Not a mock hub, not
 * a fixture JSON shim - those exist (see `demo.html`) and they are useful for
 * the hermetic half, but a shim cannot tell you that a stream token expired,
 * that a friend request needs an admin's bearer, or that a seek without a 206
 * lands on zero. Those are the failures this suite is for.
 *
 * Nothing here assumes a port, a path or an order that is not enforced.
 * In particular:
 *
 *   THE FIRST `POST /api/auth/register` BECOMES THE ADMIN, and every later
 *   register needs that admin's bearer ("only an admin can add accounts",
 *   api.rs). A harness that registers three users in parallel gets one account
 *   and two 403s, and then fails every friend, groove and share check
 *   downstream - measured once at 17 failures out of 21, all from this one
 *   line. So: matt first, alone, awaited; then kim and ana with his token.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { writeLibrary } from './fixtures/media.ts';
import { REPO_ROOT, runRoot, worldFile, type World, type WorldUser } from './fixtures/world.ts';

/** The house cadence for "is it up yet": 80 tries, 250 ms apart. Twenty seconds. */
const POLL_TRIES = 80;
const POLL_EVERY_MS = 250;

const log = (line: string) => process.stdout.write(`[e2e] ${line}\n`);

// --- small helpers --------------------------------------------------------

/**
 * A port nobody is on, by asking the kernel for one and giving it back.
 *
 * Racy in principle - something could take it in the gap - and correct in
 * practice, which is the trade every test harness makes. The alternative is a
 * fixed port, which is not racy in principle and collides constantly.
 */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return fail(new Error('no port'));
      const { port } = address;
      probe.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `url` until it answers, then returns. Throws with the log tail if it never does. */
async function waitFor(what: string, url: string, logFile: string): Promise<void> {
  for (let i = 0; i < POLL_TRIES; i += 1) {
    try {
      const reply = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (reply.ok) return;
    } catch {
      // Not up yet. A connection refused during boot is the normal case.
    }
    await sleep(POLL_EVERY_MS);
  }
  throw new Error(
    `e2e: ${what} never answered ${url} after ${(POLL_TRIES * POLL_EVERY_MS) / 1000}s.\n` +
      `--- ${logFile} ---\n${tail(logFile)}`,
  );
}

function tail(file: string, lines = 40): string {
  try {
    const text = spawnSync('tail', ['-n', String(lines), file], { encoding: 'utf8' }).stdout;
    return text ?? '(no output)';
  } catch {
    return '(no output)';
  }
}

/** The newest mtime under a set of directories - "has the source moved since we built?" */
function newestMtime(roots: string[]): number {
  let newest = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(path);
      } else {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          // A file that vanished mid-walk is not newer than anything.
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return newest;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// --- the binaries ---------------------------------------------------------

/**
 * The release hub and registry, built if the source has moved since.
 *
 * `BIN=` and `REGISTRY_BIN=` override, because every scratch harness in this
 * house already takes them and a person reaching for this one should not have
 * to learn a second spelling. An override is trusted as given: if you point it
 * at a binary, that is the binary under test.
 */
function binaries(): { hub: string; registry: string } {
  const overrides = { hub: process.env.BIN, registry: process.env.REGISTRY_BIN };
  const hub = overrides.hub ?? join(REPO_ROOT, 'server/target/release/attackfm-server');
  const registry = overrides.registry ?? join(REPO_ROOT, 'server/target/release/attackfm-registry');

  // An override is trusted as given, and only checked for existing: if you
  // point it at a binary, that is the binary under test, freshness included.
  for (const [name, path, given] of [
    ['BIN', hub, overrides.hub],
    ['REGISTRY_BIN', registry, overrides.registry],
  ] as const) {
    if (given && !existsSync(path)) throw new Error(`e2e: ${name} points at ${path}, which does not exist`);
  }

  const source = newestMtime([join(REPO_ROOT, 'server/src'), join(REPO_ROOT, 'server/crates')]);
  const stale = (path: string, given: string | undefined) => !given && mtimeOf(path) <= source;
  if (!stale(hub, overrides.hub) && !stale(registry, overrides.registry)) {
    const from = overrides.hub || overrides.registry ? 'BIN / REGISTRY_BIN, or ' : '';
    log(`binaries: reusing ${from}the release build (newer than server/src)`);
    return { hub, registry };
  }

  log('binaries: building release (this is the slow part of a cold run)');
  const run = spawnSync('cargo', ['build', '--release', '-p', 'attackfm-server', '-p', 'attackfm-registry'], {
    cwd: join(REPO_ROOT, 'server'),
    stdio: 'inherit',
  });
  if (run.status !== 0) throw new Error('e2e: cargo build --release failed');
  return { hub, registry };
}

/** The built bundle, rebuilt when `src/` has moved since. `AFM_E2E_SKIP_BUILD=1` to trust what is there. */
function bundle(): string {
  const dist = join(REPO_ROOT, 'dist');
  const index = join(dist, 'index.html');
  if (process.env.AFM_E2E_SKIP_BUILD === '1') {
    if (!existsSync(index)) throw new Error(`e2e: AFM_E2E_SKIP_BUILD=1 but there is no ${index}`);
    log('bundle: trusting dist/ (AFM_E2E_SKIP_BUILD=1)');
    return dist;
  }
  const source = newestMtime([join(REPO_ROOT, 'src')]);
  if (mtimeOf(index) > source) {
    log('bundle: reusing dist/ (newer than src/)');
    return dist;
  }
  log('bundle: npm run build');
  const run = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (run.status !== 0) throw new Error('e2e: npm run build failed');
  return dist;
}

// --- the hub's API, spoken directly ---------------------------------------

class HubError extends Error {}

async function api(
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const reply = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await reply.text();
  if (!reply.ok) throw new HubError(`${init.method ?? 'GET'} ${path} -> ${reply.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

interface Account {
  username: string;
  password: string;
}

/** matt is the admin because he is first; the order is the mechanism, not a convention. */
const ACCOUNTS: Account[] = [
  { username: 'matt', password: 'attackfm-e2e-matt' },
  { username: 'kim', password: 'attackfm-e2e-kim' },
  { username: 'ana', password: 'attackfm-e2e-ana' },
];

async function registerEveryone(hubUrl: string): Promise<Record<string, WorldUser>> {
  const users: Record<string, WorldUser> = {};
  let adminToken = '';

  for (const account of ACCOUNTS) {
    // The admin's bearer on every register after the first. Sending it on the
    // first is harmless (there is nobody to be an admin yet), sending it on
    // the rest is the whole difference between three accounts and one.
    const created = (await api(hubUrl, '/api/auth/register', {
      method: 'POST',
      token: adminToken || undefined,
      body: account,
    })) as { id: number; isAdmin: boolean };

    const signedIn = (await api(hubUrl, '/api/auth/login', { method: 'POST', body: account })) as {
      token: string;
      streamToken: string;
      user: { id: number; username: string; isAdmin: boolean };
    };
    if (!adminToken) adminToken = signedIn.token;

    users[account.username] = {
      id: signedIn.user.id ?? created.id,
      username: account.username,
      password: account.password,
      token: signedIn.token,
      streamToken: signedIn.streamToken,
      isAdmin: signedIn.user.isAdmin,
      statePath: '',
    };
    log(`account: ${account.username} (id ${users[account.username]!.id}${signedIn.user.isAdmin ? ', admin' : ''})`);
  }
  return users;
}

/**
 * A full triangle: matt-kim, matt-ana, kim-ana.
 *
 * A request then an accept, because that is the real path - `add_friendship`
 * is not reachable from outside. The accept has to come from the person ASKED
 * ("not your request to answer"), and its id comes back off `GET /api/friends`
 * as an incoming row rather than from the POST, which answers only `ok`.
 */
async function befriend(hubUrl: string, users: Record<string, WorldUser>): Promise<void> {
  const pairs: Array<[string, string]> = [
    ['matt', 'kim'],
    ['matt', 'ana'],
    ['kim', 'ana'],
  ];
  for (const [asker, asked] of pairs) {
    const from = users[asker]!;
    const to = users[asked]!;
    const answer = (await api(hubUrl, '/api/friends/requests', {
      method: 'POST',
      token: from.token,
      body: { username: to.username },
    })) as { friends?: boolean };
    // A crossing ask settles itself; only a filed one needs answering.
    if (answer.friends === true) continue;

    const inbox = (await api(hubUrl, '/api/friends', { token: to.token })) as {
      incoming: Array<{ id: number; userId: number }>;
    };
    const request = inbox.incoming.find((r) => r.userId === from.id);
    if (!request) throw new Error(`e2e: ${asked} never saw ${asker}'s friend request`);
    await api(hubUrl, `/api/friends/requests/${request.id}/accept`, { method: 'POST', token: to.token });
  }
  log('friends: matt-kim, matt-ana, kim-ana');
}

/**
 * Asks for a scan and waits until the hub is holding `want` tracks.
 *
 * Called once per record, which is what spreads `added_at` out into an order -
 * see the note on ALBUMS in fixtures/media.ts. Cheap: a scan of two dozen tiny
 * files is a directory walk and a handful of tag reads.
 */
async function scanUntil(hubUrl: string, token: string, want: number, logFile: string): Promise<void> {
  await api(hubUrl, '/api/scan', { method: 'POST', token });
  for (let i = 0; i < POLL_TRIES * 2; i += 1) {
    const page = (await api(hubUrl, '/api/library?since=0&limit=500', { token })) as {
      tracks?: unknown[];
    };
    if ((page.tracks?.length ?? 0) >= want) return;
    await sleep(POLL_EVERY_MS);
  }
  throw new Error(`e2e: the hub never indexed ${want} tracks.\n--- ${logFile} ---\n${tail(logFile)}`);
}

// --- signed-in storage ----------------------------------------------------

/**
 * A signed-in browser, without touching the sign-in screen.
 *
 * Every suite that is not ABOUT signing in starts inside the app, and the way
 * to do that is the one demo.html already uses: seed `attackfm-server-session`
 * and `attackfm-sessions` before first paint. Playwright's storageState is
 * applied at context creation, which is earlier than any init script and
 * earlier than anything the bundle can run - so the auth gate has never seen
 * a signed-out frame to flash.
 *
 * `attackfm-sessions` is keyed by the NORMALISED url (lower case, no trailing
 * slash - sessions.ts::normalise). A key that does not normalise to itself is
 * a session the app holds and cannot find.
 */
function storageStateFor(user: WorldUser, hubUrl: string, appUrl: string): string {
  const session = {
    url: hubUrl,
    token: user.token,
    streamToken: user.streamToken,
    username: user.username,
    isAdmin: user.isAdmin,
  };
  const key = hubUrl.trim().replace(/\/+$/, '').toLowerCase();
  const entries: Array<[string, string]> = [
    ['attackfm-server-session', JSON.stringify(session)],
    ['attackfm-sessions', JSON.stringify({ byUrl: { [key]: session }, primary: key })],
    // Nothing here should nag: no onboarding, no update sheet, no tour.
    ['attackfm-onboarding-skipped', '1'],
    ['attackfm-verbose-notices', 'false'],
  ];
  return JSON.stringify({
    cookies: [],
    origins: [{ origin: appUrl, localStorage: entries.map(([name, value]) => ({ name, value })) }],
  });
}

// --- the run -------------------------------------------------------------

/**
 * Everything this setup has spawned, so a setup that throws halfway does not
 * leave a hub behind.
 *
 * global-teardown kills by the pids in `world.json`, which only exists once
 * the setup has finished - so a failure between "the hub is up" and "the world
 * is written" would leak a server per attempt, and a suite agent debugging a
 * broken fixture would end the afternoon with a dozen of them.
 */
const spawned: ChildProcess[] = [];

function child(command: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
  const fd = openSync(logFile, 'a');
  const proc = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  // Not detached, deliberately: the children stay in the runner's process
  // group, so a Ctrl-C in the terminal reaches them too.
  proc.unref();
  spawned.push(proc);
  return proc;
}

export default async function globalSetup(): Promise<void> {
  try {
    await stand();
  } catch (e) {
    for (const proc of spawned) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    throw e;
  }
}

async function stand(): Promise<void> {
  const started = Date.now();
  const root = runRoot();
  // A run root is per-run, always. Reusing one means the hub comes up with the
  // last run's database, the last run's accounts and the last run's playlists,
  // and a suite that passes only on the second run is worse than one that fails.
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const dist = bundle();
  const { hub: hubBin, registry: registryBin } = binaries();

  // Made before the hub boots so the music root exists and the boot scan has
  // an empty folder to find rather than a missing one; filled a record at a
  // time once there is somebody to ask for a scan.
  const musicDir = join(root, 'music');
  mkdirSync(musicDir, { recursive: true });

  const [hubPort, registryPort] = await Promise.all([freePort(), freePort()]);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const registryUrl = `http://127.0.0.1:${registryPort}`;

  // Before the spawn, not after: the registry opens its database on the first
  // line of main and a missing parent directory is a boot failure, not a
  // retry.
  mkdirSync(join(root, 'registry'), { recursive: true });
  const registryLog = join(root, 'registry.log');
  const registryProc = child(
    registryBin,
    [],
    {
      AFM_REGISTRY_BIND: '127.0.0.1',
      AFM_REGISTRY_PORT: String(registryPort),
      AFM_REGISTRY_DATA: join(root, 'registry/registry.sqlite3'),
      AFM_REGISTRY_PUBLIC: registryUrl,
    },
    registryLog,
  );
  await waitFor('the registry', `${registryUrl}/health`, registryLog);
  log(`registry: up on ${registryUrl} (pid ${registryProc.pid})`);

  const hubLog = join(root, 'hub.log');
  const hubProc = child(
    hubBin,
    [],
    {
      AFM_BIND: '127.0.0.1',
      AFM_PORT: String(hubPort),
      AFM_DATA_DIR: join(root, 'hub'),
      AFM_MUSIC_DIR: musicDir,
      AFM_SERVER_NAME: 'E2E hub',
      // The boot scan covers the fixture; a timer would re-walk it mid-suite
      // and change `rev` under a test that is asserting on a delta. A suite
      // that adds a file asks for a scan itself (POST /api/scan).
      AFM_SCAN_MINUTES: '0',
      // Without this every invite is rejected as "for a different server",
      // blaming the invite - see memory attackfm-invite-public-url.
      AFM_PUBLIC_URL: hubUrl,
      AFM_REGISTRY_URL: registryUrl,
      // Nothing in a test run should reach out to buy music.
      AFM_IMPORTS: 'off',
      AFM_ASSETS_BAKED: join(REPO_ROOT, 'server/assets/artwork'),
    },
    hubLog,
  );
  await waitFor('the hub', `${hubUrl}/api/server`, hubLog);
  log(`hub: up on ${hubUrl} (pid ${hubProc.pid})`);

  const users = await registerEveryone(hubUrl);
  await befriend(hubUrl, users);

  const token = users.matt!.token;
  const library = await writeLibrary(musicDir, join(root, 'covers'), async (stage) => {
    await scanUntil(hubUrl, token, stage.total, hubLog);
    log(`library: ${stage.label} (${stage.total} files indexed)`);
  });

  // The app last, so its port is the only thing left to learn.
  const appLog = join(root, 'app.log');
  const appProc = spawn(process.execPath, [join(REPO_ROOT, 'e2e/serve.ts'), dist], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', openSync(appLog, 'a')],
  });
  appProc.unref();
  spawned.push(appProc);
  const appPort = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`e2e: the static server never printed a port\n${tail(appLog)}`)), 15_000);
    let buffered = '';
    appProc.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = /^(\d+)\s*$/m.exec(buffered);
      if (line) {
        clearTimeout(timer);
        done(Number(line[1]));
      }
    });
    appProc.once('error', fail);
  });
  const appUrl = `http://127.0.0.1:${appPort}`;
  await waitFor('the app', `${appUrl}/index.html`, appLog);
  log(`app: serving ${dist.replace(`${REPO_ROOT}/`, '')} on ${appUrl} (pid ${appProc.pid})`);

  for (const user of Object.values(users)) {
    user.statePath = join(root, `state-${user.username}.json`);
    writeFileSync(user.statePath, storageStateFor(user, hubUrl, appUrl));
  }

  const world: World = {
    hubUrl,
    registryUrl,
    appUrl,
    users,
    tokens: Object.fromEntries(Object.values(users).map((u) => [u.username, u.token])),
    userIds: Object.fromEntries(Object.values(users).map((u) => [u.username, u.id])),
    library,
    root,
    musicDir,
    pids: { hub: hubProc.pid ?? 0, registry: registryProc.pid ?? 0, app: appProc.pid ?? 0 },
    startedAt: started,
  };

  const file = worldFile();
  writeFileSync(file, JSON.stringify(world, null, 2));
  // Read by the fixtures in every worker process, which inherit this env.
  process.env.AFM_E2E_WORLD = file;
  process.env.AFM_E2E_ROOT = root;
  log(`world: ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
