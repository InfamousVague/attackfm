import {
  AudioLines,
  Bookmark,
  BookOpenText,
  Gauge,
  Search,
  TableOfContents,
} from '@glacier/icons';
import { PhoneShot } from '../components/Device.tsx';
import { Footer } from '../components/Footer.tsx';
import { Nav } from '../components/Nav.tsx';
import { Reveal } from '../components/Reveal.tsx';
import { SHOTS } from '../shots.ts';

/**
 * The audiobooks page.
 *
 * A second document rather than another section on the home page: books are a
 * different product to the music player wearing the same clothes, and someone
 * arriving to ask "does it do audiobooks properly" should land on an answer
 * rather than scroll past four sections about a DJ to find one.
 *
 * Everything claimed here has shipped. The table is the point of the page -
 * the prose says what reading along feels like, and the table answers the
 * question the prose cannot, which is "yes, but does it do THE thing I need".
 */

/** What a row depends on, in the fewest words that are still true. */
type Needs = 'app' | 'hub' | 'read' | 'ai';

const NEEDS_LABEL: Record<Needs, string> = {
  app: 'Any device',
  hub: 'Your hub',
  read: 'Transcribed',
  ai: 'Local AI',
};

interface Feature {
  name: string;
  what: string;
  needs: Needs;
}

/**
 * The notable features, grouped the way a reader thinks about them rather than
 * the way the code is arranged.
 */
const GROUPS: { title: string; rows: Feature[] }[] = [
  {
    title: 'The shelf',
    rows: [
      {
        name: 'Books kept apart from music',
        what: 'Their own page and their own shelves. A twelve-hour reading has no business in a shuffle, so books stay out of the mix entirely.',
        needs: 'app',
      },
      {
        name: 'Continue reading',
        what: 'Every book you are part-way through, most recent first, each one opening exactly where you left it.',
        needs: 'hub',
      },
      {
        name: 'A place per book',
        what: 'Each book keeps its own mark. Starting a second book never moves the first, and returning to it returns to its own place.',
        needs: 'hub',
      },
      {
        name: 'Favourite books',
        what: 'Hearted books get a shelf of their own on the library page, beside your playlists.',
        needs: 'app',
      },
      {
        name: 'Search the shelf',
        what: 'Narrows as you type, by title, by author and by chapter name - a part name is often written nowhere else. Accents fold both ways.',
        needs: 'app',
      },
      {
        name: 'One row per book in search',
        what: 'A fifty-chapter reading answers as one result rather than fifty identical ones, and opening it picks the book up where you left it.',
        needs: 'app',
      },
      {
        name: 'Add a book you already own',
        what: 'A single file, or a whole folder of chapters zipped up and sent from a phone - the hub unpacks it, works out what it is, and shelves it under its author.',
        needs: 'hub',
      },
    ],
  },
  {
    title: 'Reading along',
    rows: [
      {
        name: 'Word-by-word reading',
        what: 'The word being spoken carries the accent; what has been said holds, what is coming waits dim. It follows the narrator, not a wall clock, so a buffering stall never lets the words run ahead.',
        needs: 'read',
      },
      {
        name: 'Tap a line to go there',
        what: 'The reading is a scrubber. Tap any line to move the voice to it, and scroll back through what you missed without losing your place.',
        needs: 'read',
      },
      {
        name: 'Keep a passage',
        what: 'Hold a line to keep it. Kept passages join your bookmarks, and every bookmark shows the sentence it kept rather than just the chapter it was in.',
        needs: 'read',
      },
      {
        name: 'Bookmarks',
        what: 'As many per book as you like, separate from the place a book resumes from. They travel between your devices with the rest of your settings.',
        needs: 'hub',
      },
      {
        name: 'Full-screen or a strip',
        what: 'The same reading, the same scrubber and the same times whether the player is a bar at the foot of the page or the whole screen.',
        needs: 'app',
      },
    ],
  },
  {
    title: 'Chapters',
    rows: [
      {
        name: 'Chapters, however the book arrived',
        what: 'A single tagged file and a folder of one-file-per-chapter both read as one book with chapters.',
        needs: 'app',
      },
      {
        name: 'The bar measures the chapter',
        what: 'Not the whole book. Eleven minutes into chapter four is a number you can use; four hours into the book is not. Dragging stays inside the chapter you are in.',
        needs: 'app',
      },
      {
        name: 'Numbered by what the narrator says',
        what: 'Not by what the files are called. A bought book opens with the publisher’s card, and rippers count that card as chapter one - so every chapter reads one ahead of itself. The reading does not make that mistake.',
        needs: 'read',
      },
      {
        name: 'Chapters named from the reading',
        what: 'The number and name announced in the opening breath - "Chapter Zero." - read straight off the transcription by code, with no model involved.',
        needs: 'read',
      },
      {
        name: 'Chapter descriptions',
        what: 'A one-line, spoiler-free description under each chapter name, written by the model on your own hub.',
        needs: 'ai',
      },
      {
        name: 'Chapter previews',
        what: 'Where no description is written, the chapter’s own opening words stand in - with the publisher’s card and the narrator’s announcement cut away, so a preview says something about ITS chapter.',
        needs: 'read',
      },
      {
        name: 'Skip the card and the credits',
        what: 'Most readings open with a minute of "this is a recording of" and close with a list of who made it. Where the transcript can see both, the book’s menu offers to start after the first and stop before the second, remembered for that book.',
        needs: 'read',
      },
    ],
  },
  {
    title: 'Pace and time',
    rows: [
      {
        name: 'Reading speed, 0.75× to 2×',
        what: 'Pitch held steady. Your pace is remembered, applies to every book, and never follows you into music.',
        needs: 'app',
      },
      {
        name: 'Narrator pace',
        what: '"168 wpm, brisk", beside the chapter count. The number that tells you whether to reach for 1.25× before you start rather than ten minutes in.',
        needs: 'read',
      },
      {
        name: 'Time left, in listening time',
        what: '"Left in the book" answers at the speed you actually read, not the length of the file.',
        needs: 'app',
      },
    ],
  },
  {
    title: 'Finding things',
    rows: [
      {
        name: 'Search the words inside a book',
        what: 'Type a half-remembered line and the results include the moment it is spoken. Open one and it plays from exactly there, not from the top of a twelve-hour reading.',
        needs: 'read',
      },
      {
        name: 'Transcribe, and transcribe again',
        what: 'Your hub reads the book itself, on your own hardware. A book can be re-read from its own menu when you want fresher words or newer chapter names.',
        needs: 'hub',
      },
      {
        name: 'Progress while it works',
        what: 'Books being transcribed sit at the top of the shelf with a bar - "chapter 3 of 42" for a sectioned book, and a running bar for a single file, which gives nothing to measure from outside.',
        needs: 'hub',
      },
    ],
  },
  {
    title: 'Away from the house',
    rows: [
      {
        name: 'Keep a whole book on the device',
        what: 'Every file downloaded and put out of the rolling cache’s reach, with its transcript written down beside them. The far end of a twenty-hour book is exactly what a cache calls cold.',
        needs: 'app',
      },
      {
        name: 'Storage that tells books from music',
        what: 'Each is its own share of the bar and its own line in the legend, saying how much you kept on purpose. Covers and transcripts are counted underneath.',
        needs: 'app',
      },
      {
        name: 'In the car',
        what: 'Books is a branch you can walk into on CarPlay and Android Auto, rather than a flat list of things to play.',
        needs: 'app',
      },
    ],
  },
];

const HIGHLIGHTS = [
  {
    icon: BookOpenText,
    title: 'The words, as they are read',
    body: 'The reading fills the screen and the narrator moves through it. Look up mid-sentence and the sentence is there; look away for an hour and it is still there when you come back.',
  },
  {
    icon: AudioLines,
    title: 'Transcribed on your own hardware',
    body: 'Your hub reads the book itself. Nothing is sent anywhere to be understood, and what it works out - the words, their clocks, the chapter names - stays on your machine with the book.',
  },
  {
    icon: TableOfContents,
    title: 'Chapters that agree with the book',
    body: 'Numbered by what the narrator announces rather than what a ripper typed, so chapter nine is chapter nine for all thirteen hours of it.',
  },
  {
    icon: Search,
    title: 'Find the line, not the book',
    body: 'Search what your library SAYS. A half-remembered sentence lands you at the moment it is spoken.',
  },
  {
    icon: Gauge,
    title: 'Your pace, and the real time left',
    body: 'Speed from three-quarters to double with the pitch held, and a "left in the book" figure that answers in listening time.',
  },
  {
    icon: Bookmark,
    title: 'Places worth keeping',
    body: 'A mark per book that is kept for you, and as many bookmarks as you like that you chose - each quoting the sentence it kept.',
  },
];

export function Audiobooks() {
  const total = GROUPS.reduce((n, g) => n + g.rows.length, 0);

  return (
    <>
      <Nav />
      <main>
        <section className="section booksHero" id="top">
          <div className="aurora" aria-hidden="true">
            <div className="aurora__blob aurora__blob--a" />
          </div>
          <div className="wrap">
            <Reveal className="stack">
              <p className="eyebrow">Audiobooks</p>
              <h1 className="display">
                A book you can <span className="accent">read while you listen</span>
              </h1>
              <p className="hero__lead">
                AttackFM plays the audiobooks you already own from your own server - and where you
                let it, reads them too. Your hub transcribes a book on your hardware, and from that
                one pass it draws the words in time with the narrator, names the chapters the way
                the reading names them, and lets you search a sentence you half remember.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="section section--ruled" id="along">
          <div className="wrap wrap--wide row">
            <Reveal variant="left" className="stack">
              <p className="eyebrow">Reading along</p>
              <h2 className="h2">
                The words, <span className="accent">as they are read</span>
              </h2>
              <p className="body">
                The sentence being read holds bright, the word being spoken carries the underline,
                and what is coming waits dim. It follows the narrator rather than a clock, so a
                stall on a slow connection never lets the text run ahead of the voice.
              </p>
              <p className="body">
                Underneath it: which chapter you are in and how much book is left at the speed you
                actually read, over a scrubber that measures the chapter rather than the whole
                thirteen hours. Scroll back through what you missed and tap any line to send the
                narrator to it.
              </p>
            </Reveal>

            <Reveal variant="right" className="row__media">
              <PhoneShot shot={SHOTS.reading} className="phone--native tilt" />
              <div className="deviceGlow" />
            </Reveal>
          </div>
        </section>

        <section className="section section--ruled" id="reading">
          <div className="wrap">
            <Reveal className="sectionHead stack">
              <p className="eyebrow">What you get</p>
              <h2 className="h2">Six things it does that a folder of files does not</h2>
            </Reveal>
            <div className="grid booksGrid">
              {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
                <Reveal key={title} className="card">
                  <span className="card__icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="h3">{title}</h3>
                  <p className="body">{body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="section section--ruled" id="features">
          <div className="wrap wrap--wide">
            <Reveal className="sectionHead stack">
              <p className="eyebrow">Every notable feature</p>
              <h2 className="h2">{total} of them, and what each one needs</h2>
              <p className="body">
                Most of this is the app on its own. Some of it needs the hub you run - that is where
                a book lives and where your place in it is kept. The rows marked{' '}
                <b>Transcribed</b> want the book read once by the recogniser on your hub; the ones
                marked <b>Local AI</b> want a model configured there as well. Nothing here talks to
                a service you do not run.
              </p>
            </Reveal>

            <Reveal>
              <div className="featureTableWrap">
                <table className="featureTable">
                  <caption className="visually-hidden">
                    Notable audiobook features, what each does, and what it requires
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Feature</th>
                      <th scope="col">What it does</th>
                      <th scope="col">Needs</th>
                    </tr>
                  </thead>
                  {GROUPS.map((group) => (
                    <tbody key={group.title}>
                      <tr className="featureTable__group">
                        <th scope="colgroup" colSpan={3}>
                          {group.title}
                        </th>
                      </tr>
                      {group.rows.map((row) => (
                        <tr key={row.name}>
                          <th scope="row">{row.name}</th>
                          <td>{row.what}</td>
                          <td>
                            <span className="needs" data-needs={row.needs}>
                              {NEEDS_LABEL[row.needs]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="section get">
          <div className="wrap">
            <Reveal className="stack center">
              <h2 className="h2">Bring your own books</h2>
              <p className="body">
                Point the hub at the files you own and they arrive as books, with their chapters.
                Nothing here fetches anything for you.
              </p>
              <div className="get__buttons">
                <a className="btn btn--primary" href="/#download">
                  Get the app
                </a>
                <a className="btn btn--ghost" href="/#yours">
                  How self-hosting works
                </a>
              </div>
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
