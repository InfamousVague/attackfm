import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Text } from '@glacier/react';
import { Laptop, X } from '@glacier/icons';
import { fetchResume, type ResumePoint } from './resumeSync.ts';
import { sharePositionEnabled } from '../settings/behaviourPrefs.ts';
import { setPendingSeek } from '../player/pendingSeek.ts';
import { useLibrary } from '../library/library.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * "You were partway through this somewhere else."
 *
 * THE HALF THAT WAS MISSING. `recordResume` has been writing a position to the
 * account for a long time and nothing ever read it back - the switch in Privacy
 * offered to keep your place across devices and then kept it nowhere anybody
 * could reach. This is the read.
 *
 * An OFFER, never an action. Opening the app is not a request to start playing:
 * a phone that began a book out loud because a laptop had one open last night
 * would be a worse fault than the one being fixed. So it is a line you can take
 * or dismiss, and dismissing is remembered for the session.
 *
 * Asked ONCE per launch. The point is "what was I in the middle of", which is a
 * question about arriving - re-asking it every few minutes would turn a helpful
 * line into something that keeps reappearing while you are deliberately playing
 * something else.
 */
export function ResumeElsewhere({
  onPlay,
}: {
  onPlay: (track: Track, context?: Track[]) => void;
}) {
  const { tracks, books } = useLibrary();
  const [point, setPoint] = useState<ResumePoint | null>(null);
  const [gone, setGone] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    // The same switch that governs the write governs the read. With it off
    // there is nothing stored to fetch, and asking would be a request about
    // somebody who has said they do not want this.
    if (asked.current || !sharePositionEnabled()) return;
    asked.current = true;
    const ctrl = new AbortController();
    void fetchResume(ctrl.signal).then((p) => setPoint(p));
    return () => ctrl.abort();
  }, []);

  /*
   * The track this device holds for that path, or nothing.
   *
   * Books are searched as well as music: they are held apart from `tracks` on
   * purpose, and a book is the likeliest thing to be halfway through in the
   * first place - offering to resume everything EXCEPT the long thing would be
   * a strange feature.
   *
   * No match means the point names a library this device is not signed in to.
   * Nothing is offered then: an invitation that cannot be accepted is worse
   * than silence.
   */
  const here = point
    ? ([...books, ...tracks].find((t) => t.path === point.path) ?? null)
    : null;

  const take = useCallback(() => {
    if (!here || !point) return;
    // The seek cannot happen until the track has loaded, so leave word - the
    // same door a bookmark jump uses.
    setPendingSeek(here.path, Math.round(point.position * 1000));
    onPlay(here);
    setGone(true);
  }, [here, point, onPlay]);

  if (!point || !here || gone) return null;

  return (
    <div className="resumeElsewhere">
      <span className="resumeElsewhere__icon" aria-hidden>
        <Laptop size={16} />
      </span>
      <span className="resumeElsewhere__text">
        <span className="resumeElsewhere__title">Pick up where you left off</span>
        <Text tone="muted" size="xs">
          {point.title}
          {point.artist ? ` · ${point.artist}` : ''} · {clock(point.position)} in
        </Text>
      </span>
      <Button variant="soft" size="sm" onClick={take}>
        Resume
      </Button>
      <button
        type="button"
        className="resumeElsewhere__dismiss"
        aria-label="Not now"
        onClick={() => setGone(true)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** h:mm:ss for anything past an hour, m:ss below - a book is usually the first. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
