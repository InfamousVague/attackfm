import { formatNumber } from '../ux/format.ts';
import { translate } from '../i18n/LocaleShell.tsx';

/** "2d", "4h", "45m" - one number and its unit, in the locale's own shorthand.
 *  Intl's narrow unit display is exactly this abbreviation, and it knows the
 *  ones English does not: `min` in French, 分 in Japanese, and which side of
 *  the number they sit on. */
function narrow(value: number, unit: 'day' | 'hour' | 'minute'): string {
  return formatNumber(value, { style: 'unit', unit, unitDisplay: 'narrow' });
}

/** "2d 4h" / "3h 12m" / "45m" - uptime at a glance. */
export function uptimeLabel(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  if (days > 0) return `${narrow(days, 'day')} ${narrow(hours, 'hour')}`;
  if (hours > 0) return `${narrow(hours, 'hour')} ${narrow(minutes, 'minute')}`;
  return narrow(minutes, 'minute');
}

/** Always gigabytes, unlike `formatBytes` - these sit next to each other in a
 *  disk row ("40 GB free of 500 GB") and a pair that changed unit mid-sentence
 *  would be harder to compare than one that reads "0.4 GB". */
export function gbLabel(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  const decimals = gb >= 100 ? 0 : 1;
  return formatNumber(gb, {
    style: 'unit',
    unit: 'gigabyte',
    unitDisplay: 'short',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Where "close" stops: the header light goes amber from here. */
export const LATENCY_CLOSE_MS = 150;

/**
 * The latency bands, in the words a person would use. ONE definition, because
 * the header's dot links to the Servers page that explains it - the light and
 * the page must never disagree about what "close" means.
 *
 * The label is resolved here rather than returned as a key, because the three
 * surfaces that read it (NetworkDot, ServersPage, ImportServerPicker) each
 * paste it into a longer line and want a string. `translate` is not reactive,
 * which is fine for exactly these three: all of them re-render off a health
 * probe that ticks every few seconds, so a language change is picked up within
 * one tick rather than needing a render of its own.
 */
export function latencyBand(ms: number): {
  label: string;
  tone: 'best' | 'good' | 'ok' | 'slow';
} {
  if (ms < 40) return { label: translate('servers.latencySameNetwork'), tone: 'best' };
  if (ms < LATENCY_CLOSE_MS) return { label: translate('servers.latencyClose'), tone: 'good' };
  if (ms < 400) return { label: translate('servers.latencyFar'), tone: 'ok' };
  return { label: translate('servers.latencyVeryFar'), tone: 'slow' };
}
