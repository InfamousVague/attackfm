import { Sparkles, X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { applyStagedBundle, stagedBundle, watchBundle } from './appUpdate.ts';

/**
 * "There is a newer version, and it is already on the device."
 *
 * Deliberately not a modal, and deliberately not automatic. By the time this
 * appears the bundle is downloaded, checksummed and pointed at, so applying it
 * costs a reload and nothing else - but a reload during a song is still the
 * listener's call to make, not the app's. It waits.
 *
 * Dismissing hides it for this run only. The update stays staged and will be
 * running after the next ordinary launch either way; the banner is an offer to
 * have it sooner, not a thing that must be answered.
 */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(stagedBundle);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => watchBundle(() => setVersion(stagedBundle())), []);

  if (!version || dismissed === version) return null;

  return (
    <div className="updateBanner" role="status">
      <span className="updateBanner__icon" aria-hidden>
        <Sparkles size={15} />
      </span>
      <span className="updateBanner__text">
        <span className="updateBanner__title">Update ready</span>
        <span className="updateBanner__sub">Version {version} is on this device.</span>
      </span>
      <button
        type="button"
        className="updateBanner__apply"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          applyStagedBundle();
        }}
      >
        {applying ? 'Restarting…' : 'Restart'}
      </button>
      <button
        type="button"
        className="updateBanner__close"
        aria-label="Not now"
        onClick={() => setDismissed(version)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
