import { Button, Modal, Spinner, Text } from '@glacier/react';
import { RotateCw, Sparkles } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../core/tauri.ts';
import { fetchCatchUp, whyNot, type CatchUp, type NotReady } from './recap.ts';

/**
 * The one button.
 *
 * A book put down for three weeks is a book you cannot pick up, and the two
 * things on offer everywhere else are re-listening to an hour you have already
 * heard or reading a summary on the web whose first line gives away the end.
 * This asks the hub instead, which knows the text AND knows where you stopped,
 * and answers with the story so far and nothing past your mark.
 *
 * Shared by the two places a reader comes back to a book: the chapter list in
 * Now Playing, and the book's own sheet on the shelf - the second being the
 * one that matters, since three weeks later nothing is playing yet.
 *
 * The waiting is honest. A local model writing four paragraphs takes tens of
 * seconds, so the dialog opens FIRST and shows what it is doing, rather than a
 * button that appears dead until an answer lands.
 */

type Ask = { kind: 'asking' } | { kind: 'ready'; got: CatchUp } | { kind: 'none'; why: NotReady };

/*
 * The triggers, apart from the dialog.
 *
 * Both surfaces that offer this - a Modal on the shelf, a Popover in the
 * player - DESTROY their own contents when they close, and pressing a trigger
 * inside one closes it. A dialog rendered in the same subtree as its button
 * would be unmounted by its own press, so the button stays here and the dialog
 * is hoisted out by the host, joined by one piece of state.
 */

/** The trigger, in one place, so the two surfaces that offer it look the same
 *  whichever of them renders it. */
export function CatchMeUpButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="soft" size="sm" onClick={onClick}>
      <Sparkles size={15} aria-hidden /> Catch me up
    </Button>
  );
}

/** The same offer as a full-width row, for a list of other rows. */
export function CatchMeUpRow({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="catchUp__row" onClick={onClick}>
      <Sparkles size={13} aria-hidden />
      <span className="catchUp__label">Catch me up</span>
      <span className="catchUp__hint">the story so far, no spoilers</span>
    </button>
  );
}

export function CatchMeUp({
  track,
  positionMs,
  variant = 'row',
  open: openProp,
  onOpenChange,
}: {
  track: Track | null;
  /** Where the player is, when something is playing. Absent, the hub uses its
   *  own ledger - which is the whole point on the shelf. */
  positionMs?: number;
  /** `none` renders no trigger: the host has its own, and is driving `open`. */
  variant?: 'row' | 'button' | 'none';
  /*
   * Controlled, for a host that is ITSELF a dialog.
   *
   * The book sheet on the shelf is a Modal, and a Modal opened from inside one
   * stacks two overlays and two focus traps over each other - which looks
   * exactly as wrong as it sounds. So that host closes itself and drives this
   * one instead, and only ever one dialog is up.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [self, setSelf] = useState(false);
  const open = openProp ?? self;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setSelf(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const [ask, setAsk] = useState<Ask | null>(null);
  // The last answer and the mark it was written for. A reopened dialog inside
  // the same minute shows it again instead of paying for the model twice.
  const held = useRef<{ got: CatchUp; ms: number } | null>(null);
  const live = useRef(0);

  const run = useCallback(
    async (fresh: boolean) => {
      if (!track) return;
      const ticket = ++live.current;
      setAsk({ kind: 'asking' });
      const answer = await fetchCatchUp(track, positionMs, fresh);
      if (ticket !== live.current) return;
      if (answer.ready) {
        held.current = { got: answer, ms: positionMs ?? answer.upto.ms };
        setAsk({ kind: 'ready', got: answer });
      } else {
        setAsk({ kind: 'none', why: answer.reason });
      }
    },
    [track, positionMs],
  );

  /*
   * A different book is a different question; nothing carries over.
   *
   * Guarded on an actual CHANGE rather than firing on mount, and declared
   * before the effect that asks. Unguarded it ran on the first render too,
   * bumping the ticket and throwing away the very answer the open below had
   * just gone to fetch - a dialog that opened empty and stayed empty.
   */
  const seen = useRef<[string | undefined] | null>(null);
  useEffect(() => {
    const path = track?.path;
    if (seen.current && seen.current[0] !== path) {
      held.current = null;
      live.current++;
      setAsk(null);
    }
    seen.current = [path];
  }, [track?.path]);

  useEffect(() => {
    if (!open) return;
    const kept = held.current;
    if (kept && Math.abs((positionMs ?? kept.ms) - kept.ms) < 60_000) {
      setAsk({ kind: 'ready', got: kept.got });
      return;
    }
    void run(false);
    // Deliberately not re-run as the position ticks: a recap being written
    // while the book plays on must not restart itself every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!track || track.kind !== 'book') return null;

  const start = () => setOpen(true);
  const got = ask?.kind === 'ready' ? ask.got : null;

  return (
    <>
      {variant === 'row' && <CatchMeUpRow onClick={start} />}
      {variant === 'button' && <CatchMeUpButton onClick={start} />}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title="Catch me up"
        description={track.album || track.title}
        footer={
          got ? (
            <div className="catchUp__foot">
              <Text size="xs" tone="muted">
                Up to {got.upto.label}
                {got.stale ? ' · kept from earlier' : got.cached ? ' · written earlier' : ''}
              </Text>
              <Button variant="ghost" size="sm" onClick={() => void run(true)}>
                <RotateCw size={14} aria-hidden /> Write it again
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="catchUp">
          {ask?.kind === 'asking' && (
            <div className="catchUp__wait">
              <Spinner size="md" aria-label="" />
              <Text size="sm" tone="muted">
                Reading back to where you stopped. This can take a minute.
              </Text>
            </div>
          )}

          {ask?.kind === 'none' && (
            <Text size="sm" tone="muted">
              {whyNot(ask.why)}
            </Text>
          )}

          {got && (
            <>
              {got.clipped && (
                <Text size="xs" tone="muted" className="catchUp__clip">
                  The earliest chapters are left out - this picks up part way in.
                </Text>
              )}
              {got.recap.map((para, i) => (
                <p key={i} className="catchUp__para">
                  {para}
                </p>
              ))}
              {got.threads.length > 0 && (
                <div className="catchUp__threads">
                  <span className="catchUp__threadsTitle">Where things stand</span>
                  <ul>
                    {got.threads.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
