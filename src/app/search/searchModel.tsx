import { BookAudio, Check, Compass, Disc3, ListMusic, Music, Search, Tag, User, Users } from '@glacier/icons';
import type { ShelfBook } from '../library/bookShelf.ts';
import type { CSSProperties, ReactNode } from 'react';
import type { Playlist } from '../playlists/playlists.tsx';
import type { RegistryFriend } from '../servers/registry.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import {
  flatten,
  type LocalAlbum,
  type LocalArtist,
  type LocalGenre,
  type Why,
} from './trackSearch.ts';
import type { SearchResult } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/** The id ⌘K and the arrow keys work against. */
export const FIELD_ID = 'searchPageField';

/** How much of a section shows before it needs a See all. */
export const COLLAPSED = 4;
/** And how much a promoted section shows. */
export const EXPANDED = 60;
/** Songs shown beside the Top result. */
export const BESIDE = 4;
/** Genre tiles the empty page offers to browse. */
export const BROWSE = 12;

/** Joins the two halves of an album's identity. A control character, because
 *  any printable separator is something a real album title contains. */
export const SEP = '\u001f';

export type Filter =
  | 'all'
  | 'mine'
  | 'songs'
  | 'books'
  | 'artists'
  | 'albums'
  | 'playlists'
  | 'genres'
  | 'friends'
  | 'catalog';

/** Scopes answer "where from"; kinds answer "what". They share one row with a
 *  rule between them, so it reads as two questions rather than nine chips.
 *  The group travels with the chip because chips drop out when a query has
 *  nothing for them - the rule has to follow the last surviving scope, not a
 *  fixed index into a list that no longer looks like this one.
 *
 *  The chips carry a KEY rather than a word. This array is built once, at
 *  import, which is before any language has been chosen and long before the
 *  picker can change it - a word placed here would be the word the app booted
 *  in, for the rest of the session. The page resolves the key as it draws. */
export const CHIPS: { id: Filter; labelKey: string; icon: ReactNode; group: 'scope' | 'kind' }[] = [
  { id: 'all', labelKey: 'search.scopeAll', icon: <Search size={13} />, group: 'scope' },
  { id: 'mine', labelKey: 'search.scopeMine', icon: <Check size={13} />, group: 'scope' },
  { id: 'catalog', labelKey: 'search.toAdd', icon: <Compass size={13} />, group: 'scope' },
  { id: 'songs', labelKey: 'search.songs', icon: <Music size={13} />, group: 'kind' },
  /* Books are a KIND, not a scope: they are things you own, sitting in the same
     library as the songs - they are simply kept out of `tracks` so a twelve-hour
     reading never turns up in a mix or a shuffle. That separation is why the one
     global search could not find them at all until now. */
  { id: 'books', labelKey: 'search.books', icon: <BookAudio size={13} />, group: 'kind' },
  { id: 'artists', labelKey: 'search.artists', icon: <User size={13} />, group: 'kind' },
  { id: 'albums', labelKey: 'search.albums', icon: <Disc3 size={13} />, group: 'kind' },
  { id: 'playlists', labelKey: 'search.playlists', icon: <ListMusic size={13} />, group: 'kind' },
  { id: 'genres', labelKey: 'search.genres', icon: <Tag size={13} />, group: 'kind' },
  { id: 'friends', labelKey: 'search.friends', icon: <Users size={13} />, group: 'kind' },
];

/* -------------------------------------------------------------------- items */

/**
 * One thing on the page, whatever kind it is. Sections hold these and the
 * keyboard layer walks them flat, so the order you arrow through is the order
 * you read - by construction, rather than by two lists agreeing.
 */
export type Item =
  | { t: 'action'; id: string; label: string; group?: string; run: () => void }
  | { t: 'song'; id: string; track: Track; why: Why }
  | { t: 'artist'; id: string; artist: LocalArtist }
  | { t: 'album'; id: string; album: LocalAlbum }
  /* One row per BOOK, never per file. A sectioned reading is one file per
     chapter, so passing them through as songs would answer "dungeon" with fifty
     identical-looking rows for one title. */
  | { t: 'book'; id: string; book: ShelfBook }
  | { t: 'playlist'; id: string; playlist: Playlist }
  | { t: 'genre'; id: string; genre: LocalGenre }
  | { t: 'friend'; id: string; friend: RegistryFriend }
  | { t: 'catalog'; id: string; result: SearchResult; mine: Track | null };

export interface Section {
  /** The chip its See all turns on. */
  key: Filter;
  /** Catalogue key for the heading, resolved by the page - a section is data
   *  the page rebuilds every render, and its heading has to follow the
   *  language rather than the render that first named it. */
  titleKey: string;
  icon: ReactNode;
  /** How many exist, which is what the count beside the heading says. */
  total: number;
  items: Item[];
}

/** What an importer would be handed for a catalogue row. */
export function targetOf(result: SearchResult): AcquireTarget {
  return {
    kind: result.kind === 'album' ? 'album' : 'track',
    title: result.title,
    artist: result.subtitle,
    url: result.url,
  };
}

/** The key an album is filed under: title AND artist, so two records called
 *  "Greatest Hits" stay two records. */
export const albumKey = (album: { title: string; artist: string }): string =>
  `${album.title}${SEP}${album.artist}`;

/** Which word a catalogue row wears for its kind - as a key, because the only
 *  callers are rows being drawn and the word has to be this render's language. */
export function kindWordKey(kind: SearchResult['kind']): string {
  return KIND_KEY[kind];
}

const KIND_KEY: Record<SearchResult['kind'], string> = {
  artist: 'search.kindArtist',
  album: 'search.kindAlbum',
  track: 'search.kindSong',
};

/** Whether a catalogue row's name is what the query was reaching for: the
 *  same name, the start of it, or all of it and then some ("ethel" finding
 *  Ethel Cain, "ethel cain" finding her too). Deliberately stricter than the
 *  library's own matching - this promotes a row above everything else, so a
 *  loose word-scatter match is not enough. */
export function isAbout(name: string, phrase: string): boolean {
  if (!phrase) return false;
  const n = flatten(name);
  return n === phrase || n.startsWith(phrase) || phrase.startsWith(n);
}

/** A stable hue per name, so "Shoegaze" is the same colour every time it is
 *  drawn without anybody keeping a table of genres. */
export function hueOf(name: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { '--searchTileHue': `${h}` } as CSSProperties;
}

/** Up to four covers from a playlist's tracks, for its mosaic. */
export function coversOf(playlist: Playlist, tracks: readonly Track[]): string[] {
  const want = new Set(playlist.paths);
  const out: string[] = [];
  for (const t of tracks) {
    if (out.length === 4) break;
    if (want.has(t.path) && t.artwork) out.push(t.artwork);
  }
  return out;
}
