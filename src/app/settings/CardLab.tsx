import { useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, Text } from '@glacier/react';
import { Disc3, Heart, ListMusic, Repeat, X } from '@glacier/icons';
import { useLibrary } from '../library/library.tsx';
import { CardStylePicker } from './CardStylePicker.tsx';
import likedChip from '../../assets/chip-liked.webp';
import allSongsChip from '../../assets/chip-all-songs.webp';
import onRepeatChip from '../../assets/chip-on-repeat.webp';
import djMascot from '../../assets/dj-mascot.webp';

/**
 * The card lab: every way the four library doors could look, side by side.
 *
 * These four cards have been redrawn several times - photography, then flat
 * pastel with kit icons, then photography again tinted to each card's hue - and
 * every round was argued in words and settled by shipping one and looking at
 * it. This is the cheaper version of that argument: every direction on one
 * screen, on the real objects and the real counts, where they can be compared
 * rather than imagined.
 *
 * ONE markup, one stylesheet block each. Every variant renders identical DOM and
 * the CSS does all the work, which is the whole point - if a direction needs
 * its own markup to look good it is not a treatment of these cards, it is a
 * different component wearing their name, and the comparison would be rigged.
 *
 * They arrived in three rounds of ten, and the rounds are visible: the first
 * circled one idea (an object on a coloured field) too closely to settle
 * anything, the second deliberately spread out from it, and the third moves on
 * axes the first twenty never used at all - the card as an object rather than
 * a picture of one, the name as the window rather than the caption, the bars
 * as the whole face, and one that is only itself while it is moving.
 *
 * After that, variations rather than new directions: a direction that is nearly
 * right is worth three attempts at the thing that is wrong with it, and those
 * carry a `family` so they can be put on screen beside their parent.
 */

interface Card {
  key: string;
  name: string;
  sub: string;
  hue: number;
  hue2: number;
  art: string;
  Icon: typeof Heart;
  /** The number on its own, for the treatments that lead with it. */
  stat: string;
  statLabel: string;
}

/**
 * The directions, in the order they are shown.
 *
 * `family` groups a direction with its variations so they can be put on screen
 * together. Judging "is this too pale" one card at a time does not work - the
 * answer only exists next to the alternative.
 */
const STYLES: { id: string; name: string; note: string; family?: string }[] = [
  {
    id: 'editorial',
    name: 'Editorial',
    note: 'No picture at all. The name does the work, set large and tight over a hairline rule, with the count as a small caption. Fastest to read of anything here, and the only one that never has to load.',
  },
  {
    id: 'emboss',
    name: 'Emboss',
    note: 'One graphite surface for all four, the object pressed into it rather than laid on top - no colour, only light. Quietest option: it lets the artwork below the fold be the loudest thing on the page.',
  },
  {
    id: 'halftone',
    family: 'halftones',
    name: 'Duotone halftone',
    note: 'The object screened into dots and printed in two inks, the way a cheap sleeve would be. Keeps the objects while dropping the photographic gloss that makes them read as stock imagery.',
  },
  {
    id: 'glass',
    name: 'Frosted glass',
    note: 'A panel of frost over a saturated field, the object behind it and slightly out of focus. Sits closest to the rest of the app, which is glass almost everywhere else.',
  },
  {
    id: 'neon',
    name: 'Neon wire',
    note: 'Near-black card, the object reduced to a glowing outline. Only as good as the object: the heart and the amp have edges to find, the mirror ball has none and stays a lit blob.',
  },
  {
    id: 'sticker',
    name: 'Die-cut sticker',
    note: 'Flat colour, the object cut out with a white keyline and a hard shadow, set down a few degrees off square. The most physical of the ten.',
  },
  {
    id: 'stub',
    name: 'Label stub',
    note: 'Utilitarian: mono type, a thin frame, a perforated edge and a block of bars. Treats a collection as an object you file rather than a picture you look at.',
  },
  {
    id: 'stat',
    name: 'Number first',
    note: 'The count is the card. Useful when the four doors differ mostly in how much is behind them - and the only direction here that says something new rather than dressing what is already said.',
  },
  {
    id: 'mosaic',
    name: 'Real covers',
    note: 'The face is made of sleeves actually in that collection. No illustration to commission and it changes as the library does, but it says nothing at all on an empty library.',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    note: 'A soft mesh of colour with the object floating over a long diffuse shadow. The most current-looking, and the most likely to date.',
  },
  {
    id: 'midnight',
    family: 'halftones',
    name: 'Midnight halftone',
    note: 'The same dot screen printed the other way round: hot ink on near-black instead of dark ink on cream. Keeps the print texture but loses the pastel, and the objects light up instead of sitting flat.',
  },
  {
    id: 'tab',
    name: 'Shelf tab',
    note: 'A saturated band down the leading edge carrying the icon, and nothing else but the name. Colour is doing the sorting, not the picture - four cards you tell apart at the edge of your eye.',
  },
  {
    id: 'chrome',
    family: 'chromes',
    name: 'Chrome',
    note: 'Brushed metal for all four, the object polished into the plate with one specular sweep across it. Heavy, and the only direction here that would look wrong on a light theme.',
  },
  {
    id: 'riso',
    name: 'Risograph',
    note: 'Two inks printed slightly out of register on rough paper, the way a risograph misses. The misregistration is the whole look, so it has to stay visible enough to read as deliberate.',
  },
  {
    id: 'marquee',
    name: 'Marquee',
    note: 'A theatre sign: warm bulbs across the top, wide caps, everything lit from the front. The friendliest of the thirty and the least like the rest of the app.',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    note: 'Technical drawing - deep blue, a hairline grid, the object as a white line on top. Cold and precise, and it makes a library feel like equipment rather than music.',
  },
  {
    id: 'crt',
    name: 'CRT',
    note: 'Scanlines and a channel split, as if the card were being read off a tube. Fun once; the split costs real legibility at this size, which is the thing to judge.',
  },
  {
    id: 'papercut',
    name: 'Paper cut',
    note: 'Layers of cut paper with soft shadows between them, the object sitting in the window. The lightest and calmest here, and the only one that would suit a light theme untouched.',
  },
  {
    id: 'grain',
    name: 'Grain field',
    note: 'A hard two-stop gradient under heavy film grain, the object dropped to a flat silhouette. Poster logic: no detail at all, just shape and colour.',
  },
  {
    id: 'contact',
    name: 'Contact sheet',
    note: 'Sleeves as a strip of film rather than a wall of squares, the name above it. Like Real covers, it is only as good as the library behind it - but a strip survives a thin collection better than a grid does.',
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    note: 'The card is a record: grooves across the whole face, a paper label off to one side, one sheen falling over it. The most on-the-nose idea here, which is either the reason to take it or the reason not to.',
  },
  {
    id: 'cassette',
    name: 'Cassette',
    note: 'A shell rather than a sleeve - two hubs, a window, a written-on label. Says "a mix somebody made" in a way none of the others manage, which fits two of these four doors and not the other two.',
  },
  {
    id: 'knockout',
    name: 'Knockout',
    note: 'The name is the window: the object shows through the letterforms and nothing shows around them. Wants a short name and a busy picture, so Liked and DJ carry it and All songs is the test case.',
  },
  {
    id: 'levels',
    name: 'Levels',
    note: 'No object at all - the meter is the face, running the width of the card. The only direction that looks like the thing the app is actually doing while you read it.',
  },
  {
    id: 'outline',
    name: 'Outline',
    note: 'Near-black with every bit of the colour spent on a two-pixel gradient edge. The quietest of the thirty by a distance, and the one that would age slowest.',
  },
  {
    id: 'plastic',
    name: 'Soft plastic',
    note: 'One moulded surface lit from the top left, the object resting on it rather than pressed into it. Where Emboss is cut stone this is a toy, and at this size that reads as friendly rather than cheap.',
  },
  {
    id: 'diagonal',
    name: 'Diagonal',
    note: 'Two flat fields with a hard seam between them and the object straddling it. No gradients, no texture, no light - the only direction here built purely out of shape.',
  },
  {
    id: 'woodcut',
    name: 'Woodcut',
    note: 'The object thresholded to pure black on cream and hung under a heavy rule. Loses every mid-tone, which is the point: what survives is what would survive on a poster across a room.',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    note: 'A prompt and a cursor. Honest about what a library really is - and a joke that stops being funny about four days in, which is worth knowing before it ships.',
  },
  {
    id: 'pulse',
    name: 'Pulse',
    note: 'The only one that is not a still picture: the light behind the object breathes, each card out of step with its neighbours. Judge it moving - and note that it holds still for anyone who has asked their system to stop animations.',
  },
  {
    id: 'halftoneRich',
    family: 'halftones',
    name: 'Halftone: rich stock',
    note: 'The same print, run on properly coloured stock instead of tinted paper. 03 sits at 88% lightness, which is why everything on it goes chalky; this drops the ground to 62% and darkens the ink to match, and the colour arrives without touching the dots.',
  },
  {
    id: 'halftoneHot',
    family: 'halftones',
    name: 'Halftone: hot inks',
    note: 'Paper goes back to plain cream and all the colour moves into the ink - two of them, at full chroma, on a coarser screen. The most like an actual two-colour print of anything here, and the furthest from pastel without going dark.',
  },
  {
    id: 'halftoneRev',
    family: 'halftones',
    name: 'Halftone: reversed',
    note: 'A dense field of colour with the screen knocked out of it in white, the object printed light. Not the same as Midnight: that one glows on black, this one stays a flat printed thing and keeps its weight in a bright room.',
  },
  {
    id: 'chromeLiquid',
    family: 'chromes',
    name: 'Chrome: liquid',
    note: 'Mirror rather than brushed - the bright band at the top is sky, the dark one across the middle is horizon. No brush texture at all, so it reads wetter and much less like a machined panel.',
  },
  {
    id: 'chromeAnodised',
    family: 'chromes',
    name: 'Chrome: anodised',
    note: 'The same plate taking each card\'s hue, the way anodised metal does: rose for Liked, blue steel for All songs. Fixes the one real complaint about 13, which is that four identical grey cards throw away the colour coding the rest of the app relies on.',
  },
  {
    id: 'chromeDark',
    family: 'chromes',
    name: 'Chrome: dark',
    note: 'Gunmetal, with one lit edge along the top and the sweep pulled right back. Sits quietly next to the rest of the app where 13 shouts, at the cost of most of what makes metal read as metal.',
  },
];

export function CardLab({ onClose }: { onClose: () => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const [only, setOnly] = useState<string | null>(null);

  /** Real sleeves for the mosaic direction, so it is judged on real data. */
  const covers = useMemo(
    () => tracks.map((t) => t.artwork).filter((a): a is string => !!a).slice(0, 16),
    [tracks],
  );

  const cards: Card[] = useMemo(
    () => [
      {
        key: 'liked',
        name: 'Liked',
        sub: `${favoriteTracks.length} songs`,
        hue: 338,
        hue2: 300,
        art: likedChip,
        Icon: Heart,
        stat: String(favoriteTracks.length),
        statLabel: 'liked',
      },
      {
        key: 'all',
        name: 'All songs',
        sub: `${tracks.length} songs`,
        hue: 214,
        hue2: 262,
        art: allSongsChip,
        Icon: ListMusic,
        stat: String(tracks.length),
        statLabel: 'in your library',
      },
      {
        key: 'repeat',
        name: 'On repeat',
        sub: 'Your most played',
        hue: 145,
        hue2: 190,
        art: onRepeatChip,
        Icon: Repeat,
        stat: '24',
        statLabel: 'on repeat',
      },
      {
        key: 'dj',
        name: 'DJ',
        sub: 'A live set, from your taste',
        hue: 265,
        hue2: 315,
        art: djMascot,
        Icon: Disc3,
        stat: '∞',
        statLabel: 'never the same twice',
      },
    ],
    [tracks.length, favoriteTracks.length],
  );

  const shown = only ? STYLES.filter((s) => s.id === only || s.family === only) : STYLES;

  /** Families that have more than one member, in first-appearance order. */
  const families = useMemo(() => {
    const seen: string[] = [];
    for (const s of STYLES) if (s.family && !seen.includes(s.family)) seen.push(s.family);
    return seen;
  }, []);

  return createPortal(
    <div className="cardLab" role="dialog" aria-label="Card styles">
      <header className="cardLab__bar">
        <div className="cardLab__title">
          <Text weight="bold">Card styles</Text>
          <Text tone="muted" size="xs">
            {STYLES.length} directions for the four library doors, on your own library
          </Text>
        </div>
        <IconButton variant="ghost" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>

      <nav className="cardLab__jump" aria-label="Jump to a style">
        <button
          type="button"
          className="cardLab__chip"
          data-on={only === null || undefined}
          onClick={() => setOnly(null)}
        >
          All {STYLES.length}
        </button>
        {families.map((f) => (
          <button
            key={f}
            type="button"
            className="cardLab__chip"
            data-on={only === f || undefined}
            onClick={() => setOnly(f)}
          >
            Every {f.slice(0, -1)}
          </button>
        ))}
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="cardLab__chip"
            data-on={only === s.id || undefined}
            onClick={() => setOnly(s.id)}
          >
            {s.name}
          </button>
        ))}
      </nav>

      <div className="cardLab__scroll">
        {/* The six that ship, and the only part of this screen that CHANGES
            anything. Everything below is a workshop - directions drawn on the
            lab's own markup so they can be compared, most of them once. These
            six are drawn on the real card, because picking one applies it. */}
        <section className="cardLab__style cardLab__pick">
          <div className="cardLab__head">
            <span className="cardLab__no">--</span>
            <div>
              <Text weight="bold" size="sm">
                The six we ship
              </Text>
              <p className="cardLab__note">
                Pick one and the library wears it. The rest of this screen is the workshop
                they came out of.
              </p>
            </div>
          </div>
          <CardStylePicker count={tracks.length} />
        </section>
        <hr className="cardLab__rule" />

        {shown.map((style, i) => (
          <section key={style.id} className="cardLab__style">
            <div className="cardLab__head">
              <span className="cardLab__no">{String(STYLES.indexOf(style) + 1).padStart(2, '0')}</span>
              <div>
                <Text weight="bold" size="sm">
                  {style.name}
                </Text>
                <p className="cardLab__note">{style.note}</p>
              </div>
            </div>

            <div className={`labRow labRow--${style.id}`}>
              {cards.map((c) => (
                <div
                  key={c.key}
                  className={`labCard labCard--${c.key}`}
                  style={
                    {
                      '--h': c.hue,
                      '--h2': c.hue2,
                      '--art': `url("${c.art}")`,
                    } as CSSProperties
                  }
                >
                  {/* Every piece every variant might want, always present.
                      The stylesheets choose; nothing is conditionally rendered,
                      so no direction gets a structural advantage. */}
                  <span className="labCard__wash" aria-hidden />
                  {(style.id === 'mosaic' || style.id === 'contact') && (
                    <span className="labCard__mosaic" aria-hidden>
                      {(covers.length ? covers : Array(9).fill(null)).slice(0, 9).map((src, n) =>
                        src ? (
                          <img key={n} src={src} alt="" loading="lazy" />
                        ) : (
                          <span key={n} className="labCard__mosaicHole" />
                        ),
                      )}
                    </span>
                  )}
                  <img className="labCard__art" src={c.art} alt="" loading="lazy" />
                  <span className="labCard__glyph" aria-hidden>
                    <c.Icon size={34} strokeWidth={2} />
                  </span>
                  <span className="labCard__stat" aria-hidden>
                    {c.stat}
                  </span>
                  <span className="labCard__name">{c.name}</span>
                  <span className="labCard__sub">
                    {style.id === 'stat' ? c.statLabel : c.sub}
                  </span>
                  <span className="labCard__bars" aria-hidden>
                    {Array.from({ length: 14 }, (_, n) => (
                      <i key={n} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
            {i < shown.length - 1 && <hr className="cardLab__rule" />}
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
