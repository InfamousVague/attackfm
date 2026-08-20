# Artwork prompts: the cut-out set

Nineteen pieces — fifteen genres and four moods — to replace the white-ground
stills that those cards wear today.

## Why a new set at all

The card treatment we picked (reversed halftone: a dense flat field of one
colour with a dot screen knocked out of it in white) prints its object **light**.
That needs `mix-blend-mode: screen`, and screen makes black transparent and
white opaque.

The existing set is the exact opposite by construction: an object photographed
on **white**, laid over a colour with `multiply`, which burns the white away and
prints the object dark. There is no filter that turns one into the other. On a
white ground the object is *darker* than its background, so every blend that
hides the background also hides the object, and every blend that shows the
object also shows the white.

So the two kinds coexist until this set is finished. `CUTOUT_ART` in
`src/app/ux/artwork.ts` names the slugs whose picture is a cut-out; a slug in
that set gets the screened treatment and everything else keeps the old one.
**Add a slug the day its picture is published** and that one card changes — no
flag day, no half-finished wall.

## Requirements every piece must meet

These are not style preferences; the treatment breaks without them.

| | |
|---|---|
| **Ground** | Pure black, `#000000`, edge to edge. Not dark grey — screen leaves grey behind as a visible box. |
| **Framing** | One object, centred, with generous empty margin on every side. It is drawn `object-fit: contain`, so anything touching the frame edge gets clipped by the card's corner radius. |
| **Value** | The object must be clearly *brighter* than its ground everywhere it matters. It is desaturated and pushed to `contrast(1.7)` before it lands, so anything in the bottom third of the tonal range disappears. |
| **Colour** | Neutral — white, silver, colourless glass. Every piece is re-tinted to its card's own hue in CSS, and a colour cast in the file fights that tint. |
| **Silhouette** | Readable at 80 × 55 px. That is the real size of a Browse tile on a phone. |
| **Format** | Square, 1024 × 1024, no text, no logos, no watermarks, no people, no hands. |

## The house style

Same sentence in front of every subject below. It is the existing frosted-glass
language relit for a dark ground, so the two sets sit together during the
changeover instead of looking like two apps.

> Studio product photograph of **{SUBJECT}**, sculpted from thick frosted opal
> glass with a warm light source inside it so the whole form glows softly from
> within. Pure black background, edge to edge, nothing else in frame. A soft rim
> light along the top-left edge picks out the silhouette. The object is centred
> with generous empty margin on all sides and is not cropped. Neutral white
> glass, no colour cast. Photorealistic, sharp, high detail, square 1:1,
> 1024×1024. No text, no logos, no people, no hands, no background objects.

## The nineteen

Each line is the `{SUBJECT}` to drop into the house style. The slug is the
filename: `<slug>.jpg` in `server/assets/artwork/`.

### Genres

| # | Slug | Subject |
|---|---|---|
| 1 | `genre-electronic` | a modular synthesiser panel with a knot of patch cables looping out of its jacks |
| 2 | `genre-rock` | the headstock of an electric guitar, six tuning pegs, strings running out of frame at the nut |
| 3 | `genre-hiphop` | a turntable tonearm and cartridge resting on the outer edge of a record |
| 4 | `genre-pop` | a handheld vocal microphone seen head-on, its ball grille filling most of the form |
| 5 | `genre-jazz` | the bell and upper keywork of a tenor saxophone, angled across the frame |
| 6 | `genre-classical` | the scroll and pegbox of a violin, seen three-quarters on |
| 7 | `genre-metal` | three heavy chain links, the middle one standing proud of the other two |
| 8 | `genre-rnb` | a reel-to-reel tape reel, half unspooled, the loose tape falling in one soft curve |
| 9 | `genre-ambient` | a glass cloche standing over a low bank of still mist |
| 10 | `genre-indie` | a tambourine lying flat, its jingles catching the light |
| 11 | `genre-dance` | a mirror ball, its facets picked out as a grid of small flat planes |
| 12 | `genre-country` | a diatonic harmonica seen from the side, comb and cover plate visible |
| 13 | `genre-anime` | a pair of over-ear headphones with rounded cat-ear shells on the band |
| 14 | `genre-jpop` | a paper lantern with its ribbing showing through the shade |
| 15 | `genre-singer-songwriter` | a capo clamped across the fretted neck of an acoustic guitar |

### Moods

| # | Slug | Subject |
|---|---|---|
| 16 | `mood-chill` | three smooth river pebbles balanced in a stack |
| 17 | `mood-energy` | a lightning bolt sculpted as a single thick solid form |
| 18 | `mood-focus` | the head of an angled desk lamp, throwing one clean cone of light downward |
| 19 | `mood-late-night` | a crescent moon with a soft halo around its outer edge |

## Publishing one

1. Save as `server/assets/artwork/<slug>.jpg`, square, 1024 × 1024.
2. `npm run redeploy -- assets`
3. Add `'<slug>'` to `CUTOUT_ART` in `src/app/ux/artwork.ts`.
4. `npm run ship`

Step 3 is what actually changes the card. Until it is done the new picture is
published but unused, which is the safe order: an unreferenced file breaks
nothing, a referenced missing file is a card with a hole in it.

## Checking one before you commit to nineteen

The fastest test is the card lab (Settings → About, seven presses on the
wordmark): direction **33, Halftone: reversed** is the treatment these are
being made for. A piece that reads there will read on the card.
