#!/usr/bin/env node
/**
 * One-shot production redeploy for the AttackFM music server.
 *
 *   npm run redeploy            # bump the version, cross-compile, ship, restart
 *   npm run redeploy -- --keep  # re-ship the current version, unbumped
 *   npm run redeploy -- setup   # first run: make the user, dirs, and unit
 *
 * Target credentials come from a gitignored `.env` at the repo root:
 *   AFM_DEPLOY_HOST, AFM_DEPLOY_USER, AFM_DEPLOY_PASS
 *
 * It cross-compiles the Rust server to Linux glibc with cargo-zigbuild (the box
 * has no cargo), ships the binary to /opt/attackfm/bin, and restarts the
 * systemd service. /opt/attackfm/data (the index) and /opt/attackfm/music (the
 * library itself) are never touched, so a redeploy costs listeners nothing but
 * the second it takes to restart.
 *
 * Requires on this machine: node, rsync, sshpass, cargo-zigbuild + zig, and the
 * rustup target x86_64-unknown-linux-gnu. Missing tools are reported up front.
 *
 * Mirrors PrettyCardboard's scripts/redeploy.mjs, which deploys to the same box.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- remote layout ---
const REMOTE_ROOT = '/opt/attackfm';
const BIN_REMOTE = `${REMOTE_ROOT}/bin/attackfm-server`;
const SERVICE = 'attackfm';
const SERVICE_USER = 'attackfm';
// glibc pin, matching the sibling project so one zig install serves both.
const RUST_TARGET = 'x86_64-unknown-linux-gnu.2.35';
const RUST_TARGET_DIR = 'x86_64-unknown-linux-gnu';

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function fail(message) {
  console.error(`\n${c.red('✗')} ${message}\n`);
  process.exit(1);
}

function step(label) {
  console.log(`\n${c.cyan('▸')} ${c.bold(label)}`);
}

/** Parse KEY=VALUE lines; the value is everything after the first '='. */
function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) {
    fail(`No .env at ${path} (needs AFM_DEPLOY_HOST / AFM_DEPLOY_USER / AFM_DEPLOY_PASS).`);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  for (const key of ['AFM_DEPLOY_HOST', 'AFM_DEPLOY_USER', 'AFM_DEPLOY_PASS']) {
    if (!env[key]) fail(`.env is missing ${key}.`);
  }
  return env;
}

function has(tool) {
  return spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} failed (exit ${result.status ?? 'signal'}).`);
  return result;
}

/**
 * Runs a command on the box. The password reaches sshpass through the
 * environment rather than the command line, so it never appears in this
 * machine's process list.
 */
function ssh(env, command, { capture = false } = {}) {
  const args = [
    '-e',
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=20',
    `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}`,
    command,
  ];
  const result = spawnSync('sshpass', args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS },
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`remote command failed: ${command}`);
  return capture ? result.stdout.trim() : '';
}

function scp(env, localPath, remotePath) {
  const result = spawnSync(
    'sshpass',
    [
      '-e',
      'rsync',
      '-az',
      '--progress',
      '-e', 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20',
      localPath,
      `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:${remotePath}`,
    ],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  if (result.status !== 0) fail(`copy to ${remotePath} failed.`);
}

function checkTools() {
  const missing = ['rsync', 'sshpass', 'cargo-zigbuild', 'zig'].filter((t) => !has(t));
  if (missing.length > 0) {
    fail(
      `Missing: ${missing.join(', ')}.\n  brew install rsync sshpass zig && cargo install cargo-zigbuild`,
    );
  }
  const targets = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  if (!String(targets.stdout).includes(RUST_TARGET_DIR)) {
    fail(`Missing rust target.\n  rustup target add ${RUST_TARGET_DIR}`);
  }
}

/**
 * First run only: the service account, the directory tree, and the unit file.
 * Idempotent, so running it twice is harmless.
 *
 * It deliberately does NOT touch the Caddyfile. That file already serves
 * another site on this box, and a script that rewrites somebody's live reverse
 * proxy is a script that eventually takes their other site down. The snippet in
 * deploy/Caddyfile.snippet is there to paste in by hand, once.
 */
function setup(env) {
  step('Preparing the box');
  ssh(
    env,
    [
      `id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home ${REMOTE_ROOT} --shell /usr/sbin/nologin ${SERVICE_USER}`,
      `mkdir -p ${REMOTE_ROOT}/bin ${REMOTE_ROOT}/data ${REMOTE_ROOT}/music`,
      `chown -R ${SERVICE_USER}:${SERVICE_USER} ${REMOTE_ROOT}`,
    ].join(' && '),
  );

  step('Installing the systemd unit');
  scp(env, join(ROOT, 'server/deploy/attackfm.service'), '/etc/systemd/system/attackfm.service');
  ssh(env, `systemctl daemon-reload && systemctl enable ${SERVICE}`);

  console.log(`\n${c.dim('Next: paste server/deploy/Caddyfile.snippet into /etc/caddy/Caddyfile')}`);
  console.log(`${c.dim('(set your hostname), then: systemctl reload caddy')}`);
}

/**
 * Moves the server's version on, so a deploy is identifiable from the outside.
 *
 * The server has always reported `CARGO_PKG_VERSION` over /api/server and
 * /api/stats, and the app has always shown it in About - but nothing ever
 * changed it, so every server that has ever run has said 0.1.0 and the field
 * told you nothing. A version that cannot move is not a version; it is a
 * constant with a version's name.
 *
 * The bump lives here rather than in a separate command because this is the
 * only moment that is definitely a new server build. Both places that build one
 * read the same manifest: this script cross-compiles from the working tree, and
 * the home hub runs `git pull && server/home-install.sh`, so the number has to
 * be COMMITTED for the M4 to agree with the VPS about what it is running.
 *
 * `npm run redeploy -- --keep` re-ships the current version untouched, for when
 * the deploy is a retry rather than a change.
 */
function bumpServerVersion() {
  if (process.argv.includes('--keep')) {
    step('Keeping the server version');
    return readServerVersion();
  }
  const path = join(ROOT, 'server/Cargo.toml');
  const raw = readFileSync(path, 'utf8');
  // The FIRST version key under [package]; a dependency's own version pin must
  // not be what gets rewritten.
  const match = raw.match(/^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/m);
  if (!match) fail('Could not find a version in server/Cargo.toml.');
  const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  writeFileSync(path, raw.replace(match[0], `version = "${next}"`), 'utf8');
  step(`Server version ${match[1]}.${match[2]}.${match[3]} → ${next}`);
  return next;
}

function readServerVersion() {
  const raw = readFileSync(join(ROOT, 'server/Cargo.toml'), 'utf8');
  return raw.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';
}

function deploy(env) {
  const version = bumpServerVersion();
  step('Cross-compiling for Linux');
  run('cargo', ['zigbuild', '--release', '--target', RUST_TARGET], {
    cwd: join(ROOT, 'server'),
  });

  const binary = join(ROOT, 'server/target', RUST_TARGET_DIR, 'release/attackfm-server');
  if (!existsSync(binary)) fail(`Built binary not found at ${binary}.`);

  step('Shipping the binary');
  // To a temp path first, then moved into place: a running binary cannot be
  // written over, and a half-copied one must never be what systemd restarts on.
  scp(env, binary, `${REMOTE_ROOT}/bin/attackfm-server.new`);

  step('Restarting the service');
  ssh(
    env,
    [
      `systemctl stop ${SERVICE} || true`,
      `mv ${REMOTE_ROOT}/bin/attackfm-server.new ${BIN_REMOTE}`,
      `chmod +x ${BIN_REMOTE}`,
      `chown ${SERVICE_USER}:${SERVICE_USER} ${BIN_REMOTE}`,
      `systemctl start ${SERVICE}`,
    ].join(' && '),
  );

  step(`Checking it came back (expecting v${version})`);
  const status = ssh(env, `systemctl is-active ${SERVICE} || true`, { capture: true });
  if (status !== 'active') {
    ssh(env, `journalctl -u ${SERVICE} -n 30 --no-pager || true`);
    fail(`Service is "${status}" after restart.`);
  }
  const health = ssh(
    env,
    `curl -fsS --max-time 10 http://127.0.0.1:8788/api/server || echo UNREACHABLE`,
    { capture: true },
  );
  console.log(`  ${c.dim(health)}`);
  if (health.includes('UNREACHABLE')) fail('Service is running but not answering on 8788.');

  const disk = ssh(env, `df -h ${REMOTE_ROOT} | tail -1`, { capture: true });
  console.log(`\n${c.green('✓')} Deployed. ${c.dim(`disk: ${disk}`)}\n`);
}


/**
 * Publishes the plugin repository: builds every plugin under plugins-repo/
 * and mirrors dist-plugins/ into the directory the server serves at /plugins.
 * No service restart - ServeDir reads the files live.
 */
function deployPlugins(env) {
  step('Building plugin bundles');
  run('node', ['scripts/build-plugins.mjs'], { cwd: ROOT });
  step('Publishing to /plugins');
  const result = spawnSync(
    'sshpass',
    [
      '-e', 'rsync', '-az', '--delete',
      '-e', 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20',
      `${ROOT}/dist-plugins/`,
      `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:/opt/attackfm/data/plugins/`,
    ],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  if (result.status !== 0) fail('plugin publish failed.');
  ssh(env, 'chown -R attackfm:attackfm /opt/attackfm/data/plugins');
  // The public repository rides the same publish: only the plugins marked
  // `"public": true` land on plugins.attack.fm (the build already filtered
  // them into dist-plugins-public/), so the private set never leaves matt's.
  step('Publishing to plugins.attack.fm');
  const pub = spawnSync(
    'sshpass',
    [
      '-e', 'rsync', '-az', '--delete',
      '-e', 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20',
      `${ROOT}/dist-plugins-public/`,
      `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:/opt/attackfm-plugins/`,
    ],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  if (pub.status !== 0) fail('public plugin publish failed.');
  const check = ssh(
    env,
    'curl -fsS --max-time 10 http://127.0.0.1:8788/plugins/index.json | head -c 120 || echo UNREACHABLE',
    { capture: true },
  );
  console.log(`  ${c.dim(check)}`);
  if (check.includes('UNREACHABLE')) fail('/plugins is not answering.');
  console.log(`\n${c.green('\u2713')} Plugin repository published.\n`);
}

/**
 * Publishes the generated artwork set into the server's assets drop folder
 * (/opt/attackfm/data/assets, served at /api/assets). Deliberately NO
 * --delete: it is a drop folder, and pieces added on the box (new
 * generations, overrides) must survive a redeploy. No restart either -
 * ServeDir reads the files live.
 */
function deployAssets(env) {
  const src = `${ROOT}/server/assets/artwork/`;
  if (!existsSync(src)) return;
  step('Publishing artwork to /api/assets');
  const result = spawnSync(
    'sshpass',
    [
      '-e', 'rsync', '-az',
      '-e', 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20',
      src,
      `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:/opt/attackfm/data/assets/`,
    ],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  if (result.status !== 0) fail('artwork publish failed.');
  ssh(env, 'chown -R attackfm:attackfm /opt/attackfm/data/assets');
  console.log(`\n${c.green('✓')} Artwork published.\n`);
}

// The MODE is the first bare word, not simply argv[2]: flags are passed
// through `npm run redeploy -- --keep`, which lands the flag in argv[2] and
// made the one documented flag fail as an unknown mode.
const mode = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'deploy';
const env = loadEnv();
checkTools();

if (mode === 'setup') {
  setup(env);
  deploy(env);
  deployAssets(env);
} else if (mode === 'deploy') {
  deploy(env);
  deployAssets(env);
} else if (mode === 'plugins') {
  deployPlugins(env);
} else if (mode === 'assets') {
  deployAssets(env);
} else {
  fail(`Unknown mode "${mode}". Use: redeploy [setup|plugins|assets]`);
}
