/**
 * The second line under a settings row, which is a CLAIM about state.
 *
 * "Everything shared" and "nothing leaves this device" are opposite sentences
 * and one function decides which one a person reads before they open the pane
 * - so the only failure that matters here is the summary reporting the off
 * state as on. That is not a cosmetic bug: privacy switches are exactly the
 * settings people check without opening, and a row that says "all shared"
 * over four switches that are all off has told somebody the opposite of the
 * truth about where their listening goes.
 *
 * Assertions are on catalogue KEYS, not on English, so the copy can be
 * reworded and translated without a failure here; what is pinned is which
 * entry the code chose and the numbers it put in it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../i18n/translate.ts', () => ({
  translate: (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key,
}));

const { developerSummary, localAiSummary, privacySummary } = await import('./paneSummaries.ts');

/** The rail's own translator, spelled the same way as the module's mock so a
 *  case can read which entry was chosen. */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe('privacySummary', () => {
  it('says everything is shared only when NOTHING is switched off', () => {
    expect(privacySummary(true, true, true, true, t)).toBe('privacy.summaryAllShared');
  });

  it('DOES NOT say everything is shared when a switch is off', () => {
    /*
     * The whole point of the file. Each of these is one switch closed and
     * three open, and each must reach the "some off" sentence - a count that
     * looked at the wrong end of the array, or a truthiness check that read a
     * `false` as absent, lands back on "all shared" for a person who has
     * deliberately closed something.
     */
    expect(privacySummary(false, true, true, true, t)).toContain('privacy.summarySomeOff');
    expect(privacySummary(true, false, true, true, t)).toContain('privacy.summarySomeOff');
    expect(privacySummary(true, true, false, true, t)).toContain('privacy.summarySomeOff');
    expect(privacySummary(true, true, true, false, t)).toContain('privacy.summarySomeOff');
  });

  it('says nothing leaves the device only when all four are off', () => {
    expect(privacySummary(false, false, false, false, t)).toBe('privacy.summaryNothingLeaves');
    // Three of four is not "nothing leaves" - the fourth one still does.
    expect(privacySummary(true, false, false, false, t)).toContain('privacy.summarySomeOff');
  });

  it('counts the switches that are OFF, not the ones that are on', () => {
    // The line exists to tell somebody they have closed something. Counting
    // the other way gives "1 of 4" for the person who closed three, which is
    // a true number attached to the wrong noun.
    expect(privacySummary(false, false, true, true, t)).toBe(
      'privacy.summarySomeOff({"count":2,"total":4})',
    );
    expect(privacySummary(false, false, false, true, t)).toBe(
      'privacy.summarySomeOff({"count":3,"total":4})',
    );
  });

  it('passes both numbers as holes rather than building "2 of 4" itself', () => {
    // "2 of 4" is not a fixed phrase, and the count still selects a plural
    // form in the languages that have one - so the entry needs both.
    const line = privacySummary(false, true, true, true, t);
    expect(line).toContain('"count":1');
    expect(line).toContain('"total":4');
  });

  it('knows how many switches there are without being told', () => {
    // The total is the array's own length. Hard-coded, it goes stale the day
    // a fifth switch is added and the row reads "5 of 4".
    expect(privacySummary(false, false, false, false, t)).not.toContain('"total"');
    expect(privacySummary(true, true, true, false, t)).toContain('"total":4');
  });
});

describe('the two fixed lines', () => {
  it('reads Local AI through the translator it was handed', () => {
    // Handed, not fetched: this one is read during the settings hub's render,
    // so it has to follow a language change like everything else on screen.
    expect(localAiSummary(t)).toBe('settings.summaryLocalAi');
  });

  it('reads Developer through the non-reactive translator', () => {
    // The rail calls this one with no argument at all - it reaches for
    // `translate()`, which is right precisely because the rail re-renders on
    // a language change and calls it again.
    expect(developerSummary()).toBe('settings.devSummary');
  });
});
