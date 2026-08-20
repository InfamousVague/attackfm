# Card textures: twenty styles to choose between

The brutalist deck is not working in the app. This is the material for picking
what replaces it: **twenty styles, five textures each**, written so that a style
can be judged as a DECK rather than as five unrelated pictures — generate one
style's five, drop them in, and you can see what it actually does to the app.

## Where these are used, which decided how they are written

Two surfaces, and the first is the hard one:

**The library chips.** Four wide tiles — Liked, All songs, On repeat, DJ — at
about **2.34:1**. Each carries a bold cut-out object on the right *and* two
lines of **white text** on the left: the name at 41–63% down, the count at
66–84%. The texture is the backing behind both.

**The mix-card fallback.** A square, full bleed, nothing on top of it. Note this
is now a *fallback only* — since the album mosaic landed, a mix wears its own
covers whenever it has any, so the texture shows for mixes with no art at all.
The chips are where the deck actually lives.

The source is square and drawn at `cover`, so on a chip it is scaled to full
width and **cropped to the middle ~43% of its height**. Compose for that band;
the top and bottom thirds are offcuts. It still has to hold uncropped, because
the square use exists.

## Append to every prompt

> Square image, 1024×1024. Dark overall — low enough in luminance that white
> text sits on it unaided. Keep the **lower-left third quiet and dark**; put the
> incident in the upper-left and along the top. No text, no letters, no
> numerals, no logos, no faces. No vignette, no frame, no border, no drop
> shadow. No regular repeating grid that would visibly tile against the next
> card in a row of four.

## The five slots

Every style below answers the same five. Keeping them fixed is what makes two
styles comparable, and what makes any one style read as a set:

- **field** — all-over, no focal point — the workhorse
- **sweep** — one broad diagonal gesture, thinning as it crosses
- **burst** — energy in the top-left corner, gone by the middle
- **strata** — horizontal bands of uneven weight
- **scatter** — discrete marks, dense up top and sparse below

## How to judge one

Generate a style's five, point `CARD_TEXTURES` at them, and look at the **four
chips together**. That row is the test: the names and counts have to read at a
glance, the four have to look like a family without looking like one repeated
picture, and the objects on top have to stay the loudest thing on each tile. If
the texture is the first thing your eye lands on, it is too bright or too busy —
which is the specific failure the brutalist deck has.

---


## 1. Risograph

*Instead of ink on a white sheet I put it on a charcoal-grey stock and stacked dense overprints (federal blue over burgundy reads near-black), keeping the misregistered fluorescent pink as the only bright incident so the brightness lives in the offset fringes near the top rather than in the paper.*


**field**

> Risograph print on coarse charcoal-grey newsprint: three dense passes, federal blue over burgundy building to near-black, then a thin fluorescent pink plate two millimetres out of register. All-over irregular halftone grain, drum-roller streaks and ink smear, even incident edge to edge with no focal point, paper tooth showing through pinholes and roller skips.


**sweep**

> Duplicator print, one broad diagonal drag of ink from upper left down toward lower right, wide and saturated where it enters, breaking into open dot screen and bare sheet as it thins away. Deep federal blue overprinted with burgundy; a fluorescent pink plate offset three millimetres so a hot fringe rides its upper edge. Coarse dark grey stock, roller banding, ink flecks.


**burst**

> Risograph, ink energy packed into the top-left corner: overlapping burgundy and federal-blue blooms at their densest in the corner, dissolving through open halftone into bare dark stock before the middle of the sheet. A fluorescent pink plate printed out of register ghosts a warm outline off each bloom. Coarse pulpy grey-black paper, drum streaks, uneven laydown.


**strata**

> Risograph on coarse grey-black stock, horizontal bands stacked up the sheet in uneven weights: thick saturated slabs of federal blue over burgundy reading near-black, thinner ribbons of open halftone, hairline slivers of bare paper. Each band shifted a few millimetres against its neighbour, fluorescent pink misregistration flaring along the upper edges, ink mottled and roller-streaked throughout.


**scatter**

> Risograph print, discrete marks strewn across coarse dark grey paper: burgundy and federal-blue dots, short dashes and pressed ink blots at varying sizes, crowded and overlapping near the top, thinning to isolated specks lower down. Every mark doubled by a fluorescent pink plate a few millimetres out of register. Deep overprint density, coarse loose halftone, paper fibre, roller skips.


## 2. Cyanotype

*I coated the emulsion on near-black rag board and over-exposed it so the print's usual white paper becomes Prussian blue-black, then used soda-ash bleaching rather than blocked light to make the pale marks, so the highlights are few, thin and placed high.*


**field**

> Cyanotype coated onto near-black rag board, over-exposed until the whole sheet sinks to deepest Prussian blue-black. All-over photogram incident: grasses, gauze and dust printed then bleached back with soda ash to faint bone-blue filaments, even edge to edge with no focal point. Ragged brushed coating edges, granular wash mottling, chemical tidelines, salt bloom in the fibre.


**sweep**

> Cyanotype on near-black rag board, coated in visible brush strokes and exposed to deepest Prussian blue-black. A single broad swathe of gauze laid diagonally from upper left toward lower right, bleached back to cool slate and bone blue, wide and luminous where it enters and fraying into thin threads that disappear before the far corner. Granular wash, chemical tidelines.


**burst**

> Cyanotype photogram, incident crowded into the top-left corner: pressed fern fronds and flicked droplets bleached back to pale bone-blue against a Prussian blue-black sheet, brightest at the corner and fading through faint ghosts to nothing by the centre. Emulsion brushed on near-black rag board with ragged wet edges, salt granulation, soft chemical haloes, uneven coating streaks.


**strata**

> Cyanotype on near-black rag board: horizontal strips of cloth and torn paper laid across the sheet, printing as stacked bands of uneven weight, dense Prussian blue-black slabs, narrower ribbons of cool slate, thin bleached bone-blue seams glowing between them. Brushed emulsion edges overrun the band ends; granular wash and tidelines, the layering lighter high and settling darker low.


**scatter**

> Cyanotype photogram on near-black rag board: seed husks, pine needles and small pressed leaves strewn over the emulsion, each bleached back to a pale bone-blue silhouette with a soft chemical halo. Dense overlapping clusters along the top, thinning to a few isolated marks low down. Deep Prussian blue-black ground, brush-ragged coating, granular wash, faint salt bloom.


## 3. Art Deco

*Read Deco as black-lacquer-and-metal rather than gold-on-cream — the luxury comes from thin burnished brass line and inlay catching light against a matte dark ground, with the polish concentrated along the top and upper left so the lower left stays plain unlit lacquer for the type.*


**field**

> Black lacquer panel inlaid with an all-over marquetry of small stepped fans and chevron scales, each hairline-etched in tarnished brass over oxblood and deep bottle-green shell. Units vary in size and angle so no rhythm repeats; polish catches faintly along the top edge and the upper left, while the lower left sinks into plain unbuffed lacquer.


**sweep**

> A single broad plume of graduated rays sweeps from the upper-left corner toward the lower right, cut as a fan of tapering brass blades laid into black lacquer. Blades begin wide and burnished gold, then narrow into fine tarnished hairlines that dissolve before the corner; a faint oxblood shadow-fan trails just behind, matte against the polish.


**burst**

> A stepped sunburst breaks from the top-left corner: concentric quarter-arcs and slim ziggurat rays fanning outward in gold leaf, champagne bronze and gunmetal on deep lacquer-black. Rays shorten and thin with distance, their gilding wearing through to bare oxblood, and the last hairlines expire near the middle of the panel, leaving the rest plain and unlit.


**strata**

> Horizontal bands of inlaid stone and metal stacked up the panel like a skyscraper's setbacks seen edge-on: thick courses of black marble and oxblood lacquer divided by thin brass reveals and beaded gilt fillets. Band heights vary irregularly, upper courses catching more polish and finer stepped detailing, lower ones broad, matte and nearly unlit.


**scatter**

> Small Deco motifs strewn across black lacquer: gilt lozenges, three-step chevrons, tiny scallop fans and brass studs, each crisply cut and individually sized. They crowd thickly across the top and upper left, overlapping and catching light, then thin downward until only a few dim tarnished flecks remain low in the panel. Spacing irregular, nothing aligned.


## 4. Bauhaus

*Inverted the white poster ground to a matte near-black board and let the primaries survive only as small, deeply mixed areas of cadmium red, prussian blue and ochre plus hairline bone-white rules, so the hard flat geometry stays intact without ever lifting overall luminance.*


**field**

> Flat matte poster paint on charcoal board: an all-over arrangement of small circles, half-discs, squares and right triangles in deep cadmium red, prussian blue and burnt ochre, every size and rotation different so no rhythm sets in. Shapes sit on a near-black field with narrow bone-white rule lines threading between them; the lower left is left largely bare.


**sweep**

> One wide flat bar crosses the board from upper left to lower right, sliced into segments of deep cadmium red, prussian blue and slate that shrink and separate as they descend, ending in a few small squares. A single hairline white rule runs its length and overshoots; everything else is bare near-black board, matte and dry.


**burst**

> A quarter-disc anchored in the top-left corner throws a fan of hard-edged triangles and thin bars outward, deep cadmium red nearest the corner giving way to prussian blue, ochre and cool grey as the wedges narrow. Elements shrink and space apart, the last small square stopping short of centre. Flat opaque paint, dry matte texture, near-black ground.


**strata**

> Horizontal bands stacked up a near-black board: broad matte bars of charcoal and slate interleaved with narrow strips of deep cadmium red, prussian blue and ochre, weights deliberately uneven, some hairline rules, some thick blocks. A single half-circle in dark oxide sits half-buried in an upper band. Flat opaque paint, clean machine-cut edges, no gradient.


**scatter**

> Small hard-edged shapes scattered over near-black board: solid discs, right triangles, short bars and open squares, each flat and matte, no two alike in size. They cluster densely across the top and upper left, then thin steadily downward to a handful of dim slate and oxide fragments at the base. Colours held to deep cadmium red, prussian blue and ochre.


## 5. Psychedelic (late 1960s)

*Treated the liquid light show as what it physically was — coloured light projected into a blacked-out hall — so the saturation lives in thin incandescent rims, blob edges and dye seams while interiors, gaps and the lower left stay smoked black, keeping the vibration without the brightness.*


**field**

> Late-sixties liquid light show frozen on film: mineral oil and aniline dye pressed between glass clock plates and projected onto black. Amoeboid cells bloom and shear edge to edge, colour living in the incandescent rims where magenta meets violet meets acid orange. Interiors stay smoky and near-black, the churn evenly restless across the frame, dimming as it settles into the lower left.


**sweep**

> A single molten ribbon of projected oil rolls from the upper-left corner down toward the lower right, wide and boiling where it enters, stretched into a thin vibrating thread as it exits. Hot crimson-pink core banded with tangerine and cobalt, edges feathered where the dye disperses into the surround. The rest of the plate is smoked black, unlit, faintly grained with dust and scratches.


**burst**

> An explosion of wet dye blooming out of the top-left corner, concentric psychedelic rings shuddering outward like a dropped ink bomb — searing pink at the heart, cooling through tangerine, violet and oxblood as the rings widen, then breaking into torn filaments that dissolve completely by the middle of the frame. Everything beyond is unexposed black projection screen.


**strata**

> Horizontal shelves of liquid colour stacked up a black frame, each a lens of oil trapped between plates and spread flat: a thick oxblood band, a thin searing magenta seam, a wide bruised violet layer, slack dark gaps between them. Edges wobble and bleed where heat moves the dye. Weight and glow gather toward the top; lower bands sink to near-black.


**scatter**

> Hundreds of small dye cells strewn across black — each a bright-rimmed bubble of oil, some perfect rounds, some torn and trailing tails, sizes varying wildly. Rims flare magenta, tangerine and electric violet while centres stay dark and translucent. Density crowds and overlaps along the top, thins through the middle, and drops to a few isolated flecks near the bottom.


## 6. Vaporwave

*Shifted the palette from daytime mall pastel to the black between scanlines: gradients crushed toward the low end, chrome carried by narrow specular rims rather than bright metal bodies, and the glow supplied by video noise, so the nostalgia survives at a quarter of the usual luminance.*


**field**

> Night-mode vaporwave surface: a soft teal-into-magenta gradient crushed almost to black, degraded through third-generation VHS — horizontal chroma bleed, tracking noise, faint interlace lines, colour smearing sideways off every edge. A few dropout streaks and a dusting of head-switching hash gather near the top. No focal point, just an even breathing wash of dark plastic-purple video static.


**sweep**

> A wide chrome band arcs from the upper-left corner toward the lower right across a black screen, rendered like a nineties 3D demo: liquid metal catching one sunset gradient of magenta into cyan along its top edge, falling to gunmetal and then to nothing as it tapers away. VHS ghosting doubles the leading edge; the remaining screen is unlit void.


**burst**

> A lens-flare bloom detonating in the top-left corner of a black screen — early-CGI starburst with anamorphic streaks, hexagonal ghost apertures and a hot magenta core cooling through violet into pale cyan. Chroma noise crawls inside the glow. The flare's reach falls off fast, its last faint ghost dying near the centre; everything past that is dead CRT black.


**strata**

> Horizontal video bands stacked up a black frame like a mistracked tape: a wide crushed indigo gradient, a thin blown-out magenta scanline, a shelf of dull chrome reflection, a dead black gap, a strip of pale cyan dither. Each band bleeds sideways with analogue smear and slight vertical jitter. The heavier, brighter layers ride high; lower bands fade toward black.


**scatter**

> Small chrome and glass fragments floating on black — polished spheres, splinters and low-poly wireframe chips from an early rendering demo, each catching one thin magenta-to-cyan specular rim and nothing more. Sizes vary; some are doubled by VHS ghosting or chewed into compression blocks. They crowd and overlap across the top, thin through the middle, and reduce to sparse motes below.


## 7. Ukiyo-e

*Adapted by working in the aizuri night-print register: the cream paper is swapped for a sumi-and-indigo ground, the black keyblock line inverted to pale bone so the drawing reads as light on dark, bokashi gradients run toward black instead of toward white, and beni red is rationed to a single crimson accent per sheet.*


**field**

> Traditional Japanese woodblock print in near-black indigo: an all-over sheet of mokume woodgrain printing, the block's own irregular grain pressed edge to edge in sumi and deep prussian, faint bone-white ink caught in the ridges, one thin beni crimson pass misregistered a hair off. Flat, matte, hand-pressed on darkened kozo paper, incident even throughout, lower left thinning to plain ink.


**sweep**

> Japanese woodblock in a night palette: one broad stylised wave arm sweeps from the upper left down toward the lower right across dark indigo, a flat plane of deep prussian edged by a pale bone keyblock line, its crest fingers thinning and dissolving before they reach the lower right corner. Bokashi gradient sinks the water toward black; a single beni crimson stroke rides the shoulder.


**burst**

> Japanese woodblock, night sea: a breaking crest erupts in the top-left corner, flat sumi-black water throwing pale bone-white foam claws that fragment into fine printed droplets and vanish by mid-frame. Hand-cut keyblock outline, crisp and tapering; bokashi bleeds the water from deep indigo to black across the lower half, one beni crimson accent buried inside the curl.


**strata**

> Japanese woodblock: horizontal suyari-gasumi mist bars stacked up the frame over a black-indigo ground, each band a flat colour area of differing weight — some deep prussian, one thin bone-grey, one narrow beni crimson rule — separated by hand-cut keyblock edges and softened by bokashi gradients that fade band into band. Heaviest and most detailed near the top, quiet and dark below.


**scatter**

> Japanese woodblock night snow: discrete gofun-white flecks and small hand-cut petal marks scattered at irregular density over a sumi and deep-indigo ground, crowded thick along the top edge, drifting apart and dimming to almost nothing across the lower half. Flat matte print, slight block misregistration doubling a few marks in beni crimson, kozo paper grain visible throughout.


## 8. Russian Constructivist

*Adapted by inverting the movement's white poster sheet to a black ink ground, so crimson and bone-white survive as sparse hard-edged marks and thin ruled lines rather than broad bright planes — the white is rationed deliberately so the app's own type stays the brightest thing on the card.*


**field**

> Russian Constructivist print on black: an all-over field of coarse rotogravure halftone, ink density lurching irregularly, overprinted with a misregistered crimson screen offset a few millimetres and short ruled hairlines crossing at hard angles. Litho grain, plate scratches, blotted rollers. Flat matte poster ink, no focal point, incident even across the sheet, lower left sinking into unprinted black.


**sweep**

> Russian Constructivist poster on a black ground: one broad hard-edged diagonal bar drives from the upper left toward the lower right, deep crimson going to oxblood and tapering to a splinter, flanked by thin bone-white ruled lines splaying off at fixed angles. Coarse halftone breaks the bar's surface; slight plate misregistration doubles its edge. Everything beneath the diagonal left empty black.


**burst**

> Russian Constructivist graphic on black: hard-edged wedges radiate from the top-left corner, crimson and bone-white rays of unequal width fanning across the upper band, cut by arcs of toothed machine geometry, dissolving into coarse halftone that thins to bare black by mid-frame. Flat poster ink, ruled edges, one offset crimson misprint. Lower two-thirds of the sheet empty.


**strata**

> Russian Constructivist print on black: horizontal bars stacked up the frame in unequal weights — a thick crimson band, two hairline bone rules, a wide charcoal slab broken by halftone, a narrow oxblood strip — each ruled hard-edged and slightly out of register. Weight and incident concentrated in the upper half, the bands thinning, darkening and separating toward the bottom.


**scatter**

> Russian Constructivist composition on black: discrete flat marks scattered at uneven density — punched circles, short ruled ticks, small crimson triangles and toothed arc fragments — crowded and overlapping along the top edge, drifting sparse and smaller toward the bottom. Coarse halftone texture inside each shape, hard poster edges, one duplicated crimson misregistration. Lower left nearly bare.


## 9. Memphis Group

*Inverted the usual white gallery ground to a black lacquer sheet so the saturated Memphis palette reads as neon-on-black, and kept every mark small, hand-cut and generously spaced so the unprinted black between shapes — not the pattern — is what the type actually sits on.*


**field**

> Screenprinted Memphis pattern on a black lacquer sheet: hand-cut squiggles, dashes, dotted bacterio ribbons and small terrazzo chips scattered edge to edge in crimson-pink, ultramarine, jade and mustard, all matte with slight misregistration. Marks stay small and generously spaced so unprinted black dominates between them; density shifts subtly across the sheet, avoiding any single centre of interest.


**sweep**

> A single broad ribbon of Memphis confetti sweeps from the upper-left corner toward the lower-right across a black lacquer ground: fat squiggle strokes, zigzag batons, checkered rods and dotted arcs in crimson-pink, ultramarine and mustard, silkscreen-matte with hand-cut wavering edges. The band is thick and crowded at its head, thinning into a few stray jade dashes before the far corner.


**burst**

> An eruption of Memphis shapes packed into the top-left corner of a black lacquer sheet: overlapping squiggles, checkered batons, half-circles, splayed confetti dashes and speckled terrazzo shards in crimson-pink, ultramarine, jade and mustard, screenprinted flat with ragged hand-cut edges. Pieces fly outward and downward, shrinking and separating, dissolving into bare black by the middle of the frame.


**strata**

> Horizontal Memphis bands stacked up a black lacquer sheet, each a different width and idiom: a thick terrazzo strip of sparse pale chips in dark binder, a thin crimson-pink squiggle rule, a run of ultramarine zigzag teeth, a mustard dotted stripe, then wide unprinted black gaps. Flat silkscreen colour, wavering cut edges, weight concentrated in the upper bands.


**scatter**

> Loose Memphis confetti flung across a black lacquer ground: hand-cut dashes, commas, tiny squiggles, quarter-circles and speckled terrazzo chips in crimson-pink, ultramarine, jade and mustard, each a flat matte silkscreen shape with a slightly ragged edge. They crowd and overlap near the top, then break into isolated single marks that peter out toward the bottom.


## 10. Watercolour

*Painted into a saturated near-black indigo ground so the medium's signatures — blooms, backruns, hard tidelines, granulation caught in the paper tooth — appear as smoky light lifting out of the dark rather than pigment sitting on white paper.*


**field**

> Deep indigo and Payne's grey washes layered wet-on-wet over rough cold-press paper until they sit near-black, alizarin bleeding through in places toward crimson-pink. Ultramarine granulation settles into the paper tooth as fine speckle; faint backrun blooms and dried tidelines surface all over the sheet at varying scales, evenly distributed, none dominating, paper grain reading through the darkest passages.


**sweep**

> One loaded brushstroke of indigo and alizarin dragged diagonally from the upper-left corner toward the lower-right across rough cold-press paper already flooded with a near-black Payne's grey wash. The stroke blooms and backruns where it is wettest at the head, carries a hard dried tideline along one edge, and breaks into dry-brush granulation and bare dark paper as it thins.


**burst**

> A wet bloom detonating in the top-left corner of a near-black indigo wash on rough cold-press paper: clear water dropped into damp alizarin and crimson-pink pigment, pushing cauliflower backruns and hard-edged tidelines outward in irregular concentric rings. Colour and granulation are dense at the corner, fading through smoky grey feathering into flat undisturbed dark by the middle of the sheet.


**strata**

> Horizontal wash bands laid one beneath another on rough cold-press paper, each dried before the next so hard tidelines divide them: a heavy granulating indigo, a smoky Payne's grey full of backruns, a thin alizarin seam warming toward crimson-pink, then broad quiet bands of near-black. Incident and edge detail crowd the upper bands; lower ones settle into flat unbroken darkness.


**scatter**

> Discrete spatters and dropped pigment marks on rough cold-press paper over a near-black indigo ground: loaded droplets of alizarin and crimson-pink that spread, granulate and dry with hard rims, alongside dry-brush flecks and salt-bloomed pits. They cluster thickly along the top, overlapping into larger blooms, then thin to scattered single specks toward the bottom.


## 11. Chalk and pastel

*Pastel normally lives on a mid or warm toned ground, so I kept the toned-paper logic but made the ground near-black charcoal sugar paper and rationed the pigment — bone, ash, plum and dusty crimson-pink read as sparse bright dust caught on the tooth rather than a bright drawing dimmed down, with the lower left left as bare dark paper.*


**field**

> Soft pastel worked into near-black charcoal sugar paper, an all-over dusty haze of deep plum, ash grey and faint crimson-pink pigment rubbed in with the heel of the hand, the paper tooth breaking every stroke into speckle. No focal point: even drifting incident edge to edge, slightly denser and warmer toward the upper edge, thinning to bare dark paper lower down.


**sweep**

> One broad chalk gesture dragged from the upper left toward the lower right across near-black toned paper, wide and loaded where it starts in dusty bone white and pale crimson-pink, breaking into dry skips and a smeared tail as it thins away. Fingerprint blur softening one side, a hard scraped edge on the other, the surrounding sheet bare and dark.


**burst**

> Dry pigment concentrated in the top-left corner of near-black pastel paper: short scrubbed strokes of warm bone, pale ochre and crimson-pink piled and smeared outward, dust flung in a loose fan that thins quickly and dies to bare dark ground by the middle of the square. The lower half is untouched paper carrying only the faintest airborne haze.


**strata**

> Horizontal bands of soft pastel laid across near-black toned paper: a thick chalky bar of bone white near the top, thinner ribbons of slate, plum and dusty crimson-pink stacked beneath, each with a rubbed lower edge bleeding into the dark. Band weights and gaps irregular with hand-drawn wobble, the lowest bands little more than a dark smudge on bare paper.


**scatter**

> Discrete chalk marks scattered over near-black toned paper — short dashes, thumb-smudged dots and stabbed flecks of bone white, ash and dusty crimson-pink, every one gritted by the tooth of the sheet. Density heavy along the top and upper left where marks overlap into a dusty crowd, loosening downward until only a few faint isolated specks sit on bare dark ground.


## 12. Technical blueprint

*I inverted the cyanotype relationship — the mid blue becomes a near-black Prussian ground and the draughting line stays genuinely white but is kept hairline and rationed, so the drawing glows faintly across a dark sheet, with line density thinning toward the lower left and every callout left blank rather than annotated.*


**field**

> Engineering drawing on a deep Prussian-navy sheet so dark it reads near-black: hairline pale cyan-white linework covering the square in overlapping construction lines, small patches of fine diagonal hatch, blank leader arrows ending in bare ticks and little section flags, each set at its own drifting angle so nothing lines up. Line weight thin throughout, busier and cooler at the top, sparse and unresolved below.


**sweep**

> A technical section running diagonally across a near-black Prussian sheet: one broad swathe of hairline white travelling from the upper left toward the lower right, built from close-ruled forty-five degree hatching held between two long guide lines, with tick marks and blank leader arrows along its length. Dense and bright where it enters top-left, the hatch opening out into isolated strokes as it thins away.


**burst**

> The top-left corner of a dark Prussian-navy sheet crowded with fine white draughting: concentric radius arcs, angled centre lines, a cluster of hatched section fragments and small blank callout leaders radiating out of the corner. Line density falls away quickly along both edges, arcs reducing to single hairlines and vanishing into flat unmarked dark ground before the middle of the square.


**strata**

> Stacked horizontal section bands across a near-black Prussian sheet, all drawn in hairline white: a deep band of close diagonal hatch, one of sparse dashed centre line, one of small irregularly spaced material ticks, divided by long ruled rules and short scale marks. Band heights vary unevenly, the upper bands brighter and busier, the lowest reduced to a single faint rule on dark ground.


**scatter**

> Isolated draughting marks scattered over a near-black Prussian ground: small hatched squares, cross-hair centre marks, short arcs, bolt-circle clusters and stray blank leader arrows, all in hairline pale cyan-white, each rotated to its own angle. Marks crowd and overlap across the top and upper left, thin out through the middle, and dwindle to two or three faint ticks near the bottom.


## 13. Op art

*I inverted the movement's white-ground/black-line convention so black is the paper and the line work is the only light, then used line density rather than brightness as the value control — marks crowd shut into solid black wherever the type sits, and the warped, never-repeating intervals keep any two cards from tiling against each other.*


**field**

> Hard-edged optical field: two fine line rasters silkscreened in bone white over near-black board, crossed a few degrees apart so soft moiré beats swell and cancel edge to edge. Interval spacing warps continuously, never repeating. Lines crowd and thicken toward the lower left until they close into solid black; the upper half opens into pale interference with faint crimson-pink fringing at the beat crests.


**sweep**

> A single broad shear crosses the plate from upper left to lower right: a ruled raster of thin chalk-white lines on charcoal ground, bulged and torn along that diagonal as though dragged through a lens, the distortion widest and brightest at its origin and flattening back into unbroken dark by the lower right. Line weight tapers with it. Cool graphite greys, one crimson-pink edge glint.


**burst**

> Concentric arcs radiate from a point just outside the top-left corner, ruled in pale silver-white on black: hairline and tightly packed near the origin, spacing widening outward until the lines thin, break and disappear before the centre. Where arcs cross an underlying faint raster they flare into brief moiré rosettes. Figure and ground swap once near the corner, white turning black. Elsewhere flat, deep black.


**strata**

> Horizontal bands stacked up the plate, each a different optical frequency: dense hairline hatching, wide chalk-white stripes, a zone of checkered figure-ground reversal, a band of pure black. Band heights are irregular, edges razor-sharp, printed flat on near-black card. Weight and brightness are heaviest at the top and lose contrast downward until the lowest bands are black on black. One band carries a thin crimson-pink rule.


**scatter**

> Discrete geometric marks — small squares and lozenges, hard-edged, tilted on varying axes — scattered across a matte black ground in bone white and cool grey. Size and packing are dense along the top edge, loosening downward, individual marks shrinking and dimming to nothing in the lower third. A few marks invert, cutting black holes out of pale patches. Irregular spacing throughout, deliberately off-lattice.


## 14. Impressionist

*Instead of dimming a daylight palette I keyed the whole style to the nocturne end of broken colour — the dark scaffold does the work the white canvas usually does, and light is rationed to a small quota of high-value strokes held in the upper half, so the surface still shimmers without ever rising to compete with white type.*


**field**

> Oil on primed board, nocturne key: short loaded comma-strokes laid side by side without blending, prussian blue against aubergine and deep viridian, threaded with cooler slate. A sparse quota of lighter touches — dull gold, pale mauve, a crimson-pink flick — sits mostly in the upper half, describing light rather than drawing it. Visible bristle drag and impasto. Strokes shorten and darken toward the lower left.


**sweep**

> A broad diagonal drift of light crossing dark water: loaded horizontal dashes of pale gold, chalky lilac and broken white ride from the upper left down toward the lower right, each stroke shorter and cooler than the last until they sink into unmixed prussian blue and black-green. Thick wet-in-wet ridges at the bright end, thin dry scumble at the tail. No contour, no blending.


**burst**

> A knot of high-key broken colour in the top-left: crowded impasto touches of lamp gold, warm white and crimson-pink, jostling and half-mixed, as if a light source were dissolving into its own halo. Outward the strokes lengthen, cool through mauve to slate, and lose charge, leaving the centre and beyond in flat unlit prussian and umber. Palette-knife ridges only at the core.


**strata**

> Horizontal bands of a night landscape reduced to stroke direction: a lit upper register of short flickering dashes in pale gold and grey-blue; below it a denser band of long horizontal drags in prussian and teal; then a thick stratum of near-black umber laid on with a knife. Band depths uneven, edges frayed where bristles overlap. Value falls steadily from top to bottom.


**scatter**

> Separate dabs of loaded oil flicked across a deep umber-black ground: small round touches of pale gold, cold white, mauve and one or two crimson-pink, each sitting proud and unblended like reflected lights or blown petals. Clustered and overlapping near the top, thinning to isolated specks lower down, absent from the bottom corner. Bare brushy ground between them, unlit.


## 15. Cut paper collage

*Built from genuinely dark stock rather than bright paper dimmed — charcoal, ink-blue, bitumen and oxblood sugar papers carry all the cutting, with crimson-pink rationed to thin slivers, so the scissor edge and paper tooth stay the subject and white type has a flat matte ground under it.*


**field**

> Cut paper collage in matte dark stock: charcoal, ink-blue, bitumen brown and oxblood sugar paper scissored into irregular shards and overlapped edge to edge across the whole surface, angles all different, narrow near-black gaps showing between pieces. Fibrous cut edges, visible paper tooth, a few thin slivers of crimson-pink laid in sparingly. Flat colour, no modelling, no focal point.


**sweep**

> Cut paper collage: one long scissored ribbon of oxblood and crimson-pink paper travelling from the upper left across the frame toward the lower right, broad and confident at its head, narrowing to a thin sliver as it goes. Beneath it, overlapping sheets of charcoal, slate and ink-black stock. Flat matte colour, crisp hand-cut edges, faint torn fibre, paper grain throughout.


**burst**

> Cut paper collage: a fan of scissored wedges and slivers radiating out of the top-left corner in oxblood, ember orange and crimson-pink over near-black card, each piece shorter and narrower than the last until they thin away to nothing around the middle of the frame. Flat matte stock, decisive hand-cut edges, gentle overlaps, visible paper tooth.


**strata**

> Horizontal strips of cut and torn paper stacked up the frame like sediment: bands of charcoal, graphite, ink-blue, dull plum and oxblood with one narrow crimson-pink seam, thicknesses ranging from hairline to broad slab. Edges alternately razor-scissored clean and torn to a soft fibrous flecked lip. Flat matte colour, slight buckle where layers ride over one another.


**scatter**

> Small hand-cut paper chips — triangles, crescents, torn squares, thin batons — strewn across a near-black card ground in charcoal, slate, dull plum and occasional crimson-pink, clustered thickly across the upper reaches and thinning to a few isolated pieces further down. Flat matte colour, crisp scissor edges, ragged fibre at the tears, no two shapes alike.


## 16. 1980s airbrush

*Reframed as the night side of the style — deep blue-black and aubergine gradients do the volume, and the brightness budget is spent only on small hard frisket-cut specular highlights and rationed magenta bloom, so the chrome reads glossy and lit rather than greyed down.*


**field**

> Airbrushed 1980s illustration surface: deep blue-black and aubergine gradients blown edge to edge with fine overspray speckle, threaded with faint cyan and magenta haze and a sprinkling of tiny hard-edged specular sparks. Soft frisket-masked forms bleed into one another with no focal point, lacquered and slightly misty, the sheen of a sci-fi paperback cover seen under low light.


**sweep**

> A broad airbrushed ribbon of liquid chrome arcing from the upper left down toward the lower right, tapering as it travels: cool gunmetal and slate gradients with one hard frisket-cut highlight running its length and a thin crimson-pink reflection along its underside. Around it, deep blue-black mist and fine overspray grain. Glossy 1980s sci-fi paperback rendering.


**burst**

> Airbrushed 1980s illustration: a corona of magenta and hot crimson-pink light blooming out of the top-left corner over deep blue-black, throwing soft radial mist and a handful of hard-edged lens sparks that shorten and fade to nothing by mid-frame. Fine overspray stipple, frisket-crisp highlight shards, lacquered gradients, the remaining surface sinking into unlit haze.


**strata**

> Stacked horizontal bands of airbrushed gradient climbing the frame like atmospheric layers: gunmetal, deep indigo, aubergine, and one thin seam of crimson-pink glow, each softly blended within itself and divided by hard frisket-cut edges carrying narrow chrome highlight lines. Thicknesses vary from slab to hairline, fine overspray speckle throughout, polished lacquered 1980s cover-art finish.


**scatter**

> Discrete airbrushed marks strewn over a deep blue-black ground: soft magenta and cyan light-blooms, tiny hard-edged chrome flecks with four-point glints, and drifting puffs of overspray. Dense and overlapping across the upper reaches, thinning to a few lone sparks further down. Lacquered gradients, frisket-crisp highlights, fine stipple grain, irregular spacing.


## 17. Suminagashi marbling

*Inverted the usual pale-washi reading so the paper becomes black water and the floated ink registers as hairline light contours, keeping the sheet near-black with the crimson-pink used as a single threaded line rather than a wash.*


**field**

> Suminagashi floated on still black water. Dozens of concentric ink rings drift and collide across the entire surface, their contours reading as hairline separations of pale ash and cool pewter against deep sumi black, one thread of faded crimson-pink pulled through a few arcs. Even incident everywhere, rings crowded and fine at the top edge, dissolving into unmarked black at the lower left.


**sweep**

> A single pull of suminagashi: one broad braid of concentric ink rings raked diagonally from the upper-left corner toward the lower right, the bands stretching, feathering and thinning as they travel until they dissolve. Hairline contours in silver-grey and smoke on wet black, a faint crimson-pink line threaded along the widest curve. Still black water either side.


**burst**

> Suminagashi rings dropped into the top-left corner: tight nested contours crowding that corner, expanding and loosening outward, each successive ring fainter until they fade to nothing by the centre. Pale ash and pewter hairlines with one crimson-pink arc near the nucleus, all on deep still sumi black; the rest of the water left undisturbed and empty.


**strata**

> Suminagashi combed flat: concentric rings drawn out into long horizontal drifts stacked up the frame, some bands dense with fine feathered contours, others wide and almost empty. Hairlines of ash, pewter and one dull crimson-pink stripe on deep sumi black; heavier layering across the upper half, the lowest bands thinning to bare black water.


**scatter**

> Many separate suminagashi drops on black water, each a small cluster of two or three concentric rings, sizes uneven, some blown sideways into commas by a breath. Pale ash and pewter hairlines, a couple of clusters ringed in crimson-pink. Dense crowding along the top, thinning through the middle, only two or three faint drops low down.


## 18. Linocut

*Reversed the usual white-paper reading — the block is over-inked and only sparsely cleared, so carved marks print as a minority of bruised grey slivers instead of bright white, and a misregistered crimson-pink second pull supplies the accent without lifting the overall darkness.*


**field**

> Linocut pulled from a heavily inked block, barely cleared: an all-over field of dense black relief ink worked with short irregular V-gouge chatter marks that open thin pale slivers, spacing hand-cut and wandering rather than ruled. Uneven press pressure leaves grey blotches and skipped ink; a misregistered second pull adds faint crimson-pink slivers up top, while the lower left stays solid uncarved black.


**sweep**

> One long sweeping cut across a black linocut block: a broad U-gouge track curving from the upper-left down toward the lower right, widest at entry and tapering to a scratch, flanked by parallel skid marks where the blade chattered. Cleared areas print as bruised warm grey, not white; a faint crimson-pink offset ghosts the widest stretch. Untouched black elsewhere.


**burst**

> Top-left corner of the lino block hacked open: a fan of radiating gouge strokes of varying width bursting from that corner, blade chatter breaking each stroke into dashes, the strokes shortening and separating until only stray flecks remain by the centre. Cleared marks print bruised grey with crimson-pink misregistration at the corner; the rest is unbroken inked black.


**strata**

> Horizontal bands carved across an inked lino block, stacked unevenly up the frame: some bands densely hatched with parallel gouge lines, others a single wide cleared trough, others left solid black. Band heights all different, edges ragged where the blade slipped. Cleared lino prints bruised grey; one upper band carries a crimson-pink offset. Weight concentrated high, bands thinning downward.


**scatter**

> Short stabbed gouge marks scattered over a solid black lino field: chips, nicks and comma-shaped flicks of assorted sizes and angles, cut by hand so no two match and nothing lines up. Each opens a small bruised-grey clearing with a burr of skipped ink; a few carry crimson-pink offset. Marks crowd densely along the top and thin to almost nothing below.


## 19. Stained glass

*Inverted the usual balance so the black lead matrix, not the glass, owns most of the surface — jewel colour survives as small backlit pools of dusk light rather than a bright window, keeping overall luminance low without desaturating the palette or flattening the leading.*


**field**

> Antique leaded church glass shot against a dusk sky. Thick matte-black lead cames dominate the surface, webbing it into small irregular cells of deep cobalt, oxblood, aubergine and bottle green. Hand-blown glass with trapped bubbles, striations and smoky grisaille painting dulls each pane. Even cellular incident across the whole panel, brightest slivers gathering upper-left, glass darkening and lead widening toward the bottom.


**sweep**

> A single river of lit glass crossing an antique leaded panel: a broad ribbon of crimson, amber and rose cells entering at the upper-left edge and running diagonally down, narrowing to a thread of thin quarries near the lower right. Heavy black cames and smoked near-opaque glass fill everything else. Blown-glass striations, kiln bubbles, weak dusk light pushing through from behind.


**burst**

> Fragment of a rose window anchored in the top-left corner: radiating black lead cames fanning out of the corner, petal cells of saturated ruby, violet and cyan glass burning brightest at the hub. The rays lengthen, cool and lose colour, breaking down into plain smoked quarries and wide flat lead by mid-frame, leaving heavy unlit slab glass beyond.


**strata**

> A tall lancet window seen straight on, divided by horizontal iron saddle bars into stacked courses of unequal height. Upper bands hold small jewel cells of teal, ruby and old gold catching low light; lower bands are wide plain quarries of smoked, near-opaque glass held in broad black lead. Hand-blown texture, bubbles and reamy streaks run along each course.


**scatter**

> A broad field of near-black slab glass in wide flat lead, studded with discrete blown roundels and small jewel cabochons — ruby, cobalt, amber, verdigris — each lit from behind like a coal. Dense clustering across the top third, thinning to isolated jewels and long empty leaded stretches below. Chipped edges, kiln bubbles, soft grisaille smudging.


## 20. Synthwave neon

*Kept the room black and the light sources thin and sparse so bloom reads as haze around small hot cores instead of a full-frame wash, and swapped the usual perspective grid for loose tube geometry that keeps glow up top while the lower-left stays unlit.*


**field**

> A dark studio filled with a tangle of thin bent neon tubing, most sections unlit grey glass, occasional runs igniting magenta and cyan. Soft halation and drifting haze, faint reflections on a black wet floor. Loose irregular overlapping arcs at every angle with no centre, glow concentrated along the top and upper-left, tubes going dark and sparse lower down.


**sweep**

> One long bent neon tube arcing across a black room from the upper-left, a hot magenta core wrapped in cyan halation, its bloom fat and bright where it enters and thinning to a dim violet filament as it falls toward the lower right. Faint smoke catches the light and a wet floor throws a soft broken reflection. Everything else unlit.


**burst**

> A cluster of neon tube ends firing in the top-left corner of a black room: short cut lengths of magenta and cyan glass crowded together, hot cores, heavy lens bloom and anamorphic streaks raking outward. The light falls off fast through drifting haze, dissolving into deep unlit dark by the middle of the frame.


**strata**

> Horizontal neon strip lights stacked up a black wall at uneven heights and spacings, some blazing magenta, some cool cyan, several dead grey glass. Thin bright bars near the top, wide dim bands lower down, each smeared by atmospheric bloom and a soft haze layer. Distant night-horizon glow bleeding between the upper courses.


**scatter**

> Discrete points of neon light in a black smoke-filled room: sparks, dust motes and tiny glowing tube fragments in magenta, cyan and violet, each with a soft bloom halo, a few throwing long anamorphic flares. Clustered thickly along the top, drifting apart through the middle, only occasional faint embers in the lower reaches.

---

# The hi-fi set

Drawn from the app's own subject rather than from art history, which is the
argument for it: a music app's textures can be made of the machines that play
music. It also fits the hard constraint better than most of the twenty above,
and for a reason worth stating — **a valve's glow is already a small hot point
in a large dark chassis.** The shape the chips need is the shape this material
naturally has, so nothing has to be dimmed into submission.

One rule from the shared brief is relaxed here, deliberately. "No recognisable
objects" would leave no hi-fi at all, so these are written as **macro**: close
enough that they read as surface and light rather than as a photograph of an
amplifier. If a prompt starts producing a product shot, push it closer in — the
failure mode is a picture of a thing, and the fix is always more magnification.

Everything else still applies: dark overall, lower-left quiet, incident upper-
left and along the top, composed for the middle band.


## 21. Valve glow

*The one direction the constraint was already made for: a tube's light is a small hot point inside a large dark chassis, so the incident sits high and warm and the rest stays black glass and shadow without any dimming.*


**field**

> Macro across a dense bank of vacuum tubes seen end-on in an unlit chassis: smoked glass envelopes, grey mica spacers and dark plate structures filling the frame, each holding one small amber filament point. Even distribution, no focal point, most of the surface deep charcoal and reflected black, the heat glow reading as scattered embers rather than lamps.


**sweep**

> A row of output valves receding diagonally from upper left to lower right, shot wide open so only the near glass is sharp. Their filaments make a chain of warm amber flares that dim and blur along the run, dying to unlit glass before the far corner. Black chassis, faint blue getter flash on the shoulders, deep shadow beneath.


**burst**

> One power valve close in at the top-left corner, filament flaring hard orange through smoked glass, its halo bleeding into the surrounding dark and gone by the middle of the frame. Fine dust on the envelope catching the light, a cold blue getter mirror at the crown, the rest of the chassis unlit black with a single soft chrome reflection.


**strata**

> Horizontal ranks of valve crowns across a rack, seen from slightly above: bands of glass tops and ceramic bases stacked in uneven weights, the upper rows lit amber from within and each lower band falling further into unlit shadow. Warm filament light pooling along the top of each row, black steel between.


**scatter**

> Filament points and heater glows scattered irregularly through darkness at varied focal depths, dense and sharp across the top, thinning to a few blurred amber specks below. Between them, smoked glass, mica and the cold blue smear of getter flashing. Mostly black, the light reading as embers in a dark cabinet rather than as lamps.


## 22. Machined metal

*Anodised charcoal rather than bright aluminium, and lit by a single raking light so the grain is read by where the highlight ISN'T - the metal stays dark and only the tooling catches anything.*


**field**

> Extreme macro of a brushed anodised faceplate in gun-charcoal: fine unidirectional grain running edge to edge, raked by a low light so each groove holds a thread of cool highlight and a deeper shadow. Even across the frame with no focal point, a faint iridescent sheen where the anodising thickens, no bright fields anywhere.


**sweep**

> A broad turned-finish arc sweeping from upper left to lower right across dark machined aluminium: concentric lathe rings catching a raking light where they enter, the specular thread narrowing and breaking up as the arc travels until only faint tool marks remain. Charcoal anodising, micro-burrs at the cut edges, black shadow beneath.


**burst**

> Raking light striking a knurled corner at the top-left: a diamond-cut grip pattern flaring with hard cool highlights on each peak, the pattern shallowing and losing its light within a third of the frame. Beyond it, flat bead-blasted charcoal, one chamfered edge holding a thin bright line, the rest unlit.


**strata**

> Stacked heatsink fins and faceplate edges seen nearly end-on: horizontal bands of extruded charcoal aluminium in uneven depths, each catching a narrow cool highlight along its upper lip and dropping to black in the channel behind. Upper bands crisper and brighter, lower ones softening into shadow, fine machining chatter throughout.


**scatter**

> Bead-blasted dark alloy with hardware strewn across it at varied scale: countersunk screw heads, hex sockets, small drilled ports and rivets, crowded and catching cool light near the top, thinning to a few dim fixings below. Matte charcoal ground, faint circular tool swirl, no polished fields.


## 23. Piano gloss

*The lacquer is treated as a black mirror in an almost dark room, so what you see is mostly depth - one or two restrained specular events high in the frame and an enormous quiet reflection below them.*


**field**

> Deep piano-black lacquer photographed as a mirror in a nearly dark room: an all-over field of soft, barely-there reflections - the ghost of a ceiling, a dim doorway - stretched and blurred beyond recognition. Fine polishing swirl and a scatter of micro-scratches catching what little light there is. Enormously deep, almost entirely black.


**sweep**

> A single specular streak crossing high-gloss black lacquer from upper left toward lower right: bright and hard-edged where it enters, drawing out into a soft smear and vanishing before the far corner. Beneath it the lacquer holds a dim inverted reflection of the same streak. Polishing swirl visible only in the highlight, elsewhere pure depth.


**burst**

> A light source blooming in the top-left of a black lacquered cabinet: a tight specular core with a soft halo and a short flare, its reflection sinking away into the gloss and gone by the middle of the frame. Dust motes on the surface catching the edge of it. The rest is unbroken black with a faint warm cast.


**strata**

> Horizontal reflected bands lying across black piano lacquer - the smeared image of a lit rack of equipment, or a window's slats - stacked in uneven weights and softened almost to abstraction by the gloss. Brighter, sharper bands high in the frame, dissolving into flat depth lower down. Fine swirl marks catching light between them.


**scatter**

> High-gloss black lacquer under a single low light: dust, lint and fine swirl scratches scattered across the surface, each catching a small hard specular point. Dense and bright across the upper area, thinning to almost nothing below. Between the marks, black so deep it reads as space rather than as a surface.


## 24. Meters and lamps

*Backlighting rather than front lighting: the scales are lit from behind so the illuminated area is a small warm window in a black fascia, and the needles and lamps supply the incident without any broad bright field.*


**field**

> Macro across a wall of VU meter faces in a dark fascia: cream printed scales lit dimly from behind, their arcs, tick marks and red overload sections repeating at varied angles and sizes so no rhythm sets in. Glass covers holding faint reflections, black bezels between them, the whole surface low and warm rather than lit.


**sweep**

> A single meter needle's arc swung from upper left toward lower right, its illuminated scale glowing warm amber behind it and falling into shadow as the arc travels. The needle a thin hard line, its tip catching a bright point; the printed graduations blurring out past the lit zone. Black bezel and glass reflections elsewhere.


**burst**

> One backlit dial window flaring at the top-left corner: warm amber light behind a cream scale, the printed arc and numerals abstracted into pure marks, the glow spilling onto the surrounding fascia and dying by the middle of the frame. A needle crossing it, a red sector at its edge, everything beyond in unlit black.


**strata**

> Stacked meter and indicator windows across a dark rack face: horizontal bands of backlit scale, each a different height and warmth, separated by wide black bezels and thin chrome trim. The upper windows brighter and more detailed, lower ones dim or unlit entirely, glass catching a faint raking reflection along each row.


**scatter**

> Small indicator lamps and pilot LEDs scattered across a black fascia at varied focal depths: warm amber, a few cool green and red points, some sharp and some thrown out of focus into soft discs. Dense across the top, thinning to isolated points below. Between them, matte black panel and faint silkscreen ghosting.
