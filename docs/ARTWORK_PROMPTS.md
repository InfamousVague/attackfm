# Artwork prompts: the cut-out set

Nineteen pieces - fifteen genres and four moods - to replace the white-ground
stills those cards wear today. **Every prompt below is complete.** Paste one as
it stands; there is nothing to assemble.

## Why a new set at all

The card treatment (reversed halftone: a dense flat field of one colour with a
dot screen knocked out of it in white) prints its object **light**. That needs
`mix-blend-mode: screen`, and screen makes black transparent and white opaque.

The existing set is the exact opposite by construction: an object photographed
on **white**, laid over a colour with `multiply`, which burns the white away and
prints the object dark. No filter turns one into the other. On a white ground
the object is *darker* than its background, so every blend that hides the
background also hides the object, and every blend that shows the object also
shows the white.

So the two kinds coexist until this set is finished. `CUTOUT_ART` in
`src/app/ux/artwork.ts` names the slugs whose picture is a cut-out; a slug in
that set gets the screened treatment and everything else keeps the old one.
**Add a slug the day its picture is published** and that one card changes - no
flag day, no half-finished wall.

The four library chips already wear bundled cut-outs, which is why they took the
treatment immediately and these cards could not.

## Requirements that are arithmetic, not taste

The treatment breaks without these.

| | |
|---|---|
| **Ground** | Pure black, `#000000`, edge to edge. Not dark grey - screen leaves grey behind as a visible box. |
| **Framing** | One object, centred, with real margin on every side. It is drawn `object-fit: contain`, so anything touching the frame edge gets clipped by the card's corner radius. |
| **Value** | Clearly *brighter* than the ground everywhere it matters. It is desaturated and pushed to `contrast(1.7)` before it lands, so anything in the bottom third of the tonal range disappears. |
| **Colour** | Neutral - white, silver, colourless glass. Every piece is re-tinted to its card's own hue in CSS, and a colour cast in the file fights that tint. |
| **Silhouette** | Readable at 80 x 55 px. That is the real size of a Browse tile on a phone. |
| **Format** | Square, 1024 x 1024, no text, no logos, no watermarks, no people, no hands. |

The **hue** column below is the field colour each object lands on, from
`SLUG_HUE` in `artwork.ts` - the card is `hsl(<hue> 84% 34%)`. Judge a
generated image against that, not against white.


## Genres

### 01. Electronic

`genre-electronic.jpg` &middot; hue 190

```text
Studio product photograph of a modular synthesiser panel with a knot of patch cables looping out of its jacks, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 02. Rock

`genre-rock.jpg` &middot; hue 22

```text
Studio product photograph of the headstock of an electric guitar, six tuning pegs, strings running out of frame at the nut, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 03. Hip-hop

`genre-hiphop.jpg` &middot; hue 285

```text
Studio product photograph of a turntable tonearm and cartridge resting on the outer edge of a record, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 04. Pop

`genre-pop.jpg` &middot; hue 330

```text
Studio product photograph of a handheld vocal microphone seen head-on, its ball grille filling most of the form, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 05. Jazz

`genre-jazz.jpg` &middot; hue 38

```text
Studio product photograph of the bell and upper keywork of a tenor saxophone, angled across the frame, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 06. Classical

`genre-classical.jpg` &middot; hue 45

```text
Studio product photograph of the scroll and pegbox of a violin, seen three-quarters on, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 07. Metal

`genre-metal.jpg` &middot; hue 215

```text
Studio product photograph of three heavy chain links, the middle one standing proud of the other two, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 08. R&B / Soul

`genre-rnb.jpg` &middot; hue 315

```text
Studio product photograph of a reel-to-reel tape reel, half unspooled, the loose tape falling in one soft curve, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 09. Ambient

`genre-ambient.jpg` &middot; hue 175

```text
Studio product photograph of a glass cloche standing over a low bank of still mist, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 10. Indie

`genre-indie.jpg` &middot; hue 48

```text
Studio product photograph of a tambourine lying flat, its jingles catching the light, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 11. Dance

`genre-dance.jpg` &middot; hue 12

```text
Studio product photograph of a mirror ball, its facets picked out as a grid of small flat planes, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 12. Country / Folk

`genre-country.jpg` &middot; hue 25

```text
Studio product photograph of a diatonic harmonica seen from the side, comb and cover plate visible, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 13. Anime

`genre-anime.jpg` &middot; hue 340

```text
Studio product photograph of a pair of over-ear headphones with rounded cat-ear shells on the band, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 14. J-pop

`genre-jpop.jpg` &middot; hue 355

```text
Studio product photograph of a paper lantern with its ribbing showing through the shade, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 15. Singer-songwriter

`genre-singer-songwriter.jpg` &middot; hue 285

```text
Studio product photograph of a capo clamped across the fretted neck of an acoustic guitar, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```


## Moods

### 16. Chill

`mood-chill.jpg` &middot; hue 205

```text
Studio product photograph of three smooth river pebbles balanced in a stack, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 17. Energy

`mood-energy.jpg` &middot; hue 55

```text
Studio product photograph of a lightning bolt sculpted as a single thick solid form, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 18. Focus

`mood-focus.jpg` &middot; hue 40

```text
Studio product photograph of the head of an angled desk lamp, throwing one clean cone of light downward, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```

### 19. Late night

`mood-late-night.jpg` &middot; hue 260

```text
Studio product photograph of a crescent moon with a soft halo around its outer edge, sculpted from thick frosted opal glass with a warm light source inside it so the whole form glows softly from within. Pure black background, edge to edge, nothing else in frame. A soft rim light along the top-left edge picks out the silhouette. The object is centred with generous empty margin on all sides and is not cropped. Neutral white glass, no colour cast. Photorealistic, sharp, high detail, square 1:1, 1024x1024. No text, no logos, no people, no hands, no background objects.
```


## Publishing one

1. Save as `server/assets/artwork/<slug>.jpg`, square, 1024 x 1024.
2. `npm run redeploy -- assets`
3. Add `'<slug>'` to `CUTOUT_ART` in `src/app/ux/artwork.ts`.
4. `npm run ship`

Step 3 is what actually changes the card, and this is the safe order: an
unreferenced file breaks nothing, a referenced missing file is a card with a
hole in it.

## Checking one before you commit to nineteen

The card lab (Settings -> About, seven presses on the wordmark) has the
treatment as direction **33, Halftone: reversed**. A piece that reads there will
read on the card.
