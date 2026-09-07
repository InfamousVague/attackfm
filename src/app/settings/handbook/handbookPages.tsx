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
import { Trans } from '../../i18n/LocaleShell.tsx';
import type { Translate } from '../settingsShared.ts';

/**
 * The handbook's pages: everything the pane shows, as data, so the pager is
 * dumb and the words live in one place. Each page is one idea - an icon, a
 * title, a screenful of prose - filed under a chapter the progress bar
 * segments by. Order here IS the reading order.
 *
 * The voice matches the rest of the app: what a thing is and why it is that
 * way, not marketing. The plugin chapter is the exception - it is written at
 * developers, and precision beats warmth where the two pull apart.
 *
 * WHY THE WORDS ARE NOT HERE ANY MORE. This array is built the moment the
 * module is imported, which is before a language has been chosen - so a
 * paragraph written into it would be the paragraph the app booted with, and
 * the language picker would leave the manual behind in whatever it started in.
 * Titles and chapter names are catalogue keys the pane resolves; a page's
 * body, which is prose and markup together rather than one string, is a small
 * function handed the translator at render.
 *
 * The identifiers inside the developer chapter - `desktopOnly`, `slots`, the
 * file paths - are passed in as VALUES rather than written into the sentence.
 * They are names of things in the code, and a translated `desktopOnly` is a
 * flag that does not exist.
 */

export interface HandbookPage {
  /** Stable key; also what the pager's animation re-keys on. */
  id: string;
  /** The chapter this page files under - the progress bar's segments. */
  chapterKey: string;
  /** The page's glyph, drawn in the tinted squircle at the top. */
  icon: ReactNode;
  titleKey: string;
  /** Built at render, because a screenful of prose has to follow the picker. */
  body: (t: Translate) => ReactNode;
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

/**
 * A sentence with code spans in it.
 *
 * The names go in as `values`, never as part of the catalogue entry: the
 * entry says WHERE a name sits in the sentence and the name itself is handed
 * over intact, so no translation can rename an API. The `<c>` tag in the
 * entry is the code span the name lands in.
 */
function Spans({ k, names }: { k: string; names: Record<string, string> }) {
  return <Trans i18nKey={k} values={names} components={{ c: <code /> }} />;
}

const GLYPH = 26;
const FACT = 14;

const CH_WELCOME = 'settings.handbookChapterWelcome';
const CH_APP = 'settings.handbookChapterTheApp';
const CH_HOOD = 'settings.handbookChapterUnderTheHood';
const CH_PLUGINS = 'settings.handbookChapterPlugins';

export const HANDBOOK_PAGES: readonly HandbookPage[] = [
  // ── Welcome ────────────────────────────────────────────────────────────
  {
    id: 'cover',
    chapterKey: CH_WELCOME,
    icon: <BookOpen size={GLYPH} />,
    titleKey: 'settings.handbookCoverTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookCoverIntro')}</P>
        <P>{t('settings.handbookCoverTurning')}</P>
      </>
    ),
  },

  // ── The app ────────────────────────────────────────────────────────────
  {
    id: 'identity',
    chapterKey: CH_APP,
    icon: <Network size={GLYPH} />,
    titleKey: 'settings.handbookIdentityTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookIdentityIntro')}</P>
        <Facts
          items={[
            { icon: <Network size={FACT} />, text: t('settings.handbookIdentityFactAccount') },
            { icon: <Server size={FACT} />, text: t('settings.handbookIdentityFactJoin') },
            { icon: <Compass size={FACT} />, text: t('settings.handbookIdentityFactSkip') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'nav',
    chapterKey: CH_APP,
    icon: <Compass size={GLYPH} />,
    titleKey: 'settings.handbookNavTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookNavIntro')}</P>
        <Facts
          items={[
            { icon: <Compass size={FACT} />, text: t('settings.handbookNavFactBack') },
            { icon: <Search size={FACT} />, text: t('settings.handbookNavFactSearch') },
            { icon: <AppWindow size={FACT} />, text: t('settings.handbookNavFactPluginTabs') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'library',
    chapterKey: CH_APP,
    icon: <LibraryBig size={GLYPH} />,
    titleKey: 'settings.handbookLibraryTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookLibraryIntro')}</P>
        <Facts
          items={[
            { icon: <Server size={FACT} />, text: t('settings.handbookLibraryFactPlaylists') },
            { icon: <Download size={FACT} />, text: t('settings.handbookLibraryFactImports') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'deck',
    chapterKey: CH_APP,
    icon: <Disc3 size={GLYPH} />,
    titleKey: 'settings.handbookDeckTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookDeckIntro')}</P>
        <Facts
          items={[
            { icon: <Sparkles size={FACT} />, text: t('settings.handbookDeckFactEffects') },
            { icon: <MonitorSpeaker size={FACT} />, text: t('settings.handbookDeckFactQueue') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'books',
    chapterKey: CH_APP,
    icon: <BookAudio size={GLYPH} />,
    titleKey: 'settings.handbookBooksTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookBooksShelf')}</P>
        <P>{t('settings.handbookBooksReader')}</P>
        <Facts
          items={[
            { icon: <Gauge size={FACT} />, text: t('settings.handbookBooksFactSpeed') },
            { icon: <SkipForward size={FACT} />, text: t('settings.handbookBooksFactSkip') },
            { icon: <Quote size={FACT} />, text: t('settings.handbookBooksFactSpoken') },
            { icon: <Upload size={FACT} />, text: t('settings.handbookBooksFactAdd') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'search',
    chapterKey: CH_APP,
    icon: <Search size={GLYPH} />,
    titleKey: 'settings.handbookSearchTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookSearchIntro')}</P>
        <Facts
          items={[
            {
              icon: <Command size={FACT} />,
              // The operators are the station filter's own syntax (stations.rs
              // matches on them), so they are handed in whole rather than
              // written into a sentence somebody might translate.
              text: (
                <Spans
                  k="settings.handbookSearchFactOperators"
                  names={{ artist: 'artist:', album: 'album:', genre: 'genre:' }}
                />
              ),
            },
            { icon: <Search size={FACT} />, text: t('settings.handbookSearchFactPlugins') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'booth',
    chapterKey: CH_APP,
    icon: <Sparkles size={GLYPH} />,
    titleKey: 'settings.handbookBoothTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookBoothIntro')}</P>
        <P>{t('settings.handbookBoothKnobs')}</P>
      </>
    ),
  },
  {
    id: 'suggestions',
    chapterKey: CH_APP,
    icon: <Telescope size={GLYPH} />,
    titleKey: 'settings.handbookSuggestionsTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookSuggestionsDiscover')}</P>
        <P>{t('settings.handbookSuggestionsLibrary')}</P>
        <Facts
          items={[
            { icon: <Download size={FACT} />, text: t('settings.handbookSuggestionsFactPlays') },
            { icon: <Blocks size={FACT} />, text: t('settings.handbookSuggestionsFactPerListener') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'offline',
    chapterKey: CH_APP,
    icon: <HardDrive size={GLYPH} />,
    titleKey: 'settings.handbookOfflineTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookOfflineIntro')}</P>
        <Facts
          items={[
            { icon: <HardDrive size={FACT} />, text: t('settings.handbookOfflineFactPins') },
            { icon: <RefreshCw size={FACT} />, text: t('settings.handbookOfflineFactSpace') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'connect',
    chapterKey: CH_APP,
    icon: <MonitorSpeaker size={GLYPH} />,
    titleKey: 'settings.handbookConnectTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookConnectSeat')}</P>
        <P>{t('settings.handbookConnectGroove')}</P>
      </>
    ),
  },
  {
    id: 'servers',
    chapterKey: CH_APP,
    icon: <Server size={GLYPH} />,
    titleKey: 'settings.handbookServersTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookServersIntro')}</P>
        <Facts
          items={[{ icon: <Server size={FACT} />, text: t('settings.handbookServersFactDot') }]}
        />
      </>
    ),
  },
  {
    id: 'pairing',
    chapterKey: CH_APP,
    icon: <QrCode size={GLYPH} />,
    titleKey: 'settings.handbookPairingTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPairingIntro')}</P>
        <Facts
          items={[{ icon: <QrCode size={FACT} />, text: t('settings.handbookPairingFactWhere') }]}
        />
      </>
    ),
  },
  {
    id: 'updates',
    chapterKey: CH_APP,
    icon: <RefreshCw size={GLYPH} />,
    titleKey: 'settings.handbookUpdatesTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookUpdatesIntro')}</P>
        <Facts
          items={[
            { icon: <ShieldCheck size={FACT} />, text: t('settings.handbookUpdatesFactRefused') },
            { icon: <RefreshCw size={FACT} />, text: t('settings.handbookUpdatesFactAbout') },
          ]}
        />
      </>
    ),
  },

  // ── Under the hood ─────────────────────────────────────────────────────
  {
    id: 'stack',
    chapterKey: CH_HOOD,
    icon: <Layers size={GLYPH} />,
    titleKey: 'settings.handbookStackTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookStackIntro')}</P>
        <Facts
          items={[
            { icon: <Layers size={FACT} />, text: t('settings.handbookStackFactOta') },
            { icon: <Server size={FACT} />, text: t('settings.handbookStackFactServer') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'design',
    chapterKey: CH_HOOD,
    icon: <Palette size={GLYPH} />,
    titleKey: 'settings.handbookDesignTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookDesignIntro')}</P>
        <Facts
          items={[
            { icon: <Palette size={FACT} />, text: t('settings.handbookDesignFactCascade') },
            { icon: <Blocks size={FACT} />, text: t('settings.handbookDesignFactKit') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'providers',
    chapterKey: CH_HOOD,
    icon: <ListTree size={GLYPH} />,
    titleKey: 'settings.handbookProvidersTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookProvidersIntro')}</P>
        <P>
          <Spans k="settings.handbookProvidersWhy" names={{ hook: 'useLibrary' }} />
        </P>
      </>
    ),
  },

  // ── Building plugins ───────────────────────────────────────────────────
  {
    id: 'plugin-object',
    chapterKey: CH_PLUGINS,
    icon: <Blocks size={GLYPH} />,
    titleKey: 'settings.handbookPluginObjectTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginObjectIntro')}</P>
        <P>{t('settings.handbookPluginObjectStable')}</P>
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
    chapterKey: CH_PLUGINS,
    icon: <PackageOpen size={GLYPH} />,
    titleKey: 'settings.handbookPluginTwoWaysTitle',
    body: (t) => (
      <>
        <P>
          <Spans k="settings.handbookPluginTwoWaysIntro" names={{ manifest: 'index.json' }} />
        </P>
        <Facts
          items={[
            { icon: <Download size={FACT} />, text: t('settings.handbookPluginTwoWaysFactInstall') },
            { icon: <PackageOpen size={FACT} />, text: t('settings.handbookPluginTwoWaysFactChannel') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-platforms',
    chapterKey: CH_PLUGINS,
    icon: <MonitorSmartphone size={GLYPH} />,
    titleKey: 'settings.handbookPluginPlatformsTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginPlatformsIntro')}</P>
        <Facts
          items={[
            {
              icon: <MonitorSmartphone size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginPlatformsDesktopOnly"
                  names={{ flag: 'desktopOnly' }}
                />
              ),
            },
            {
              icon: <Server size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginPlatformsRequiresServer"
                  names={{ flag: 'requiresServer' }}
                />
              ),
            },
            {
              icon: <Network size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginPlatformsServerBacked"
                  names={{ flag: 'serverBacked' }}
                />
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-chrome',
    chapterKey: CH_PLUGINS,
    icon: <AppWindow size={GLYPH} />,
    titleKey: 'settings.handbookPluginChromeTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginChromeIntro')}</P>
        <Facts
          items={[
            {
              icon: <AppWindow size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginChromeSlots"
                  names={{ field: 'slots', a: 'titlebar-end', b: 'player-trailing' }}
                />
              ),
            },
            {
              icon: <Compass size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginChromePages"
                  names={{ field: 'pages', play: 'onPlay', artist: 'onOpenArtist' }}
                />
              ),
            },
            {
              icon: <BookOpen size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginChromeSections"
                  names={{ field: 'settingsSections' }}
                />
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-data',
    chapterKey: CH_PLUGINS,
    icon: <Download size={GLYPH} />,
    titleKey: 'settings.handbookPluginDataTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginDataIntro')}</P>
        <Facts
          items={[
            {
              icon: <Disc3 size={FACT} />,
              text: <Spans k="settings.handbookPluginDataTiles" names={{ field: 'playlistTiles' }} />,
            },
            {
              icon: <Download size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginDataDownloads"
                  names={{ field: 'downloads', stage: 'stage', parts: 'parts' }}
                />
              ),
            },
            { icon: <ShieldCheck size={FACT} />, text: t('settings.handbookPluginDataFactOneQueue') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-verbs',
    chapterKey: CH_PLUGINS,
    icon: <Command size={GLYPH} />,
    titleKey: 'settings.handbookPluginVerbsTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginVerbsIntro')}</P>
        <Facts
          items={[
            {
              icon: <Command size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginVerbsCommands"
                  names={{ hook: 'usePaletteCommands', flag: 'exclusive' }}
                />
              ),
            },
            {
              icon: <Download size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookPluginVerbsAcquire"
                  names={{ hook: 'useAcquireHandlers', can: 'canHandle' }}
                />
              ),
            },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-provider',
    chapterKey: CH_PLUGINS,
    icon: <ShieldCheck size={GLYPH} />,
    titleKey: 'settings.handbookPluginProviderTitle',
    body: (t) => (
      <>
        <P>
          <Spans k="settings.handbookPluginProviderIntro" names={{ field: 'Provider' }} />
        </P>
        <P>{t('settings.handbookPluginProviderFence')}</P>
      </>
    ),
  },
  {
    id: 'plugin-hook-rules',
    chapterKey: CH_PLUGINS,
    icon: <ListOrdered size={GLYPH} />,
    titleKey: 'settings.handbookPluginHooksTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookPluginHooksIntro')}</P>
        <Facts
          items={[
            { icon: <ListOrdered size={FACT} />, text: t('settings.handbookPluginHooksFactOrder') },
            { icon: <Braces size={FACT} />, text: t('settings.handbookPluginHooksFactIds') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-host-table',
    chapterKey: CH_PLUGINS,
    icon: <Braces size={GLYPH} />,
    titleKey: 'settings.handbookHostTableTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookHostTableIntro')}</P>
        <Facts
          items={[
            {
              icon: <Braces size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookHostTableAvailable"
                  names={{
                    react: 'react',
                    kit: '@glacier/react',
                    icons: '@glacier/icons',
                    seam: '@attackfm/app/*',
                  }}
                />
              ),
            },
            { icon: <ShieldCheck size={FACT} />, text: t('settings.handbookHostTableFactContract') },
          ]}
        />
      </>
    ),
  },
  {
    id: 'plugin-anatomy',
    chapterKey: CH_PLUGINS,
    icon: <FolderTree size={GLYPH} />,
    titleKey: 'settings.handbookAnatomyTitle',
    body: (_t) => (
      <>
        <P>
          <Spans
            k="settings.handbookAnatomyIntro"
            names={{ dir: 'plugins-repo/', manifest: 'plugin.json' }}
          />
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
          <Spans k="settings.handbookAnatomyPublic" names={{ flag: 'public: true' }} />
        </P>
      </>
    ),
  },
  {
    id: 'plugin-build',
    chapterKey: CH_PLUGINS,
    icon: <Rocket size={GLYPH} />,
    titleKey: 'settings.handbookBuildTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookBuildIntro')}</P>
        <Code>{`node scripts/build-plugins.mjs
# -> dist-plugins/         everything
# -> dist-plugins-public/  the public: true set`}</Code>
        <Facts
          items={[{ icon: <Rocket size={FACT} />, text: t('settings.handbookBuildFactVersion') }]}
        />
      </>
    ),
  },
  {
    id: 'colophon',
    chapterKey: CH_PLUGINS,
    icon: <ScrollText size={GLYPH} />,
    titleKey: 'settings.handbookColophonTitle',
    body: (t) => (
      <>
        <P>{t('settings.handbookColophonIntro')}</P>
        <Facts
          items={[
            {
              icon: <Braces size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookColophonTypes"
                  names={{ path: 'src/plugins/types.ts' }}
                />
              ),
            },
            {
              icon: <ListTree size={FACT} />,
              text: (
                <Spans
                  k="settings.handbookColophonHostRuntime"
                  names={{ path: 'src/plugins/hostRuntime.ts' }}
                />
              ),
            },
            {
              icon: <FolderTree size={FACT} />,
              text: (
                <Spans k="settings.handbookColophonRepo" names={{ path: 'plugins-repo/' }} />
              ),
            },
          ]}
        />
        <P>{t('settings.handbookColophonOutro')}</P>
      </>
    ),
  },
];

/** One chapter as the pager sees it: its name, where it starts, how long. */
export interface HandbookChapter {
  /** Catalogue key - the pager resolves it, for the same reason the pages do. */
  titleKey: string;
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
  if (last && last.titleKey === page.chapterKey) {
    last.count += 1;
  } else {
    chapters.push({ titleKey: page.chapterKey, start: index, count: 1, icon: page.icon });
  }
  return chapters;
}, []);
