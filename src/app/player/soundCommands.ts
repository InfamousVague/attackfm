import type { ConnectCommand } from './connect.ts';
import fixture from '../../../shared/sound-commands.json';

/**
 * The client's end of `shared/sound-commands.json` - the one spelling of the
 * commands that carry the SOUND to whichever device is playing.
 *
 * WHY A FIXTURE AND NOT A CONSTANT IN EACH LANGUAGE. The hub is Rust and this
 * is TypeScript, and the two used to name these words in hand-written literals
 * on both sides - including in their tests, which is how `gains` came to be
 * dropped in transit with both suites green. Nothing linked the two spellings,
 * so nothing could notice they had stopped agreeing. Now the JSON is the
 * contract: connect.rs's tests read it to check that the hub classifies these
 * actions as sound and that a frame carrying each payload survives serde, and
 * this module reads it to build every frame that goes out.
 *
 * The type is load-bearing, not decoration. `SoundAction` is the fixture's own
 * keys, so a fourth sound store added in TypeScript alone cannot reach
 * `soundFrame` and cannot appear in `ConnectCommand`: it has to be named here
 * first, which is what makes the hub's suite go red until the hub is taught
 * about it too. That is the whole point - it is the failure the mix had, and a
 * "we will remember next time" is not a mechanism.
 */
const COMMANDS = fixture.commands;

/** An action that shapes the sound rather than driving the transport. */
export type SoundAction = keyof typeof COMMANDS;

/** Every one of them, in the fixture's order. */
export const SOUND_ACTIONS = Object.keys(COMMANDS) as SoundAction[];

/** What the payload of each is called on the wire. */
export function soundField(action: SoundAction): string {
  return COMMANDS[action].field;
}

export function isSoundAction(action: string): action is SoundAction {
  return Object.prototype.hasOwnProperty.call(COMMANDS, action);
}

/**
 * One frame, built from the fixture rather than from a literal at the call
 * site - so the name of the field and the name of the action move together and
 * move with the hub.
 *
 * The payload is always the WHOLE of one store, never the control that just
 * moved: a dropped frame then cannot leave the two ends holding different
 * sounds, and a device that arrives late is handed the room rather than a diff
 * of it.
 */
export function soundFrame(action: SoundAction, payload: unknown): ConnectCommand {
  // The key is read out of the fixture, so the compiler cannot see which field
  // is being set - the assertion says "this is a command", and what makes that
  // true is `ConnectCommand` declaring one optional field per action, named
  // from the same file.
  return { action, [soundField(action)]: payload } as ConnectCommand;
}
