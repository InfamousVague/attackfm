import { Button, Label, Text } from '@glacier/react';
import { useDownloads } from '@attackfm/app/importsBridge';
import { useServerSession } from '@attackfm/app/serverSession';

/**
 * The Downloads tab. Once the seat of the local engine's knobs - SpotiFLAC
 * install state, quality, services, the output folder - it slimmed to a
 * status pane when the engine moved to the hub: downloads run where the music
 * lives, so the machine-local configuration went with them. What remains is
 * what a listener still owns from here: watching the queue and clearing the
 * finished cards.
 */
export function DownloadsSettings() {
  const { session } = useServerSession();
  const { jobs, active, clearFinished } = useDownloads();
  const finished = jobs.length - active.length;

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Imports run on your server - connect one under Settings &rarr; Server first.
        </Text>
      </div>
    );
  }

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>Where downloads run</Label>
        <Text tone="muted" size="sm">
          Links you import are downloaded by {session.url.replace(/^https?:\/\//, '')}{' '}
          straight into its library, then synced to every signed-in device. Paste a
          link in search, or use the get-this buttons around the app.
        </Text>
      </div>
      <div className="prefsSection">
        <Label>Queue</Label>
        <Text tone="muted" size="sm">
          {active.length === 0
            ? 'Nothing downloading right now.'
            : `${active.length} ${active.length === 1 ? 'import' : 'imports'} in flight.`}
          {finished > 0 ? ` ${finished} finished ${finished === 1 ? 'card' : 'cards'}.` : ''}
        </Text>
        {finished > 0 && (
          <div className="prefsActions">
            <Button variant="outline" size="sm" onClick={clearFinished}>
              Clear finished
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
