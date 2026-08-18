/**
 * Publishes the WEB app to attack.fm/listen.
 *
 * The same app the desktop and phone builds run, served as an ordinary web
 * page from a subdirectory of the marketing site. Caddy already serves
 * /opt/attackfm-site with file_server, so /listen needs no server config at
 * all - a directory there IS the route, and file_server does the
 * trailing-slash redirect itself.
 *
 * Two build details make that work, both set in vite.config.ts:
 *  - `base: './'`, so index.html asks for ./assets/... and the browser
 *    resolves it under /listen/ rather than the domain root.
 *  - AFM_WEB=1, which hashes the entry filename. The app normally ships
 *    STABLE names (the OTA loader has to name a file before it has seen it),
 *    and a stable name served over HTTP is how a returning visitor gets
 *    pinned to a stale bundle forever.
 *
 * Deliberately its own script rather than a flag on deploy-site: the site and
 * the app are different trees on different release clocks, and publishing one
 * must never be able to blow away the other. This writes only inside
 * /opt/attackfm-site/listen, and backs that directory up before it does.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, 'dist');
const REMOTE = '/opt/attackfm-site/listen';
const URL_ = 'https://attack.fm/listen/';

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
            green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const step = (label) => console.log(`\n\x1b[36m▸\x1b[0m ${c.bold(label)}`);
const ok = (m) => console.log(`${c.green('✓')} ${m}`);
function fail(message) {
  console.error(`${c.red('✗')} ${message}`);
  process.exit(1);
}

function loadEnv() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) fail('No .env (needs AFM_DEPLOY_HOST / AFM_DEPLOY_USER / AFM_DEPLOY_PASS).');
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  for (const key of ['AFM_DEPLOY_HOST', 'AFM_DEPLOY_USER', 'AFM_DEPLOY_PASS']) {
    if (!env[key]) fail(`${key} missing from .env`);
  }
  return env;
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (res.status !== 0) fail(`${command} ${args.join(' ')} failed`);
}

function ssh(env, command, { capture = false } = {}) {
  const res = spawnSync(
    'sshpass',
    ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}`, command],
    { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8',
      env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
  );
  if (res.status !== 0) fail(`remote command failed: ${command}`);
  return capture ? String(res.stdout ?? '').trim() : '';
}

const env = loadEnv();

step('Building the web app');
run('npx', ['vite', 'build'], { cwd: root, env: { ...process.env, AFM_WEB: '1' } });

const indexPath = resolve(DIST, 'index.html');
if (!existsSync(indexPath)) fail(`Build produced no index.html in ${DIST}.`);
const html = readFileSync(indexPath, 'utf8');
// The hashed entry proves later that the box is serving THIS build.
const built = /src="\.?\/?(assets\/app-[^"]+\.js)"/.exec(html)?.[1];
if (!built) {
  fail('Built index.html has no hashed app entry - was AFM_WEB=1 honoured by vite.config.ts?');
}

step('Backing up what is on the box');
const stamp = ssh(env, 'date -u +%Y%m%d-%H%M%S', { capture: true });
ssh(
  env,
  `set -e
   if [ -d ${REMOTE} ]; then
     sudo cp -a ${REMOTE} ${REMOTE}.bak-${stamp}
     echo "  backed up to ${REMOTE}.bak-${stamp}"
     ls -1dt ${REMOTE}.bak-* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf
   else
     echo "  nothing at ${REMOTE} yet - first publish"
   fi`,
);

step('Publishing');
const STAGE = `/home/${env.AFM_DEPLOY_USER}/.attackfm-listen-stage`;
ssh(env, `rm -rf ${STAGE} && mkdir -p ${STAGE}`);
run(
  'sshpass',
  ['-e', 'rsync', '-az', '--delete', '-e', 'ssh -o StrictHostKeyChecking=no',
   `${DIST}/`, `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}:${STAGE}/`],
  { env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS } },
);
ssh(
  env,
  `set -e
   sudo mkdir -p ${REMOTE}
   sudo rsync -a --delete ${STAGE}/ ${REMOTE}/
   sudo chown -R root:root ${REMOTE}
   sudo find ${REMOTE} -type d -exec chmod 755 {} +
   sudo find ${REMOTE} -type f -exec chmod 644 {} +
   rm -rf ${STAGE}`,
);

step('Checking it came back');
const code = String(
  spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '25', URL_], { encoding: 'utf8' }).stdout ?? '',
).trim();
if (code !== '200') fail(`${URL_} answered ${code}, expected 200.`);

// The bytes on the wire must be the ones just built.
const body = String(spawnSync('curl', ['-s', '-m', '25', URL_], { encoding: 'utf8' }).stdout ?? '');
if (!body.includes(built)) fail(`${URL_} is serving a different bundle than was just built (expected ${built}).`);

// And the asset itself has to be reachable at the resolved subpath - the one
// thing `base: './'` can get wrong, and it would 404 every visitor.
const assetCode = String(
  spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '25', `https://attack.fm/listen/${built}`],
    { encoding: 'utf8' }).stdout ?? '',
).trim();
if (assetCode !== '200') fail(`the app bundle 404s at /listen/${built} - the base path did not resolve.`);

// Without the trailing slash the relative asset paths would resolve one level
// too high, so the redirect is load-bearing, not cosmetic.
const bare = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '-m', '25',
  'https://attack.fm/listen'], { encoding: 'utf8' });
console.log(`  /listen (no slash) -> ${String(bare.stdout ?? '').trim()}`);

ok(`Published. ${c.dim(`serving ${built}`)}`);
console.log(c.dim(`  rollback: sudo rsync -a --delete ${REMOTE}.bak-${stamp}/ ${REMOTE}/`));
