import { Sparkles, X } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import {
  applyStagedBundle,
  markAnnounced,
  markNotesSeen,
  notesFor,
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
  const [applying, setApplying] = useState(false);

  if (dismissed) return null;

  return (
    <div className="updateBanner" role="status">
      <div className="updateBanner__row">
        <span className="updateBanner__icon" aria-hidden>
          <Sparkles size={15} />
        </span>
        {/* What it is, not what changed. This strip exists to offer the
            restart; the changelog is the modal's job, one turn per version,
            and repeating it here is how it ended up on the home screen twice. */}
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
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </div>
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
        onClose={() => {
          // Closing the announcement IS reading it. Without this the seen-mark
          // was written by the strip's dismiss, and the strip is gone.
          if (arrived) markNotesSeen();
          setAnnouncing(null);
        }}
      />
    );
  }

  // An update that has landed draws NOTHING on the page it lands on.
  //
  // There used to be a strip here restating the changelog after the restart -
  // and the modal above had usually just said the same thing, so the news
  // arrived twice and the second copy sat on the home screen waiting to be
  // dismissed. The modal is the announcement and it gets one turn per version;
  // once it has had it, the version is finished with. The notes themselves are
  // not lost - notesFor() still holds them, and Settings' About pane names the
  // running version.
  if (arrived) return null;
  // An OFFER outlives its modal: "later" means later, not never.
  if (staged) return <UpdateReady version={staged} />;
  return null;
}

/**
 * The restart OFFER alone, for a surface that wants it without the full
 * UpdateBanner's first-launch announcement modal - Settings shows this under
 * its recent-panes chips. It draws nothing until a bundle is staged, and the
 * same offer as the home banner once one is: "there is a newer version on the
 * device, restart to use it". Watches the bundle so it appears the moment one
 * lands while Settings is open.
 */
export function StagedUpdateBanner() {
  const [staged, setStaged] = useState<string | null>(stagedBundle);
  useEffect(() => watchBundle(() => setStaged(stagedBundle())), []);
  if (!staged) return null;
  return <UpdateReady version={staged} />;
}
