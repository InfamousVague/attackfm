/**
 * WHICH COMMIT THE TEST REPORT DESCRIBES.
 *
 * Its own file, and not a helper inside `scripts/test-report.mjs`, because two
 * scripts have to agree on the answer: the generator writes it into the report,
 * and `scripts/ship-update.mjs` refuses to publish a bundle whose report was
 * produced for a different one. If they computed it separately they would
 * disagree the first time either was edited, and the failure would look like a
 * stale report rather than a bug. Importing test-report.mjs to share the
 * function is not an option - that file RUNS the suite the moment it loads.
 *
 * WHY IT IS NOT SIMPLY `git rev-parse --short HEAD`.
 *
 * The report is a committed file that records the commit it belongs to, and
 * its own commit changes HEAD. Write X into the file, commit it, and HEAD is Y
 * - so the naive field is wrong the instant it is stored, `--check` disagrees
 * with the committed copy on that one key forever, and the ship guard can
 * never be satisfied by anything. The fixed point does not exist.
 *
 * So the answer is the newest commit that changed anything OTHER than the
 * report. A commit that only re-stamps the report does not make the report
 * stale - it IS the report - and every other commit does. On a tree whose tip
 * is real work this is exactly `git rev-parse --short HEAD`; the one case it
 * differs is the commit carrying the regenerated file, which is precisely the
 * case the naive answer gets wrong.
 */
import { spawnSync } from 'node:child_process';

/** The report's path, repo-relative - the one file that does not count. */
export const REPORT_PATH = 'src/app/diag/testReport.generated.json';

/**
 * The short SHA the report should carry, or null outside a git checkout.
 *
 * Walks back over commits that touched nothing but the report. Ten is a
 * generous bound: a longer run of them means somebody is re-stamping in a
 * loop, and past that the honest answer is the tip.
 */
export function reportCommit(cwd = process.cwd()) {
  const at = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
  };

  let sha = at('rev-parse', '--short', 'HEAD');
  if (!sha) return null;

  for (let i = 0; i < 10; i += 1) {
    const touched = at('show', '--name-only', '--format=', sha);
    if (touched === null) return sha;
    const files = touched.split('\n').map((s) => s.trim()).filter(Boolean);
    // An empty list is a merge or an empty commit: it changed nothing on its
    // own, so it is not what made the report stale either - but it is also not
    // a report re-stamp, and stopping here keeps this from walking history.
    if (!files.length || files.some((f) => f !== REPORT_PATH)) return sha;
    const parent = at('rev-parse', '--short', `${sha}^`);
    if (!parent) return sha;
    sha = parent;
  }
  return sha;
}
