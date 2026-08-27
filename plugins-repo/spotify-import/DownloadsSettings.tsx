import { Button, Label, Text } from '@glacier/react';
import { useDownloads } from '@attackfm/app/importsBridge';
import { ImportServerPicker, useImportServer } from '@attackfm/app/importServer';

/**
 * The Downloads tab. Once the seat of the local engine's knobs - SpotiFLAC
 * install state, quality, services, the output folder - it slimmed to a
 * status pane when the engine moved onto a server: downloads run where the
 * engine is, so the machine-local configuration went with them. What remains
 * is what a listener still owns from here: which server does the fetching, and
 * watching the queue.
 */
export function DownloadsSettings() {
  const target = useImportServer();
  const { jobs, active, clearFinished } = useDownloads();
  const finished = jobs.length - active.length;

  if (!target) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Imports run on a server - connect one under Settings &rarr; Server first.
        </Text>
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {/* The picker ships from core, not from this bundle: it speaks the
          settings kit (whose CSS a plugin cannot import) and it carries the
          `import-server` search anchor, which must not live in a bundle that
          can be a version behind the app. */}
      <ImportServerPicker />
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
