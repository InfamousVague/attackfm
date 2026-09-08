/**
 * Two things the identity suite needs that the shared world does not carry.
 *
 * 1. THE REGISTRY THE BUNDLE ACTUALLY TALKS TO.
 *
 *    `servers/registry.ts` bakes its base URL in at build time
 *    (`VITE_REGISTRY_URL`, defaulting to https://registry.attack.fm), and
 *    global-setup builds `dist/` BEFORE it has picked the run's registry port -
 *    so the address cannot be handed to the bundle even in principle. The
 *    consequence is that every registry-backed screen in the app - the front
 *    door's account form, invites, recovery codes, the friends graph - points
 *    at production and is untestable as shipped.
 *
 *    So the requests are turned around in the browser instead: any call to the
 *    production registry is answered from `world.registryUrl`, byte for byte,
 *    headers included. `route.continue({ url })` cannot do it (Playwright
 *    refuses a protocol change, and https -> http is one), so the reply is
 *    fetched here and fulfilled. Playwright answers the CORS preflight itself
 *    for a routed request; the local registry's own `allow_origin(Any)` covers
 *    the rest.
 *
 *    A context that is going to hold a registry identity MUST have this
 *    installed before it navigates, or the app quietly reaches the real
 *    internet.
 *
 * 2. A SECOND HUB.
 *
 *    "Add a server" and "what does the library look like with two" cannot be
 *    asked of a world with one, and neither can "switch back". A second hub is
 *    a second copy of the same binary on its own port, its own database and its
 *    own three files - pointed at the SAME registry, which is what makes one
 *    account able to hold both.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { REPO_ROOT, type World } from './world.ts';

/** What the shipped bundle believes the registry is. */
export const BAKED_REGISTRY = 'https://registry.attack.fm';

/**
 * Answer this context's registry calls from the run's own registry.
 *
 * Install it on the context, not the page: the app opens no registry sockets,
 * but it does call from more than one document over a sign-out/reload, and a
 * per-page route would lapse under it.
 */
export async function useLocalRegistry(context: BrowserContext, world: World): Promise<void> {
  await context.route(`${BAKED_REGISTRY}/**`, async (route) => {
    const request = route.request();
    const target = request.url().replace(BAKED_REGISTRY, world.registryUrl);
    const method = request.method();
    let reply: Response;
    try {
      reply = await fetch(target, {
        method,
        headers: request.headers(),
        body: method === 'GET' || method === 'HEAD' ? undefined : (request.postData() ?? undefined),
      });
    } catch (e) {
      // The registry is down, which is a real thing for a suite to assert - so
      // it reads as a failed request rather than as a hung one.
      await route.abort('connectionfailed');
      void e;
      return;
    }
    const body = Buffer.from(await reply.arrayBuffer());
    const headers: Record<string, string> = {};
    reply.headers.forEach((value, name) => {
      // Both are re-derived by the browser from the body we hand over; passing
      // the originals through describes a body that is no longer there.
      if (name === 'content-encoding' || name === 'content-length') return;
      headers[name] = value;
    });
    headers['access-control-allow-origin'] = '*';
    await route.fulfill({ status: reply.status, headers, body });
  });
}

/** Where the app keeps the signed-in central identity (registryKeys.ts). */
export const REGISTRY_SESSION_KEY = 'attackfm-registry-session';

export interface RegistryIdentity {
  token: string;
  account: { id: number; handle: string };
}

/** A minimal client for the run's registry, spoken directly. */
export class RegistryApi {
  constructor(readonly base: string) {}

  async call<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
    const reply = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${reply.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  signup(handle: string, password: string): Promise<RegistryIdentity> {
    return this.call<RegistryIdentity>('/v1/signup', { method: 'POST', body: { handle, password } });
  }

  invite(
    token: string,
    serverUrl: string,
    serverName: string,
    life: { ttlSecs?: number; standing?: boolean; maxUses?: number } = {},
  ): Promise<{ code: string; expiresAt: number }> {
    return this.call('/v1/invites', { method: 'POST', token, body: { serverUrl, serverName, ...life } });
  }
}

/**
 * Put a signed-in central identity in this context before the bundle runs.
 *
 * An init script rather than `storageState`: the storage state files belong to
 * global-setup and are shared with every other suite, and a suite that wants an
 * identity wants it on ONE context rather than on everybody's.
 */
export async function seedIdentity(context: BrowserContext, identity: RegistryIdentity): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key!, value!);
      } catch {
        // A context with no storage is not a case this suite is about.
      }
    },
    [REGISTRY_SESSION_KEY, JSON.stringify({ token: identity.token, account: identity.account })] as const,
  );
}

/**
 * Sign this context into a hub before the bundle runs, and name the device.
 *
 * The same two keys global-setup writes into its storage states, plus the
 * device identity: two contexts of the same browser are two devices to the
 * hub, and they would otherwise both derive the name "Chrome on Mac" - which
 * makes a device picker with two identical rows, and an assertion that cannot
 * say which one it meant.
 *
 * `attackfm-sessions` is keyed by the NORMALISED url (lower case, no trailing
 * slash - sessions.ts::normalise). A key that does not normalise to itself is
 * a session the app holds and cannot find.
 */
export async function seedServerSession(
  context: BrowserContext,
  session: { url: string; token: string; streamToken: string; username: string; isAdmin: boolean },
  device?: { id: string; name: string },
): Promise<void> {
  const key = session.url.trim().replace(/\/+$/, '').toLowerCase();
  await context.addInitScript(
    ([one, set, dev]) => {
      try {
        localStorage.setItem('attackfm-server-session', one!);
        localStorage.setItem('attackfm-sessions', set!);
        localStorage.setItem('attackfm-onboarding-skipped', '1');
        localStorage.setItem('attackfm-verbose-notices', 'false');
        if (dev) {
          localStorage.setItem('attackfm-device-id', dev.id);
          localStorage.setItem('attackfm-device-name', dev.name);
        }
      } catch {
        // A context with no storage is not a case these suites are about.
      }
    },
    [
      JSON.stringify(session),
      JSON.stringify({ byUrl: { [key]: session }, primary: key }),
      device ?? null,
    ] as const,
  );
}

// --- a second hub -----------------------------------------------------------

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

export interface SecondHub {
  url: string;
  /** How many tracks it indexed, so a suite can assert on a sum. */
  tracks: number;
  stop: () => void;
}

/** Everything this module has spawned, so a spec that throws before its
 *  afterAll does not leave a hub running for the rest of the afternoon. */
const spawnedHubs = new Set<ChildProcess>();
process.on('exit', () => {
  for (const proc of spawnedHubs) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/**
 * A second, empty hub on the same registry, holding `records` of the run's
 * fixture music.
 *
 * Empty is the point: a hub with no accounts at all crowns its first registry
 * arrival (registry_auth.rs), so one account can own both boxes without a
 * password ever being typed at the second one.
 */
export async function startSecondHub(world: World, name: string, records = 1): Promise<SecondHub> {
  const bin =
    process.env.BIN ?? join(REPO_ROOT, 'server/target/release/attackfm-server');
  if (!existsSync(bin)) throw new Error(`e2e: no hub binary at ${bin}`);

  // A directory nobody has used before. Playwright discards a worker after a
  // failure and re-runs the file's `beforeAll` in a fresh one; reusing the path
  // would hand the second attempt the first one's database - an "empty" hub
  // that already has an owner, which fails in a way that has nothing to do with
  // whatever went wrong first.
  const slug = `${name.replace(/[^A-Za-z0-9_-]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const root = join(world.root, `hub2-${slug}`);
  const musicDir = join(root, 'music');
  mkdirSync(join(musicDir, 'Music'), { recursive: true });

  // A slice of the run's own library, so the songs are real files with real
  // tags and the second hub's count is something a suite can add up. Copied
  // one ARTIST at a time from inside `Music/`, never the folder itself: the
  // top level is `Music/` beside `Audiobooks/`, and taking it whole would put
  // the entire fixture on both boxes and make the sum below meaningless.
  const artists = readdirSync(join(world.musicDir, 'Music'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .slice(0, records);
  for (const artist of artists) {
    cpSync(join(world.musicDir, 'Music', artist.name), join(musicDir, 'Music', artist.name), {
      recursive: true,
    });
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(bin, [], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      AFM_BIND: '127.0.0.1',
      AFM_PORT: String(port),
      AFM_DATA_DIR: join(root, 'data'),
      AFM_MUSIC_DIR: musicDir,
      AFM_SERVER_NAME: name,
      AFM_SCAN_MINUTES: '0',
      AFM_PUBLIC_URL: url,
      AFM_REGISTRY_URL: world.registryUrl,
      AFM_IMPORTS: 'off',
    },
  });
  proc.unref();
  spawnedHubs.add(proc);

  const stop = () => {
    spawnedHubs.delete(proc);
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  };

  // The same 80 x 250 ms the shared harness waits: twenty seconds is a cold
  // sqlite open and a scan of three files with room to spare.
  let up = false;
  for (let i = 0; i < 80 && !up; i += 1) {
    try {
      const reply = await fetch(`${url}/api/server`, { signal: AbortSignal.timeout(2000) });
      up = reply.ok;
    } catch {
      // Not listening yet.
    }
    if (!up) await sleep(250);
  }
  if (!up) {
    stop();
    throw new Error(`e2e: the second hub (${name}) never answered ${url}/api/server`);
  }

  // The boot scan covers the copied folders; poll the count off the public
  // info rather than guessing at how long a directory walk takes.
  let tracks = 0;
  for (let i = 0; i < 80; i += 1) {
    const info = (await (await fetch(`${url}/api/server`)).json()) as { tracks?: number };
    tracks = info.tracks ?? 0;
    if (tracks > 0) break;
    await sleep(250);
  }
  if (tracks === 0) {
    stop();
    throw new Error(`e2e: the second hub (${name}) indexed nothing from ${musicDir}`);
  }

  return { url, tracks, stop };
}

export interface HubAccount {
  url: string;
  token: string;
  streamToken: string;
  username: string;
  isAdmin: boolean;
}

/**
 * The first account on a hub, which is therefore its admin.
 *
 * The register is allowed to be refused. Playwright discards a worker after a
 * failure and re-runs the file's `beforeAll` in the new one - so on the second
 * pass this hub already has its owner, `register` answers "only an admin can
 * add accounts", and throwing there would replace the real failure with a
 * confusing one from the setup.
 */
export async function firstAccount(hubUrl: string, username: string, password: string): Promise<HubAccount> {
  const post = async (path: string, mayRefuse = false) => {
    const reply = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await reply.text();
    if (!reply.ok && !mayRefuse) throw new Error(`POST ${path} -> ${reply.status} ${text}`);
    return reply.ok && text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  await post('/api/auth/register', true);
  const signedIn = (await post('/api/auth/login')) as {
    token: string;
    streamToken: string;
    user: { username: string; isAdmin: boolean };
  };
  return {
    url: hubUrl,
    token: signedIn.token,
    streamToken: signedIn.streamToken,
    username: signedIn.user.username,
    isAdmin: signedIn.user.isAdmin,
  };
}

// --- watching the Connect session from outside the browser -------------------

/** The hub's own view of the shared session, as `connect.rs` publishes it. */
export interface ConnectState {
  activeDeviceId: string | null;
  trackId: number | null;
  positionMs: number;
  playing: boolean;
  queue: number[];
  epoch: number;
}

/**
 * A third device that only listens.
 *
 * The seat is the hub's fact, not the browser's, and every scenario in the
 * Connect suite is really an assertion about it: who holds it, whether it
 * moved, what the holder says is coming up. Reading it out of a page means
 * reading one device's opinion of it - which is exactly the thing that was
 * wrong in `activeElsewhere`'s history, three different derivations of one
 * fact. So this opens a socket of its own and keeps the last frame the hub
 * sent, and the specs assert against that.
 *
 * It says hello (a socket that has not is in no room and is sent nothing) and
 * never reports state, so it appears in the device list and can never take the
 * seat.
 */
export class ConnectWatch {
  private socket: WebSocket | null = null;
  state: ConnectState | null = null;
  devices: Array<{ id: string; name: string; online: boolean }> = [];

  private constructor(readonly name: string) {}

  static async open(hubUrl: string, streamToken: string, name = 'Watcher'): Promise<ConnectWatch> {
    const watch = new ConnectWatch(name);
    const url = `${hubUrl.replace(/^http/, 'ws')}/api/connect?t=${encodeURIComponent(streamToken)}`;
    const socket = new WebSocket(url);
    watch.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      let frame: { type?: string; state?: ConnectState; devices?: typeof watch.devices };
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch {
        return;
      }
      if (frame.type === 'state' && frame.state) watch.state = frame.state;
      if (frame.type === 'devices' && frame.devices) watch.devices = frame.devices;
    });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('e2e: the connect watcher never opened')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        socket.send(JSON.stringify({ type: 'hello', id: `watch-${name}`, name, kind: 'web' }));
        done();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        fail(new Error('e2e: the connect watcher could not connect'));
      });
    });
    return watch;
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // Already gone.
    }
    this.socket = null;
  }
}
