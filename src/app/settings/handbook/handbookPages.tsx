import type { ReactNode } from 'react';
import {
  AppWindow,
  Blocks,
  BookAudio,
  BookOpen,
  Braces,
  Command,
  Compass,
  Disc3,
  Download,
  FolderTree,
  Gauge,
  HardDrive,
  Layers,
  LibraryBig,
  ListOrdered,
  ListTree,
  MonitorSmartphone,
  MonitorSpeaker,
  Network,
  PackageOpen,
  Palette,
  QrCode,
  Quote,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Telescope,
  Upload,
} from '@glacier/icons';

/**
 * The handbook's pages: everything the pane shows, as data, so the pager is
 * dumb and the words live in one place. Each page is one idea - an icon, a
 * title, a screenful of prose - filed under a chapter the progress bar
 * segments by. Order here IS the reading order.
 *
 * The voice matches the rest of the app: what a thing is and why it is that
 * way, not marketing. The plugin chapter is the exception - it is written at
 * developers, and precision beats warmth where the two pull apart.
 */

export interface HandbookPage {
  /** Stable key; also what the pager's animation re-keys on. */
  id: string;
  /** The chapter this page files under - the progress bar's segments. */
  chapter: string;
  /** The page's glyph, drawn in the tinted squircle at the top. */
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

/** A paragraph of handbook prose. */
function P({ children }: { children: ReactNode }) {
  return <p className="handbook__p">{children}</p>;
}

/** Icon-led fact rows - the handbook's bullet points. */
function Facts({ items }: { items: readonly { icon: ReactNode; text: ReactNode }[] }) {
  return (
    <ul className="handbook__facts">
      {items.map((f, i) => (
        <li key={i}>
          <span className="handbook__factIcon" aria-hidden="true">
            {f.icon}
          </span>
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A short code block - a manifest, a signature - kept small on purpose. */
function Code({ children }: { children: string }) {
  return (
    <pre className="handbook__code">
      <code>{children}</code>
    </pre>
  );
}

const GLYPH = 26;
const FACT = 14;

export const HANDBOOK_PAGES: readonly HandbookPage[] = [
  // ── Welcome ────────────────────────────────────────────────────────────
  {
    id: 'cover',
    chapter: 'Welcome',
    icon: <BookOpen size={GLYPH} />,
    title: 'The AttackFM Handbook',
    body: (
      <>
        <P>
          How the app works, and how to build for it - one page at a time. The
          first chapters walk the app the way a listener meets it; the last one
          is written at developers and ends with a plugin you could publish.
        </P>
        <P>
          Turn pages with the arrows below, the ← → keys, or a sideways swipe
          on the page itself. The bar above tracks where you are - tap a
          segment to jump to that chapter - and the counter between the arrows
          opens the whole index, every page of every chapter, from anywhere.
        </P>
      </>
    ),
  },

  // ── The app ────────────────────────────────────────────────────────────
  {
    id: 'identity',
    chapter: 'The app',
    icon: <Network size={GLYPH} />,
    title: 'Identity, then a library',
    body: (
      <>
        <P>
          An account is who you are; a server is only where some music happens
          to live. So a fresh phone asks for the account first, and everything
          else hangs off it: the servers it can reach, the devices it plays
          on, the friends who can hear what you are into.
        </P>
        <Facts
          items={[
            {
              icon: <Network size={FACT} />,
              text: 'One central account, whatever server you listen from.',
            },
            {
              icon: <Server size={FACT} />,
              text: 'Join a server with an invite, sign into one directly, or skip and stay local.',
            },
            {
              icon: <Compass size={FACT} />,
              text: 'Skipped onboarding is never nagged about - joining later lives on the Friends page.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'nav',
    chapter: 'The app',
    icon: <Compass size={GLYPH} />,
    title: 'Getting around',
    body: (
      <>
        <P>
          The phone keeps its tabs on the bottom bar, the desktop keeps them on
          a rail - same items, the shape each platform holds naturally. Every
          page you open joins one back/forward history, so the app never loses
          your place.
        </P>
        <Facts
          items={[
            {
              icon: <Compass size={FACT} />,
              text: 'Drag in from the left edge to go back - the page follows your thumb, and letting go early puts it back.',
            },
            {
              icon: <Search size={FACT} />,
              text: 'Pull down on any page (or press ⌘K) to summon search over whatever you were doing.',
            },
            {
              icon: <AppWindow size={FACT} />,
              text: 'Plugins can add whole tabs here; the bar folds them in beside Home and Library.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'library',
    chapter: 'The app',
    icon: <LibraryBig size={GLYPH} />,
    title: 'The library and the hub',
    body: (
      <>
        <P>
          Signed into a server, the server is the library - the phone, the
          desktop and the web all read the same shelves. A desktop with a local
          music folder feeds the hub rather than competing with it: it first
          asks the server what is missing, then sends only that.
        </P>
        <Facts
          items={[
            {
              icon: <Server size={FACT} />,
              text: 'Playlists live on the server when signed in, so every device sees one set.',
            },
            {
              icon: <Download size={FACT} />,
              text: 'Imports run on the server too - a phone can start one and put its screen to sleep.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'deck',
    chapter: 'The app',
    icon: <Disc3 size={GLYPH} />,
    title: 'The deck',
    body: (
      <>
        <P>
          One queue, whatever feeds it - an album, a playlist, a station, a
          friend&rsquo;s jam. Crossfade, the equalizer and the sleep timer live
          in Playback settings; the disc itself scratches under your finger,
          on a real tape loop, because a jog wheel that ignores physics is just
          a button.
        </P>
        <Facts
          items={[
            {
              icon: <Sparkles size={FACT} />,
              text: 'Effects are rendered by the server, so a preset sounds identical on every device.',
            },
            {
              icon: <MonitorSpeaker size={FACT} />,
              text: 'The queue survives navigation - pages come and go, the deck does not.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'books',
    chapter: 'The app',
    icon: <BookAudio size={GLYPH} />,
    title: 'Books',
    body: (
      <>
        <P>
          Audiobooks keep a shelf of their own, with a seat on the bar - a
          nightly book is a daily destination, and a twelve-hour reading loose
          in shuffle would be wrong every place it turned up. Books file under
          their authors, the hero&rsquo;s one verb is Resume, and a transcribed
          book&rsquo;s card says how fast its narrator actually reads - 168
          wpm, brisk - the number that settles 1.25&times; before the book
          starts rather than ten minutes in.
        </P>
        <P>
          Playing one turns Now Playing into a reader. The hub transcribes a
          book ahead of time - the shelf&rsquo;s Read along button asks, and a
          book&rsquo;s hold menu can always ask for a fresh reading - and the
          words follow the narration word by word. Tap a line to play from its
          top; hold one to keep it, and the passage joins that book&rsquo;s
          bookmarks carrying the sentence itself, kept with your account so a
          place marked on the sofa is there on the bus. Chapters get truthful
          names and a line each without spoilers, written by the hub&rsquo;s
          AI - a preamble mislabelled Chapter 1 gets called a preamble.
        </P>
        <Facts
          items={[
            {
              icon: <Gauge size={FACT} />,
              text: 'Speed runs 0.75× to 2× without touching pitch - chapters, bookmarks and the words all stay exactly where they were.',
            },
            {
              icon: <SkipForward size={FACT} />,
              text: 'Where the transcript can see the publisher’s card and the closing credits, the book’s menu offers to skip both, remembered for that book alone.',
            },
            {
              icon: <Quote size={FACT} />,
              text: 'Spoken words are searchable: half a remembered line surfaces as “Heard in your library” and plays from the moment it is said.',
            },
            {
              icon: <Upload size={FACT} />,
              text: 'Add a book puts one you own on the shelf. A phone cannot hand over a folder of chapters, so zip it and add the zip - the hub unpacks it and shelves the book, chapters intact.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'search',
    chapter: 'The app',
    icon: <Search size={GLYPH} />,
    title: 'Search',
    body: (
      <>
        <P>
          One search, summoned from anywhere, over songs, artists, albums and
          lyrics at once. It forgives typos rather than returning nothing, and
          it remembers what you reached for last time.
        </P>
        <Facts
          items={[
            {
              icon: <Command size={FACT} />,
              text: (
                <>
                  Operators narrow it: <code>artist:</code>, <code>album:</code>,{' '}
                  <code>genre:</code> - stackable with free text.
                </>
              ),
            },
            {
              icon: <Search size={FACT} />,
              text: 'Plugins can answer too: a pasted store link becomes an import command right in the results.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'booth',
    chapter: 'The app',
    icon: <Sparkles size={GLYPH} />,
    title: 'The Booth and the taste engine',
    body: (
      <>
        <P>
          Behind the Booth sits a curator that reads the library - tempo,
          mood, what plays next to what - and builds mixes from what it learns.
          It counts a song as yours only when you finish it or heart it. A skip
          is not a listen, and the engine knows the difference.
        </P>
        <P>
          Its knobs live in the Booth itself rather than in Settings: they are
          the taste engine&rsquo;s own, opened from its room, not a pane about
          an abstraction.
        </P>
      </>
    ),
  },
  {
    id: 'suggestions',
    chapter: 'The app',
    icon: <Telescope size={GLYPH} />,
    title: 'What it suggests',
    body: (
      <>
        <P>
          Everything the machine picks for you sits on Library, under your own
          shelves. The mixes are built on the server from your listening and
          contain only music you already own, so they play the instant you tap
          them; Music Date is the deck of things the collector went and fetched
          on your behalf, waiting on a listen to earn a place.
        </P>
        <P>
          There is no separate Discover page. Looking for music you do not own
          yet is a search - the search field takes a Discover scope, which looks
          outward instead of at your shelves.
        </P>
        <Facts
          items={[
            {
              icon: <Download size={FACT} />,
              text: 'A card you do not own yet still plays: tapping it opens Now Playing downloading.',
            },
            {
              icon: <Blocks size={FACT} />,
              text: 'Suggestions are per listener: two people on one server get different shelves.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'offline',
    chapter: 'The app',
    icon: <HardDrive size={GLYPH} />,
    title: 'Offline and the cache',
    body: (
      <>
        <P>
          The phone keeps a self-rotating cache of what you actually play,
          ranked by how hot a song runs - recency and count together - so the
          plane test passes without anyone managing storage.
        </P>
        <Facts
          items={[
            {
              icon: <HardDrive size={FACT} />,
              text: 'Pinned songs are sacred: never evicted, never counted against the cache budget.',
            },
            {
              icon: <RefreshCw size={FACT} />,
              text: 'Downloads & space shows both halves - how many songs are down here, and what they cost.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'connect',
    chapter: 'The app',
    icon: <MonitorSpeaker size={GLYPH} />,
    title: 'Connect: where it plays',
    body: (
      <>
        <P>
          Every signed-in device appears in one registry, and exactly one of
          them holds the seat - the device actually making sound. The others
          are remotes: they see the same queue and drive the same playback,
          and pressing play somewhere claims the seat first, deliberately, so
          music never jumps rooms by accident.
        </P>
        <P>
          Jams are their own room, not a hand-off: the host&rsquo;s player
          sets the pace, everyone else follows it, and a friend&rsquo;s room
          folds your picks into their queue instead of yours. If the host
          steps out, the clock passes to whoever has been there longest.
        </P>
      </>
    ),
  },
  {
    id: 'servers',
    chapter: 'The app',
    icon: <Server size={GLYPH} />,
    title: 'Servers and mirrors',
    body: (
      <>
        <P>
          An account can know several servers, but a device is signed into one
          at a time - the Servers pane is where you move. A mirror can carry
          the songs you actually listen to, so a small box in the cloud covers
          for the big one at home when you are away.
        </P>
        <Facts
          items={[
            {
              icon: <Server size={FACT} />,
              text: 'The header’s network dot glances the connection; Manage lands on the Servers pane.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'pairing',
    chapter: 'The app',
    icon: <QrCode size={GLYPH} />,
    title: 'Linking a device',
    body: (
      <>
        <P>
          Nobody should type a password on a phone keyboard. A device that is
          already in shows a one-time code - scan it and the new device is
          signed in, server address and all. The typed code underneath exists
          for the day the camera does not.
        </P>
        <Facts
          items={[
            {
              icon: <QrCode size={FACT} />,
              text: 'Settings → Link a device on the signed-in side; the camera on the new one.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'updates',
    chapter: 'The app',
    icon: <RefreshCw size={GLYPH} />,
    title: 'Updates',
    body: (
      <>
        <P>
          The app checks for a new frontend shortly after launch and every few
          hours after, downloads it in the background, verifies it, and offers
          a restart with a banner that says what changed. No store, no cable -
          a TypeScript fix reaches every device the same day it ships.
        </P>
        <Facts
          items={[
            {
              icon: <ShieldCheck size={FACT} />,
              text: 'A bundle needing a newer native shell than yours is refused, not half-applied.',
            },
            {
              icon: <RefreshCw size={FACT} />,
              text: 'About shows every check’s outcome - silence is the one thing an updater must never be.',
            },
          ]}
        />
      </>
    ),
  },

  // ── Under the hood ─────────────────────────────────────────────────────
  {
    id: 'stack',
    chapter: 'Under the hood',
    icon: <Layers size={GLYPH} />,
    title: 'The stack',
    body: (
      <>
        <P>
          One TypeScript + React app, built with Vite, is the whole frontend -
          the phone, the desktop and the browser all run the same bundle inside
          Tauri shells or a plain tab. The hub is a Rust server; identity is a
          separate registry service the devices and servers both trust.
        </P>
        <Facts
          items={[
            {
              icon: <Layers size={FACT} />,
              text: 'An OTA update is exactly two self-contained files: app.js and app.css.',
            },
            {
              icon: <Server size={FACT} />,
              text: 'The server owns the heavy work: imports, effects, the discover feed, enrichment.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'design',
    chapter: 'Under the hood',
    icon: <Palette size={GLYPH} />,
    title: 'The design system',
    body: (
      <>
        <P>
          Every control comes from Glacier, the house component kit - buttons,
          fields, modals, the settings surface this handbook sits in - themed
          by tokens, so five themes and a rack of accents are data, not forks.
        </P>
        <Facts
          items={[
            {
              icon: <Palette size={FACT} />,
              text: 'The app’s own stylesheet is a book of ordered chapters; order is the cascade, and a rule’s chapter is part of its meaning.',
            },
            {
              icon: <Blocks size={FACT} />,
              text: 'Plugins get the same kit and the same icons, so nothing they draw looks foreign.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'providers',
    chapter: 'Under the hood',
    icon: <ListTree size={GLYPH} />,
    title: 'The provider pyramid',
    body: (
      <>
        <P>
          The app renders inside a stack of providers whose nesting order is
          load-bearing: who you are sits above which server you are on, which
          sits above the library, which sits above the plugins, which sit above
          playback. Each layer can read everything above it and nothing below.
        </P>
        <P>
          That is why a connect or disconnect rebuilds the library instead of
          blending two, and why a plugin&rsquo;s provider may call{' '}
          <code>useLibrary</code> - the pyramid put the library above it on
          purpose.
        </P>
      </>
    ),
  },

  // ── Building plugins ───────────────────────────────────────────────────
  {
    id: 'plugin-object',
    chapter: 'Building plugins',
    icon: <Blocks size={GLYPH} />,
    title: 'A plugin is a plain object',
    body: (
      <>
        <P>
          No base class, no lifecycle methods, no manifest ceremony at runtime.
          A plugin is an object with an id, a name, and whichever contribution
          fields it wants to fill. Mounting and unmounting its contributions IS
          the lifecycle - React already owns that.
        </P>
        <P>
          Every field must be stable for the life of the app. Dynamism lives
          inside the components and hooks a plugin hands over, never in the
          shape of the object itself.
        </P>
        <Code>{`import type { Plugin } from '../types.ts';

export const myPlugin: Plugin = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'One sentence on the card.',
};`}</Code>
      </>
    ),
  },
  {
    id: 'plugin-two-ways',
    chapter: 'Building plugins',
    icon: <PackageOpen size={GLYPH} />,
    title: 'Two ways in',
    body: (
      <>
        <P>
          A plugin either compiles into the app - one line in the registry
          array, ordered in version control - or installs from a repository at
          runtime. A repository is just a URL serving <code>index.json</code>{' '}
          and one bundle file per plugin; the official one is baked in, and a
          server can host its own.
        </P>
        <Facts
          items={[
            {
              icon: <Download size={FACT} />,
              text: 'Installing downloads the bundle once and persists it - plugins load at boot, network or not.',
            },
            {
              icon: <PackageOpen size={FACT} />,
              text: 'A repository is a distribution channel, not a dependency: removing a source uninstalls nothing.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-platforms',
    chapter: 'Building plugins',
    icon: <MonitorSmartphone size={GLYPH} />,
    title: 'Where a plugin may run',
    body: (
      <>
        <P>
          Three flags describe what a plugin needs, and the marketplace filters
          live against the platform and the session - a card offering something
          the device cannot do is worse than no card.
        </P>
        <Facts
          items={[
            {
              icon: <MonitorSmartphone size={FACT} />,
              text: (
                <>
                  <code>desktopOnly</code> - shells out or walks the filesystem;
                  never listed on a phone.
                </>
              ),
            },
            {
              icon: <Server size={FACT} />,
              text: (
                <>
                  <code>requiresServer</code> - its whole value lives on the
                  hub; absent everywhere until a server connects.
                </>
              ),
            },
            {
              icon: <Network size={FACT} />,
              text: (
                <>
                  <code>serverBacked</code> - a local engine will do (desktop),
                  or a server will (anywhere); the importer reaches a phone the
                  moment it signs in.
                </>
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-chrome',
    chapter: 'Building plugins',
    icon: <AppWindow size={GLYPH} />,
    title: 'Contributions: chrome and pages',
    body: (
      <>
        <P>
          The chrome offers fixed mount points, and a plugin fills the ones it
          wants. A page is the biggest: a first-class navigation destination
          with its own nav item, walked by the app&rsquo;s history like Home
          is.
        </P>
        <Facts
          items={[
            {
              icon: <AppWindow size={FACT} />,
              text: (
                <>
                  <code>slots</code> - one component each for{' '}
                  <code>titlebar-end</code> and <code>player-trailing</code>.
                </>
              ),
            },
            {
              icon: <Compass size={FACT} />,
              text: (
                <>
                  <code>pages</code> - label, icon, and a Content component
                  handed <code>onPlay</code> and <code>onOpenArtist</code>;
                  everything else it reads from context like a core page.
                </>
              ),
            },
            {
              icon: <BookOpen size={FACT} />,
              text: (
                <>
                  <code>settingsSections</code> - tabs appended to this very
                  modal, rendered behind the crash fence.
                </>
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-data',
    chapter: 'Building plugins',
    icon: <Download size={GLYPH} />,
    title: 'Contributions: data contracts',
    body: (
      <>
        <P>
          Some contributions are data, not components, so the app keeps its own
          look and the plugin says only what the thing IS.
        </P>
        <Facts
          items={[
            {
              icon: <Disc3 size={FACT} />,
              text: (
                <>
                  <code>playlistTiles</code> - a hook returning name, cover,
                  tracks; the showcase draws the tile and wires play-through
                  itself.
                </>
              ),
            },
            {
              icon: <Download size={FACT} />,
              text: (
                <>
                  <code>downloads</code> - hand your queue to the Downloads
                  page. Four states (queued, downloading, done, error), an
                  optional <code>stage</code> for finer words, optional{' '}
                  <code>parts</code> for the disclosure list.
                </>
              ),
            },
            {
              icon: <ShieldCheck size={FACT} />,
              text: 'Never render your own queue page - a user watching two things arrive should not need to know which plugin owns which.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-verbs',
    chapter: 'Building plugins',
    icon: <Command size={GLYPH} />,
    title: 'Contributions: verbs',
    body: (
      <>
        <P>
          Two hooks let a plugin answer the app&rsquo;s questions in the
          moment they are asked.
        </P>
        <Facts
          items={[
            {
              icon: <Command size={FACT} />,
              text: (
                <>
                  <code>usePaletteCommands</code> - commands for the current
                  search query. Mark one <code>exclusive</code> when the query
                  is an action, like a pasted link, and songs should stand
                  aside.
                </>
              ),
            },
            {
              icon: <Download size={FACT} />,
              text: (
                <>
                  <code>useAcquireHandlers</code> - ways to &ldquo;get
                  this&rdquo; for a track, album or playlist. Say what you{' '}
                  <code>canHandle</code>; when several plugins can, the user
                  chooses, and when none can, the Add control stays inert.
                </>
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-provider',
    chapter: 'Building plugins',
    icon: <ShieldCheck size={GLYPH} />,
    title: 'The Provider and the crash fence',
    body: (
      <>
        <P>
          A plugin&rsquo;s <code>Provider</code> mounts around the app content,
          inside the core providers, so it may read the library and the
          session. Background work - queues, subscriptions, polling - lives
          here as ordinary effects, and switching the plugin off unmounts them
          all.
        </P>
        <P>
          Every contribution renders behind a fence: a throw anywhere pulls the
          whole plugin for the session - tabs, buttons, provider and all - and
          the app carries on. The Plugins pane says what left and why, rather
          than the app going down with a guest&rsquo;s error.
        </P>
      </>
    ),
  },
  {
    id: 'plugin-hook-rules',
    chapter: 'Building plugins',
    icon: <ListOrdered size={GLYPH} />,
    title: 'The rules hooks live by',
    body: (
      <>
        <P>
          Plugin hooks run inside the runtime&rsquo;s hook scope, which means
          the ordinary React rule matters doubly: call your own hooks
          unconditionally, in fixed order, before any early return. A hook
          that sometimes calls two hooks and sometimes three takes down its
          whole plugin.
        </P>
        <Facts
          items={[
            {
              icon: <ListOrdered size={FACT} />,
              text: 'Contributions render in registration order; nothing sorts, everything walks the array.',
            },
            {
              icon: <Braces size={FACT} />,
              text: 'Ids need only be unique within your plugin - the runtime namespaces them before merging.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-host-table',
    chapter: 'Building plugins',
    icon: <Braces size={GLYPH} />,
    title: 'The host module table',
    body: (
      <>
        <P>
          A repository plugin is compiled elsewhere but cannot bring its own
          React - a second copy could not share hooks with the app&rsquo;s. So
          its imports compile down to lookups in a table the app installs on
          the global before any bundle runs.
        </P>
        <Facts
          items={[
            {
              icon: <Braces size={FACT} />,
              text: (
                <>
                  Available: <code>react</code>, <code>@glacier/react</code>,{' '}
                  <code>@glacier/icons</code>, and the curated{' '}
                  <code>@attackfm/app/*</code> seam - the library, playlists,
                  the session, the equalizer, platform truths.
                </>
              ),
            },
            {
              icon: <ShieldCheck size={FACT} />,
              text: 'The table is a contract: adding is free, removing breaks every published plugin - so it only grows.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-anatomy',
    chapter: 'Building plugins',
    icon: <FolderTree size={GLYPH} />,
    title: 'Anatomy of a repo plugin',
    body: (
      <>
        <P>
          A directory under <code>plugins-repo/</code>: a{' '}
          <code>plugin.json</code> naming it, and an entry module exporting one
          factory.
        </P>
        {/* No relative-import line in this sample ON PURPOSE: the OTA build
            verifies app.js holds no `from './…'` sequences, and a doc string
            wearing one reads as a broken bundle to that check. */}
        <Code>{`// plugin.json
{ "id": "pedals", "name": "Pedals",
  "version": "0.3.4", "entry": "plugin.ts",
  "public": true }

// plugin.ts - imports the Plugin object
// from the index module beside it, then:
export function createPlugin() {
  return pedals;
}`}</Code>
        <P>
          <code>public: true</code> is what puts a build into the official
          catalogue; without it the plugin still builds, for repositories you
          host yourself.
        </P>
      </>
    ),
  },
  {
    id: 'plugin-build',
    chapter: 'Building plugins',
    icon: <Rocket size={GLYPH} />,
    title: 'Build and publish',
    body: (
      <>
        <P>
          One script builds every plugin into publishable bundles plus the
          repository manifest the marketplace reads. Each entry compiles to a
          single file whose host imports became table lookups; nothing from the
          app is bundled twice.
        </P>
        <Code>{`node scripts/build-plugins.mjs
# -> dist-plugins/         everything
# -> dist-plugins-public/  the public: true set`}</Code>
        <Facts
          items={[
            {
              icon: <Rocket size={FACT} />,
              text: 'Bump the version before republishing - an installed bundle updates only when the version moves.',
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'colophon',
    chapter: 'Building plugins',
    icon: <ScrollText size={GLYPH} />,
    title: 'Where to read more',
    body: (
      <>
        <P>
          The code is the reference, and it is written to be read.
        </P>
        <Facts
          items={[
            {
              icon: <Braces size={FACT} />,
              text: (
                <>
                  <code>src/plugins/types.ts</code> - the whole contract, with
                  the reasons in the comments.
                </>
              ),
            },
            {
              icon: <ListTree size={FACT} />,
              text: (
                <>
                  <code>src/plugins/hostRuntime.ts</code> - the module table a
                  remote bundle builds against.
                </>
              ),
            },
            {
              icon: <FolderTree size={FACT} />,
              text: (
                <>
                  <code>plugins-repo/</code> - working examples, from a preset
                  rack to a whole importer.
                </>
              ),
            },
          ]}
        />
        <P>
          This handbook lives here in Settings, keeps your page, and is a
          plugin-sized feature itself - most of what it describes, it uses.
        </P>
      </>
    ),
  },
];

/** One chapter as the pager sees it: its title, where it starts, how long. */
export interface HandbookChapter {
  title: string;
  /** Index of the chapter's first page within HANDBOOK_PAGES. */
  start: number;
  count: number;
  /** The glyph of the chapter's first page, reused by the contents list. */
  icon: ReactNode;
}

/** The chapters, derived from the pages so the two can never disagree. */
export const HANDBOOK_CHAPTERS: readonly HandbookChapter[] = HANDBOOK_PAGES.reduce<
  HandbookChapter[]
>((chapters, page, index) => {
  const last = chapters[chapters.length - 1];
  if (last && last.title === page.chapter) {
    last.count += 1;
  } else {
    chapters.push({ title: page.chapter, start: index, count: 1, icon: page.icon });
  }
  return chapters;
}, []);
