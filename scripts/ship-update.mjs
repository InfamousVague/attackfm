/**
 * Ship a new frontend to the hub, where every device will pick it up.
 *
 *   npm run ship            # bump the patch version, build, publish, verify
 *   npm run ship -- --dry   # show what would happen, touch nothing
 *   npm run ship -- --keep  # publish the current version without bumping
 *
 * This is the whole loop for a TypeScript or CSS change: no APK, no App Store,
 * no cable. Devices ask the hub every six hours (and ~20s after launch), and
 * show a banner once the bundle is down and verified.
 *
 * It will NOT publish a bundle whose native generation is ahead of what the
 * installed apps can run - that is the one mistake this mechanism cannot
 * recover from on its own, so the check is here as well as on both ends.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const KEEP = process.argv.includes('--keep');
const step = (m) => console.log(`\x1b[36m▸\x1b[0m \x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m✗\x1b[0m ${m}`); process.exit(1); };

function env() {
  const out = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
let version = pkg.version;

if (!KEEP) {
  const bits = version.split('.').map(Number);
  bits[2] = (bits[2] || 0) + 1;
  version = bits.join('.');
}

const rs = readFileSync(join(ROOT, 'src-tauri/src/bundle.rs'), 'utf8');
const native = Number(rs.match(/NATIVE_GENERATION:\s*u32\s*=\s*(\d+)/)?.[1]);
if (!Number.isFinite(native)) die('could not read NATIVE_GENERATION from bundle.rs');

step(`Shipping ${version} (native generation ${native})`);
if (DRY) { ok('dry run — nothing built, nothing published'); process.exit(0); }

if (!KEEP) {
  // The version IS the update's identity on every device, so it moves before
  // the build that carries it.
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
}

step('Building the web bundle');
if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) die('build failed');

const files = ['app.js', 'app.css'].map((name) => {
  const path = join(ROOT, 'dist/assets', name);
  const bytes = readFileSync(path);
  return { name, path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
});
for (const f of files) console.log(`    ${f.name}  ${(f.bytes.length / 1024).toFixed(0)} KB  ${f.sha256.slice(0, 12)}…`);

const e = env();
const host = e.AFM_DEPLOY_HOST, user = e.AFM_DEPLOY_USER;
if (!host || !user) die('AFM_DEPLOY_HOST / AFM_DEPLOY_USER missing from .env');
const remote = '/opt/attackfm/data/appbundle';
const ssh = (cmd) =>
  spawnSync('sshpass', ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`, cmd],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });

step('Uploading');
ssh(`mkdir -p ${remote}`);
const rs2 = spawnSync('sshpass',
  ['-e', 'rsync', '-az', '-e', 'ssh -o StrictHostKeyChecking=no',
   ...files.map((f) => f.path), `${user}@${host}:${remote}/`],
  { stdio: 'inherit', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });
if (rs2.status !== 0) die('upload failed');

step('Publishing');
// VERSION is written LAST and alone: until it lands the server reports that it
// publishes nothing, so no device can ever see a manifest for a half-uploaded
// bundle. This ordering is the entire atomicity guarantee.
ssh(`printf '%s' '${native}' > ${remote}/NATIVE && printf '%s' '${version}' > ${remote}/VERSION`);

step('Verifying the hub serves what we just built');
const check = spawnSync('sshpass',
  ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`,
   `sha256sum ${remote}/app.js ${remote}/app.css | awk '{print $1}'`],
  { encoding: 'utf8', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });
const remoteSums = String(check.stdout).trim().split('\n').map((l) => l.trim());
const localSums = files.map((f) => f.sha256);
const same = localSums.every((s) => remoteSums.includes(s));
if (!same) {
  die(`checksums differ — the hub does NOT have what was built.\n    local:  ${localSums.join(' ')}\n    remote: ${remoteSums.join(' ')}`);
}

ok(`published ${version} — devices will offer it within six hours, or on their next launch`);
