# Prompts: background textures for the library chips

The library chips — **Liked**, **All songs**, **On repeat**, **DJ** — currently
borrow the mix-card texture deck (`tex-01…12.webp`). That deck was drawn for a
surface with **nothing on top of it**. The chips are the opposite: each one
carries a bold object AND two lines of white text, so a texture that is a
handsome full-bleed square on a mix card is busy in exactly the wrong places
here.

These prompts are for a deck that is drawn for the chip instead.

---

## The shape you are drawing for

Measured off the running app at a 420px-wide phone layout, as percentages of
the chip so they hold at any size:

| | across | down |
|---|---|---|
| **The chip** | 188 × 80 px, **2.34 : 1** | |
| **The object** (heart, records, repeat mark, DJ) | starts at **26%**, runs off the right edge | bleeds past top and bottom |
| **The name** ("Liked") | from **7%** | **41 – 63%** |
| **The count** ("0 songs") | from **7%** | **66 – 84%** |

Two consequences, and both matter more than the style:

**1. The lower-left is text.** Everything from the left edge to about **60%
across**, and from **35% down to the bottom**, sits under white type. It has to
stay dark and quiet — no bright shapes, no hard edges, no high-contrast speckle.
A texture that is merely *interesting* there is a texture that makes "0 songs"
hard to read.

**2. The source is square, the chip is not.** These are used at
`background-size: cover`, so a square image on a 2.34:1 chip is scaled to the
full width and then **cropped to the middle ~43% of its height**. Compose for
that middle band; treat the top and bottom thirds of the square as offcuts. The
same file is also used square on the mix cards, so it should not look broken
uncropped — but the middle band is what people actually see on a chip.

**Where the character goes:** the **top-left**, and the band running left-to-
right above the text. That area is uncovered on every chip.

---

## Constraints to append to every prompt

> Square image, 1024×1024. Very dark — near-black ground (#0a0a0b), overall
> luminance low enough that white text sits on it unaided. Monochrome plus at
> most one accent: a desaturated crimson-pink (#e0316b) used sparingly, never as
> a large bright field. No text, no letters, no numerals, no logos, no
> recognisable objects, no faces. No vignette, no frame, no border. Flat and
> graphic — printed, not rendered; no gloss, no 3D, no drop shadows, no
> perspective. Keep the **lower-left third essentially empty and dark**; put the
> incident in the **upper-left and along the top**. Avoid regular repeating grids
> that will visibly tile against the next card in the row.

---

## The deck

Eight, which is enough that a row of four never shows the same one twice. Keep
the numbering stable — the picker maps a hue onto an index, so a file that
changes meaning changes which chip wears it.

**`chip-tex-01` — torn edge**
> A single torn strip of black paper lying across the upper third at a shallow
> angle, its ragged fibrous edge catching a faint grey light. Beneath it, flat
> undisturbed near-black. Photocopied twice: the tear reads as a hard white-grey
> fray, the field stays clean.

**`chip-tex-02` — halftone fade**
> A coarse halftone dot field, dots largest and densest along the top edge and
> dissolving completely to flat black by 45% down. Newsprint scale — dots
> individually visible, not a smooth gradient. Slight registration error on the
> crimson so a thin misaligned ghost of it sits above the dots.

**`chip-tex-03` — scanline drag**
> Horizontal photocopier drag: thin streaks pulled left to right across the top
> half, of the kind a scanner makes when the sheet slips. Charcoal on black,
> one or two streaks catching the crimson faintly. Perfectly clear below the
> midline.

**`chip-tex-04` — folded sheet**
> A sheet of black paper unfolded, the crease lines visible as faint pale
> valleys forming an irregular grid in the upper-left corner and flattening out
> toward the lower-right. Soft paper grain throughout, nothing sharp.

**`chip-tex-05` — spray edge**
> A dry aerosol spray arcing in from the top-left corner, heaviest at the corner
> and thinning to nothing by a third of the way across. Overspray speckle,
> uneven, hand-made. Deep crimson going almost black at its thin end.

**`chip-tex-06` — tape and grain**
> Two strips of matte black tape laid at slight angles across the top edge, half
> off the page, their cut ends visible. Heavy film grain over everything. The
> tape is barely a shade lighter than the ground — legible by its edges, not by
> its brightness.

**`chip-tex-07` — ink bleed**
> Black ink soaking into absorbent paper along the top edge, feathering
> downward in irregular fingers that stop well short of the middle. Where the
> ink is thinnest, the paper's warm grey shows through. Otherwise flat.

**`chip-tex-08` — stamped block**
> A single large geometric block — a bar or a wedge — hand-stamped in the
> upper-left, ink unevenly loaded so the impression is patchy and the edges
> broken. Crimson, dark enough to sit down into the ground. Nothing else on the
> sheet.

---

## Checking one before you keep it

Open a chip with the texture in place and read the count line ("0 songs",
"Your most played") **at arm's length**. If your eye goes to the texture first,
or if the count is harder to read than the name above it, the incident is too
low or too bright — push it up and darken it.

The wash already helps: the chip paints
`linear-gradient(140deg, rgb(0 0 0 / 0.35), rgb(0 0 0 / 0.72))` over the
texture, darkest toward the bottom-right. It is a safety net, not a licence —
it is deliberately gentle so the texture still reads as a material.

## Wiring a deck in

Drop the files here, add them to `CARD_TEXTURES` in `src/app/ux/artwork.ts`, and
keep `cardTexture()`'s bucket count matching the deck length — it divides 360°
by the number of textures, so a deck of eight makes 45° buckets and a deck of
twelve makes 30°.

Each chip passes a fixed hue, and that number alone decides which texture it
wears. Against the **current twelve**, checked rather than worked out on paper:

| chip | hue | texture |
|---|---|---|
| Liked | 338 | `tex-12` |
| All songs | 214 | `tex-08` |
| On repeat | 145 | `tex-05` |
| DJ | 265 | `tex-09` |

Four different ones, which is what you want — the four sit together in a grid
and repeats would read as a mistake. **Re-check this after changing the deck
length**: the bucket size changes with it, and two chips can land on the same
texture without anything failing. If they collide, move a chip's hue rather
than reordering the deck, since the deck is shared with the mix cards.
