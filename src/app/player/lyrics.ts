import type { LyricLine } from '@glacier/react';
import { onlineMetadataEnabled } from '../settings/netPrefs.ts';
import type { Track } from '../core/tauri.ts';
import { fetchTranscript } from './transcript.ts';
import { sessionForOrigin } from '../servers/sessions.ts';
import { request } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';

/**
 * Lyrics for the strip's mic popover, looked up on LRCLIB - the open synced
 * lyrics database (lrclib.net), free, keyless, and CORS-clean - by the
 * signature it indexes on: artist, title, album, and duration.
 *
 * What a track has decides what the popover can do: synced lines light and
 * seek; plain-only lyrics read as static text; nothing is an honest empty.
 */
/**
 * A synced line, and - where anyone has said so - the clock on each word
 * inside it.
 *
 * Two sources fill `words`, and neither is a guess: LRC's A2 extension,
 * which writes `<00:12.34>` before each word and which some taggers and
 * LRCLIB entries carry, and the hub's own alignment of a recognised reading
 * against these very lines. Absent means nobody knew, and the surfaces fall
 * back to lighting the whole line exactly as they always have.
 */
export interface SyncedLine extends LyricLine {
  words?: { t: number; w: string }[];
}

export interface TrackLyrics {
  /** Timed lines, or null when LRCLIB has no synced body for the track. */
  synced: SyncedLine[] | null;
  /** Untimed lines for a plain-only match, or null. */
  plain: string[] | null;
}

const NONE: TrackLyrics = { synced: null, plain: null };

/**
 * One in-flight or settled lookup per track path. Failures cache too: a track
 * LRCLIB does not know stays unknown for the session rather than being asked
 * for on every open of the popover.
 */
const cache = new Map<string, Promise<TrackLyrics>>();

/**
 * Every spelling of a line break at once. Tag frames in the wild carry all
 * three: \n from most writers, \r\n from Windows taggers, and bare \r from
 * old iTunes - and a split that misses the last one hands the whole song back
 * as one giant line.
 */
const LINE_BREAK = /\r\n|\r|\n/;

/** The untimed lines of a plain-text body, blank lines dropped. */
function plainLines(text: string): string[] {
  return text.split(LINE_BREAK).filter((l) => l.trim().length > 0);
}

/**
 * A line's time tags: `[mm:ss.xx]` and the hour form `[hh:mm:ss.xx]`, either
 * fraction spelling ([00:12.34] and the misauthored [00:12:34] both occur).
 * The optional leading group is the hours.
 */
const TIME_TAG = /\[(?:(\d+):)?(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

/**
 * The A2 extension's per-word timestamps - `<00:12.34>` woven through the
 * text.
 *
 * These used to be thrown away, because the surface highlighted lines rather
 * than words. It highlights words now, and a time somebody WROTE beats any
 * time we could infer: this is the same fact the hub spends minutes of
 * recognition to recover for songs that lack it, sitting in the file for
 * free. Lifted out of the text either way - nobody wants to read a timecode.
 */
const WORD_TAG = /<(\d+):(\d{1,2}(?:[.:]\d{1,3})?)>\s?/g;

/**
 * The `[offset:±ms]` header some files carry: a whole-song correction, plus
 * meaning the lyrics should land that much sooner. Discarding it (as the
 * other metadata tags are) would leave every line leading or lagging the
 * vocal by the same beat for the whole track.
 */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * LRC into seconds-and-text lines. A line may carry several tags (a chorus
 * sung twice lists both times); each becomes its own entry so the highlight
 * returns to the repeated line at its second time. Pure metadata tags
 * ([ar:], [ti:], …) fall away - except [offset:], which is applied.
 */
export function parseLrc(lrc: string): SyncedLine[] {
  const offsetSeconds = Number(lrc.match(OFFSET_TAG)?.[1] ?? 0) / 1000;
  const out: SyncedLine[] = [];
  for (const raw of lrc.split(LINE_BREAK)) {
    const tags = [...raw.matchAll(TIME_TAG)];
    if (tags.length === 0) continue;
    const body = raw.slice((tags.at(-1)?.index ?? 0) + tags.at(-1)![0].length);
    const text = body.replace(WORD_TAG, '').trim();
    /*
     * The words, where the file timed them. Only for a line carrying ONE time
     * tag: a repeated chorus writes the same text under several stamps, and
     * word times are absolute, so the second occurrence would light words from
     * the first pass through. A line like that keeps its line-level timing and
     * loses only the finer grain it could not have used honestly anyway.
     */
    const words =
      tags.length === 1
        ? [...body.matchAll(WORD_TAG)]
            .map((m, i, all) => {
              const at = Number(m[1]) * 60 + Number(m[2]!.replace(':', '.'));
              const from = (m.index ?? 0) + m[0].length;
              const to = i + 1 < all.length ? all[i + 1]!.index : body.length;
              return { t: at, w: body.slice(from, to).replace(WORD_TAG, '').trim() };
            })
            .filter((x) => Number.isFinite(x.t) && x.w.length > 0)
        : [];
    for (const tag of tags) {
      const lead = tag[1];
      const mid = Number(tag[2]);
      const last = tag[3]!;
      if (!Number.isFinite(mid)) continue;
      // Three groups is two different formats wearing one spelling. With a
      // real fraction on the end ([00:01:02.50]) it can only be hour form;
      // all bare ([00:12:34]) it is almost always the old centisecond
      // spelling [mm:ss:xx] - songs run minutes, karaoke files by the
      // thousand write hundredths with a colon, and hour-form tags in music
      // are the rarity. The dot decides.
      const time =
        lead !== undefined && !last.includes('.')
          ? Number(lead) * 60 + mid + Number(last) / 100
          : Number(lead ?? 0) * 3600 + mid * 60 + Number(last.replace(':', '.'));
      if (!Number.isFinite(time)) continue;
      out.push({
        time: Math.max(0, time - offsetSeconds),
        text,
        // The song's own offset moves the words with the line they sit in.
        ...(words.length > 0
          ? { words: words.map((x) => ({ t: Math.max(0, x.t - offsetSeconds), w: x.w })) }
          : {}),
      });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * The hub's word-timed copy of this song's lyrics, or null.
 *
 * One request per song, only for a track that lives on a server (a local
 * file has no hub to ask), and a miss is an ordinary answer: most songs have
 * not been through the aligner and never will. Deliberately quiet on every
 * failure - the lyrics that follow are the point, and this is only a better
 * grain of the same words.
 */
async function fetchTimedWords(track: Track): Promise<SyncedLine[] | null> {
  const id = trackIdFromPath(track.path);
  if (id == null) return null;
  const session = sessionForOrigin(originFromPath(track.path));
  if (!session) return null;
  try {
    const r = await request<{ lines: { startMs: number; text: string; words?: [number, string][] }[] }>(
      session.url,
      `/api/lyrics/${id}`,
      { token: session.token },
    );
    const lines = (r.lines ?? [])
      .filter((l) => typeof l.text === 'string' && l.text.trim().length > 0)
      .map((l) => ({
        time: l.startMs / 1000,
        text: l.text.trim(),
        ...(Array.isArray(l.words) && l.words.length > 0
          ? { words: l.words.map(([t, w]) => ({ t: t / 1000, w: String(w) })) }
          : {}),
      }));
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * The file's own lyrics tag. Taggers store either plain text or full LRC in
 * it - parseLrc decides which this is: timed lines mean synced, anything
 * else reads as plain.
 */
function fromTags(track: Track): TrackLyrics | null {
  const embedded = track.lyrics.trim();
  if (!embedded) return null;
  const synced = parseLrc(embedded);
  if (synced.length > 0) return { synced, plain: null };
  const plain = plainLines(embedded);
  return plain.length > 0 ? { synced: null, plain } : null;
}

/** LRCLIB's answer for the track, 404 read as the miss it means. The privacy
 * gate lives in lookup(), which knows how to serve the miss without caching it. */
async function fromLrclib(track: Track): Promise<TrackLyrics> {
  const query = new URLSearchParams({
    artist_name: track.artist,
    track_name: track.title,
  });
  if (track.album) query.set('album_name', track.album);
  // Only a duration LRCLIB will accept: it rejects the whole request (400)
  // outside 1..3600s, and answers fine without one - so an hour-plus mix or
  // a sub-second stub is asked for by name alone rather than never answered.
  const seconds = track.duration != null ? Math.round(track.duration) : null;
  if (seconds != null && seconds >= 1 && seconds <= 3600) query.set('duration', String(seconds));
  const response = await fetch(`https://lrclib.net/api/get?${query}`, {
    headers: { 'Lrclib-Client': 'AttackFM (https://github.com/InfamousVague)' },
  });
  // 404 is LRCLIB's word for "not indexed" - an answer, not an error.
  if (response.status === 404) return NONE;
  if (!response.ok) throw new Error(`lrclib ${response.status}`);
  const body = (await response.json()) as { syncedLyrics?: string | null; plainLyrics?: string | null };
  const synced = body.syncedLyrics ? parseLrc(body.syncedLyrics) : [];
  if (synced.length > 0) return { synced, plain: null };
  const plain = plainLines(body.plainLyrics ?? '');
  return plain.length > 0 ? { synced: null, plain } : NONE;
}

/**
 * SYNCED BEATS PLAIN, WHEREVER EACH CAME FROM. Most files the importer writes
 * carry a plain lyrics tag, and a plain tag that short-circuited the network
 * meant a library full of synced lyrics on LRCLIB rendered as static
 * paragraphs. So: a synced tag wins outright (no network); otherwise LRCLIB
 * is asked, its synced body wins over the tag's plain text, and the tag's
 * plain text stands in when LRCLIB has nothing better - including when the
 * network fails, which must never take away words the file itself carries.
 *
 * `settled` says whether this answer is final: a lookup the network never
 * answered is best-effort, shown but not kept, so one offline moment cannot
 * pin a track to its plain tag for the whole session.
 */
async function lookup(track: Track): Promise<{ lyrics: TrackLyrics; settled: boolean }> {
  const tagged = fromTags(track);
  // A file that times its own words needs nobody's help - and an author's
  // clocks beat any we could infer.
  if (tagged?.synced?.some((l) => l.words?.length)) return { lyrics: tagged, settled: true };
  /*
   * The hub's own timing, where it has done the work.
   *
   * It holds the SAME lines (it reads LRCLIB too) with a clock on every word,
   * aligned against a recognised pass of the song - so this is not a second
   * opinion about the words, it is the first opinion with better timing.
   * Asked before the plain tag short-circuit below, because a synced tag with
   * no word clocks is exactly what the hub improves on.
   */
  const timed = await fetchTimedWords(track);
  if (timed) return { lyrics: { synced: timed, plain: tagged?.plain ?? null }, settled: true };
  if (tagged?.synced) return { lyrics: tagged, settled: true };
  // The privacy switch: an answer that was never asked for is served but not
  // kept (like a network failure), so flipping lookups back ON re-asks on the
  // very next open instead of pinning the OFF-era blank for the session.
  if (!onlineMetadataEnabled()) return { lyrics: tagged ?? NONE, settled: false };
  try {
    const fetched = await fromLrclib(track);
    return { lyrics: fetched.synced ? fetched : (tagged ?? fetched), settled: true };
  } catch {
    return { lyrics: tagged ?? NONE, settled: false };
  }
}

/** The track's lyrics, from cache or one network lookup. Never rejects. */
export function fetchLyrics(track: Track): Promise<TrackLyrics> {
  /*
   * A BOOK IS READ, NOT SUNG, so its words come from our own server rather
   * than from a lyrics database that has never heard of it.
   *
   * Hooked here, at the one entry point both surfaces call, so neither the
   * words-over-the-disc backdrop nor the lyrics panel needs to learn what a
   * transcript is - they are handed timed lines either way and cannot tell a
   * narrator from a singer. Not cached in `cache` below: transcripts keep
   * their own, keyed by track id, so making one can be picked up without a
   * reload.
   */
  if (track.kind === 'book') {
    return fetchTranscript(track).then((lines) => (lines ? { synced: lines, plain: null } : NONE));
  }
  const held = cache.get(track.path);
  if (held) return held;
  const looked = lookup(track).then(({ lyrics, settled }) => {
    // An unsettled answer is served but not kept: the next open asks again.
    if (!settled) cache.delete(track.path);
    return lyrics;
  });
  cache.set(track.path, looked);
  return looked;
}
