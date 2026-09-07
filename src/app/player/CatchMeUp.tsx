import { Button, Modal, Spinner, Text } from '@glacier/react';
import { RotateCw, Sparkles } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../core/tauri.ts';
import { fetchCatchUp, type CatchUp, type NotReady } from './recap.ts';
import { useT } from '../i18n/LocaleShell.tsx';

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
 * Why there is nothing to show, as a key per reason.
 *
 * `recap.ts` used to answer this itself, in English, from a switch - which put
 * eight sentences of reader-facing copy in a file that otherwise only talks to
 * the hub. The reasons are a closed set the server names, so the mapping is a
 * table here and the words live in the catalogue with the rest of the dialog's.
 * Record<NotReady, ...> is the guard: a reason added upstream will not typecheck
 * until it has a line here.
 */
const WHY_NOT: Record<NotReady, string> = {
  'at-the-start': 'books.recapNotStarted',
  reading: 'books.recapNotRead',
  'no-transcript': 'books.recapNoTranscript',
  'no-model': 'books.recapNoModel',
  'model-silent': 'books.recapNoAnswer',
  'not-a-book': 'books.recapNotABook',
  'old-server': 'books.recapOldServer',
  offline: 'books.recapOffline',
};

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
  const t = useT();
  return (
    <Button variant="soft" size="sm" onClick={onClick}>
      <Sparkles size={15} aria-hidden /> {t('books.catchMeUp')}
    </Button>
  );
}

/** The same offer as a full-width row, for a list of other rows. */
export function CatchMeUpRow({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="catchUp__row" onClick={onClick}>
      <Sparkles size={13} aria-hidden />
      <span className="catchUp__label">{t('books.catchMeUp')}</span>
      <span className="catchUp__hint">{t('books.catchMeUpHint')}</span>
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
  const t = useT();
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
        title={t('books.catchMeUp')}
        description={track.album || track.title}
        footer={
          got ? (
            <div className="catchUp__foot">
              {/* One sentence, not "Up to" + a mark + a tail: where the recap
                  stops and how fresh it is are read together, and only the
                  freshest case has nothing to add. */}
              <Text size="xs" tone="muted">
                {got.stale
                  ? t('books.recapUpToKept', { mark: got.upto.label })
                  : got.cached
                    ? t('books.recapUpToEarlier', { mark: got.upto.label })
                    : t('books.recapUpTo', { mark: got.upto.label })}
              </Text>
              <Button variant="ghost" size="sm" onClick={() => void run(true)}>
                <RotateCw size={14} aria-hidden /> {t('books.recapWriteAgain')}
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
                {t('books.recapReadingBack')}
              </Text>
            </div>
          )}

          {ask?.kind === 'none' && (
            <Text size="sm" tone="muted">
              {t(WHY_NOT[ask.why])}
            </Text>
          )}

          {got && (
            <>
              {got.clipped && (
                <Text size="xs" tone="muted" className="catchUp__clip">
                  {t('books.recapClipped')}
                </Text>
              )}
              {got.recap.map((para, i) => (
                <p key={i} className="catchUp__para">
                  {para}
                </p>
              ))}
              {got.threads.length > 0 && (
                <div className="catchUp__threads">
                  <span className="catchUp__threadsTitle">{t('books.recapThreads')}</span>
                  <ul>
                    {got.threads.map((thread, i) => (
                      <li key={i}>{thread}</li>
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
