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
  /** This box hands its collector's downloads to a peer rather than fetching. */
  delegates: boolean;
  /** This box does its own fetching. */
  downloadsHere: boolean;
  /** When a download box last took work, or null if none ever has. */
  peerSeenAt: number | null;
  /** Pulls raised in the last day that actually arrived. */
  landedToday: number;
  recent: {
    title: string;
    artist: string;
    kind: 'track' | 'album';
    /**
     * Where the download is, not just how far along it is. 'offered' means no
     * download box has taken it; 'fetching' means one has and is working on it.
     */
    state: 'offered' | 'fetching' | 'queued' | 'landed' | 'promoted' | 'failed';
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

/** A date dealt from the pool: not on the box yet, judged on its preview. */
export interface PreviewDateCard {
  extId: string;
  title: string;
  artist: string;
  cover: string;
  preview: string;
  seed: string;
  /** Which bench dealt it: 'trending' (the charts), 'fresh' (new releases),
   *  or 'taste' - the card wears the answer as its subtitle. */
  lane?: string;
  /** The pool's own tempo read. Absent on a `tiny` card, which skips the
   *  analysis gate on purpose - draw nothing rather than "- BPM". */
  bpm?: number | null;
  /** How well the catalogue thinks the SONG does, 0-1 within its harvest. */
  popularity?: number | null;
  /** Who this is, built before the card was dealt. `null` when the hub has
   *  not got to them yet; absent entirely on a hub from before profiles. */
  profile?: DateArtistProfile | null;
}

/** The best measured candidates, ready to date on their thirty seconds -
 *  and how deep the pool runs past the dealt hand, so every surface can
 *  promise the same number. */
/** Which deck to deal. 'new' = only just-released music, 'tiny' = only the
 *  small, obscure acts (most-unknown first). Absent/anything else = the usual
 *  seated mix. An older server ignores the param and deals its ordinary mix. */
export type DateMode = 'new' | 'tiny';

export async function fetchDateCandidates(
  session: ServerSession,
  count = 25,
  mode?: DateMode,
): Promise<{ cards: PreviewDateCard[]; total: number }> {
  const q = new URLSearchParams({ count: String(count) });
  if (mode) q.set('mode', mode);
  const out = await request<{ candidates?: PreviewDateCard[]; total?: number }>(
    session.url,
    `/api/date/candidates?${q.toString()}`,
    { token: session.token },
  );
  return { cards: out.candidates ?? [], total: out.total ?? (out.candidates ?? []).length };
}

/**
 * Who a card's artist is - built by the hub before the card was dealt.
 *
 * Every block is attributed and OPTIONAL, and `sources` is the contract: a
 * panel renders a block only when its source is in that list. That is what
 * keeps this honest - a tiny act with nothing but a catalogue entry gets a
 * thin profile rather than an invented one, and nothing here is ever written
 * by a model except `blurb`, which is prose and says so.
 */
export interface DateArtistProfile {
  /** The honest one-line "who they are / where they're from", or empty when
   *  the server has not learned this artist yet (it fills in behind the ask). */
  blurb: string;
  /** A short discography - albums, newest first, with years. Facts from the
   *  catalogue, so even an artist no model knows still gets a real list.
   *  Kept at the top level for hubs and bundles from before the rest. */
  discography: string[];
  /** Deezer fan count, when known - the "how big are they" number. */
  fans: number | null;
  /** Which sources actually answered: 'deezer' | 'musicbrainz' |
   *  'listenbrainz' | 'spotify'. Empty means nobody did. */
  sources?: string[];
  /** Only the catalogue answered so far and the full build has not run yet -
   *  worth re-asking in a moment. */
  partial?: boolean;
  deezer?: {
    fans?: number | null;
    albums?: number | null;
    picture?: string | null;
    discography?: string[];
    /** The songs of theirs most people reach for. */
    top?: string[];
    /** Who the catalogue puts near them - relatedness, not a read on you. */
    related?: string[];
  };
  musicbrainz?: {
    /** Town if MusicBrainz has one, else country. */
    from?: string | null;
    began?: string | null;
    ended?: string | null;
    /** 'Person' | 'Group' | … - the difference between "formed" and "born". */
    kind?: string | null;
    /** MusicBrainz's own short note distinguishing same-named acts. */
    note?: string | null;
    genres?: string[];
  };
  listenbrainz?: { listeners?: number | null };
  spotify?: {
    genres?: string[];
    followers?: number | null;
    /** Spotify's own 0-100. */
    popularity?: number | null;
    image?: string | null;
  };
  /** How much of them is already on this server, and how much you have
   *  hearted. Computed per request, never stored. */
  yours?: { tracks: number; hearted: number };
}

/** Look up the current card's artist. Cheap to call as cards advance; the
 *  server caches the prose and pulls the discography live. */
export async function fetchDateArtist(
  session: ServerSession,
  name: string,
): Promise<DateArtistProfile> {
  const out = await request<Partial<DateArtistProfile>>(
    session.url,
    `/api/date/artist?name=${encodeURIComponent(name)}`,
    { token: session.token },
  );
  return normaliseProfile(out);
}

/** Every field optional and defaulted here, so a new bundle against an older
 *  hub degrades to what that hub knows rather than to `undefined`. */
export function normaliseProfile(out: Partial<DateArtistProfile>): DateArtistProfile {
  return {
    ...out,
    blurb: out.blurb ?? '',
    discography: out.discography ?? out.deezer?.discography ?? [],
    fans: out.fans ?? out.deezer?.fans ?? null,
    sources: out.sources ?? [],
  };
}

/**
 * Who all of these are, in one ask.
 *
 * The deck's library half never passes through the deal, and a deck open a
 * while outruns whatever the deal attached - both want the same thing, and
 * asking per card was one request per artist as they came up. On-file only:
 * a name the hub has not built yet answers `null` and is queued behind the
 * reply, so this stays fast however many names go in.
 */
export async function fetchDateProfiles(
  session: ServerSession,
  artists: string[],
): Promise<Record<string, DateArtistProfile | null>> {
  const out = await request<{ profiles?: Record<string, Partial<DateArtistProfile> | null> }>(
    session.url,
    '/api/date/profiles',
    { method: 'POST', token: session.token, body: JSON.stringify({ artists }) },
  );
  const rows: Record<string, DateArtistProfile | null> = {};
  for (const [name, p] of Object.entries(out.profiles ?? {})) {
    rows[name] = p ? normaliseProfile(p) : null;
  }
  return rows;
}

/** A FRESH preview URL for one candidate - the stored one carries an
 *  expiring signature and may be days dead. Null when the catalogue has
 *  nothing playable any more. */
export async function fetchDatePreview(
  session: ServerSession,
  extId: string,
): Promise<string | null> {
  try {
    const out = await request<{ preview?: string }>(
      session.url,
      `/api/date/preview?extId=${encodeURIComponent(extId)}`,
      { token: session.token },
    );
    return out.preview ?? null;
  } catch {
    return null;
  }
}

/** The swipe on a preview date: a keep buys the song, a pass forgets it. */
export async function dateCandidateVerdict(
  session: ServerSession,
  extId: string,
  kept: boolean,
): Promise<void> {
  await request(session.url, '/api/date/candidate-verdict', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ extId, kept }),
  });
}

/** One spoken line about an upcoming date card: the words, and the cached
 *  clips that say them (empty when the server has no voice). */
export interface DateBriefingSong {
  say: string;
  voice: string[];
}

/**
 * The DJ's word on the next few cards, in deck order - the client names the
 * cards because the deck's order and filters live here, not on the server.
 * Landed auditions travel as track ids, preview candidates as ext ids; the
 * server speaks about the band either way.
 */
export async function fetchDateBriefing(
  session: ServerSession,
  ids: number[],
  extIds: string[] = [],
): Promise<DateBriefingSong[]> {
  if (ids.length === 0 && extIds.length === 0) return [];
  const params = new URLSearchParams();
  if (ids.length > 0) params.set('ids', ids.slice(0, 3).join(','));
  if (extIds.length > 0) params.set('extIds', extIds.slice(0, 3).join(','));
  const out = await request<{ songs?: DateBriefingSong[] }>(
    session.url,
    `/api/date/briefing?${params.toString()}`,
    { token: session.token },
  );
  return out.songs ?? [];
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
  /** Staged semantic enrichment. Optional for compatibility with older boxes. */
  enrichment?: {
    stage: 'first' | 'second' | 'complete';
    firstLayer: { complete: number; total: number };
    secondLayer: { complete: number; total: number };
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
  /** The same songs with artist and length, which is what a page needs to draw
   *  them as rows. Absent on an older server, where the titles above are the
   *  fallback; a list with neither still adds, it just cannot be read first. */
  items?: { title: string; artist?: string; durationMs?: number | null }[];
}

export async function fetchDiscover(session: ServerSession): Promise<Suggestion[]> {
  const reply = await request<{ suggestions: Suggestion[] }>(session.url, '/api/discover', {
    token: session.token,
  });
  return reply.suggestions;
}

/**
 * One swipe, told to the server as it happens.
 *
 * `dateDone` above only fires when a deck runs completely dry, which meant a
 * listener who turned down six cards and closed the app had told the server
 * nothing: the passes lived in one browser's localStorage, the next device
 * dealt the same six again, and the files stayed on the disk. This reports
 * each verdict on its own so a pass is durable the moment it is made.
 *
 * Deliberately fire-and-forget at the call site: a swipe must never wait on
 * the network, and a verdict that fails to send is re-sent by `dateDone` when
 * the deck empties.
 */
export async function dateVerdict(
  session: ServerSession,
  kept: number[],
  passed: number[],
): Promise<{ discarded: number; freedBytes: number }> {
  const out = await request<{ discarded?: number; freedBytes?: number }>(
    session.url,
    '/api/date/verdict',
    {
      token: session.token,
      method: 'POST',
      body: JSON.stringify({ kept, passed }),
    },
  );
  return { discarded: out.discarded ?? 0, freedBytes: out.freedBytes ?? 0 };
}

/** Why an audition was not raised - or, for `inflight`, why it did not need
 *  to be. Mirrors the server's `reason` field; null when it was queued. */
export type AuditionReason =
  | 'inflight'
  | 'missing'
  | 'unreachable'
  | 'refused'
  | 'held'
  | 'budget'
  | 'offline';

/**
 * "Let me hear this one": fetch a TEMPORARY copy of a catalogue song through
 * the collector's door. It lands as an audition (For You, yours) and is never
 * filed into the library by this alone - a listen through or a heart does
 * that. `queued: false` comes with the reason the row can say.
 */
export async function requestAudition(
  session: ServerSession,
  song: { extId: string; title: string; artist: string; url: string; cover: string },
): Promise<{ queued: boolean; reason: AuditionReason | null }> {
  const out = await request<{ queued?: boolean; reason?: string | null }>(
    session.url,
    '/api/audition',
    {
      token: session.token,
      method: 'POST',
      body: JSON.stringify({
        ext_id: song.extId,
        title: song.title,
        artist: song.artist,
        url: song.url,
        cover: song.cover,
      }),
    },
  );
  const known: AuditionReason[] = [
    'inflight',
    'missing',
    'unreachable',
    'refused',
    'held',
    'budget',
    'offline',
  ];
  const reason = known.find((r) => r === out.reason) ?? null;
  return { queued: out.queued === true, reason };
}
