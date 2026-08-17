/** "2d 4h" / "3h 12m" / "45m" - uptime at a glance. */
export function uptimeLabel(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function gbLabel(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** Where "close" stops: the header light goes amber from here. */
export const LATENCY_CLOSE_MS = 150;

/**
 * The latency bands, in the words a person would use. ONE definition, because
 * the header's dot links to the Servers page that explains it - the light and
 * the page must never disagree about what "close" means.
 */
export function latencyBand(ms: number): {
  label: string;
  tone: 'best' | 'good' | 'ok' | 'slow';
} {
  if (ms < 40) return { label: 'same network', tone: 'best' };
  if (ms < LATENCY_CLOSE_MS) return { label: 'close', tone: 'good' };
  if (ms < 400) return { label: 'far', tone: 'ok' };
  return { label: 'very far', tone: 'slow' };
}
