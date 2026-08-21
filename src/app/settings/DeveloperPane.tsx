import { Switch, Text } from '@glacier/react';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';
import { setDeveloperMode, useDeveloperMode } from './developerMode.ts';

/**
 * The Developer page. Unlocked by seventeen presses on the wordmark in About,
 * then a Settings section of its own under About for as long as the switch at
 * the top stays on.
 *
 * SCAFFOLD - the tooling itself is being filled in. What is here already is
 * the one row that must never be missing: the way out.
 */
export function DeveloperPane() {
  const on = useDeveloperMode();
  return (
    <div className="prefsBody devPane">
      <PaneSection title="Developer mode" description="Hidden tools for working on the app. Off again, and this page and Diagnostics disappear until the next seventeen taps.">
        <SettingRow
          id="dev-mode"
          label="Developer mode"
          hint="Shows this page and Diagnostics in Settings."
          control={<Switch checked={on} onCheckedChange={(v) => setDeveloperMode(v)} aria-label="Developer mode" />}
        />
      </PaneSection>
      <Text tone="muted" size="sm">
        Tooling lands here.
      </Text>
    </div>
  );
}
