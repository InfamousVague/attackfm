import { ChevronDown, Sparkles, X } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import {
  applyStagedBundle,
  markAnnounced,
  markNotesSeen,
  notesFor,
  notesLines,
  previousFor,
  shouldAnnounce,
  stagedBundle,
  unseenNotes,
  watchBundle,
} from './appUpdate.ts';
import { UpdateModal } from './UpdateModal.tsx';

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
  const [open, setOpen] = useState(false);
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
          {/* The first change, not the words "What changed:" - a label that
              only announces a list is a line spent saying nothing, and this
              strip has exactly one line to spend. */}
          <span className="updateBanner__sub">{lines[0]}</span>
        </span>
        {lines.length > 1 && (
          <button
            type="button"
            className="updateBanner__more"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span>{open ? 'Less' : `+${lines.length - 1}`}</span>
            <ChevronDown
              size={13}
              className={open ? 'updateBanner__chev is-open' : 'updateBanner__chev'}
            />
          </button>
        )}
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
 * The update surface: a modal the first time a version has something to say,
 * and the quiet banner ever after.
 *
 * The modal is the announcement - the whole changelog, each line badged with
 * what kind of change it is - and it gets exactly one turn per version. The
 * banner is what remains once that turn is spent: dismissing the modal must
 * not also throw away the offer, since "not right now" is the commonest
 * answer to being asked to restart mid-song.
 */
export function UpdateBanner() {
  const [staged, setStaged] = useState<string | null>(stagedBundle);
  // Read once at mount: whether this launch is the one that followed a
  // restart is a fact about the launch, not something that changes under it.
  const [arrived] = useState(unseenNotes);
  /** The version the modal is announcing right now, if any. */
  const [announcing, setAnnouncing] = useState<string | null>(null);
  /** Versions this mount has already ruled on, so the decision is made once. */
  const decided = useRef(new Set<string>());
  /** Announced here, so the strip does not repeat what the modal just said. */
  const told = useRef(new Set<string>());

  useEffect(() => watchBundle(() => setStaged(stagedBundle())), []);

  // Whether a version still owes an announcement is decided in an effect, not
  // during render: `shouldAnnounce` reads a flag that `markAnnounced` writes,
  // and under StrictMode's deliberate double-render the second pass would see
  // its own first pass's mark and conclude the news had already been told.
  // The just-arrived version wins over a staged one - it is the news, where a
  // staged bundle is only ever an offer.
  const candidate = arrived?.version ?? staged;
  useEffect(() => {
    if (!candidate || decided.current.has(candidate)) return;
    decided.current.add(candidate);
    if (!shouldAnnounce(candidate)) return;
    markAnnounced(candidate);
    told.current.add(candidate);
    setAnnouncing(candidate);
  }, [candidate]);

  if (announcing) {
    return (
      <UpdateModal
        open
        version={announcing}
        previous={previousFor(announcing)}
        notes={(arrived ? arrived.notes : notesFor(announcing)) ?? ''}
        done={arrived !== null}
        onClose={() => setAnnouncing(null)}
      />
    );
  }

  // News already told is finished with - closing that modal acknowledged the
  // version, and repeating it as a strip would be the same sentence twice.
  if (arrived) {
    return told.current.has(arrived.version) ? null : (
      <WhatChanged version={arrived.version} notes={arrived.notes} />
    );
  }
  // An OFFER outlives its modal: "later" means later, not never.
  if (staged) return <UpdateReady version={staged} />;
  return null;
}
