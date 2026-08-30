/**
 * The date briefing's own switch, per device like the DJ voice's: on unless
 * turned off, stored only when off. Kept apart from `attackfm-dj-voice` so a
 * listener can have a talking DJ and a quiet date, or the reverse.
 */
const PREF = 'attackfm-date-voice';

export function dateVoiceEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) !== 'off';
  } catch {
    return true;
  }
}

export function setDateVoice(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF);
    else localStorage.setItem(PREF, 'off');
  } catch {
    // Storage refused: the choice still holds for this run.
  }
}
