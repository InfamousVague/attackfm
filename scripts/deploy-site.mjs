#!/usr/bin/env node
/**
 * Publish the marketing site to attack.fm.
 *
 * Caddy serves the bare domain straight off /opt/attackfm-site with file_server
 * (the web app shares that root at /listen - see deploy-listen.mjs, and the
 * --exclude below that keeps this publish from deleting it)
 * (see /etc/caddy/Caddyfile), so publishing is: build, back up what is there,
 * rsync the new tree over it.
 *
 * The backup is the point. The page this replaces existed ONLY on the box -
 * nothing in git could reproduce it - so the first deploy is also the only
 * chance to keep a copy of it. Every later deploy keeps one too, because a
 * static site with no rollback is one bad rsync from an empty domain.
 *
 * Credentials come from .env: AFM_DEPLOY_HOST / AFM_DEPLOY_USER / AFM_DEPLOY_PASS.
 * The password is passed to sshpass through the SSHPASS environment variable and
 * never appears in an argument list, where `ps` would show it to any user on the
 * machine.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, 'dist-site');
const REMOTE = '/opt/attackfm-site';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (s) => console.log(`\n\x1b[36m▸\x1b[0m ${bold(s)}`);
const ok = (s) => console.log(`\x1b[32m✓\x1b[0m ${s}`);

function fail(message) {
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
}

function loadEnv() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) {
    fail(`No .env at ${path} (needs AFM_DEPLOY_HOST / AFM_DEPLOY_USER / AFM_DEPLOY_PASS).`);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  for (const key of ['AFM_DEPLOY_HOST', 'AFM_DEPLOY_USER', 'AFM_DEPLOY_PASS']) {
    if (!env[key]) fail(`.env is missing ${key}.`);
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} failed (exit ${result.status ?? 'signal'}).`);
  return result;
}

function ssh(env, script, { capture = false } = {}) {
  const result = spawnSync(
    'sshpass',
    ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}`, script],
    {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) fail(`Remote command failed (exit ${result.status ?? 'signal'}).`);
  return capture ? String(result.stdout ?? '').trim() : '';
}

const env = loadEnv();

if (spawnSync('sshpass', ['-V'], { stdio: 'ignore' }).status !== 0) {
  fail('sshpass is not installed (brew install sshpass).');
}

step('Building the site');
run('npx', ['vite', 'build', '--config', 'vite.site.config.ts'], { cwd: root });

if (!existsSync(resolve(DIST, 'index.html'))) {
  fail(`Build produced no index.html in ${DIST}.`);
}

// Kept for the post-deploy check further down: the built index names the hashed
// bundle, which is how we prove the box is serving THIS build and not a cached
// older one.
const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');

step('Backing up what is on the box');
// Timestamped, so repeated deploys do not overwrite the one good copy. Taken
// from the REMOTE clock: this script may run from a machine in another zone.
const stamp = ssh(env, 'date -u +%Y%m%d-%H%M%S', { capture: true });
ssh(
  env,
  `set -e
   if [ -d ${REMOTE} ]; then
     sudo cp -a ${REMOTE} ${REMOTE}.bak-${stamp}
     echo "  backed up to ${REMOTE}.bak-${stamp}"
     # Keep the three most recent backups; older ones are noise on a small disk.
     ls -1dt ${REMOTE}.bak-* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf
   else
     echo "  nothing at ${REMOTE} yet"
   fi`,
);

step('Publishing');
// --delete so files removed from the build disappear from the box too. rsync
// writes into a staging path this user owns, then the move is done with sudo,
// because /opt is not writable by the deploy account.
const STAGE = `/home/${env.AFM_DEPLOY_USER}/.attackfm-site-stage`;
ssh(env, `rm -rf ${STAGE} && mkdir -p ${STAGE}`);
run(
  'sshpass',
  [
    '-e',
    'rsync',
    '-az',
    '--delete',
    '-e',
    'ssh -o StrictHostKeyChecking=no',
    `${DIST}/`,
    `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:${STAGE}/`,
  ],
  { env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
);
ssh(
  env,
  `set -e
   sudo mkdir -p ${REMOTE}
   # --exclude listen: the web app (deploy-listen.mjs) lives in a subdirectory
   # of this same tree, and --delete would take it with every site publish -
   # attack.fm/listen would 404 until someone noticed and republished it. The
   # two trees share a document root but not a release clock.
   # deadcatbounce is the same arrangement: a separate game, published by its
   # own repo's scripts/deploy.mjs, sharing only this document root.
   sudo rsync -a --delete --exclude 'listen' --exclude 'listen/**' --exclude 'art' --exclude 'art/**' --exclude 'deadcatbounce' --exclude 'deadcatbounce/**' ${STAGE}/ ${REMOTE}/
   sudo chown -R root:root ${REMOTE}
   # Caddy runs as its own user and only needs to read.
   sudo find ${REMOTE} -type d -exec chmod 755 {} +
   sudo find ${REMOTE} -type f -exec chmod 644 {} +
   rm -rf ${STAGE}`,
);

step('Publishing the shared artwork');
// These are one shared body of art, not per-library data, so every install
// reads them from one place. They used to be served by the hub at
// /api/assets - but matt.attack.fm/api now proxies to the home Mac, which
// never received them, so every one of them 404ed for everybody. Serving them
// off the static site fixes that AND removes the last reason for a listener on
// someone else's server to touch Matt's house at all.
//
// /art, NOT /assets. Vite emits the site's own hashed bundle into assets/, so
// the first version of this excluded that directory from the publish and then
// rsynced artwork over it with --delete - which deleted index-*.js and
// index-*.css and served a blank page. The two trees get their own names.
const ART = resolve(root, 'server/assets/artwork');
if (existsSync(ART)) {
  const artStage = `/home/${env.AFM_DEPLOY_USER}/.attackfm-art-stage`;
  ssh(env, `rm -rf ${artStage} && mkdir -p ${artStage}`);
  run(
    'sshpass',
    ['-e', 'rsync', '-az', '--delete', '-e', 'ssh -o StrictHostKeyChecking=no',
     `${ART}/`, `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:${artStage}/`],
    { env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  ssh(
    env,
    `set -e
     sudo mkdir -p ${REMOTE}/art
     sudo rsync -a --delete ${artStage}/ ${REMOTE}/art/
     sudo chown -R root:root ${REMOTE}/art
     sudo find ${REMOTE}/art -type d -exec chmod 755 {} +
     sudo find ${REMOTE}/art -type f -exec chmod 644 {} +
     rm -rf ${artStage}`,
  );
  ok('artwork published to /art');
}

step('Checking it came back');
const status = spawnSync(
  'curl',
  ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '25', 'https://attack.fm'],
  { encoding: 'utf8' },
);
const code = String(status.stdout ?? '').trim();
if (code !== '200') fail(`attack.fm answered ${code}, expected 200.`);

// Prove the bytes on the wire are the ones just built, not a cached older page.
const served = spawnSync('curl', ['-s', '-m', '25', 'https://attack.fm'], { encoding: 'utf8' });
const body = String(served.stdout ?? '');
const built = /src="([^"]*index-[^"]*\.js)"/.exec(html)?.[1];
if (built && !body.includes(built)) {
  fail(`attack.fm is serving a different bundle than was just built (expected ${built}).`);
}

// The page having a 200 is not the same as the page WORKING: it references a
// hashed bundle by name, and a publish that drops it serves a blank screen with
// a perfectly good status code. Ask for the bundle itself.
if (built) {
  const asset = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '25', `https://attack.fm${built.replace(/^\.?/, '')}`],
    { encoding: 'utf8' },
  );
  const assetCode = String(asset.stdout ?? '').trim();
  if (assetCode !== '200') {
    fail(`the page loads but its bundle ${built} answers ${assetCode} - the site would render blank.`);
  }
}

ok(`Deployed. ${dim(built ? `serving ${built}` : '')}`);
console.log(dim(`  rollback: sudo rsync -a --delete ${REMOTE}.bak-${stamp}/ ${REMOTE}/`));
