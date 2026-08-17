//! What an update looks like when it arrives.
//!
//! A modal, not a strip along the top: an update is the rare moment the app
//! has something to SAY, and the changelog is the only part of it anybody
//! cares about. The strip could show one line and hide the rest behind a
//! chevron; this shows the whole story, each line carrying an icon that says
//! what KIND of change it is at a glance - a fix, a new thing, something about
//! your phone, something about how it looks.
//!
//! Two moments, one shape:
//!   - before the restart ("Update ready"), with Restart / Later;
//!   - on the launch straight after it ("Updated to x.y.z"), with Done.
//!
//! It appears ONCE per version. Dismissing leaves the quiet banner (see
//! UpdateBanner.tsx) standing in its place, so a listener who said "later"
//! keeps a way back without being asked twice.

import { Button, Modal } from '@glacier/react';
import {
  Bug,
  Check,
  Cloud,
  Music,
  Paintbrush,
  RefreshCw,
  Smartphone,
  Sparkles,
  Zap,
  type IconProps,
} from '@glacier/icons';
import type { ComponentType } from 'react';
import { applyStagedBundle, markNotesSeen, notesLines } from './appUpdate.ts';

/** The kinds a changelog line can be, in the order they are tested. */
interface Kind {
  id: string;
  icon: ComponentType<IconProps>;
  /** Rules that put a line in this bucket, tried against the raw line. */
  match: RegExp;
}

/**
 * What each line is about, read from the line itself.
 *
 * The changelog is written for listeners, not parsed from commit trailers, so
 * this reads the same words a person would: a line that starts "Fixed:" or
 * says something "no longer" happens is a fix; one that names Android or a
 * phone is about the device in your hand. Order matters - the first match
 * wins, so the explicit prefixes are tested before the vaguer nouns, and
 * anything unclaimed is simply new.
 */
const KINDS: Kind[] = [
  { id: 'fix', icon: Bug, match: /^fixed\b|^fix\b|\bno longer\b|\bis gone\b|\bworks again\b|\bstops\b|failing|broken/i },
  { id: 'device', icon: Smartphone, match: /^android\b|^ios\b|^unfolded\b|\bphones?\b|\biphone\b|\btablet\b/i },
  { id: 'update', icon: RefreshCw, match: /\bupdates?\b|\bchangelog\b|\brestart\b|\bversion\b/i },
  { id: 'look', icon: Paintbrush, match: /\blight mode\b|\bdark\b|\btheme\b|\bcovers?\b|\btiles?\b|\bart\b|\blayout\b|\bheader\b|\bnav\b/i },
  { id: 'music', icon: Music, match: /\bsongs?\b|\bplay(?:s|ing|back)?\b|\bqueue\b|\balbums?\b|\bplaylists?\b|\bmusic\b|\blyrics\b/i },
  { id: 'server', icon: Cloud, match: /\bservers?\b|\bsync\b|\bdownloads?\b|\bstream\b|\bfriends?\b|\battack\.fm\b/i },
  { id: 'speed', icon: Zap, match: /\bfaster\b|\bspeed\b|\bquick\b|\bsmooth\b|\binstant\b/i },
];

function kindFor(line: string): Kind {
  return KINDS.find((k) => k.match.test(line)) ?? { id: 'new', icon: Sparkles, match: /.^/ };
}

/**
 * A line, split at its "Label: rest" prefix when it has one.
 *
 * The changelog writes those prefixes ("Fixed:", "Android:") as plain prose,
 * and they read as noise once an icon is already saying the same thing - so
 * the label becomes a small tag and the sentence keeps only its own words.
 * Only a SHORT leading word or two counts: "Settings → About has a Check for
 * updates button, and says what happened" must not lose half of itself to a
 * colon in the middle of the sentence.
 */
function splitLabel(line: string): { label: string | null; text: string } {
  const m = line.match(/^([A-Z][A-Za-z ]{1,11}):\s+(.*)$/);
  if (!m || !m[1] || !m[2]) return { label: null, text: line };
  return { label: m[1], text: m[2] };
}

function NoteList({ lines }: { lines: string[] }) {
  return (
    <ul className="updateModal__notes">
      {lines.map((line, i) => {
        const kind = kindFor(line);
        const Glyph = kind.icon;
        const { label, text } = splitLabel(line);
        return (
          <li key={i} className="updateModal__note" data-kind={kind.id}>
            <span className="updateModal__noteIcon" aria-hidden>
              <Glyph size={15} />
            </span>
            <span className="updateModal__noteText">
              {label && <span className="updateModal__noteTag">{label}</span>}
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The hero: a big glyph over the version this is about. */
function Hero({
  done,
  from,
  to,
}: {
  done: boolean;
  from: string | null;
  to: string;
}) {
  return (
    <div className="updateModal__hero">
      <span className={done ? 'updateModal__mark is-done' : 'updateModal__mark'} aria-hidden>
        {done ? <Check size={26} /> : <Sparkles size={26} />}
      </span>
      <span className="updateModal__title">{done ? 'Up to date' : 'Update ready'}</span>
      <span className="updateModal__version">
        {/* Where it came from earns its place only when it is known and
            different - "0.3.46 → 0.3.47" tells a story that "0.3.47" alone
            does not. */}
        {from && from !== to ? (
          <>
            <span className="updateModal__from">{from}</span>
            <span className="updateModal__arrow" aria-hidden>
              →
            </span>
            <span className="updateModal__to">{to}</span>
          </>
        ) : (
          <span className="updateModal__to">{to}</span>
        )}
      </span>
    </div>
  );
}

export function UpdateModal({
  open,
  version,
  previous,
  notes,
  done,
  onClose,
}: {
  open: boolean;
  version: string;
  /** The version being left behind, when this device knows it. */
  previous: string | null;
  notes: string;
  /** True on the launch after the restart: the update already happened. */
  done: boolean;
  onClose: () => void;
}) {
  const lines = notesLines(notes);
  return (
    <Modal
      open={open}
      onClose={() => {
        if (done) markNotesSeen();
        onClose();
      }}
      size="sm"
    >
      <div className="updateModal">
        <Hero done={done} from={previous} to={version} />
        {lines.length > 0 ? (
          <NoteList lines={lines} />
        ) : (
          <p className="updateModal__quiet">
            Small fixes and polish. Nothing that changes how anything works.
          </p>
        )}
        <div className="updateModal__actions">
          {done ? (
            <Button
              variant="solid"
              size="md"
              className="updateModal__go"
              onClick={() => {
                markNotesSeen();
                onClose();
              }}
            >
              Nice
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="md" onClick={onClose}>
                Later
              </Button>
              <Button
                variant="solid"
                size="md"
                className="updateModal__go"
                onClick={() => applyStagedBundle()}
              >
                <RefreshCw size={15} /> Restart now
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
