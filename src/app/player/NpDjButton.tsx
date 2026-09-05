import { useEffect, useState, type CSSProperties } from 'react';
import { Button, IconButton, Popover, Spinner, Text } from '@glacier/react';
import { djDoorOpen, openDj } from '../nav/djDoor.ts';
import { Bot, Sparkles, MessageCircle } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { usePlayNowOptional } from './playNow.tsx';
import { startDjRun } from '../booth/djSession.ts';
import { MOODS } from '../booth/DjLauncher.tsx';
import { fireNativeHaptic } from '../core/haptics.ts';

/**
 * The DJ, at the decks: a seat on the Now Playing action row that starts a
 * live set right here - by request, so the voice can be met where the music
 * already is instead of a page away in the Booth. The panel is the Booth's
 * own vocabulary (the taste hero, the mood chips - the same MOODS list, so
 * the two doors cannot drift), and the set it starts is the same shared run
 * (djSession) the Booth publishes: the bridge toasts the lines and speaks
 * the beats no matter which door opened the set.
 */
/** What the DJ is up to while you wait - cycled under the countdown disc. */
const CUE_LINES = [
  'Reading the room…',
  'Digging the crates…',
  'Matching the mood…',
  'Lining up the opener…',
  'Dropping the needle…',
];

/** The wait budget the countdown paces itself to - the server holds the
 *  patter model to five seconds, so the whole reply lands inside this. */
const CUE_SECONDS = 8;

/**
 * The cueing face: a spinning record that fills its rim as the seconds run
 * down, a big number in the label, and the DJ's busywork narrated line by
 * line. If the set lands early the panel simply closes mid-count; if the
 * count runs dry first, the number gives way to an ellipsis and the disc
 * keeps spinning - a promise, not a stopwatch.
 */
function DjCountdown() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(tick);
  }, []);
  const left = Math.max(0, CUE_SECONDS - elapsed);
  const frac = Math.min(1, elapsed / CUE_SECONDS);
  const line = CUE_LINES[Math.min(CUE_LINES.length - 1, Math.floor(elapsed / 1.7))]!;
  /* An explicit SVG progress ring rather than a conic paint: the conic read
     as a faint rim on a real phone, and a countdown whose progress cannot be
     seen is just a number. dashoffset walks the circumference down as the
     seconds do. */
  const R = 42;
  const C = 2 * Math.PI * R;
  return (
    <div className="npDjCue" role="status" aria-live="polite">
      <span className="npDjCue__disc">
        <svg className="npDjCue__ring" viewBox="0 0 100 100" aria-hidden>
          <circle className="npDjCue__rail" cx="50" cy="50" r={R} />
          <circle
            className="npDjCue__fill"
            cx="50"
            cy="50"
            r={R}
            transform="rotate(-90 50 50)"
            style={{ strokeDasharray: C, strokeDashoffset: C * (1 - frac) } as CSSProperties}
          />
        </svg>
        <span className="npDjCue__num">{left > 0.05 ? Math.ceil(left) : '…'}</span>
      </span>
      <span className="npDjCue__line">{line}</span>
    </div>
  );
}

export function NpDjButton() {
  const { session } = useServerSession();
  const { tracks, forYou } = useLibrary();
  const play = usePlayNowOptional();
  const [open, setOpen] = useState(false);
  const [busySeed, setBusySeed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = busySeed !== null;

  // No server, no library, no play door: the seat simply is not there.
  if (!session || !play || tracks.length === 0) return null;

  const start = async (seed: string) => {
    setBusySeed(seed);
    setNote(null);
    try {
      const { queue } = await startDjRun(session, [...tracks, ...forYou], seed);
      const opener = queue[0];
      if (!opener) {
        setNote('The DJ came up empty. Play a few things first.');
        return;
      }
      // Close FIRST: starting the set re-renders the whole sheet (new
      // track), and unmounting a kit Popover while it is open strands its
      // portalled panel on screen. Shut the door, then change the record.
      setOpen(false);
      fireNativeHaptic('medium');
      play(opener, queue);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'The DJ could not start.');
    } finally {
      setBusySeed(null);
    }
  };

  return (
    <Popover
      placement="top"
      aria-label="DJ"
      className="popoverSheet npDjPanel"
      open={open}
      onOpenChange={setOpen}
      trigger={
        /* A robot head, not a record. Every other disc in the app means an
           ALBUM (the library tiles, the Booth platter, the notification for a
           new record), so the one control that summons the AI voice was
           wearing the same glyph as the thing it plays. The DJ is a machine
           that talks - say so, and the seat stops reading as "another album
           button" on a row where the neighbours are a book and a microphone. */
        <IconButton variant="ghost" aria-label="Start a DJ set">
          <Bot size={20} />
        </IconButton>
      }
    >
      <div className="npDj">
        {busy ? (
          <DjCountdown />
        ) : (
          <>
        <Button
          type="button"
          variant="gradient"
          fullWidth
          disabled={busy}
          onClick={() => void start('')}
        >
          {busySeed === '' ? <Spinner size="sm" aria-label="Cueing" /> : <Sparkles size={15} />}
          From my taste
        </Button>
        {/* The conversation - and its microphone. This popover was the only
            DJ door outside the developer-mode Booth, and it could start a
            set but never talk. */}
        {djDoorOpen() && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            fullWidth
            className="npDj__talk"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              openDj();
            }}
          >
            <MessageCircle size={15} />
            Talk to the DJ
          </Button>
        )}
        <div className="npDj__chips" role="group" aria-label="Set the mood">
          {MOODS.map(({ label, seed, Icon }) => (
            <Button
              key={label}
              type="button"
              variant={busySeed === seed ? 'solid' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={() => void start(seed)}
            >
              {busySeed === seed ? <Spinner size="sm" aria-label="Cueing" /> : <Icon size={14} />}
              {label}
            </Button>
          ))}
        </div>
        {note && (
          <Text size="xs" tone="muted">
            {note}
          </Text>
        )}
          </>
        )}
      </div>
    </Popover>
  );
}
