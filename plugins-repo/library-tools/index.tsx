import { Wrench } from '@glacier/icons';
import type { Plugin } from '../../src/plugins/types.ts';
import { ToolboxPage } from './ToolboxPage.tsx';

/**
 * Library tools, as a plugin: one Toolbox page of five janitor tools - album
 * art repair, tag editing, duplicate merging, a storage breakdown, and
 * playlist backup/restore. Everything it does runs through the hub's new
 * maintenance endpoints (the files live there, so the fixes must too), which
 * is why it is `requiresServer`: with no hub connected there is nothing to
 * janitor. Each tool also survives an OLD hub gracefully - an endpoint the
 * server does not have yet renders as a quiet "update your server" note, so
 * the plugin can ship ahead of the fleet.
 */
export const libraryTools: Plugin = {
  id: 'library-tools',
  name: 'Library tools',
  description:
    'A toolbox of library janitor tools: fix album art, repair tags, merge duplicates, see where the disk went, and back up your playlists.',
  icon: <Wrench size={22} />,
  author: 'AttackFM',
  version: '0.1.0',
  tags: ['Tools', 'Maintenance'],
  requiresServer: true,
  details:
    'Adds a Toolbox page with five tools for keeping a library healthy. The ' +
    'Art fixer finds albums with no cover and pulls candidates from iTunes, ' +
    'Deezer, and the Cover Art Archive; the Metadata doctor edits any track or ' +
    'whole album’s tags in the files themselves; the Duplicate finder ' +
    'clusters probable same-recordings and merges them without deleting ' +
    'anything (dropped files move to the server’s trash folder); the ' +
    'Storage lens shows where the disk went by artist, album, and codec; and ' +
    'Backup exports your playlists and favorites as JSON or M3U and imports ' +
    'them back. Fixes are written into the files on your server, so every ' +
    'device picks them up through the normal sync.',
  pages: [{ id: 'main', label: 'Toolbox', icon: <Wrench size={18} />, Content: ToolboxPage }],
};
