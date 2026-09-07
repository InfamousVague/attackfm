import { useEffect, useState } from 'react';
import { formatBytes, formatNumber } from '../ux/format.ts';
import { AlertDialog, Button, Label, ProgressBar, Spinner, Switch, Text } from '@glacier/react';
import { Trash2 } from '@glacier/icons';
import { request } from '../api/http.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { useServerSession } from './serverSession.tsx';

/**
 * What the server does when nobody is asking it for anything.
 *
 * Admin only, because these spend the operator's hardware rather than each
 * listener's: GPU time, disk, and hours of it. They were environment variables,
 * which means in practice they were nothing - nobody edits a systemd unit to
 * decide whether their music box should be busy tonight.
 */

interface Running {
  trackId: number;
  title: string;
  artist: string;
  /** 0..1 through the separation itself. */
  fraction: number;
  /** `separating` while the model runs, `packing` while the parts are written. */
  phase: string;
}

interface Prefetch {
  enabled: boolean;
  /** Whether Liked is one of the things separated ahead. Absent on a server
   *  from before separating became opt-in. */
  liked?: boolean;
  /** False when the server has no demucs at all - a different thing from off. */
  available: boolean;
  wanted: number;
  done: number;
  failed: number;
  bytes: number;
  /**
   * The honest pair: how many liked-or-playlisted songs are apart, out of how
   * many there are. The queue's own counts cannot answer this - it is filled a
   * batch at a time, so `wanted` is a few dozen however many thousand remain.
   */
  /* Optional, because a server that has not been rebuilt yet does not send
     them - and the OTA reaches phones hours before somebody pulls on the hub.
     The readout falls back to the counts rather than emptying itself out. */
  separated?: number;
  total?: number;
  /** What the machine is doing right now, or null when it is idle. */
  running?: Running | null;
}

/**
 * The separation status, polled.
 *
 * A hook rather than state inside one component, because two places need this
 * and they ask different questions of it: the operator, deciding whether their
 * machine should be busy tonight, and the listener, wondering whether their
 * library is ready. Only one settings pane is on screen at a time, so this never
 * runs twice at once.
 */
export function usePrefetchStatus(): Prefetch | null {
  const { session } = useServerSession();
  const [state, setState] = useState<Prefetch | null>(null);

  /*
   * Polled while the pane is open, but only while there is something to watch.
   *
   * This deliberately read ONCE, on the reasoning that a number ticking while
   * you decide whether to switch something off is a distraction. That was right
   * about the counts and wrong about the work: separating a song takes about a
   * minute, so a figure that only moves when a whole one finishes looks stuck,
   * and "is this actually doing anything" is the question people open this row
   * to answer.
   *
   * So it ticks while the server is separating and stops when it is not - the
   * idle case is a settled number that needs no clock, which is what the
   * original reasoning was actually about.
   */
  useEffect(() => {
    if (!session) return;
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const next = await request<Prefetch>(session.url, '/api/stems/prefetch', {
          token: session.token,
        });
        if (!live) return;
        setState(next);
        timer = window.setTimeout(read, next.running ? 2_000 : 20_000);
      } catch {
        if (!live) return;
        setState(null);
        // A server that stopped answering is not a reason to hammer it.
        timer = window.setTimeout(read, 20_000);
      }
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [session]);

  return state;
}

/**
 * How far along the whole job is - read only, and safe to show anyone.
 *
 * Split out of the row below so it can also sit in Playback, where somebody
 * looking for "is my music ready to pull apart yet" will actually look. The
 * SWITCH stays admin-only under Servers, because turning it on spends the
 * operator's GPU and disk; watching it does not. The endpoint agrees - it asks
 * only for a signed-in caller, not an admin.
 */
/** The song being worked on, named the way the catalogue names songs. */
function songLabel(t: (key: string, values?: Record<string, unknown>) => string, running: Running): string {
  if (!running.title) return t('servers.aSong');
  return running.artist
    ? t('servers.songTitleByArtist', { title: running.title, artist: running.artist })
    : t('servers.songTitleQuoted', { title: running.title });
}

export function StemProgress({ state }: { state: Prefetch }) {
  const t = useT();
  if (!state.available) return null;

  /*
   * "Taking apart “Blue Monday” — New Order · 40%".
   *
   * Built here rather than in the JSX below because the verb is a whole
   * catalogue entry with the song inside it, not a word glued in front of one:
   * `phase` is the server's own token and is matched, never shown. The song
   * goes in as one `what` hole so the quotation marks come from the catalogue
   * as well - not every language quotes with “ ”.
   */
  const now = state.running;
  const nowLine = now
    ? [
        now.phase === 'packing'
          ? t('servers.stemsFiling', { what: songLabel(t, now) })
          : t('servers.stemsTakingApart', { what: songLabel(t, now) }),
        ...(now.phase === 'separating' && now.fraction > 0
          ? [formatNumber(now.fraction, { style: 'percent', maximumFractionDigits: 0 })]
          : []),
      ].join(' · ')
    : null;
  if (typeof state.total === 'number' && state.total > 0) {
    return (
      <div className="prefetchProgress">
        {/* The whole job, as one bar. Counted against liked-and-playlisted
            songs rather than against stems on disk, so it cannot read 90%
            because somebody separated a lot of things by hand. */}
        <ProgressBar
          value={state.separated ?? 0}
          max={state.total}
          tone="accent"
          size="sm"
          aria-label={t('servers.stemsProgressLabel')}
        />
        <Text tone="muted" size="xs">
          {/* A bulleted LIST of readings, not a sentence: each part is its own
              catalogue entry, and the optional ones simply do not join the
              list. Building it as JSX siblings would hand a translator the
              separators and none of the order. */}
          {[
            t('servers.stemsApartOfTotal', {
              count: state.total,
              n: formatNumber(state.separated ?? 0),
              total: formatNumber(state.total),
            }),
            ...(state.wanted > 0
              ? [t('servers.stemsQueued', { count: state.wanted, n: formatNumber(state.wanted) })]
              : []),
            t('servers.stemsUsed', { size: formatBytes(state.bytes) }),
            ...(state.failed > 0
              ? [t('servers.stemsFailed', { count: state.failed, n: formatNumber(state.failed) })]
              : []),
          ].join(' · ')}
        </Text>
        {/* Naming the song is what turns a stalled-looking number into
            visible work: this moves every couple of seconds even when the
            count above will not change for another minute. */}
        {state.running && (
          <Text tone="muted" size="xs" className="prefetchProgress__now">
            <Spinner size="sm" aria-hidden />
            {nowLine}
          </Text>
        )}
        {!state.running && state.enabled && (state.separated ?? 0) >= state.total && (
          <Text tone="muted" size="xs">
            {t('servers.stemsAllApart')}
          </Text>
        )}
      </div>
    );
  }
  /* An older server sends counts but no total. Rather than show nothing until
     somebody rebuilds the hub, say what it does know. */
  if (state.done > 0 || state.wanted > 0) {
    return (
      <Text tone="muted" size="xs">
        {[
          t('servers.stemsReady', { count: state.done, n: formatNumber(state.done) }),
          t('servers.stemsWaiting', { count: state.wanted, n: formatNumber(state.wanted) }),
          t('servers.stemsUsed', { size: formatBytes(state.bytes) }),
          ...(state.failed > 0
            ? [t('servers.stemsFailed', { count: state.failed, n: formatNumber(state.failed) })]
            : []),
        ].join(' · ')}
      </Text>
    );
  }
  return null;
}

export function BackgroundWork() {
  const t = useT();
  const { session } = useServerSession();
  const state = usePrefetchStatus();
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneNote, setPruneNote] = useState<string | null>(null);
  /*
   * What the prune WOULD delete, fetched before the question is asked.
   *
   * The dialog used to describe the rule ("everything outside Liked and the
   * lists you turned on") and let the reader work out what that meant for
   * them. That is exactly backwards for a destructive button, and dangerous
   * in one specific way: with the Liked switch OFF, Liked is not in the keep
   * set, so the honest sentence and the actual behaviour part company at the
   * worst possible moment. Now the server counts first and the dialog states
   * the real number, the real size, and whether Liked is currently spared.
   */
  const [plan, setPlan] = useState<{ tracks: number; bytes: number } | null>(null);
  const [planning, setPlanning] = useState(false);

  // The other half of the optimistic switches: stand down as soon as the
  // server's own answer says the same thing, and not a moment before. Must sit
  // above the early return - it is a hook.
  useEffect(() => {
    if (override !== null && state?.enabled === override) setOverride(null);
  }, [state?.enabled, override]);
  useEffect(() => {
    if (likedOverride !== null && state?.liked === likedOverride) setLikedOverride(null);
  }, [state?.liked, likedOverride]);

  if (!session || !state) return null;
  const enabled = override ?? state.enabled;
  const likedOn = likedOverride ?? state.liked ?? false;

  const flip = async (on: boolean) => {
    setBusy(true);
    /*
     * Held locally rather than written into the polled state, which the next
     * tick would overwrite.
     *
     * Kept until the POLL agrees, not until the POST returns. Clearing it on
     * the response looked right - the server had just confirmed the write - but
     * the value underneath is whatever the last poll fetched, and when the
     * server is idle that poll is twenty seconds old. So the switch went on,
     * the write succeeded, and it snapped straight back off in front of you,
     * where it sat until the next tick quietly put it right. It read as the
     * server refusing the change; it was our own stale copy.
     *
     * A failed write clears the override immediately, because there the stale
     * value IS the true one.
     */
    setOverride(on);
    try {
      await request(session.url, '/api/stems/prefetch', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({ enabled: on }),
      });
    } catch {
      // Put it back: a switch that stays where you left it while the server
      // disagrees is worse than one that springs back.
      setOverride(null);
    } finally {
      setBusy(false);
    }
  };

  const flipLiked = async (on: boolean) => {
    // Same hold-until-the-poll-agrees rule as `flip` above, for the same
    // reason - this switch sprang back too.
    setLikedOverride(on);
    try {
      await request(session.url, '/api/stems/prefetch/liked', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({ enabled: on }),
      });
    } catch {
      setLikedOverride(null);
    }
  };

  /** Ask what would go, then put the question with the answer in it. */
  const askToPrune = async () => {
    setPlanning(true);
    setPruneNote(null);
    try {
      const dry = await request<{ tracks: number; bytes: number }>(
        session.url,
        '/api/stems/prune?dry=1',
        { method: 'POST' , token: session.token },
      );
      if (dry.tracks === 0) {
        setPruneNote(t('servers.stemsNothingToClear'));
        return;
      }
      setPlan(dry);
    } catch (err) {
      setPruneNote(err instanceof Error ? err.message : t('servers.stemsPruneFailed'));
    } finally {
      setPlanning(false);
    }
  };

  const prune = async () => {
    setPruning(true);
    setPruneNote(null);
    try {
      const reply = await request<{ tracks: number; bytes: number }>(
        session.url,
        '/api/stems/prune',
        { method: 'POST', token: session.token },
      );
      setPruneNote(
        reply.tracks === 0
          ? t('servers.stemsNothingToClear')
          : t('servers.stemsCleared', {
              count: reply.tracks,
              n: formatNumber(reply.tracks),
              size: formatBytes(reply.bytes),
            }),
      );
    } catch (err) {
      setPruneNote(err instanceof Error ? err.message : t('servers.stemsPruneFailed'));
    } finally {
      setPruning(false);
    }
  };

  return (
    <div className="prefsSection" data-setting="stem-prefetch">
      <Label>{t('servers.backgroundWork')}</Label>
      <Switch
        label={t('servers.stemsPrefetch')}
        checked={enabled && state.available}
        disabled={busy || !state.available}
        onCheckedChange={(on: boolean) => void flip(on)}
      />
      <Text tone="muted" size="sm">
        {!state.available ? t('servers.stemsUnavailable') : t('servers.stemsPrefetchBlurb')}
      </Text>
      {state.available && state.liked !== undefined && (
        <Switch
          label={t('servers.stemsIncludeLiked')}
          checked={likedOn}
          disabled={!enabled}
          onCheckedChange={(on: boolean) => void flipLiked(on)}
        />
      )}
      <StemProgress state={state} />
      {state.available && (
        <>
          <div className="prefsActions">
            <Button
              variant="outline"
              size="sm"
              disabled={pruning || planning}
              onClick={() => void askToPrune()}
            >
              <Trash2 size={14} />{' '}
              {pruning ? t('servers.stemsClearing') : planning ? t('servers.stemsCounting') : t('servers.stemsClearRest')}
            </Button>
          </div>
          <Text tone="muted" size="sm">
            {t('servers.stemsClearBlurb')}
          </Text>
          {pruneNote && (
            <Text tone="muted" size="sm">
              {pruneNote}
            </Text>
          )}
          <AlertDialog
            open={plan !== null}
            onClose={() => setPlan(null)}
            title={
              plan
                ? t('servers.stemsClearConfirm', {
                    count: plan.tracks,
                    n: formatNumber(plan.tracks),
                    size: formatBytes(plan.bytes),
                  })
                : t('servers.stemsClearRestQuestion')
            }
            description={likedOn ? t('servers.stemsClearBodyLiked') : t('servers.stemsClearBodyNotLiked')}
            actionLabel={t('servers.stemsClearAction')}
            tone="danger"
            onAction={() => {
              setPlan(null);
              void prune();
            }}
          />
        </>
      )}
    </div>
  );
}
