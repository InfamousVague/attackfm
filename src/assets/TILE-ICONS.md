# Prompts: brutalist faces for the Recent and New Playlist tiles

Both tiles currently wear a 24px lucide line glyph — `History` and `Plus` —
centred on a plain square. They sit in a grid beside playlist tiles that show
real album art, and beside the library chips whose faces are hand-made objects
(`chip-liked.png`, `chip-all-songs.png`, `chip-on-repeat.png`). Next to those,
a thin outline glyph reads as a placeholder.

These prompts are for objects that join **that** family.

## The slot, measured

| | |
|---|---|
| Face | **118 × 118 px** on a phone, square at any width, 16px corner radius, `overflow: hidden` |
| Current glyph | 23 × 23 — **20% of the face** |
| Label | **outside** the tile, underneath it |
| Ground | `tileRecent`: a dark diagonal gradient. `tileAdd`: frosted glass with a blur behind it |

Two things follow.

**The whole face is yours.** Unlike the library chips, no text is laid over
these — the name sits below the tile. There is no safe zone to keep clear, so
the object can be large and centred. Aim for it to occupy **60–70%** of the
square, which is three times the present glyph and the reason these will stop
looking like placeholders.

**Transparent, not full-bleed.** The tile paints its own ground and the two
grounds differ (one gradient, one glass). A full-bleed square would cover that
and make the pair inconsistent with the playlist tiles beside them. Match the
existing chip art: a cut-out object on transparency, which is also why it must
read against both a near-black gradient *and* a translucent blur.

## Constraints for both

> 512×512 PNG, **transparent background**. A single cut-out object, centred,
> occupying about 65% of the frame with clear empty margin around it. Brutalist
> print: torn paper, coarse halftone, photocopier grain, hard broken edges —
> flat and printed, never rendered, no gloss, no 3D, no perspective, no drop
> shadow. Palette is off-white and charcoal with one accent of desaturated
> crimson-pink (#e0316b). Light enough overall to read on a near-black tile. No
> text, no numerals, no logos, no frame, no border, no background panel.

## `tile-recent.png`

The metaphor has to stay legible — this is a control, not decoration, and
somebody scanning the grid needs to know it means "what I played lately".

> A clock face torn from newsprint, roughly circular with a ragged hand-torn
> edge, printed in coarse halftone dots so the dial reads as grey stipple rather
> than flat grey. No numerals — only four short heavy tick marks at the
> quarters, hand-stamped and slightly crooked. A single thick arrow sweeps
> anticlockwise around the outside of the dial in solid desaturated crimson,
> its head blunt and its tail broken where the ink ran dry. The whole thing very
> slightly rotated, as though set down by hand.

## `tile-add.png`

> A bold plus sign built from two torn strips of off-white paper laid across
> each other, the horizontal strip over the vertical, both with fibrous ragged
> ends and neither quite square to the other. Photocopied hard: the paper is
> near-white, the shadow between the two strips is a solid black line. One
> short edge catches a smear of desaturated crimson where the ink was still wet.
> Thick and blunt, filling its square — a mark made with a brush, not a thin
> cross.

## Shipped

Both are in: `tile-recent.webp` and `tile-add.webp`, generated from the prompts
above and wired into `src/app/playlists/PlaylistShowcase.tsx`. What was done to
them between the generator and the repo, in case the next pair needs the same:

- **Trimmed to the object's own alpha bounds and re-padded square.** The
  generator left uneven margin, and the CSS sizes by the FRAME, so an off-centre
  object sits off-centre on the tile no matter what the sizing rule says.
- **Resized 816 → 512** to match the chip art, and **converted PNG → WebP**:
  956 KB and 780 KB became 100 KB and 53 KB. That matters more than it looks —
  the OTA bundle inlines assets as data URIs, so a megabyte of PNG costs about
  1.4 MB of base64 on every device that updates.

The prompts below the line are kept as the record of what made them.

## How they were wired

Both were plain `<div className="tileSquircle …">` wrappers holding a lucide
component — `History size={24}` at Recent and `Plus size={24}` at New Playlist.
Each glyph became an `<img>`, the way the chips do:

```tsx
<div className="tileSquircle tileRecent" aria-hidden>
  <img className="tileObjectArt" src={recentTile} alt="" loading="lazy" />
</div>
```

and give the class a size, since the tile centres its child but does not
stretch it:

```css
.tileObjectArt {
  inline-size: 65%;
  block-size: 65%;
  object-fit: contain;
}
```

Keep `aria-hidden` on the wrapper: the tile's accessible name comes from the
label underneath, so the picture must stay silent rather than announce itself
twice.

**Check it on the glass one.** `tileAdd` is frosted with a blur behind it, so
the plus is the one at risk — an object that reads well on `tileRecent`'s dark
gradient can wash out over glass. If it does, the fix is a heavier charcoal in
the object itself, not a background panel behind it.
