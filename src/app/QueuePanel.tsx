//! The queue, laid open on the Now Playing sheet: what is playing, and the line
//! of songs behind it that you can drag into whatever order you like or lift out
//! entirely. The list is the play order - a reorder here is what the deck's own
//! skips will follow, and (over AttackFM Connect) what every other device sees.
//!
//! Only the UPCOMING run is editable: the current track is pinned at the top and
//! anything already played has left the line. Reordering resolves through the
//! kit's SortableList, which carries both drag and full keyboard reordering.

import { Button, IconButton, Slider, SortableList, Text } from '@glacier/react';
import { ChevronDown, Music, Radio, X } from '@glacier/icons';
import { artSized } from './server.ts';
import { useArtLoad } from './artLoad.ts';
import { useRadioOptional } from './radio.tsx';
import type { Track } from './tauri.ts';

interface QueueRow {
  id: string;
  track: Track;
}

export function QueuePanel({
  queue,
  current,
  onQueueChange,
  onPlayTrack,
  onClose,
  inJam = false,
}: {
  queue: Track[];
  current: Track | null;
  /** The new play order, current track and all. Skips read whatever it holds. */
  onQueueChange: (next: Track[]) => void;
  /** Jump straight to a queued track. */
  onPlayTrack: (track: Track) => void;
  onClose: () => void;
  inJam?: boolean;
}) {
  // The current track's spot splits the line: everything after it is still to
  // come. With the current track absent from the queue (a lone DJ pick, say),
  // there is nothing behind it to arrange.
  const curIdx = current ? queue.findIndex((t) => t.path === current.path) : -1;
  const head = curIdx >= 0 ? queue.slice(0, curIdx + 1) : queue.slice();
  const upcoming = curIdx >= 0 ? queue.slice(curIdx + 1) : [];
  const rows: QueueRow[] = upcoming.map((t) => ({ id: t.path, track: t }));

  // The station, when one is on: the queue is where "what's next" is read, so
  // it is where the dial belongs.
  const radio = useRadioOptional();

  const reorder = (next: QueueRow[]) => onQueueChange([...head, ...next.map((r) => r.track)]);
  const remove = (path: string) => onQueueChange(queue.filter((t) => t.path !== path));

  return (
    <div className="queuePanel" role="dialog" aria-label="Queue">
      <header className="queuePanel__head">
        <span className="queuePanel__title">{inJam ? 'Jam queue' : 'Queue'}</span>
        <IconButton variant="ghost" aria-label="Close queue" onClick={onClose}>
          <ChevronDown size={22} />
        </IconButton>
      </header>

      <div className="queuePanel__body">
        {/* On air: what it was seeded from, the two knobs, and the way out.
            The list below keeps filling itself for as long as this is here. */}
        {radio?.on && (
          <div className="radioBar">
            <div className="radioBar__head">
              <span className="radioBar__title">
                <Radio size={15} />
                {radio.seed ? `Radio from ${radio.seed.title}` : 'Radio'}
              </span>
              <Button variant="ghost" size="sm" onClick={radio.stop}>
                Stop
              </Button>
            </div>
            <label className="radioBar__dial">
              <span>Calmer</span>
              <Slider
                aria-label="Energy"
                min={-1}
                max={1}
                step={0.1}
                value={radio.dial.energy}
                onValueChange={(v) => radio.setDial({ energy: v })}
              />
              <span>Harder</span>
            </label>
            <label className="radioBar__dial">
              <span>Deep cuts</span>
              <Slider
                aria-label="Familiarity"
                min={0}
                max={1}
                step={0.1}
                value={radio.dial.familiar}
                onValueChange={(v) => radio.setDial({ familiar: v })}
              />
              <span>Favourites</span>
            </label>
            {radio.filling && (
              <Text size="xs" tone="subtle">
                Finding the next few…
              </Text>
            )}
          </div>
        )}

        {current && (
          <div className="queueNow">
            <span className="queueNow__label">Now playing</span>
            <div className="queueRow queueRow--now">
              <Cover track={current} />
              <div className="queueRow__meta">
                <span className="queueRow__title">{current.title}</span>
                <span className="queueRow__artist">{current.artist}</span>
              </div>
            </div>
          </div>
        )}

        <div className="queueUp">
          <span className="queueUp__label">Next up</span>
          {rows.length === 0 ? (
            <Text tone="muted" size="sm" className="queueUp__empty">
              Nothing queued. Add songs from anywhere with “Add to queue,” and
              they line up here.
            </Text>
          ) : (
            <SortableList
              items={rows}
              onReorder={reorder}
              getLabel={(r) => r.track.title}
              className="queueSortable"
              renderItem={(r) => (
                <div className="queueRow">
                  <button
                    type="button"
                    className="queueRow__play"
                    onClick={() => onPlayTrack(r.track)}
                  >
                    <Cover track={r.track} />
                    <div className="queueRow__meta">
                      <span className="queueRow__title">{r.track.title}</span>
                      <span className="queueRow__artist">{r.track.artist}</span>
                    </div>
                  </button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${r.track.title} from the queue`}
                    onClick={() => remove(r.track.path)}
                  >
                    <X size={16} />
                  </IconButton>
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Cover({ track }: { track: Track }) {
  // Queue rows draw the cover at thumb size, so the 160 variant carries it;
  // the skeleton shimmer holds the square until the bytes arrive.
  const src = artSized(track.artwork, 160);
  const art = useArtLoad(src, '');
  return (
    <span className="queueRow__cover" aria-hidden>
      {track.artwork ? <img {...art} src={src ?? undefined} alt="" loading="lazy" /> : <Music size={16} />}
    </span>
  );
}
