import { request } from './http.ts';
import type { ServerSession } from './http.ts';
import type { ActivityEvent } from './activity.ts';

/**
 * The owner's view of the server's Local AI - the OpenAI-compatible endpoint
 * (Ollama by default) behind the curator, discovery, the DJ, the home mixes
 * and the stations. Admin only, both halves: the URL and model names are the
 * operator's business, and the report is about the operator's hardware.
 *
 * Every route here is NEW on the server. A hub that has not been rebuilt
 * answers 404, and the pane shows that as "this server does not have Local AI
 * settings yet" rather than as a fault - the OTA reaches phones hours before
 * the hub is rebuilt (BackgroundWork's note about exactly this).
 */

/** The effective configuration, and where each value came from. */
export interface AiSettings {
  /** The ORIGIN only - the server appends /v1/chat/completions etc. */
  url: string | null;
  chatModel: string | null;
  embedModel: string | null;
  fastModel: string | null;
  refinementModel: string | null;
  djModel: string | null;
  timeoutSecs: number;
  chatEnabled: boolean;
  embeddingsEnabled: boolean;
  /** Keys the owner has overridden in the app (server_prefs); absent = env. */
  overrides: Partial<Record<keyof Omit<AiSettings, 'overrides' | 'envDefaults'>, true>>;
  /** What the environment would give if every override were cleared. */
  envDefaults: Partial<Record<keyof Omit<AiSettings, 'overrides' | 'envDefaults'>, string | number | boolean | null>>;
}

/** A settings write: `null` clears that override so the env decides again. */
export type AiSettingsPatch = Partial<{
  url: string | null;
  chatModel: string | null;
  embedModel: string | null;
  fastModel: string | null;
  refinementModel: string | null;
  djModel: string | null;
  timeoutSecs: number | null;
  chatEnabled: boolean | null;
  embeddingsEnabled: boolean | null;
}>;

export interface AiHealth {
  checkedAt: number | null;
  reachable: boolean | null;
  latencyMs: number | null;
  /** Model names the endpoint lists (GET /v1/models); empty if unknown. */
  models: string[];
  error: string | null;
}

/** One thing the AI is used FOR, with the model it uses and how it has fared. */
export interface AiFunction {
  /** Stable id: 'embed' | 'fast-profile' | 'refinement' | 'name-lists' | 'home-mixes' | 'stations' | 'dj-patter' | 'trait-analysis' | 'trait-queue' | 'new-music' | 'collector-reason' */
  id: string;
  label: string;
  uses: 'chat' | 'embed';
  model: string | null;
  calls: number;
  failures: number;
  avgMs: number | null;
  lastAt: number | null;
  lastOk: boolean | null;
}

export interface AiReport {
  settings: AiSettings;
  health: AiHealth;
  functions: AiFunction[];
  totals: { calls: number; failures: number; avgMs: number | null; sinceBoot: number };
  /** Mirror of the curator's live status object. */
  curator: { phase: string; lastCurated: number; ai: boolean; chat: boolean; embeddings: boolean } | null;
  /** The newest AI-sourced activity events, newest first. */
  recent: ActivityEvent[];
}

export function fetchAiReport(session: ServerSession, signal?: AbortSignal): Promise<AiReport> {
  return request<AiReport>(session.url, '/api/ai', { token: session.token, signal });
}

export function setAiSettings(session: ServerSession, patch: AiSettingsPatch): Promise<AiSettings> {
  return request<AiSettings>(session.url, '/api/ai/settings', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify(patch),
  });
}

/** Asks the server to ping the model endpoint now. Longer deadline: a cold Ollama can take a while. */
export function probeAi(session: ServerSession): Promise<AiHealth> {
  return request<AiHealth>(session.url, '/api/ai/probe', { method: 'POST', token: session.token, timeoutMs: 20_000 });
}

export type AiRunWhat = 'curate';

/** Manual triggers for things the loops would otherwise wait to do. */
export function runAi(session: ServerSession, what: AiRunWhat): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(session.url, '/api/ai/run', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ what }),
  });
}
