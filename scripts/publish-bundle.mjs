/**
 * Publish the built web bundle to a hub, so its devices pick it up.
 *
 *   node scripts/publish-bundle.mjs            # to the VPS from .env
 *   node scripts/publish-bundle.mjs --dry      # show what would go
 *
 * Copies dist/assets/app.{js,css} into <AFM_DATA_DIR>/appbundle/ on the server
 * along with a VERSION and NATIVE marker. The server generates the manifest by
 * hashing those files at request time, so there is no separate manifest to
 * fall out of step with the bytes.
 *
 * NATIVE is the generation the bundle expects; it must match
 * src-tauri/src/bundle.rs's NATIVE_GENERATION. A device whose binary is older
 * refuses the download rather than running JS its Rust cannot serve - which is
 * the one failure this whole mechanism cannot recover from on its own.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

function env() {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function nativeGeneration() {
  const rs = readFileSync(join(ROOT, 'src-tauri/src/bundle.rs'), 'utf8');
  const m = rs.match(/NATIVE_GENERATION:\s*u32\s*=\s*(\d+)/);
  if (!m) throw new Error('could not read NATIVE_GENERATION from bundle.rs');
  return Number(m[1]);
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const native = nativeGeneration();
const files = ['dist/assets/app.js', 'dist/assets/app.css'].filter((f) => existsSync(join(ROOT, f)));
if (files.length === 0) {
  console.error('No built bundle. Run `npm run build` first.');
  process.exit(1);
}

console.log(`▸ publishing ${version} (native ${native})`);
for (const f of files) console.log(`    ${f}`);
if (DRY) process.exit(0);

const e = env();
const host = e.AFM_DEPLOY_HOST;
const user = e.AFM_DEPLOY_USER;
const remote = '/opt/attackfm/data/appbundle';
const run = (cmd, args) =>
  spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });

run('sshpass', ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`,
  `mkdir -p ${remote}`]);
run('sshpass', ['-e', 'rsync', '-az', '-e', 'ssh -o StrictHostKeyChecking=no',
  ...files, `${user}@${host}:${remote}/`]);
// VERSION last: until it lands the server publishes nothing, so a device can
// never see a manifest for a half-uploaded bundle.
run('sshpass', ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`,
  `printf '%s' '${native}' > ${remote}/NATIVE && printf '%s' '${version}' > ${remote}/VERSION`]);
console.log('✓ published');
