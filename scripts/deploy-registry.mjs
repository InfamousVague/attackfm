#!/usr/bin/env node
/**
 * Deploy the registry - the box that serves OTA updates.
 *
 *   npm run redeploy:registry           # cross-compile, back up, ship, restart, verify
 *   npm run redeploy:registry -- --dry  # say what would happen, touch nothing
 *
 * `npm run redeploy` ships ONLY attackfm-server. The registry is its own
 * binary and its own systemd unit, so a registry change deployed with that
 * command silently does nothing and the endpoint keeps answering from the old
 * one. This is the missing half.
 *
 * What it serves is worth being careful about: `registry.attack.fm/v1/app/*`
 * is where every installed app asks for its OTA bundle, and `/v1/*` is the
 * account directory for every user. It is not a service that can be down for
 * a few minutes while somebody works out what went wrong.
 *
 * So the two failure modes that have actually happened are designed out:
 *
 *   1. Shipping a macOS binary. `cargo build --release` on this machine
 *      produces arm64 Mach-O; the box is x86-64 Linux. systemd reports
 *      203/EXEC, "Exec format error", and the registry stays DOWN. This
 *      cross-compiles like redeploy.mjs does AND runs `file` on the result,
 *      refusing to ship anything that is not an ELF x86-64.
 *   2. No way back. The old binary is copied to .prev before the new one lands,
 *      and if the restart or the health check fails, .prev is put back and the
 *      service restarted again automatically. A deploy that goes wrong ends
 *      with the registry up on the previous build rather than with an operator
 *      reading journalctl at speed.
 *
 * Credentials come from the same gitignored .env as redeploy.mjs:
 *   AFM_DEPLOY_HOST, AFM_DEPLOY_USER, AFM_DEPLOY_PASS
 *
 * Requires here: node, rsync, sshpass, cargo-zigbuild + zig, and the rustup
 * target x86_64-unknown-linux-gnu.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- remote layout (see attackfm-registry.service on the box) ---
const REMOTE_ROOT = '/opt/attackfm';
const BIN_REMOTE = `${REMOTE_ROOT}/bin/attackfm-registry`;
const SERVICE = 'attackfm-registry';
const SERVICE_USER = 'attackfm';
const PORT = 8795;
const PUBLIC_HEALTH = 'https://registry.attack.fm/v1/app/bundle';
/** `-p`, not `--bin`: cargo answers "no bin target named ... in default-run
 *  packages" for this workspace member. */
const CRATE = 'attackfm-registry';
const RUST_TARGET = 'x86_64-unknown-linux-gnu.2.35';
const RUST_TARGET_DIR = 'x86_64-unknown-linux-gnu';

const DRY = process.argv.slice(2).includes('--dry');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
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
  return spawnSync('which', [tool], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} failed (exit ${result.status ?? 'signal'}).`);
  return result;
}

/** The password reaches sshpass through the environment rather than the
 *  command line, so it never appears in this machine's process list. */
function ssh(env, command, { capture = false, allowFail = false } = {}) {
  const result = spawnSync(
    'sshpass',
    [
      '-e',
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=20',
      `${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST}`,
      command,
    ],
    {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0 && !allowFail) fail(`remote command failed: ${command}`);
  return capture ? String(result.stdout ?? '').trim() : '';
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
    { stdio: 'inherit', env: { ...process.env, SSHPASS: env.AFM_DEPLOY_PASS }, encoding: 'utf8' },
  );
  if (result.status !== 0) fail(`rsync to ${remotePath} failed.`);
}

function checkTools() {
  const missing = ['rsync', 'sshpass', 'cargo-zigbuild', 'zig'].filter((t) => !has(t));
  if (missing.length > 0) {
    fail(`Missing: ${missing.join(', ')}.\n  brew install rsync sshpass zig && cargo install cargo-zigbuild`);
  }
  const targets = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  if (!String(targets.stdout).includes(RUST_TARGET_DIR)) {
    fail(`Missing rust target.\n  rustup target add ${RUST_TARGET_DIR}`);
  }
}

/** Roll back to the binary we saved a moment ago, then report why. */
function rollback(env, why) {
  console.error(`\n${c.yellow('!')} ${why} - rolling back to the previous binary.`);
  ssh(
    env,
    [
      `systemctl stop ${SERVICE} || true`,
      `cp -a ${BIN_REMOTE}.prev ${BIN_REMOTE}`,
      `systemctl start ${SERVICE}`,
    ].join(' && '),
    { allowFail: true },
  );
  const back = ssh(env, `systemctl is-active ${SERVICE} || true`, { capture: true, allowFail: true });
  if (back === 'active') {
    fail(`${why}\n  Rolled back; the registry is up on the PREVIOUS build.`);
  }
  fail(
    `${why}\n  ${c.red('THE ROLLBACK ALSO FAILED - the registry is DOWN.')}\n` +
      `  ssh ${env.AFM_DEPLOY_USER}@${env.AFM_DEPLOY_HOST} 'journalctl -u ${SERVICE} -n 40 --no-pager'`,
  );
}

function deploy(env) {
  step('Cross-compiling the registry for Linux');
  if (!DRY) {
    run('cargo', ['zigbuild', '--release', '--target', RUST_TARGET, '-p', CRATE], {
      cwd: join(ROOT, 'server'),
    });
  }

  const binary = join(ROOT, 'server/target', RUST_TARGET_DIR, 'release', CRATE);
  if (!DRY && !existsSync(binary)) fail(`Built binary not found at ${binary}.`);

  step('Checking it is actually a Linux binary');
  if (!DRY) {
    const kind = String(spawnSync('file', ['-b', binary], { encoding: 'utf8' }).stdout ?? '').trim();
    console.log(`  ${c.dim(kind)}`);
    // The whole reason this check exists: a plain `cargo build` here yields a
    // Mach-O arm64 binary that systemd cannot exec, and the failure only shows
    // up as the registry being down.
    if (!/ELF 64-bit/.test(kind) || !/x86-64/.test(kind)) {
      fail(`That is not an x86-64 ELF binary - refusing to ship it.\n  file says: ${kind}`);
    }
  }

  if (DRY) {
    console.log(`\n${c.yellow('dry run')} would ship ${binary}\n  -> ${env.AFM_DEPLOY_HOST}:${BIN_REMOTE}\n  then restart ${SERVICE} and check ${PUBLIC_HEALTH}\n`);
    return;
  }

  step('Backing up the binary that is running now');
  // Copied, not moved: until the new one is in place the old one is still the
  // thing serving requests.
  ssh(env, `cp -a ${BIN_REMOTE} ${BIN_REMOTE}.prev`, { allowFail: true });

  step('Shipping');
  // Land beside the target first - a running binary cannot be written over,
  // and a half-copied one must never be what systemd restarts on.
  scp(env, binary, `${BIN_REMOTE}.new`);

  step('Restarting');
  ssh(
    env,
    [
      `systemctl stop ${SERVICE} || true`,
      `mv ${BIN_REMOTE}.new ${BIN_REMOTE}`,
      `chmod +x ${BIN_REMOTE}`,
      `chown ${SERVICE_USER}:${SERVICE_USER} ${BIN_REMOTE}`,
      `systemctl start ${SERVICE}`,
    ].join(' && '),
  );

  step('Checking it came back');
  const status = ssh(env, `systemctl is-active ${SERVICE} || true`, { capture: true, allowFail: true });
  if (status !== 'active') {
    ssh(env, `journalctl -u ${SERVICE} -n 30 --no-pager || true`, { allowFail: true });
    rollback(env, `Service is "${status}" after restart.`);
  }

  const local = ssh(
    env,
    `curl -fsS --max-time 10 http://127.0.0.1:${PORT}/v1/app/bundle >/dev/null && echo OK || echo UNREACHABLE`,
    { capture: true, allowFail: true },
  );
  if (!local.includes('OK')) {
    rollback(env, `Running but not answering on ${PORT}.`);
  }

  step('Checking the OTA endpoint the apps actually ask');
  // Through Caddy and the public name, because that is the path a phone takes;
  // answering on localhost proves the process, not the service.
  const version = ssh(
    env,
    `curl -fsS --max-time 15 ${PUBLIC_HEALTH} | head -c 400 || echo UNREACHABLE`,
    { capture: true, allowFail: true },
  );
  if (version.includes('UNREACHABLE')) {
    rollback(env, 'The public OTA endpoint did not answer.');
  }
  let served = '';
  try {
    served = JSON.parse(version).version ?? '';
  } catch {
    // A body that is not the manifest is not fatal on its own - it is reported
    // rather than rolled back, since the service is up and answering.
    console.log(`  ${c.yellow('!')} answered, but the body was not the bundle manifest`);
  }

  console.log(
    `\n${c.green('✓')} Registry deployed.${served ? ` ${c.dim(`serving OTA bundle ${served}`)}` : ''}\n`,
  );
}

const env = loadEnv();
checkTools();
deploy(env);
