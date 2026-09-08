/**
 * Takes the world back down.
 *
 * By PID, from `world.json`, and only PIDs this run started. Never by name:
 * `pkill -f attackfm-server` on a machine where the owner's own hub is running
 * kills the owner's own hub, and a test harness that can do that will do it on
 * the worst possible afternoon.
 *
 * The run root is deliberately LEFT on disk. A failed run's hub log is the
 * first thing anyone wants, and the next run's setup deletes the root before
 * it writes anything, so nothing accumulates across runs.
 */
import { readFileSync } from 'node:fs';
import { worldFile, type World } from './fixtures/world.ts';

function stop(label: string, pid: number): void {
  if (!pid) return;
  try {
    // SIGTERM: the hub and the registry both listen for it and close their
    // database cleanly. A SIGKILL leaves a -wal beside the sqlite file, which
    // is harmless here and untidy everywhere else.
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`[e2e] stopped ${label} (pid ${pid})\n`);
  } catch {
    // Already gone - a crashed hub is why the run failed, not a teardown error.
  }
}

export default async function globalTeardown(): Promise<void> {
  let world: World;
  try {
    world = JSON.parse(readFileSync(worldFile(), 'utf8')) as World;
  } catch {
    return;
  }
  stop('the app server', world.pids.app);
  stop('the hub', world.pids.hub);
  stop('the registry', world.pids.registry);
}
