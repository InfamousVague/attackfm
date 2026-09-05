//! What each kind of news is called, in one place.
//!
//! This table used to live inside the notifications settings pane, which was
//! fine while the pane was the only thing that named a kind. Now the bell reads
//! the same words on the row itself, and two copies of a vocabulary is two
//! copies that drift - somebody renames "New music" in the switch list and the
//! notification that arrives still says something else.
//!
//! The server owns the kind LIST: `/api/notify/prefs` answers with every kind
//! it knows, and this is only how each one READS. A kind absent from here falls
//! back to its own id rather than vanishing, which is what the pane has always
//! done and what lets the server add one without a frontend release.

import {
  Bell,
  Bot,
  Compass,
  Disc3,
  Download,
  ListMinus,
  ListPlus,
  Scissors,
  Sparkles,
  TriangleAlert,
  UserMinus,
  Users,
} from '@glacier/icons';
import type { ComponentType } from 'react';

export const NOTICE_COPY: Record<string, { label: string; hint: string }> = {
  drops: {
    label: 'New music',
    hint: 'When something you asked for finishes landing in the library.',
  },
  curated: {
    label: 'Curator playlists',
    hint: 'When your curator has built something new to hear.',
  },
  dates: {
    label: 'Waiting to meet you',
    hint: 'When songs the collector found are queued up for a date.',
  },
  digest: {
    label: 'While you were away',
    hint: 'Every few days: what landed in the library, and who it was by.',
  },
  recap: {
    label: 'Your week in music',
    hint: 'Once a week: what you played, for how long, and the name that ran through it.',
  },
  friends: {
    label: 'Friend requests',
    hint: 'When somebody asks to be friends.',
  },
  // A local-only kind (not a server push kind, so it never appears in the
  // account's switch list), raised by the client's NewMusicNotices watcher and
  // gated by the device's "Discovery notifications" switch. Distinct from
  // 'drops' on purpose: 'drops' is music that LANDED and is yours to play, this
  // is music picked for you that you do not own yet - a door to Discover, not a
  // song to start.
  newmusic: {
    label: 'New to discover',
    hint: 'When the discovery shelf has fresh music picked for your taste.',
  },
  // Shared playlists - local-only kinds, raised by the client's
  // PlaylistNotices watcher off the hub's own activity ledger. Addressed to
  // you (a friend chose YOUR name to share with, and adds to a list you are
  // on), so they ring whether or not verbose is on, like a friend request.
  'playlist-shared': {
    label: 'Shared playlists',
    hint: 'When a friend shares a playlist with you.',
  },
  'playlist-add': {
    label: 'Playlist additions',
    hint: 'When somebody adds songs to a playlist you share.',
  },
  // ---- verbose kinds: local-only, behind the device's "verbose" switch ----
  // These never appear in the server's push list (set_pref would 400 on
  // them) and are raised by the client's own watchers, like 'failed'. Each
  // job uses ONE id with a '-started' kind and then its plain kind, so the
  // ring replaces the start with the completion and rings again (same id +
  // different kind = a new event - see notices.ts).
  'download-started': {
    label: 'Download started',
    hint: 'The moment a download is picked up, not only when it lands.',
  },
  'stems-started': {
    label: 'Taking a song apart',
    hint: 'When the server starts pulling a song into stems in the background.',
  },
  stems: {
    label: 'Stems ready',
    hint: 'When a song has been pulled apart and its stems are on the server.',
  },
  'ai-started': {
    label: 'AI working',
    hint: 'When a background AI pass begins: profiles, curation, discovery, mixes.',
  },
  ai: {
    label: 'AI finished',
    hint: 'When a background AI pass completes, with what it did.',
  },
  // The quiet half of the shared-playlist news: a song taken out, somebody
  // leaving, a list taken away. Housekeeping rather than an offer, so it
  // sits behind the same switch as the machine's own chatter.
  'playlist-removed': {
    label: 'Playlist removals',
    hint: 'When somebody takes a song out of a playlist you share.',
  },
  'playlist-left': {
    label: 'Playlist departures',
    hint: 'When somebody leaves a playlist you share.',
  },
  'playlist-unshared': {
    label: 'Playlist withdrawn',
    hint: 'When a friend stops sharing a playlist with you.',
  },
};

/** The order they read in: the ones about music first, the periodic ones next,
 *  people last. Anything the server knows and this list does not lands after
 *  them rather than being dropped. */
export const NOTICE_ORDER = ['drops', 'curated', 'dates', 'digest', 'recap', 'friends'];

/**
 * The glyph a row wears when it has no artwork of its own.
 *
 * Deliberately a small set: a notification list where every row carries a
 * different picture reads as a toolbar, not as news.
 */
export function noticeGlyph(kind: string): ComponentType<{ size?: number }> {
  switch (kind) {
    case 'drops':
      return Download;
    case 'failed':
      return TriangleAlert;
    case 'curated':
      return Sparkles;
    case 'dates':
      return Disc3;
    case 'newmusic':
      return Compass;
    case 'friends':
    case 'playlist-shared':
      return Users;
    case 'playlist-add':
      return ListPlus;
    case 'playlist-removed':
      return ListMinus;
    case 'playlist-left':
    case 'playlist-unshared':
      return UserMinus;
    case 'download-started':
      return Download;
    case 'stems-started':
    case 'stems':
      return Scissors;
    case 'ai-started':
    case 'ai':
      return Bot;
    default:
      return Bell;
  }
}
