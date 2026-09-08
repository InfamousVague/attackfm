import { describe, expect, it } from 'vitest';
import { mixArt } from './mixArt.ts';
import { artworkHue, artworkUrl, mixArtwork } from '../ux/artwork.ts';

/**
 * The face a mix wears on a shelf card.
 *
 * Two answers, and the difference between them is a whole card design: an
 * OBJECT (a decade, a mood, a genre, one of the five curator covers) sits on
 * a tinted ground, and NULL means the mix keeps the 2x2 mosaic of what is
 * actually inside it. A heuristic mix with no story in its name is best told
 * by its own contents, so a function that always found a picture would put a
 * generic object over every rail on the page.
 *
 * The slug rules themselves belong to `artwork.ts` and are its business; what
 * this function owes is the PAIRING - the URL and the hue of the ground it
 * sits on have to name the same slug, or the card is one object over another
 * object's colour.
 */

describe('mixArt', () => {
  it('pairs the URL and the hue off ONE slug', () => {
    /*
     * The whole reason this is a function and not two call sites. Resolve the
     * slug twice and a card can end up with the late-night cover on the chill
     * mix's ground - and nothing about the card would say it was wrong.
     */
    const art = mixArt('Late night drive', { id: 'm1' })!;
    const slug = mixArtwork('Late night drive', { id: 'm1' })!;
    expect(art.src).toBe(artworkUrl(slug));
    expect(art.hue).toBe(artworkHue(slug));
  });

  it('keeps the mosaic - null - when the name tells no story', () => {
    // The counter-case, and the one a careless edit erases first: a default
    // picture here would take the covers off every heuristic mix at once.
    expect(mixArt('Songs about nothing', { id: 'm1' })).toBeNull();
    expect(mixArt('Songs about nothing', { id: 'm1', flavor: 'heuristic' })).toBeNull();
  });

  it('always finds a face for a curated or AI mix, story or not', () => {
    // The other half of that rule: a mix the machine wrote a name for gets
    // one of the five curator covers rather than falling back to a mosaic.
    expect(mixArt('Songs about nothing', { id: 'm1', curated: true })).not.toBeNull();
    expect(mixArt('Songs about nothing', { id: 'm1', flavor: 'ai' })).not.toBeNull();
  });

  it('deals a curator cover by ID, so one mix keeps one face across renders', () => {
    // The shelf re-renders on every feed poll. A face picked at random would
    // shuffle the rail under the reader's hand.
    const first = mixArt('Songs about nothing', { id: 'm1', curated: true });
    expect(mixArt('Songs about nothing', { id: 'm1', curated: true })).toEqual(first);
    // ...and two mixes are not dealt the same one just because they are both
    // curated - that is what makes it a rail of five faces and not one.
    expect(mixArt('Anything else', { id: 'm2', curated: true })).not.toEqual(first);
  });

  it('reads the story out of the title rather than the id', () => {
    // A decade, a mood and a genre each take their own object, and the id is
    // only ever the tie-breaker for a name that says nothing.
    expect(mixArt('Best of the 90s', { id: 'm1' })?.src).toContain('decade-1990s');
    expect(mixArt('Chill Sunday', { id: 'm1' })?.src).toContain('mood-chill');
    expect(mixArt('Jazz hours', { id: 'm1' })?.src).toContain('genre-jazz');
  });

  it('asks for a real published file, not a slug', () => {
    // The caller puts this straight into an <img src>. A slug leaking through
    // would be a broken image on every card at once.
    expect(mixArt('Best of the 90s', { id: 'm1' })?.src).toMatch(/^https?:\/\/.+\.jpg$/);
  });
});
