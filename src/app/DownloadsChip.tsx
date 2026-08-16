import { Download, TriangleAlert } from '@glacier/icons';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';

/**
 * The import queue's presence, floating above the strip.
 *
 * Downloads used to hold a nav seat (a rail item on the desktop, a row in the
 * phone's ⋮ menu) that sat there whether or not anything was happening - a
 * door to a room that is usually empty. This is the opposite deal: nothing
 * anywhere while the queue is idle, and while work IS in flight, a chip that
 * says so from every page, riding just above the transport where the eye
 * already goes for "what is the app doing".
 *
 * It stays for a failure, because a failed download needs a hand (retry lives
 * on the page this opens), and it leaves when the work is done - finished
 * imports become library rows, and the library is their surface. The page
 * itself still exists; this chip is simply its one door now.
 */
export function DownloadsChip({ open, current }: { open: () => void; current: boolean }) {
  const dl = useDownloadsOptional();
  // No importer, or already standing on the page the chip would open.
  if (!dl || current) return null;
  const active = dl.active.length;
  const failed = dl.jobs.filter((j) => j.state === 'error').length;
  if (active === 0 && failed === 0) return null;

  // One number across every sized job; jobs that do not know their total
  // (single tracks, still enumerating) ride along without skewing it.
  const sized = dl.active.filter((j) => (j.total ?? 0) > 0);
  const done = sized.reduce((sum, j) => sum + j.completed, 0);
  const total = sized.reduce((sum, j) => sum + (j.total ?? 0), 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  const label =
    active > 0
      ? `${active} downloading${pct !== null ? ` · ${pct}%` : ''}`
      : `${failed} ${failed === 1 ? 'download' : 'downloads'} failed`;

  return (
    <button
      type="button"
      className="downloadsChip"
      data-tone={active === 0 ? 'failed' : undefined}
      onClick={open}
      aria-label={`${label} — open downloads`}
    >
      {active > 0 ? (
        <Download size={14} aria-hidden />
      ) : (
        <TriangleAlert size={14} aria-hidden />
      )}
      {label}
    </button>
  );
}
