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
//!
//! The words themselves are CATALOGUE KEYS rather than the words. This table is
//! built at import time, which is before any locale provider exists, so a table
//! of English here would be a table of English for the rest of the session and
//! the language picker would move nothing in it. Whoever renders a row resolves
//! the key with `t()` at that moment, and the switch list re-reads on a change.

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

export const NOTICE_COPY: Record<string, { labelKey: string; hintKey: string }> = {
  drops: {
    labelKey: 'notices.dropsLabel',
    hintKey: 'notices.dropsHint',
  },
  curated: {
    labelKey: 'notices.curatedLabel',
    hintKey: 'notices.curatedHint',
  },
  dates: {
    labelKey: 'notices.datesLabel',
    hintKey: 'notices.datesHint',
  },
  digest: {
    labelKey: 'notices.digestLabel',
    hintKey: 'notices.digestHint',
  },
  recap: {
    labelKey: 'notices.recapLabel',
    hintKey: 'notices.recapHint',
  },
  friends: {
    labelKey: 'notices.friendsLabel',
    hintKey: 'notices.friendsHint',
  },
  // Local-only, raised by GrooveNotices off the groove provider's own poll:
  // a friend asking you into a groove, or to listen along with you. Addressed
  // to you and waiting on an answer, so it rings like a friend request.
  groove: {
    labelKey: 'notices.grooveLabel',
    hintKey: 'notices.grooveHint',
  },
  // A local-only kind (not a server push kind, so it never appears in the
  // account's switch list), raised by the client's NewMusicNotices watcher and
  // gated by the device's "Discovery notifications" switch. Distinct from
  // 'drops' on purpose: 'drops' is music that LANDED and is yours to play, this
  // is music picked for you that you do not own yet - a door to Discover, not a
  // song to start.
  newmusic: {
    labelKey: 'notices.newMusicLabel',
    hintKey: 'notices.newMusicHint',
  },
  // Shared playlists - local-only kinds, raised by the client's
  // PlaylistNotices watcher off the hub's own activity ledger. Addressed to
  // you (a friend chose YOUR name to share with, and adds to a list you are
  // on), so they ring whether or not verbose is on, like a friend request.
  'playlist-shared': {
    labelKey: 'notices.playlistSharedLabel',
    hintKey: 'notices.playlistSharedHint',
  },
  'playlist-add': {
    labelKey: 'notices.playlistAddLabel',
    hintKey: 'notices.playlistAddHint',
  },
  // ---- verbose kinds: local-only, behind the device's "verbose" switch ----
  // These never appear in the server's push list (set_pref would 400 on
  // them) and are raised by the client's own watchers, like 'failed'. Each
  // job uses ONE id with a '-started' kind and then its plain kind, so the
  // ring replaces the start with the completion and rings again (same id +
  // different kind = a new event - see notices.ts).
  'download-started': {
    labelKey: 'notices.downloadStartedLabel',
    hintKey: 'notices.downloadStartedHint',
  },
  'stems-started': {
    labelKey: 'notices.stemsStartedLabel',
    hintKey: 'notices.stemsStartedHint',
  },
  stems: {
    labelKey: 'notices.stemsLabel',
    hintKey: 'notices.stemsHint',
  },
  'ai-started': {
    labelKey: 'notices.aiStartedLabel',
    hintKey: 'notices.aiStartedHint',
  },
  ai: {
    labelKey: 'notices.aiLabel',
    hintKey: 'notices.aiHint',
  },
  // The quiet half of the shared-playlist news: a song taken out, somebody
  // leaving, a list taken away. Housekeeping rather than an offer, so it
  // sits behind the same switch as the machine's own chatter.
  'playlist-removed': {
    labelKey: 'notices.playlistRemovedLabel',
    hintKey: 'notices.playlistRemovedHint',
  },
  'playlist-left': {
    labelKey: 'notices.playlistLeftLabel',
    hintKey: 'notices.playlistLeftHint',
  },
  'playlist-unshared': {
    labelKey: 'notices.playlistUnsharedLabel',
    hintKey: 'notices.playlistUnsharedHint',
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
    case 'groove':
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
