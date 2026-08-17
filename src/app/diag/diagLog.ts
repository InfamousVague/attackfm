//! What went wrong, kept where a phone can hand it over.
//!
//! A phone in a pocket has no console. When the header dot goes grey and the
//! library will not load, the one thing nobody could answer was WHY: the
//! reachability probe caught its failure with a bare `catch {}` and threw the
//! reason away, so "unreachable — cached songs only" was the whole story the
//! device could tell. This is the missing half - a small ring of recent
//! failures the listener can read on the device and copy out of it.
//!
//! Three rules earn their keep here:
//!
//!   - It PERSISTS. The interesting failures happen at launch, before anyone
//!     opens settings, and an in-memory buffer forgets them on the next cold
//!     start - which is exactly when the listener goes looking.
//!   - It is BOUNDED, in entries and in characters. A device that has been
//!     failing a probe every thirty seconds for a week must not fill its own
//!     storage with the news.
//!   - It REDACTS. Stream URLs carry tokens in the query string, and a log
//!     built to be pasted into a chat window is the last place they belong.

import { APP_VERSION, SHELL_VERSION } from '../core/version.ts';

const KEY = 'attackfm-diag-v1';
/** Enough to show a pattern (a probe failing every 30s for ~20 minutes),
 *  little enough to stay a cheap synchronous read at boot. */
const MAX_ENTRIES = 120;
/** No single entry may run away with the buffer - a server that answers an
 *  HTML error page would otherwise write kilobytes per failure. */
const MAX_DETAIL = 300;

export interface DiagEntry {
  /** Epoch ms. */
  at: number;
  /** A short stable label - 'probe', 'request', 'crash', 'promise'. */
  kind: string;
  /** One line, already human-readable and already redacted. */
  detail: string;
}

let entries: DiagEntry[] = load();
const listeners = new Set<() => void>();

function load(): DiagEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Written by an older shape, or hand-edited: take only what still reads.
    return parsed.filter(
      (e): e is DiagEntry =>
        !!e && typeof e === 'object' && typeof (e as DiagEntry).at === 'number',
    );
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // A full or disabled store is not worth failing a playback path over; the
    // in-memory ring still serves the pane for this run.
  }
}

/**
 * Strip anything secret out of a URL before it is written down.
 *
 * Stream and art URLs carry `?t=<stream token>`, and the whole point of this
 * log is that it gets pasted somewhere. The parameter NAMES stay - knowing a
 * token was present is diagnostic; its value never is.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw, 'https://placeholder.invalid');
    for (const [k] of [...u.searchParams]) {
      if (/^(t|token|key|auth|password|code|secret)$/i.test(k)) u.searchParams.set(k, '…');
    }
    const out = u.toString();
    return out.startsWith('https://placeholder.invalid')
      ? out.slice('https://placeholder.invalid'.length)
      : out;
  } catch {
    // Not a URL we can parse - blunt instrument rather than leak it.
    return raw.replace(/([?&](?:t|token|key|auth)=)[^&]*/gi, '$1…');
  }
}

/** Append one failure. Cheap enough to call from any catch block. */
export function recordDiag(kind: string, detail: string): void {
  const line = detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
  const last = entries[entries.length - 1];
  // A probe failing on a heartbeat writes the same line forever. Collapse the
  // repeat into a count so twenty minutes of one fault does not push every
  // other clue out of the ring.
  if (last && last.kind === kind && stripCount(last.detail) === line) {
    const n = countOf(last.detail) + 1;
    entries[entries.length - 1] = { at: Date.now(), kind, detail: `${line}  (×${n})` };
  } else {
    entries.push({ at: Date.now(), kind, detail: line });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  }
  persist();
  for (const cb of listeners) cb();
}

function stripCount(detail: string): string {
  return detail.replace(/ {2}\(×\d+\)$/, '');
}
function countOf(detail: string): number {
  const m = / {2}\(×(\d+)\)$/.exec(detail);
  return m ? Number(m[1]) : 1;
}

export function diagEntries(): readonly DiagEntry[] {
  return entries;
}

export function clearDiag(): void {
  entries = [];
  persist();
  for (const cb of listeners) cb();
}

export function subscribeDiag(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Turn a thrown thing into a line worth reading.
 *
 * A failed `fetch` is the least informative object in the platform: WebKit
 * says "Load failed" and Chromium says "Failed to fetch" for DNS, TLS, a
 * refused connection, and a blocked mixed-content request alike. The browser
 * will not tell us which, so the line says what the app actually knows -
 * where it was going and what class of failure it was - and names the usual
 * causes rather than pretending to have diagnosed one.
 */
export function describeFailure(err: unknown, url?: string): string {
  const where = url ? ` → ${redactUrl(url)}` : '';
  if (err instanceof DOMException && err.name === 'AbortError') {
    return `timed out or was cancelled${where}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/load failed|failed to fetch|networkerror/i.test(msg)) {
    return `could not connect${where} — no answer (DNS, TLS, wrong port, or the host is down/off the tailnet)`;
  }
  return `${msg}${where}`;
}

/**
 * The whole log as one block of text, with the context that makes it
 * readable by someone who is not holding the phone.
 *
 * The header matters as much as the entries: nine times in ten the fault is
 * visible in the server address alone (an `http://` or a `:8788` that cannot
 * work from a phone), and that is a thing the listener cannot otherwise see
 * written down.
 */
export function diagReport(context: Record<string, string | number | boolean | null>): string {
  const head = [
    `AttackFM diagnostics — ${new Date().toISOString()}`,
    `frontend ${APP_VERSION} · shell ${SHELL_VERSION}`,
    ...Object.entries(context).map(([k, v]) => `${k}: ${v ?? '—'}`),
    `user agent: ${typeof navigator === 'undefined' ? '—' : navigator.userAgent}`,
    `online: ${typeof navigator === 'undefined' ? '—' : navigator.onLine}`,
  ];
  const body = entries.length
    ? entries.map((e) => `${new Date(e.at).toISOString()}  [${e.kind}] ${e.detail}`)
    : ['(nothing recorded)'];
  return [...head, '', `${entries.length} entries`, ...body].join('\n');
}

/**
 * Catch what never reached a `try` - a render that threw, a promise nobody
 * awaited. Installed once from the entry module.
 */
export function installGlobalDiag(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    // Resource errors (a cover that 404s) fire here too and are noise; only
    // script errors carry a message worth keeping.
    if (!e.message) return;
    recordDiag('crash', `${e.message}${e.filename ? ` (${redactUrl(e.filename)}:${e.lineno})` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordDiag('promise', describeFailure(e.reason));
  });
}
