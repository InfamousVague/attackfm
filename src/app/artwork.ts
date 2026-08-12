//! The generated artwork set: frosted-physical stills served by the home
//! server at `/api/assets` (see attackfm-artwork-plan.md - the app's own
//! material language, one object standing for each genre, mood, decade and
//! empty state). This module is the ONE table of what exists and what wears
//! it: surfaces ask by meaning (a genre name, a mix title, an empty-state
//! name) and get a slug or null - never a URL they built themselves. Every
//! consumer keeps its old face as the fallback, so a server without the set
//! (or no server at all) looks exactly like yesterday.

/** A served asset's URL. Unauthenticated, cacheable, plain JPEG. */
export function artworkUrl(session: { url: string }, slug: string): string {
  return `${session.url.replace(/\/+$/, '')}/api/assets/${slug}.jpg`;
}

/** "Hip-Hop" / "hip hop" / "R&B" → one comparable key. */
function genreKey(raw: string): string {
  return raw.toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]+/g, '');
}

/** The twelve genre tiles, keyed by the names libraries actually use. */
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
    dance: 'genre-dance',
    disco: 'genre-dance',
    country: 'genre-country',
    folk: 'genre-country',
  }),
);

/** The tile a genre wears, or null when no object stands for it yet. */
export function genreArtwork(genre: string): string | null {
  return GENRE_ART.get(genreKey(genre)) ?? null;
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

/** The empty states the set covers; the rest keep their painted pairs. */
const EMPTY_ART: Record<string, string> = {
  library: 'empty-library',
  search: 'empty-search',
  playlist: 'empty-playlist',
  liked: 'empty-liked',
  downloads: 'empty-downloads',
};

export function emptyArtwork(name: string): string | null {
  return EMPTY_ART[name] ?? null;
}
