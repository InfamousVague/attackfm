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
import { bootCheck } from './boot-check.mjs';

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
  /*
   * One bullet per note, continuation lines folded in.
   *
   * A changelog bullet wraps across physical lines, its continuations
   * indented under the "- ". Pushing each physical line as its own note is
   * what put a fresh icon beside every wrapped fragment on the update card -
   * a four-line bullet read as four one-liners. A line that opens a bullet
   * ("- ...") starts a new note; anything else is the rest of the one above
   * it and joins on with a space. The "- " marker stays on: the client
   * (appUpdate.notesLines) strips it, and keeping it is what tells a
   * continuation from a new bullet here.
   */
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    const t = line.trim();
    if (!t) continue;
    if (/^[-*]\s/.test(t)) out.push(t);
    else if (out.length) out[out.length - 1] += ' ' + t;
    else out.push(t);
  }
  return out.join('\n');
}

/**
 * What the registry is serving right now, or null if it cannot be asked.
 *
 * The LIVE number, deliberately - not main's package.json, not this tree's.
 * See the guard below for why that distinction is the whole point.
 */
async function liveVersion() {
  try {
    const res = await fetch('https://registry.attack.fm/v1/app/bundle', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const v = (await res.json())?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** -1, 0 or 1, comparing dotted numeric versions. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const rs = readFileSync(join(ROOT, 'src-tauri/src/bundle.rs'), 'utf8');
// BUNDLE_REQUIRES, not NATIVE_GENERATION. The first is what this frontend needs
// of the binary under it; the second is what a freshly built binary provides.
// Stamping a bundle with the second locks every device still on the previous
// generation out of every future update - including the update that would have
// given them the new binary.
const native = Number(rs.match(/BUNDLE_REQUIRES:\s*u32\s*=\s*(\d+)/)?.[1]);
if (!Number.isFinite(native)) die('could not read BUNDLE_REQUIRES from bundle.rs');
const provides = Number(rs.match(/NATIVE_GENERATION:\s*u32\s*=\s*(\d+)/)?.[1]);
if (Number.isFinite(provides) && native > provides) {
  die(`BUNDLE_REQUIRES (${native}) is ahead of NATIVE_GENERATION (${provides}): no binary could run this.`);
}

const notes = notesFor(version);
step(`Shipping ${version} (requires native generation ${native}; this checkout provides ${provides})`);
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
/*
 * NEVER PUBLISH AT OR BELOW WHAT IS ALREADY LIVE.
 *
 * The version this script ships is derived from package.json, and package.json
 * is a file nobody is obliged to push. Twice in a row a session shipped and
 * never committed the Release bump, so main sat two versions behind the
 * registry - and the next session to rebase onto main inherited a stale number,
 * bumped it, and published UNDER what was already out. A device on the newer
 * bundle is then told to go backwards, and the notes it carries belong to
 * whoever last used that number.
 *
 * "Rebase onto main first" does not catch this, because main is exactly the
 * thing that was wrong. The registry is the only source that knows what devices
 * can actually see, so that is what this compares against.
 *
 * Both numbers are printed on every run, not only on refusal: a check that is
 * silent when healthy teaches nobody what it compares, and the person who hits
 * it at 3am wants to see the pair rather than just the verdict.
 *
 * An unreachable registry does NOT block the ship - the publish itself would
 * fail moments later anyway, and refusing here would turn a network blip into
 * a release freeze. It says so out loud instead.
 */
const live = await liveVersion();
if (live === null) {
  console.log(`    version  ${version} (registry unreachable — publishing unguarded)`);
} else {
  console.log(`    version  ${version}   ·   registry has ${live}`);
  if (cmpVersion(version, live) <= 0) {
    die(
      `refusing to publish ${version}: the registry already serves ${live}.\n` +
        `    package.json here says ${pkg.version}, which is behind what is live —\n` +
        `    somebody shipped without pushing their Release bump. Set the version\n` +
        `    above ${live} and add a matching CHANGELOG section, then ship again.`,
    );
  }
}

/**
 * Refuse to build from a tree that is not level with origin/main.
 *
 * The registry guard above stops the version NUMBER going backwards. This stops
 * the CODE going backwards, which is the same accident wearing a version bump
 * and is invisible to every check made after the fact.
 *
 * Both directions are real and both happened on 2026-08-20:
 *
 * BEHIND - main has commits this tree lacks. The bundle is built without them,
 * so a HIGHER version publishes with LESS code in it, and every device already
 * on the older version loses whatever was dropped. That is how 0.3.239 went out
 * carrying a CSS fix but not the playlist syncing that 0.3.238 had shipped
 * twenty minutes earlier. Nothing downstream can catch it: the sha matches the
 * builder's own build, their markers are present, the version went up, and the
 * changelog is a clean union. "Newer" is not "superset".
 *
 * AHEAD - this tree has commits not on main. The bundle carries code main
 * cannot reproduce, so the release is unauditable, and the next session to build
 * from main silently drops it. The specific way this bites: a push is REJECTED
 * as non-fast-forward and the build runs anyway in the same command, leaving the
 * work unpushed for as long as the ship takes.
 *
 * Being level is cheap to restore (pull, or push) and is the only state in which
 * the bundle and main agree about what this release contains.
 *
 * Like the registry check, this does NOT block when it cannot get an answer -
 * no git, no origin, no network. A release freeze caused by a fetch timeout is
 * worse than the failure being prevented, so it says so and carries on. And it
 * prints the comparison on every run rather than only on refusal.
 *
 * TESTING THIS GIVES A FALSE PASS THE OBVIOUS WAY. Stepping back a commit to
 * make the tree "behind" also steps back to a commit that PREDATES this guard,
 * so nothing fires, no `tree` line prints, and the silence reads exactly like a
 * pass. Two people hit that before getting a real result. Either restore this
 * file over the older checkout (`git checkout <guard-commit> -- <this file>`)
 * and raise package.json above the live version so the registry check does not
 * refuse first, or stage the case properly: clone, commit, `git update-ref
 * refs/remotes/origin/main`, move HEAD back, then break the remote URL so the
 * fetch below cannot quietly undo the staging. Whichever route, the proof that
 * the test was real is the `tree ... N ahead / N behind` line appearing at all.
 *
 * Never use `git reset --hard` to unwind a probe commit in the shared checkout -
 * it takes every other session's uncommitted work with it, and has already
 * destroyed a load-bearing uncommitted change here once. `git update-ref
 * refs/heads/<branch> HEAD~1 HEAD` moves the branch and leaves the tree alone.
 */
const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
};

if (git('rev-parse', '--git-dir') === null) {
  console.log('    tree     not a git checkout — skipping the level-with-main check');
} else {
  // A failed fetch is not fatal; the counts below are then measured against
  // whatever origin/main was last known to be, which is still worth having.
  const fetched = git('fetch', '--quiet', 'origin', 'main') !== null;
  const head = git('rev-parse', '--short', 'HEAD');
  const ahead = git('rev-list', '--count', 'origin/main..HEAD');
  const behind = git('rev-list', '--count', 'HEAD..origin/main');

  if (ahead === null || behind === null) {
    console.log('    tree     could not compare against origin/main — publishing unguarded');
  } else {
    const stale = fetched ? '' : ' (offline — origin/main may be stale)';
    console.log(`    tree     ${head}   ·   ${ahead} ahead / ${behind} behind origin/main${stale}`);

    if (Number(behind) > 0) {
      die(
        `refusing to build ${version}: origin/main has ${behind} commit(s) this tree does not.\n` +
          `    The bundle would publish a higher version with LESS code than what is\n` +
          `    already live, and every device on the current version would lose it.\n` +
          `    Run ${'`'}git pull --rebase${'`'} and ship again.`,
      );
    }
    if (Number(ahead) > 0) {
      die(
        `refusing to build ${version}: this tree has ${ahead} commit(s) not on origin/main.\n` +
          `    The bundle would carry code main cannot reproduce, and the next session\n` +
          `    to build from main would drop it. Push first — and if the push is\n` +
          `    REJECTED, stop and pull rather than building anyway.`,
      );
    }
  }
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

/*
 * Does it start?
 *
 * The last check that looks at the bundle from the outside has just passed,
 * and every check above it passed on 0.3.252 and 0.3.253 too - both of which
 * reached phones as a black screen. Nothing here had ever RUN the thing, so
 * an app that cannot boot and one that can were the same release to this
 * script. This loads it in a real browser and asks whether anything appeared.
 *
 * Before the upload, deliberately. A check that runs after would only be able
 * to tell you what is already on Matt's phone.
 */
step('Booting the bundle');
// A malfunctioning guard must never be able to stop a good release: if the
// check itself falls over - no browser, a port already taken, a CDP change -
// that is this script's problem and not the bundle's, so it degrades to a
// warning exactly as a missing browser does. Only a bundle that demonstrably
// renders nothing is allowed to stop a ship.
const boot = await bootCheck(join(ROOT, 'dist')).catch((err) => ({
  skipped: `the check itself failed to run (${String(err).slice(0, 90)})`,
}));
if (boot.skipped) {
  console.log(`    \x1b[33m!\x1b[0m skipped — ${boot.skipped}`);
} else if (!boot.ok) {
  die(
    `the bundle does not start — this would be a black screen on every device.\n` +
      `    #root has ${boot.rootChildren} children after load.\n` +
      (boot.errors.length
        ? boot.errors.map((x) => `    ${x}`).join('\n')
        : '    (nothing was thrown — React rendered nothing without complaining)'),
  );
} else {
  ok(`it starts — “${boot.text.slice(0, 60)}…”`);
  // Noise from having no server to talk to is expected and is not a failure;
  // it is printed because a real fault often shows up here first.
  if (boot.errors.length) for (const x of boot.errors) console.log(`    \x1b[33m!\x1b[0m ${x}`);
}

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
