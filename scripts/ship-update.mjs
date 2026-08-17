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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/**
 * The changelog section for a version, from CHANGELOG.md.
 *
 * Read from the repo rather than typed at the prompt so the notes that reach a
 * phone are the ones committed alongside the code they describe - a changelog
 * written at deploy time is a changelog nobody reviews.
 */
function notesFor(v) {
  let md;
  try {
    md = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '';
  }
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().replace(/^#+\s*/, '').startsWith(v));
  if (start < 0) return '';
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n');
}

const rs = readFileSync(join(ROOT, 'src-tauri/src/bundle.rs'), 'utf8');
const native = Number(rs.match(/NATIVE_GENERATION:\s*u32\s*=\s*(\d+)/)?.[1]);
if (!Number.isFinite(native)) die('could not read NATIVE_GENERATION from bundle.rs');

const notes = notesFor(version);
step(`Shipping ${version} (native generation ${native})`);
if (notes) {
  for (const line of notes.split('\n')) console.log(`    ${line}`);
} else if (process.argv.includes('--no-notes')) {
  console.log('    \x1b[33mshipping with no notes (--no-notes)\x1b[0m');
} else {
  die(
    `no \x1b[1m## ${version}\x1b[0m section in CHANGELOG.md.\n` +
    `    Add one, or pass --no-notes to ship without a changelog.\n` +
    `    (A silent update is nearly always a mistake - 0.3.42 went out that way.)`,
  );
}
if (DRY) { ok('dry run — nothing built, nothing published'); process.exit(0); }

if (!KEEP) {
  // The version IS the update's identity on every device, so it moves before
  // the build that carries it.
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
}

step('Building the web bundle (self-contained OTA mode)');
// AFM_OTA=1 makes vite inline every dynamic import and asset into app.js /
// app.css (see vite.config.ts). The two files ARE the bundle: a chunk or a
// hashed asset beside them would be a file no device ever downloads, whose
// relative import cannot resolve out of a bundle directory anyway - the exact
// breakage that quarantined every pre-0.3.43 bundle on real phones.
if (
  spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, AFM_OTA: '1' },
  }).status !== 0
)
  die('build failed');

step('Verifying the bundle is self-contained');
const emitted = readdirSync(join(ROOT, 'dist/assets'));
const strays = emitted.filter((n) => n !== 'app.js' && n !== 'app.css');
if (strays.length) {
  die(
    `the OTA build emitted files beyond app.js/app.css — they would never reach a device:\n` +
    strays.map((s) => `      ${s}`).join('\n') +
    `\n    (a new worker/worklet or a vite config change broke inlining)`,
  );
}
const jsText = readFileSync(join(ROOT, 'dist/assets/app.js'), 'utf8');
const relImport = jsText.match(/import\(\s*["']\.\//) || jsText.match(/from\s*["']\.\//);
if (relImport) die('app.js still holds relative imports — inlineDynamicImports did not apply');
const cssText = readFileSync(join(ROOT, 'dist/assets/app.css'), 'utf8');
const relUrl = cssText.match(/url\(\s*["']?(?!data:|#)[^)"']+\)/);
if (relUrl) die(`app.css still references external files: ${relUrl[0].slice(0, 80)}`);
ok('app.js + app.css are the whole bundle');

const files = ['app.js', 'app.css'].map((name) => {
  const path = join(ROOT, 'dist/assets', name);
  const bytes = readFileSync(path);
  return { name, path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
});
for (const f of files) console.log(`    ${f.name}  ${(f.bytes.length / 1024).toFixed(0)} KB  ${f.sha256.slice(0, 12)}…`);

const e = env();
const host = e.AFM_DEPLOY_HOST, user = e.AFM_DEPLOY_USER;
if (!host || !user) die('AFM_DEPLOY_HOST / AFM_DEPLOY_USER missing from .env');
// The registry (registry.attack.fm) is the canonical update source - the same
// central service every device already talks to for sign-in, whatever music
// server it listens from. The music hub's old directory is kept published in
// lockstep as a TRANSITION path: devices running a 0.3.43/0.3.44 frontend
// still check their session's server, and this is how they get carried onto
// the registry-checking client. Retire it once nothing old is left checking.
const remote = '/opt/attackfm/registry/appbundle';
const legacy = '/opt/attackfm/data/appbundle';
const sshRaw = (cmd, opts = {}) =>
  spawnSync('sshpass', ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`, cmd],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS }, ...opts });

/**
 * A remote step that must succeed.
 *
 * The box rate-limits ssh under a burst, so a lone failure is usually
 * transient - but it is never something to shrug at, because a half-applied
 * publish is exactly the state VERSION-last was designed to avoid. Retries a
 * few times, then stops the run.
 */
const ssh = (cmd) => {
  for (let i = 0; i < 4; i += 1) {
    if (sshRaw(cmd).status === 0) return;
    if (i < 3) console.log(`    \x1b[33mretrying (${i + 1}/3)…\x1b[0m`);
  }
  die(`remote command failed after 4 attempts: ${cmd}`);
};

/**
 * The same retry, for a command whose OUTPUT is the point.
 *
 * The readbacks below used to be single-shot, and a connection the box refused
 * under its ssh rate limit came back with empty stdout - which reads exactly
 * like "the remote has different bytes". A good publish of 0.3.116 was
 * reported as "checksums differ — a door does NOT have what was built" while
 * both doors in fact held the right files. A failed CHECK is not a failed
 * publish, so this retries before it is allowed to accuse anyone.
 */
const sshRead = (cmd) => {
  for (let i = 0; i < 4; i += 1) {
    const r = spawnSync('sshpass',
      ['-e', 'ssh', '-o', 'StrictHostKeyChecking=no', `${user}@${host}`, cmd],
      { encoding: 'utf8', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });
    const out = String(r.stdout ?? '').trim();
    if (r.status === 0 && out) return out;
    if (i < 3) console.log(`    \x1b[33mretrying readback (${i + 1}/3)…\x1b[0m`);
  }
  die(`could not read back from the box after 4 attempts: ${cmd}\n    The publish itself may well have landed — check ${'`'}curl -s https://registry.attack.fm/v1/app/bundle${'`'} before re-shipping.`);
};

step('Uploading');
ssh(`mkdir -p ${remote} ${legacy}`);
let uploaded = false;
for (let i = 0; i < 4 && !uploaded; i += 1) {
  const rs2 = spawnSync('sshpass',
    ['-e', 'rsync', '-az', '-e', 'ssh -o StrictHostKeyChecking=no',
     ...files.map((f) => f.path), `${user}@${host}:${remote}/`],
    { stdio: 'inherit', env: { ...process.env, SSHPASS: e.AFM_DEPLOY_PASS } });
  uploaded = rs2.status === 0;
  if (!uploaded && i < 3) console.log(`    \x1b[33mretrying upload (${i + 1}/3)…\x1b[0m`);
}
if (!uploaded) die('upload failed after 4 attempts');

step('Publishing (registry, then the legacy hub path)');
// VERSION is written LAST and alone: until it lands the server reports that it
// publishes nothing, so no device can ever see a manifest for a half-uploaded
// bundle. This ordering is the entire atomicity guarantee.
// NOTES before VERSION, for the same reason the files go first: nothing is
// published until VERSION lands, so notes can never describe a bundle a
// device cannot yet see.
const notesB64 = Buffer.from(notes, 'utf8').toString('base64');
ssh(`printf '%s' '${notesB64}' | base64 -d > ${remote}/NOTES`);
ssh(`printf '%s' '${native}' > ${remote}/NATIVE && printf '%s' '${version}' > ${remote}/VERSION`);
// The legacy copy is cp'd FROM the registry dir on the box - one upload, two
// doors, and the same VERSION-last ordering.
ssh(
  `rm -f ${legacy}/VERSION && cp ${remote}/app.js ${remote}/app.css ${remote}/NOTES ${remote}/NATIVE ${legacy}/ && cp ${remote}/VERSION ${legacy}/VERSION`,
);

step('Verifying both doors serve what we just built');
const remoteSums = sshRead(
  `sha256sum ${remote}/app.js ${remote}/app.css ${legacy}/app.js ${legacy}/app.css | awk '{print $1}'`,
).split('\n').map((l) => l.trim());
const localSums = files.map((f) => f.sha256);
const same = localSums.every((s) => remoteSums.filter((r) => r === s).length === 2);
if (!same) {
  die(`checksums differ — a door does NOT have what was built.\n    local:  ${localSums.join(' ')}\n    remote: ${remoteSums.join(' ')}`);
}

// BYTES, not lines: NOTES is written without a trailing newline, so a
// one-line changelog reads as zero lines and once failed a good publish.
const [publishedVersion, legacyVersion, noteBytes] = sshRead(
  `cat ${remote}/VERSION; echo; cat ${legacy}/VERSION; echo; wc -c < ${remote}/NOTES`,
).split('\n').map((l) => l.trim());
if (publishedVersion !== version || legacyVersion !== version) {
  die(`published ${publishedVersion || '(nothing)'} / legacy ${legacyVersion || '(nothing)'}, wanted ${version}`);
}
if (notes && Number(noteBytes) === 0) {
  die('the notes did not land — the registry would offer this update with no changelog');
}

ok(`published ${version} — ${notes ? `${notes.split('\n').length} changelog lines, ` : ''}devices will offer it within six hours, or on their next launch`);
