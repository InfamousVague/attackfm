import { request, type ServerSession } from './http.ts';

// --- DJ --------------------------------------------------------------------

/** One run of the DJ set: a spoken line, then the tracks it introduces. */
export interface DjBlock {
  say: string;
  trackIds: number[];
}

export interface DjSet {
  /** Whether a model wrote the patter (false = a wordless set of good picks). */
  ai: boolean;
  /** The vibe it was steered toward, echoed back. */
  vibe: string;
  blocks: DjBlock[];
}

/**
 * A continuous DJ set drawn from the listener's OWN library: runs of tracks
 * with a spoken line opening each. `seed` steers the whole thing toward a vibe
 * ("something mellow for a rainy morning"); empty just mirrors recent listening.
 */
export async function fetchDj(session: ServerSession, seed = '', count?: number): Promise<DjSet> {
  const params = new URLSearchParams();
  if (seed.trim()) params.set('seed', seed.trim());
  if (count) params.set('count', String(count));
  const qs = params.toString();
  const out = await request<Partial<DjSet>>(
    session.url,
    `/api/dj${qs ? `?${qs}` : ''}`,
    { token: session.token },
  );
  return { ai: out.ai ?? false, vibe: out.vibe ?? seed, blocks: out.blocks ?? [] };
}

export type DjTraitCategory =
  | 'sonic' | 'energy' | 'genre_style' | 'vocals' | 'era' | 'mood'
  | 'production' | 'lyrical_theme' | 'instrumentation' | 'scene_culture';

export interface DjTrait {
  id: string;
  label: string;
  category: DjTraitCategory;
  description: string;
  weight: number;
  confidence: number;
  query: string;
  signals: {
    energy?: number | null;
    bpmMin?: number | null;
    bpmMax?: number | null;
    yearMin?: number | null;
    yearMax?: number | null;
    genres: string[];
  };
}

export interface DjTraitAnalysis {
  source: 'song' | 'album' | 'playlist';
  trackId?: number;
  trackIds?: number[];
  summary: string;
  traits: DjTrait[];
  cached: boolean;
  ai: boolean;
  djNote?: string;
}

export async function saveDjNote(session: ServerSession, trackId: number, note: string): Promise<{ok: boolean; note: string}> {
  return request(session.url, '/api/dj/note', {
    method: 'POST', token: session.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId, note }),
  });
}

export interface DjMatchExplanation {
  trackId: number;
  reason: string;
  scores: { sonic: number; measuredAudio: number; lyrical: number; community: number;
    history: number; liked: number; collaborative: number };
}

export interface DjTraitQueueResult {
  trackIds: number[];
  semantic: boolean;
  explanations: DjMatchExplanation[];
}

export async function analyzeDjCollection(
  session: ServerSession, source: 'album' | 'playlist', name: string,
  trackIds: number[], signal?: AbortSignal,
): Promise<DjTraitAnalysis> {
  return request<DjTraitAnalysis>(session.url, '/api/dj/analyze', {
    method: 'POST', token: session.token, signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, name, trackIds }),
  });
}

export async function analyzeDjTrack(
  session: ServerSession,
  trackId: number,
  signal?: AbortSignal,
): Promise<DjTraitAnalysis> {
  return request<DjTraitAnalysis>(session.url, '/api/dj/analyze', {
    method: 'POST', token: session.token, signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId }),
  });
}

export async function generateDjTraitQueue(
  session: ServerSession,
  trackId: number,
  traits: DjTrait[],
  count = 24,
): Promise<DjTraitQueueResult> {
  return request(session.url, '/api/dj/queue', {
    method: 'POST', token: session.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId, traits, count }),
  });
}

export async function generateDjCollectionQueue(
  session: ServerSession, trackIds: number[], traits: DjTrait[], count = 24,
): Promise<DjTraitQueueResult> {
  return request(session.url, '/api/dj/queue', {
    method: 'POST', token: session.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds, traits, count }),
  });
}

/** One station the DJ suggests: a place to tune to, not a list to play. */
export interface DjStation {
  id: string;
  name: string;
  blurb: string;
  /** The vibe the DJ steers by - what tapping the card asks for. */
  seed: string;
  /** 'ai' when a model named it, 'heuristic' when it came from the play log. */
  flavor: string;
}

/**
 * The DJ's suggested stations.
 *
 * Never blocks on the model: the server answers from its cache and refreshes
 * behind the request, so an empty list here means a brand-new listener rather
 * than a slow one.
 */
export async function fetchDjStations(session: ServerSession): Promise<DjStation[]> {
  const out = await request<{ stations?: DjStation[] }>(session.url, '/api/dj/stations', {
    token: session.token,
  });
  return out.stations ?? [];
}
