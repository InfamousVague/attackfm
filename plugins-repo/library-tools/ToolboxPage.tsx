/**
 * The Toolbox page: a small index of five tool cards and a useState that
 * swaps the chosen tool in, with a back row to return - the same one-level
 * internal navigation the importer's settings panes use. Deliberately not
 * routes: the page owns no history, so the app's own back/forward keeps
 * working across it as one destination.
 */
import { useState } from 'react';
import { Text } from '@glacier/react';
import { Archive, Copy, HardDrive, Image, Tags, Wrench } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import type { ReactNode } from 'react';
import { ArtFixer } from './ArtFixer.tsx';
import { MetadataDoctor } from './MetadataDoctor.tsx';
import { DuplicateFinder } from './DuplicateFinder.tsx';
import { StorageLens } from './StorageLens.tsx';
import { BackupTool } from './BackupTool.tsx';
import { QuietNote, panel, row, stack } from './ui.tsx';

type ToolId = 'art' | 'meta' | 'dupes' | 'storage' | 'backup';

const TOOLS: { id: ToolId; name: string; blurb: string; icon: ReactNode }[] = [
  {
    id: 'art',
    name: 'Art fixer',
    blurb: 'Find albums with no cover and pick a proper one from the big art sources.',
    icon: <Image size={20} />,
  },
  {
    id: 'meta',
    name: 'Metadata doctor',
    blurb: 'Edit a track’s tags - or retag a whole album at once - in the files themselves.',
    icon: <Tags size={20} />,
  },
  {
    id: 'dupes',
    name: 'Duplicate finder',
    blurb: 'Cluster probable same-recordings, keep the best copy, trash the rest safely.',
    icon: <Copy size={20} />,
  },
  {
    id: 'storage',
    name: 'Storage lens',
    blurb: 'Where the disk went: by artist, album, and codec, plus the big-but-unplayed.',
    icon: <HardDrive size={20} />,
  },
  {
    id: 'backup',
    name: 'Backup',
    blurb: 'Export playlists and favorites as JSON or M3U, and import them back.',
    icon: <Archive size={20} />,
  },
];

export function ToolboxPage() {
  const { session } = useServerSession();
  const [view, setView] = useState<ToolId | null>(null);
  const back = () => setView(null);

  // The plugin is requiresServer, so the nav item should never show without a
  // session - but the page can outlive a disconnect by a render, and every
  // tool needs the session, so the gate lives here once.
  if (!session) {
    return (
      <div style={{ padding: '18px 20px', maxWidth: 860, margin: '0 auto' }}>
        <QuietNote>
          The toolbox works on your home server’s library - connect one under Settings &rarr;
          Server first.
        </QuietNote>
      </div>
    );
  }

  if (view === 'art') return <ArtFixer session={session} onBack={back} />;
  if (view === 'meta') return <MetadataDoctor session={session} onBack={back} />;
  if (view === 'dupes') return <DuplicateFinder session={session} onBack={back} />;
  if (view === 'storage') return <StorageLens session={session} onBack={back} />;
  if (view === 'backup') return <BackupTool session={session} onBack={back} />;

  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 860, margin: '0 auto' }}>
      <div style={row(12)}>
        <span
          aria-hidden
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 'var(--glacier-radius-md)',
            background: 'var(--glacier-accent-soft)',
            color: 'var(--glacier-accent-text)',
          }}
        >
          <Wrench size={22} />
        </span>
        <div style={stack(2)}>
          <Text as="div" size="lg" weight="semibold" role="heading" aria-level={1}>
            Toolbox
          </Text>
          <Text tone="muted" size="sm">
            Janitor tools for the library on {session.url.replace(/^https?:\/\//, '')}.
          </Text>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
        }}
      >
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            onClick={() => setView(tool.id)}
            style={{
              ...panel,
              ...stack(8),
              alignItems: 'flex-start',
              cursor: 'pointer',
              font: 'inherit',
              color: 'var(--glacier-text)',
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 'var(--glacier-radius-md)',
                background: 'var(--glacier-surface-sunken)',
                color: 'var(--glacier-accent-text)',
              }}
            >
              {tool.icon}
            </span>
            <Text weight="medium">{tool.name}</Text>
            <Text tone="muted" size="sm">
              {tool.blurb}
            </Text>
          </button>
        ))}
      </div>
    </div>
  );
}
