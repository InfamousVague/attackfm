import { useState } from 'react';
import { Button, IconButton, Popover, Spinner, Text } from '@glacier/react';
import { Disc3, Sparkles } from '@glacier/icons';
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
export function NpDjButton() {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
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
      const { queue } = await startDjRun(session, tracks, seed);
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
        <IconButton variant="ghost" aria-label="Start a DJ set">
          <Disc3 size={20} />
        </IconButton>
      }
    >
      <div className="npDj">
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
      </div>
    </Popover>
  );
}
