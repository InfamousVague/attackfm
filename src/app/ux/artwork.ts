//! The generated artwork set: frosted-physical stills (see
//! attackfm-artwork-plan.md - the app's own material language, one object
//! standing for each genre, mood, decade and empty state). This module is the
//! ONE table of what exists and what wears it: surfaces ask by meaning (a
//! genre name, a mix title, an empty-state name) and get a slug or null -
//! never a URL they built themselves. Every consumer keeps its old face as
//! the fallback, so an unreachable host looks exactly like yesterday.
//!
//! Served from the MAIN server (the same always-on box that runs the
//! registry), not from each library server: the set is one shared body of
//! art, not per-library data, so every install sees it without every home
//! hub having to carry and update its own copy. Publish once with
//! `npm run redeploy -- assets`.

// Brutalist card-background textures, bundled locally (not from the asset
// server): a fixed deck of 12 that replaces the old per-item hue gradient.
import tex01 from '../../assets/art/tex/tex-01.webp';
import tex02 from '../../assets/art/tex/tex-02.webp';
import tex03 from '../../assets/art/tex/tex-03.webp';
import tex04 from '../../assets/art/tex/tex-04.webp';
import tex05 from '../../assets/art/tex/tex-05.webp';
import tex06 from '../../assets/art/tex/tex-06.webp';
import tex07 from '../../assets/art/tex/tex-07.webp';
import tex08 from '../../assets/art/tex/tex-08.webp';
import tex09 from '../../assets/art/tex/tex-09.webp';
import tex10 from '../../assets/art/tex/tex-10.webp';
import tex11 from '../../assets/art/tex/tex-11.webp';
import tex12 from '../../assets/art/tex/tex-12.webp';

const CARD_TEXTURES = [tex01, tex02, tex03, tex04, tex05, tex06, tex07, tex08, tex09, tex10, tex11, tex12];

/**
 * A brutalist card-background texture, chosen by the same 0–360 hue hash that
 * used to pick a card's gradient - so a card keeps one stable texture and a
 * shelf still reads as varied, now as grit instead of a colour wash. Twelve
 * 30° buckets map evenly onto the twelve textures.
 */
export function cardTexture(hue: number): string {
  const i = Math.min(CARD_TEXTURES.length - 1, Math.floor(((hue % 360) + 360) % 360 / 30));
  return CARD_TEXTURES[i]!;
}

const ASSETS_URL =
  (import.meta.env?.VITE_ASSETS_URL as string | undefined)?.replace(/\/+$/, '') ||
  // The STATIC site, not a hub. This used to point at matt.attack.fm/api/assets,
  // which stopped working the day that domain's /api began proxying to the home
  // Mac: the publish step writes to the VPS, so every one of these 404ed. It
  // also meant a listener on somebody else's server fetched art through Matt's
  // house for no reason. Plain files on the marketing domain are neither.
  'https://attack.fm/art';

/**
 * A served asset's URL. Unauthenticated, cacheable, plain JPEG.
 *
 * A slug with a cut-out has TWO files published, and this picks between them.
 * That is not tidiness - it is the only way to change the art without breaking
 * the app as it stands on a phone that has not updated yet. An install running
 * yesterday's bundle multiplies whatever it is given over a gradient, and the
 * cut-outs are black-ground: multiplied, a black ground turns the whole card
 * black. It also knows nothing about CUTOUT_ART, so it asks for the plain slug
 * and keeps getting the white-ground still it was built for. Both files stay
 * published; neither has to wait for the other.
 */
export function artworkUrl(slug: string): string {
  return `${ASSETS_URL}/${slug}${CUTOUT_ART.has(slug) ? '-c' : ''}.jpg`;
}

/** "Hip-Hop" / "hip hop" / "R&B" → one comparable key. */
function genreKey(raw: string): string {
  return raw.toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]+/g, '');
}

/**
 * The ground a piece sits on. Each object came out of the generator on its
 * own hue (the plan gives every family one), so the card behind it wears
 * that same hue rather than a hash of the title - the gradient and the
 * object agree instead of clashing. Anything unlisted falls to a stable
 * hash, so a new slug still gets a colour of its own.
 */
const SLUG_HUE: Record<string, number> = {
  'genre-electronic': 190,
  'genre-rock': 22,
  'genre-hiphop': 285,
  'genre-pop': 330,
  'genre-jazz': 38,
  'genre-classical': 45,
  'genre-metal': 215,
  'genre-rnb': 315,
  'genre-ambient': 175,
  'genre-indie': 48,
  'genre-dance': 12,
  'genre-country': 25,
  'genre-anime': 340,
  'genre-jpop': 355,
  'genre-singer-songwriter': 285,
  'mood-chill': 205,
  'mood-energy': 55,
  'mood-focus': 40,
  'mood-late-night': 260,
  'decade-1980s': 300,
  'decade-1990s': 150,
  'decade-2000s': 165,
  'decade-2010s': 200,
  'curator-brain': 350,
  'curator-loop': 265,
  'curator-crystal': 210,
  'curator-hand': 230,
  'curator-mixtape': 30,
  'empty-library': 220,
  'empty-search': 195,
  'empty-playlist': 275,
  'empty-liked': 340,
  'empty-downloads': 160,
};

export function artworkHue(slug: string): number {
  const known = SLUG_HUE[slug];
  if (known !== undefined) return known;
  let h = 7;
  for (const ch of slug) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** The genre tiles, keyed by the names libraries actually use. */
const GENRE_ART = new Map<string, string>(
  Object.entries({
    electronic: 'genre-electronic',
    electronica: 'genre-electronic',
    edm: 'genre-electronic',
    techno: 'genre-electronic',
    house: 'genre-electronic',
    trance: 'genre-electronic',
    idm: 'genre-electronic',
    rock: 'genre-rock',
    altrock: 'genre-rock',
    alternativerock: 'genre-rock',
    alternative: 'genre-rock',
    punk: 'genre-rock',
    hiphop: 'genre-hiphop',
    hiphoprap: 'genre-hiphop',
    rap: 'genre-hiphop',
    pop: 'genre-pop',
    jazz: 'genre-jazz',
    classical: 'genre-classical',
    metal: 'genre-metal',
    heavymetal: 'genre-metal',
    rnb: 'genre-rnb',
    rnbsoul: 'genre-rnb',
    soul: 'genre-rnb',
    ambient: 'genre-ambient',
    downtempo: 'genre-ambient',
    indie: 'genre-indie',
    indierock: 'genre-indie',
    indiepop: 'genre-indie',
    singersongwriter: 'genre-singer-songwriter',
    singersongwriters: 'genre-singer-songwriter',
    songwriter: 'genre-singer-songwriter',
    acoustic: 'genre-singer-songwriter',
    anime: 'genre-anime',
    animesoundtrack: 'genre-anime',
    jpop: 'genre-jpop',
    japanesepop: 'genre-jpop',
    jrock: 'genre-jpop',
    dance: 'genre-dance',
    disco: 'genre-dance',
    country: 'genre-country',
    folk: 'genre-country',
    americana: 'genre-country',
    bluegrass: 'genre-country',
    // The harmonica is as much a blues object as a country one.
    blues: 'genre-country',
    // Funk and soul are one shelf, and the tape reel is the soul object.
    funk: 'genre-rnb',
    motown: 'genre-rnb',
    // The violin stands for anything written down.
    soundtrack: 'genre-classical',
    soundtracks: 'genre-classical',
    score: 'genre-classical',
    opera: 'genre-classical',
    orchestral: 'genre-classical',
    // Rooms off the same corridor as the ones already here.
    grunge: 'genre-rock',
    emo: 'genre-rock',
    hardrock: 'genre-rock',
    postrock: 'genre-rock',
    psychedelic: 'genre-rock',
    shoegaze: 'genre-indie',
    lofi: 'genre-ambient',
    chillout: 'genre-ambient',
    trap: 'genre-hiphop',
    drill: 'genre-hiphop',
    grime: 'genre-hiphop',
    dubstep: 'genre-electronic',
    dnb: 'genre-electronic',
    drumandbass: 'genre-electronic',
    drumnbass: 'genre-electronic',
    drumbass: 'genre-electronic',
    breakbeat: 'genre-electronic',
    garage: 'genre-electronic',
    synthwave: 'genre-electronic',
  }),
);

/**
 * Slugs whose picture is a dark-ground CUT-OUT rather than a white-ground still.
 *
 * The two kinds cannot wear the same treatment, and the difference is not
 * stylistic - it is arithmetic. The original set is an object photographed on
 * white, laid over a colour with `multiply`, which burns the white away and
 * prints the object dark. The halftone card wants the opposite: a dense field
 * with the object printed LIGHT, which needs `screen` - and screen turns a
 * white ground into a white card. There is no filter that rescues one into the
 * other, because on a white ground the object is darker than its background and
 * every blend that hides the background also hides the object.
 *
 * So this is a per-piece switch rather than a flag day. A slug named here gets
 * the halftone treatment; everything else keeps the old one and looks exactly
 * as it does today. Add a slug the day its new picture is published, and that
 * one tile changes.
 */
const CUTOUT_ART = new Set<string>([
  'genre-ambient',
  'genre-anime',
  'genre-classical',
  'genre-country',
  'genre-dance',
  'genre-electronic',
  'genre-hiphop',
  'genre-indie',
  'genre-jazz',
  'genre-jpop',
  'genre-metal',
  'genre-pop',
  'genre-rnb',
  'genre-rock',
  'genre-singer-songwriter',
  'mood-chill',
  'mood-energy',
  'mood-focus',
  'mood-late-night',
]);

/** Whether a slug's picture is built for the halftone (screened) treatment. */
export function isCutoutArt(slug: string | null | undefined): boolean {
  return !!slug && CUTOUT_ART.has(slug);
}

/**
 * The tile a genre wears, or null when no object stands for it yet.
 *
 * The whole name first, then its WORDS. Libraries label things compounds -
 * "Alternative & Indie", "Dance/Electronic", "Pop/Rock", "Country & Folk" - and
 * matching only the whole string meant every one of those came back with
 * nothing, on a shelf where its two halves both have an object sitting ready.
 * The table shows how that was being handled: `hiphoprap`, `rnbsoul`,
 * `indierock`, `heavymetal` are all whole compounds someone hit and pasted in
 * one at a time, which fixes the compound in front of you and none of the
 * others. A compound name is two genres with punctuation between them, and
 * either half is a true answer.
 *
 * mixArtwork already reads mix TITLES this way; this is the same rule finally
 * applied to the names too.
 */
export function genreArtwork(genre: string): string | null {
  const whole = GENRE_ART.get(genreKey(genre));
  if (whole) return whole;

  const words = genre.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // PAIRS before single words, because several genres are two words that only
  // mean something joined: "hip hop" and "lo fi" find nothing one word at a
  // time, and "post rock" would land on rock either way but for the wrong
  // reason. A pair is the more specific answer wherever both match.
  for (let i = 0; i < words.length - 1; i += 1) {
    const art = GENRE_ART.get(genreKey(words[i]! + words[i + 1]!));
    if (art) return art;
  }

  for (const word of words) {
    const art = GENRE_ART.get(genreKey(word));
    if (art) return art;
  }
  return null;
}

/** The five curator covers, dealt by mix id so one mix keeps one face. */
const CURATOR_ART = ['curator-brain', 'curator-loop', 'curator-crystal', 'curator-hand', 'curator-mixtape'];

function curatorArtwork(id: string): string {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return CURATOR_ART[h % CURATOR_ART.length]!;
}

/**
 * The cover a mix wears: a decade, a mood, or a genre named in its title
 * takes that object; anything else the AI made rotates through the curator
 * covers. Null means keep the track mosaic - a heuristic mix with no story
 * in its name is best told by what is actually inside it.
 */
export function mixArtwork(
  title: string,
  opts: { id: string; curated?: boolean; flavor?: 'ai' | 'heuristic' },
): string | null {
  const t = title.toLowerCase();
  if (/\b(19)?80s\b|\beighties\b/.test(t)) return 'decade-1980s';
  if (/\b(19)?90s\b|\bnineties\b/.test(t)) return 'decade-1990s';
  if (/\b2000s\b|\bnoughties\b/.test(t)) return 'decade-2000s';
  if (/\b2010s\b/.test(t)) return 'decade-2010s';
  if (/\bchill|\bcalm|\bunwind|\bslow\b/.test(t)) return 'mood-chill';
  if (/\benerg|\bhype|\bworkout|\bpump/.test(t)) return 'mood-energy';
  if (/\bfocus|\bstudy|\bconcentrat|\bdeep work/.test(t)) return 'mood-focus';
  if (/\blate night|\bmidnight|\bafter dark|\bnight\b/.test(t)) return 'mood-late-night';
  for (const word of t.split(/[^a-z0-9&]+/)) {
    const art = word && GENRE_ART.get(genreKey(word));
    if (art) return art;
  }
  if (opts.curated || opts.flavor === 'ai') return curatorArtwork(opts.id);
  return null;
}
