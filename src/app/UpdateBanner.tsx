import { ChevronDown, Sparkles, X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import {
  applyStagedBundle,
  markNotesSeen,
  notesFor,
  notesLines,
  stagedBundle,
  unseenNotes,
  watchBundle,
} from './appUpdate.ts';

/**
 * "There is a newer version, and it is already on the device."
 *
 * Deliberately not a modal, and deliberately not automatic. By the time this
 * appears the bundle is downloaded, checksummed and pointed at, so applying it
 * costs a reload and nothing else - but a reload during a song is still the
 * listener's call to make, not the app's. It waits.
 *
 * It leads with WHAT CHANGED rather than a version number, because a version
 * number is not a reason to restart. The first line of the changelog sits in
 * the banner; the rest is one tap away.
 */
function UpdateReady({ version }: { version: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const lines = notesLines(notesFor(version) ?? '');

  if (dismissed) return null;

  return (
    <div className="updateBanner" role="status">
      <div className="updateBanner__row">
        <span className="updateBanner__icon" aria-hidden>
          <Sparkles size={15} />
        </span>
        <span className="updateBanner__text">
          <span className="updateBanner__title">Update ready</span>
          <span className="updateBanner__sub">
            {lines.length > 0 ? lines[0] : `Version ${version} is on this device.`}
          </span>
        </span>
        {lines.length > 1 && (
          <button
            type="button"
            className="updateBanner__more"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span>{open ? 'Less' : `+${lines.length - 1}`}</span>
            <ChevronDown size={13} className={open ? 'updateBanner__chev is-open' : 'updateBanner__chev'} />
          </button>
        )}
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
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </div>
      {open && lines.length > 1 && (
        <ul className="updateNotes">
          {lines.slice(1).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "Here is what the app just became."
 *
 * The other half, and the half that actually justifies keeping notes at all:
 * an update that arrives silently is indistinguishable from things moving
 * around on their own. Shown once per version, on the launch that follows the
 * restart, then acknowledged for good.
 */
function WhatChanged({ version, notes }: { version: string; notes: string }) {
  const [gone, setGone] = useState(false);
  const lines = notesLines(notes);
  if (gone || lines.length === 0) return null;
  return (
    <div className="updateBanner updateBanner--done" role="status">
      <div className="updateBanner__row">
        <span className="updateBanner__icon" aria-hidden>
          <Sparkles size={15} />
        </span>
        <span className="updateBanner__text">
          <span className="updateBanner__title">Updated to {version}</span>
          <span className="updateBanner__sub">What changed:</span>
        </span>
        <button
          type="button"
          className="updateBanner__close"
          aria-label="Dismiss"
          onClick={() => {
            markNotesSeen();
            setGone(true);
          }}
        >
          <X size={14} />
        </button>
      </div>
      <ul className="updateNotes">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function UpdateBanner() {
  const [staged, setStaged] = useState<string | null>(stagedBundle);
  // Read once at mount: whether this launch is the one that followed a
  // restart is a fact about the launch, not something that changes under it.
  const [arrived] = useState(unseenNotes);

  useEffect(() => watchBundle(() => setStaged(stagedBundle())), []);

  if (arrived) return <WhatChanged version={arrived.version} notes={arrived.notes} />;
  if (staged) return <UpdateReady version={staged} />;
  return null;
}
