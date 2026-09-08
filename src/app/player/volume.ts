/**
 * The fader's numbers and the one rule that bends them.
 *
 * Unity, the ceiling and the detent are read by more than the fader itself -
 * the deck's initial level, the Connect bridge's clamp on a volume arriving
 * from another device, the Player's cap when boost is switched off - so they
 * are not the volume popover's private business and do not live inside it.
 */

/** Unity (0 dB) sits at 100; the fader runs on to 150 for a boost region. */
export const VOLUME_UNITY = 100;
export const VOLUME_MAX = 150;
// How far past unity the thumb must be dragged before it leaves the detent.
const DETENT_RADIUS = 6;

/** Snaps the fader to unity within a small band, so 100% takes a deliberate
 * extra drag to pass rather than being easy to skim over. */
export function snapToUnity(value: number): number {
  return Math.abs(value - VOLUME_UNITY) <= DETENT_RADIUS ? VOLUME_UNITY : value;
}
