import type { IncomingTrack } from '../downloads/incoming.tsx';
import type { useT } from '../i18n/LocaleShell.tsx';

/**
 * The words under an arriving song's name.
 *
 * One line has to carry three different situations - a download that is
 * running, one the hub has promised but is not touching right now, and one
 * that already died and can be started again - and the difference between
 * them is the whole reason the line exists. A spinner over an empty queue
 * says "any moment now" about a song nothing is fetching, and "will retry"
 * over a job that failed with nothing scheduled to touch it is the sentence
 * that made these rows look stuck for days.
 */

/** The translator, as this file passes it around. Named `tr` rather than the
 *  usual `t` because `t` is already the name every helper here gives the TRACK
 *  it is handed, and shadowing that would be a rename waiting to go wrong. */
export type Tr = ReturnType<typeof useT>;

/**
 * The failed job's reason, trimmed to the half a person acts on - the server
 * appends its own transcript under the first line, and the first line is the
 * part that says whether trying again is worth anything.
 */
export function shortFailure(error: string | null | undefined, tr: Tr): string {
  const first = (error ?? '').split('\n')[0]?.trim() ?? '';
  if (!first) return tr('downloads.failed');
  const cut = first.replace(/\s*Retry to resume\.?$/i, '').trim();
  return cut.length > 48 ? `${cut.slice(0, 45)}\u2026` : cut || tr('downloads.failed');
}

/** The one line under an arriving song's name: what it is waiting on. */
export function incomingStatus(t: IncomingTrack, tr: Tr): string {
  const why = !t.stalled
    ? tr('downloads.downloading')
    : t.onRetry
      ? shortFailure(t.failure, tr)
      : tr('downloads.waitingTurn');
  // The credit and the status are joined through a catalogue entry rather than
  // an em dash written here, because which side of the dash each half sits on
  // - and whether a dash is the right mark at all - is the translator's call.
  return t.artist ? tr('downloads.statusWithArtist', { artist: t.artist, status: why }) : why;
}
