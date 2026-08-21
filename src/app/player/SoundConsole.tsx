import { useMemo, useState } from 'react';
import { CounterBadge, SegmentedControl, Switch } from '@glacier/react';
import { EqPanel } from './EqPanel.tsx';
import { FxRoom } from './FxRoom.tsx';
import { FiltersRoom } from './FiltersRoom.tsx';
import { StemsRoom, useStemsOut } from './StemsRoom.tsx';
import { FILTERS, signature } from './filters.ts';
import { FxSaved } from './FxSaved.tsx';
import { FX_NODES, silenceFxChain, useFxChain } from './fxChain.ts';

/**
 * The sound console: one door onto the whole signal path, extracted whole
 * from NowPlayingSheet. It was ~150 self-contained lines at the bottom of a
 * 900-line sheet, and PlayerStrip importing the SHEET to get at it was the
 * tell that it wanted its own file. Everything here moved verbatim - the
 * rooms, the persisted last-room key, and the chain row that keeps a
 * plugin-built chain visible after the plugin is gone.
 */
/**
 * The hi-fi chain's presence in CORE chrome, beside the EQ it composes with.
 *
 * The chain is edited in the console above, but a plugin can put nodes in it
 * too (Pedals does), its state persists, and plugins can be removed - and a
 * persistent audio process with no visible switch is the exact trap the old
 * effects rack solved by purging itself. This row is the other solution: as
 * long as a chain is colouring playback, the player itself says so and can
 * turn it off, whatever built it.
 */
/**
 * One door onto the whole signal path.
 *
 * These were two popovers - an equaliser and a pedalboard - on the reasoning
 * that they are different instruments and burying a stomp switch under an EQ
 * is how you fail to find it mid-song. True, but the answer was wrong: two
 * icons for one signal chain made the third thing, the hi-fi rack, homeless,
 * and it had to make do with a single switch at the bottom of the EQ.
 *
 * A segmented control fixes the finding problem better than a second icon
 * did. One place to reach for sound, three rooms behind it, and the room you
 * were last in is where you land next time - the chain persists, so the
 * console should remember which end of it you were working on.
 */
/** The console's three rooms: the graphic EQ, the chain you build, and the
 *  shelf of finished sounds. */
type Room = 'eq' | 'hifi' | 'filters' | 'stems';

export function SoundConsole({ narrow }: { narrow: boolean }) {
  const chain = useFxChain();
  // How many parts are out of the song right now, for the tab's dot.
  const stemsOut = useStemsOut();
  const [room, setRoom] = useState<Room>(() => {
    try {
      const held = localStorage.getItem(CONSOLE_KEY);
      // 'pedals' is what this key held while the board was the third room.
      // Anyone whose last visit was there lands on Filters rather than on a
      // room that no longer exists - which would otherwise silently fall back
      // to EQ and look like the preference was never saved.
      if (held === 'pedals') return 'filters';
      return held === 'hifi' || held === 'filters' || held === 'stems' ? held : 'eq';
    } catch {
      return 'eq';
    }
  });

  const go = (next: Room) => {
    setRoom(next);
    try {
      localStorage.setItem(CONSOLE_KEY, next);
    } catch {
      // A storage that will not take the preference is not worth failing over.
    }
  };

  // What is actually in the chain, so the tabs can say so at a glance rather
  // than making somebody open each room to find out where their sound is
  // coming from.
  // Every live node, pedals included: the HiFi room lists the whole chain, so
  // a count that quietly skipped half of it would disagree with the room it
  // labels.
  const hifiCount = chain.nodes.filter((n) => n.on).length;

  // The Filters tab says which filter is on rather than how many boxes it is
  // made of: the whole point of a filter is that its parts are not the unit
  // anybody is thinking in.
  const filterOn = useMemo(() => {
    if (chain.nodes.length === 0) return null;
    const now = signature(chain.nodes.map((n) => ({ t: n.t, params: n.params })));
    return FILTERS.find((f) => signature(f.nodes) === now)?.name ?? null;
  }, [chain]);

  return (
    <div className="soundConsole">
      {/* A real header, outside the scroller.
          It used to be a sticky bar inside it, which meant it needed a frosted
          backdrop to hide the rows sliding underneath - and that backdrop is a
          second dark pane laid over a panel that is already glass, which is
          exactly the block it looked like. Nothing passes behind it now, so it
          needs no material of its own. */}
      <div className="soundConsole__tabs">
        <SegmentedControl
          aria-label="Sound"
          size="sm"
          fullWidth
          value={room}
          options={[
            { value: 'eq', label: 'EQ' },
            {
              value: 'hifi',
              label: (
                <span className="soundConsole__tab">
                  HiFi
                  {/* A count badge does hide itself at zero, but it is said
                      here too so the two tabs read the same way. */}
                  {hifiCount > 0 && <CounterBadge count={hifiCount} size="sm" tone="neutral" />}
                </span>
              ),
            },
            {
              value: 'stems',
              label: (
                <span className="soundConsole__tab">
                  Stems
                  {/* A count, not a dot: "two parts out" is a thing somebody
                      wants to know at a glance, and unlike a filter the number
                      genuinely means something. */}
                  {stemsOut > 0 && <CounterBadge count={stemsOut} size="sm" tone="accent" />}
                </span>
              ),
            },
            {
              value: 'filters',
              label: (
                <span className="soundConsole__tab">
                  Filters
                  {/* A dot, not a number: a filter is one thing or nothing, and
                      "1" would invite the question of what two would mean.
                      Rendered conditionally rather than leaning on count={0}:
                      CounterBadge hides a zero COUNT, but `dot` draws the dot
                      whatever the count is, so the tab claimed a filter was on
                      when none was. */}
                  {filterOn && (
                    <CounterBadge count={1} dot tone="accent" size="sm" aria-label={`${filterOn} is on`} />
                  )}
                </span>
              ),
            },
          ]}
          onValueChange={(v) => go(v as Room)}
        />
      </div>
      {/* The scroller. Moving it here from the popover panel is what lets the
          header above be a header: the panel no longer scrolls, so no row ever
          passes through its padding or behind the tabs. */}
      <div className="soundConsole__body">
        {room === 'eq' && (
          <>
            <EqPanel narrow={narrow} />
            <FxChainRow />
          </>
        )}
        {room === 'hifi' && (
          <>
            <FxRoom />
            {/* Below the room, because A/B and saving act on the whole chain -
                pedals and filters included - and hanging them inside one room
                made them look like that room's own. */}
            <FxSaved />
          </>
        )}
        {room === 'filters' && <FiltersRoom />}
        {room === 'stems' && <StemsRoom />}
      </div>
    </div>
  );
}

/** Which room of the console was last open. */
const CONSOLE_KEY = 'attackfm-sound-console-room';

function FxChainRow() {
  const chain = useFxChain();
  if (chain.nodes.length === 0) return null;
  const live = chain.nodes.filter((n) => n.on).length;
  return (
    <div className="eqFxChainRow">
      <span className="eqFxChainRow__label">
        HiFi chain · {live > 0 ? `${live} node${live === 1 ? '' : 's'}` : 'all out'}
      </span>
      {live > 0 && (
        <button type="button" className="eqFxChainRow__allOff" onClick={silenceFxChain}>
          All out
        </button>
      )}
    </div>
  );
}
