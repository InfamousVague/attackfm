import { Text } from '@glacier/react';
import { PaneSection } from './kit/settingsKit.tsx';

/**
 * Local AI - the owner's pane for the server's model endpoint: what it points
 * at, which model does which job, whether it answers, and what it has been
 * doing. Shown only to the server's admin (the owner; the client's
 * `session.isAdmin`), and every route it calls is admin-gated on the server too.
 *
 * SCAFFOLD - being filled in.
 */
export function LocalAiPane() {
  return (
    <div className="prefsBody localAiPane">
      <PaneSection title="Local AI" description="The model behind the curator, discovery, the DJ, the mixes and the stations.">
        <Text tone="muted" size="sm">
          Coming up.
        </Text>
      </PaneSection>
    </div>
  );
}

/** The rail row's second line, for SettingsModal. */
export function localAiSummary(): string {
  return 'Model, health and what it has been doing';
}
