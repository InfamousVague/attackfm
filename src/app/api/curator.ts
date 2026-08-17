import { request, type ServerSession } from './http.ts';

/**
 * The collector: the curator's buying arm. Status of the autonomous downloads -
 * what it has pulled, how much of its budget is spent, and whether it has had
 * to stop. `userId` is the caller's own id, which is how the client matches
 * `Track.curatorUserId` rows to "mine" without storing ids in the session.
 */
export interface CollectorStatus {
  userId: number;
  enabled: boolean;
  /** Why pulls are stopped: 'cap' when the budget is spent, null when running. */
  halted: 'cap' | null;
  /** Bytes of collector music nobody has adopted yet - what the cap meters. */
  ledgerBytes: number;
  capBytes: number;
  /** The self-tuning dial, 0..1 - how far afield the picks reach right now. */
  exploration: number;
  /** Whether this box can actually import (the downloader tool is present). */
  importable: boolean;
  recent: {
    title: string;
    artist: string;
    kind: 'track' | 'album';
    state: 'queued' | 'landed' | 'promoted' | 'failed';
    at: number;
    /** Why the curator chose it, when the model wrote one. */
    reason: string;
  }[];
}

export async function fetchCollectorStatus(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<CollectorStatus> {
  return request<CollectorStatus>(session.url, '/api/curator/pulls', {
    token: session.token,
    signal,
  });
}

/** Flip the collector for this account (and, as admin, resize the budget). */
export async function setCollectorSettings(
  session: ServerSession,
  settings: { enabled?: boolean; capBytes?: number },
): Promise<void> {
  await request(session.url, '/api/curator/pulls/settings', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify(settings),
  });
}

/** One thing the curator thinks you would like but do not own yet. */
export interface Discovery {
  id: string;
  title: string;
  artist: string;
  cover: string;
  url: string;
  preview: string;
  /** The artist of yours it hangs off - the "because you play X" line. */
  seed: string;
  /** Measured off the catalogue's own preview, when one existed. */
  bpm: number | null;
  /** Whether its words were actually read and compared, so the UI can say why
   *  it is here without overclaiming. */
  lyricsRead: boolean;
  score: number;
}

export interface DiscoveryFeed {
  items: Discovery[];
  progress: { pool: number; listened: number };
  /** How many distinct songs you have played inside the taste window, and how
   *  many the model waits for before it has an opinion. Straight from the gate
   *  itself (curator::TASTE_MIN_TRACKS), so the page's ask cannot drift from
   *  the rule. Absent on servers older than this field. */
  taste?: { heard: number; needed: number };
}

/** What the curator found outside your library, best first. */
export async function fetchDiscoveries(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<DiscoveryFeed> {
  return request<DiscoveryFeed>(session.url, '/api/discoveries', {
    token: session.token,
    signal,
  });
}

/**
 * The deck ran out: tell the server what the verdicts were so it can go and get
 * more shaped by them, instead of waiting out its own six-hourly sweep.
 * Answers as soon as the work is queued, not when it finishes.
 */
export async function dateDone(
  session: ServerSession,
  kept: number[],
  passed: number[],
): Promise<{ seeded: number }> {
  const out = await request<{ seeded?: number }>(session.url, '/api/date/done', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ kept, passed }),
  });
  return { seeded: out.seeded ?? 0 };
}

/** One playlist the curator built from this listener's own history. */
export interface CuratedList {
  slug: string;
  name: string;
  blurb: string;
  trackIds: number[];
  builtAt: number;
}

/** What the always-running curator has done and how far it has got. */
export interface CuratorFeed {
  lists: CuratedList[];
  status: {
    /** "enriching" | "curating" | "idle". */
    phase: string;
    lastCurated: number;
    /** Whether a local model is configured server-side. */
    ai: boolean;
    /** Whether a chat model is configured - the half that writes names and
     *  patter. Absent from older servers. */
    chat?: boolean;
    /** Whether the embedder is answering - i.e. lyrics are being read. */
    embeddings: boolean;
  };
  progress: {
    checked: number;
    withTempo: number;
    withLyrics: number;
    total: number;
    /** The library's tempo spread, when enough songs carry a measured bpm.
     *  Absent from older servers. */
    tempoMin?: number | null;
    tempoMedian?: number | null;
    tempoMax?: number | null;
  };
}

/**
 * The audio analyser's own count: how much of the library has been listened
 * to by the measuring half of the stack - the 48-part fingerprint that trait
 * queues rank against. `ffmpeg: false` means the numbers will never move on
 * this box, which is worth saying out loud rather than showing a stuck bar.
 */
export interface FeaturesStatus {
  analyzed: number;
  fingerprinted: number;
  total: number;
  ffmpeg: boolean;
}

export async function fetchFeaturesStatus(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<FeaturesStatus> {
  return request<FeaturesStatus>(session.url, '/api/features/status', {
    token: session.token,
    signal,
  });
}

export async function fetchCurator(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<CuratorFeed> {
  return request<CuratorFeed>(session.url, '/api/curator', { token: session.token, signal });
}

/** A suggested chart playlist the user can add through the import pipeline. */
export interface Suggestion {
  id: string;
  title: string;
  blurb: string;
  cover: string | null;
  /** The playlist/album/track URL to hand the importer. */
  url: string;
  section: string;
  /** Where it came from ('spotify' | 'deezer'); absent on an older server. */
  source?: string;
  /** What it is ('playlist' | 'album' | 'track'); absent on an older server. */
  kind?: string;
  trackCount: number | null;
  /** Track titles in order, for the preview - absent on an older server. */
  tracks?: string[];
}

export async function fetchDiscover(session: ServerSession): Promise<Suggestion[]> {
  const reply = await request<{ suggestions: Suggestion[] }>(session.url, '/api/discover', {
    token: session.token,
  });
  return reply.suggestions;
}
