import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Pill,
  Button,
  Input,
  SegmentedBar,
  Select,
  Spinner,
  Switch,
  Text,
  useToast,
} from '@glacier/react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleCheck,
  CircleX,
  Compass,
  HeartHandshake,
  RotateCcw,
  Shuffle,
  Sparkles,
  Zap,
} from '@glacier/icons';
import { IconTile, PaneSection, SettingRow, SettingsCallout, SettingsEmpty, SubNav } from './kit/settingsKit.tsx';
import { djVoiceEnabled, setDjVoice } from '../booth/djVoice.ts';
import { dateVoiceEnabled, setDateVoice } from '../date/dateVoice.ts';
import { takePendingReveal, type Translate } from './settingsShared.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatAgo, formatNumber, formatTotal } from '../ux/format.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchAiActivity, fetchAiReport, fetchAiVoices, probeAi, runAi, setAiSettings } from '../api/ai.ts';
import type { AiHealth, AiReport, AiRunWhat, AiSettingsPatch, AiVoice } from '../api/ai.ts';
import type { ActivityEvent } from '../api/activity.ts';
import { ServerError } from '../api/http.ts';

/**
 * Local AI - the owner's pane for the server's model endpoint: what it points
 * at, which model does which job, whether it answers, and what it has been
 * doing. Shown only to the server's admin (the owner; the client's
 * `session.isAdmin`), and every route it calls is admin-gated on the server
 * too, because hiding a row is a courtesy and never a permission.
 *
 * THE ORGANISING IDEA: every value here has two states worth telling apart -
 * the owner chose it, or the unit file did. A field the owner has taken over
 * shows a Set badge and can be handed back; one they have not shows what the
 * environment is saying, greyed. Without that distinction an empty box is
 * ambiguous between "nothing is configured" and "configured elsewhere, and I
 * am not showing you", and the second is how somebody ends up setting a value
 * that was already set.
 *
 * NOTHING IS PROBED ON THE WAY IN. A cold Ollama can take seconds to answer,
 * and a settings pane that hangs for eight seconds before drawing is worse
 * than one with a button. Health starts as "not checked".
 */

/**
 * Fields that are a plain line of text, in the order they read.
 *
 * Catalogue keys rather than words: this array is built when the module is
 * imported, before a language has been chosen, so anything written here in
 * English would still be English after the picker was used. The pane resolves
 * them where it draws the field.
 *
 * `example` is NOT one of them, and is not called `placeholder` any more. An
 * origin and a model tag - `qwen3.5:9b` - are things you type back verbatim,
 * not prose about them, and naming the field for what it holds keeps the next
 * reader (and the string scanner) from filing them as copy to translate.
 */
const TEXT_FIELDS = [
  {
    key: 'url' as const,
    labelKey: 'settings.aiEndpoint',
    hintKey: 'settings.aiEndpointHint',
    example: 'http://127.0.0.1:11434',
  },
  {
    key: 'chatModel' as const,
    labelKey: 'settings.aiChatModel',
    hintKey: 'settings.aiChatModelHint',
    example: 'qwen3.5:9b',
  },
  {
    key: 'embedModel' as const,
    labelKey: 'settings.aiEmbedModel',
    hintKey: 'settings.aiEmbedModelHint',
    example: 'nomic-embed-text',
  },
  {
    key: 'fastModel' as const,
    labelKey: 'settings.aiFastModel',
    hintKey: 'settings.aiFastModelHint',
    example: 'qwen3.5:9b',
  },
  {
    key: 'refinementModel' as const,
    labelKey: 'settings.aiAuditModel',
    hintKey: 'settings.aiAuditModelHint',
    example: 'gemma4:12b',
  },
];

/*
 * Latencies and timeouts, in the unit's own words.
 *
 * These were written out as `${ms}ms` and `${secs}s` - two abbreviations that
 * are English, sit on the wrong side of the number in some locales, and were
 * hidden from the catalogue inside a template literal. Intl knows both, so
 * they come from there rather than from a key; the sentence AROUND the number
 * is still a catalogue entry.
 */
function msLabel(ms: number): string {
  return formatNumber(ms, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' });
}

function secondsLabel(seconds: number, digits = 0): string {
  return formatNumber(seconds, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/* "3 hours ago", and the six Arabic forms of it. The hand-rolled ladder this
 * replaces is one of the four ux/format.ts was written to absorb - it said
 * "3d ago" in English on every surface, in every language. */
function ago(seconds: number | null, t: Translate): string {
  if (!seconds) return t('settings.aiNever');
  return formatAgo(seconds * 1000);
}

/**
 * The things you can ask this server to do, as one-tap tiles.
 *
 * Every one of these already ran on a timer somewhere - a harvest every six
 * hours, mixes rebuilt once a day, a buying pass every five minutes. What was
 * missing was a door: no way to say "do it now", and no way to watch while it
 * happened. The `what` is the string the server matches on.
 *
 * `patience` is the honest bit. These passes take minutes - a harvest paces
 * itself at 700ms a call so the catalogue does not throttle it - and one of
 * them cannot deliver its result at all without a download finishing on another
 * machine first. Saying so under the tile is better than a spinner that ends
 * while nothing has visibly changed.
 */
/** The picker's escape hatch: a model the list cannot offer. */
const TYPE_IT = '\u0000type';

// `what` is the word the server matches on and stays English; everything the
// reader sees is a key, because the tiles are built at import time.
const ACTIONS: {
  what: AiRunWhat;
  labelKey: string;
  patienceKey: string;
  icon: ReactNode;
}[] = [
  {
    what: 'discover',
    labelKey: 'settings.aiFindMusic',
    patienceKey: 'settings.aiFindMusicPatience',
    icon: <Compass size={20} />,
  },
  {
    what: 'mix',
    labelKey: 'settings.aiNewMix',
    patienceKey: 'settings.aiNewMixPatience',
    icon: <Shuffle size={20} />,
  },
  {
    what: 'dates',
    labelKey: 'settings.aiTopUpDates',
    patienceKey: 'settings.aiTopUpDatesPatience',
    icon: <HeartHandshake size={20} />,
  },
  {
    what: 'curate',
    labelKey: 'settings.aiFullPassTile',
    patienceKey: 'settings.aiFullPassPatience',
    icon: <Sparkles size={20} />,
  },
];

/**
 * What a function has been doing, in one phrase.
 *
 * Three different situations used to share the words "never run": it has never
 * worked, it has not been needed since the server restarted, and the server
 * restarted ninety seconds ago. Only the first is a problem, and it was the
 * reading everybody got - a freshly deployed box reported six dead functions
 * while its models were still resident from the work it had just finished.
 */
function activity(
  fn: { calls: number; lastAt: number | null; everAt: number | null },
  t: Translate,
): string {
  if (fn.calls > 0) {
    return t('settings.aiFnCalls', { count: fn.calls, when: ago(fn.lastAt, t) });
  }
  if (fn.everAt) return t('settings.aiFnLastUsed', { when: ago(fn.everAt, t) });
  return t('settings.aiFnNeverRun');
}

/**
 * Whether a named model and one the endpoint lists are the same thing.
 *
 * Ollama reports its default tag explicitly (`nomic-embed-text:latest`) while
 * the setting naming it is almost always written bare, so comparing the strings
 * marked the embedding model "not in use" on a server that was embedding with
 * it. An explicit tag on BOTH sides still has to match - `qwen3.5:9b` and
 * `qwen3.5:32b` are not each other.
 */
function sameModel(named: string | null | undefined, listed: string): boolean {
  if (!named) return false;
  const bare = (v: string) => v.trim().replace(/:latest$/, '');
  return bare(named) === bare(listed);
}

/**
 * How long something has been running.
 *
 * Everything from a minute up goes through the house formatter, which knows
 * the unit names in every locale. Under a minute it cannot be asked -
 * formatTotal rounds to whole minutes, so a pass that started twenty seconds
 * ago would report "0 min" - so the seconds case goes to Intl directly, which
 * plurals the unit itself rather than through a two-form catalogue entry.
 */
function duration(seconds: number): string {
  if (seconds < 60) return secondsLabel(seconds);
  return formatTotal(seconds);
}

/*
 * A note on what this pane no longer says out loud.
 *
 * Several sections opened with a paragraph explaining WHY they work as they do:
 * that the statistics are per-process so a month of health cannot hide an
 * endpoint failing this morning; that the curator stands down while anybody is
 * playing, which is why a pass can sit unfinished on a busy hub; that health is
 * probed on demand because a cold model takes seconds to answer. All true, all
 * worth knowing, and all of it was the first thing a reader met on a phone,
 * above the controls. It lives here now, where the next person to change this
 * file will find it, and the pane says the short half.
 */
/**
 * The fallback five, for a hub that cannot be asked.
 *
 * The picker lists what the server's own ElevenLabs account HAS now
 * (`/api/ai/voices`), and these are what it falls back to: an older hub with
 * no such endpoint, a hub with no key, a hub that cannot reach ElevenLabs.
 * They were verified against that same account once and frozen here, which is
 * exactly why the list had to stop being frozen - a CLONED voice is the one
 * voice on an account that is nobody else's, and a hand-typed list can never
 * show it.
 */
// The id is ElevenLabs'; the line beside it is ours, so it is a key - the
// voice's NAME is a proper noun a translator leaves alone, the description of
// how it sounds is not.
const DJ_VOICES = [
  { id: 'FGY2WhTYpPnrIDTdsKH5', labelKey: 'settings.voiceLaura' },
  { id: 'tnSpp4vdxKPjI9w0GnoV', labelKey: 'settings.voiceHope' },
  { id: 'oW8bn5YtBB89X2nJ0DT9', labelKey: 'settings.voiceVerity' },
  { id: 'nPczCjzI2devNBz1zQrb', labelKey: 'settings.voiceBrian' },
  { id: 'onwK4e9ZLuTAKqWW03F9', labelKey: 'settings.voiceDaniel' },
  { id: 'cgSgspJ2msm6clMCkdW9', labelKey: 'settings.voiceJessica' },
];

/**
 * The last resort, for a hub that will not say what it is speaking in.
 *
 * The pane asks the server (`current`, from /api/ai/voices) rather than
 * assuming, because these drifted apart: the pane showed Hope while the box's
 * own drop-in named a different voice, so the picker was describing something
 * nobody could hear. This is only what a hub too old to answer gets - and it
 * matches the server's own default (voice.rs `DEFAULT_VOICE`), which is the
 * one thing that makes it a fair guess rather than a second opinion. It is
 * also in DJ_VOICES above, deliberately: a Select whose value names no option
 * shows an empty box.
 */
const DEFAULT_DJ_VOICE = 'FGY2WhTYpPnrIDTdsKH5';

/** How ElevenLabs' own word for where a voice came from reads on a row. The
 *  KEYS are the service's categories and are matched on; the values are ours,
 *  so they are catalogue keys in turn. */
const VOICE_KIND: Record<string, string> = {
  cloned: 'settings.voiceKindCloned',
  professional: 'settings.voiceKindProfessional',
  premade: 'settings.voiceKindPremade',
  generated: 'settings.voiceKindGenerated',
};

/**
 * The voices to offer, and the order to offer them in.
 *
 * Cloned first, always. A voice made from somebody's own recording is the
 * point of having a picker - it is the one on the list nobody else's server
 * can offer - and burying it under five stock names alphabetically would be
 * filing it as one more option.
 */
function voiceOptions(live: AiVoice[], t: Translate): { value: string; label: string }[] {
  if (live.length === 0) return DJ_VOICES.map((v) => ({ value: v.id, label: t(v.labelKey) }));
  const rank = (v: AiVoice) => (v.category === 'cloned' ? 0 : v.category === 'professional' ? 1 : 2);
  return [...live]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((v) => {
      // A category the service has invented since this map was written falls
      // through as its own raw word rather than as nothing.
      const known = VOICE_KIND[v.category];
      const kind = known ? t(known) : v.category;
      // Name and category joined through a key, not a dash: the voice's name
      // is a proper noun and the category is translated, and which of the two
      // leads - and what sits between them - is the translator's call.
      return {
        value: v.id,
        label: kind ? t('settings.voiceWithKind', { name: v.name, kind }) : v.name,
      };
    });
}

export function LocalAiPane() {
  const t = useT();
  const { session } = useServerSession();
  const { toast } = useToast();
  const [voiceOn, setVoiceOn] = useState(djVoiceEnabled);
  const [dateVoiceOn, setDateVoiceOn] = useState(dateVoiceEnabled);
  const [report, setReport] = useState<AiReport | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  /** The hub's own voices. Empty until asked, and empty forever on a hub that
   *  has no key or no such endpoint - the picker falls back either way. */
  const [voices, setVoices] = useState<AiVoice[]>([]);
  /** What the hub says it is actually speaking in, whatever set it. */
  const [voiceNow, setVoiceNow] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // What is in the boxes, which is not what is saved until it is. Keyed by
  // field so a save in flight on one does not blank another being typed in.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * Fields the reader has switched to free text. Per field, and never reset by
   * a reload: choosing "Type a name…" and having the box turn back into a
   * dropdown under your hands is the kind of thing that makes a pane feel
   * broken.
   */
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  /*
   * The pane is four pages behind one toggle. SubNav, not SegmentedControl,
   * because the kit's own rule says so: SegmentedControl is a value input,
   * and switching between chunks of a pane is navigation.
   */
  const [chunk, setChunk] = useState<'ask' | 'taste' | 'model' | 'activity'>('ask');
  const rootRef = useRef<HTMLDivElement | null>(null);

  /*
   * A page switch starts at the top. The pages share one scroller
   * (.settingsScreen__pane on the phone, the modal's panel on desktop), and a
   * scroller keeps its offset when its content is swapped - so arriving on a
   * short page from deep in a long one landed PAST the content, which read as
   * scrolling being broken rather than as a preserved offset.
   */
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'start' });
  }, [chunk]);

  /*
   * The account's real voices, asked for once per visit.
   *
   * Silent on every failure, and deliberately: an older hub has no such route
   * and answers 404, and the honest fallback is the list this pane has always
   * shown rather than an error about a feature the reader did not ask for.
   */
  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    void fetchAiVoices(session, ctrl.signal)
      .then((out) => {
        if (ctrl.signal.aborted) return;
        setVoices(out.voices ?? []);
        setVoiceNow(out.current ?? null);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [session]);

  /*
   * Settings search can land on a row that lives on a non-default page.
   * revealSetting announces the id before its scroll timer; switching here
   * puts the row in the DOM in time for the timer's querySelector to find it.
   */
  useEffect(() => {
    const route = (id: string) => {
      if (id.startsWith('ai-do-')) setChunk('ask');
      else if (id === 'ai-taste') setChunk('taste');
      else if (id.startsWith('ai-')) setChunk('model');
    };
    // The search click that opens this pane fires its event BEFORE the pane
    // exists - React commits the mount after the handler - so the missed one
    // is picked up here; the listener covers searches made while it is open.
    const pending = takePendingReveal();
    if (pending) route(pending);
    const onReveal = (e: Event) => route((e as CustomEvent<{ id: string }>).detail?.id ?? '');
    window.addEventListener('afm-reveal-setting', onReveal);
    return () => window.removeEventListener('afm-reveal-setting', onReveal);
  }, []);
  /**
   * The feed, one page per entry, oldest page last.
   *
   * Kept as a stack rather than a single page so going back is free: the pages
   * already read do not need fetching again, and the cursor for each is simply
   * the last id of the one before it. `pages[0]` is seeded from the report, so
   * opening this pane is still one request.
   */
  const [pages, setPages] = useState<ActivityEvent[][]>([]);
  const [page, setPage] = useState(0);
  /** Whether anything older than the LAST page loaded exists. */
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    // Re-armed on the way IN, not just cleared on the way out. React runs
    // effects twice in development against the SAME component instance, so a
    // ref that is only ever set false stays false for the second mount - and
    // every guarded setState after it is dropped. The pane sat on "Reading the
    // report…" forever with a 200 in the network log.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const next = await fetchAiReport(session);
      if (!alive.current) return;
      setReport(next);
      // A refresh restarts the feed at the top: anything read further back was
      // read against a report that no longer exists, and silently keeping the
      // reader on page four of a stale list is worse than sending them home.
      setPages([next.recent]);
      setPage(0);
      setMore(next.recentHasMore === true);
      setMissing(false);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // The OTA reaches phones hours before the hub is rebuilt, so a 404 here
      // is the ordinary state of a server that has not caught up - not a fault
      // to alarm the owner with.
      if (e instanceof ServerError && e.status === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : t('settings.aiReportFailed'));
    }
  }, [session, t]);

  useEffect(() => { void load(); }, [load]);

  /*
   * Follow along.
   *
   * These passes run for minutes, so the pane has to keep asking or the step
   * line freezes at whatever it said when the page loaded. Only while something
   * IS running - an idle server is not polled at all - and one more read after
   * it finishes, which is what replaces the running card with the outcome in
   * the feed without the reader having to do anything.
   */
  const isRunning = report?.running != null;
  useEffect(() => {
    if (!isRunning || !session) return;
    const id = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(id);
  }, [isRunning, session, load]);

  const save = async (patch: AiSettingsPatch, which: string) => {
    if (!session) return;
    setSaving(which);
    try {
      const settings = await setAiSettings(session, patch);
      if (!alive.current) return;
      setReport((prev) => (prev ? { ...prev, settings } : prev));
      setDraft((d) => { const { [which]: _drop, ...rest } = d; return rest; });
    } catch (e) {
      toast({
        message: t('settings.aiSaveFailed', {
          why: e instanceof Error ? e.message : t('settings.aiServerRefused'),
        }),
        tone: 'danger',
      });
    } finally {
      if (alive.current) setSaving(null);
    }
  };

  const older = async () => {
    // Already read: no request, just move.
    if (page + 1 < pages.length) {
      setPage(page + 1);
      return;
    }
    const current = pages[page];
    const cursor = current?.[current.length - 1]?.id;
    if (!session || !cursor) return;
    setPaging(true);
    try {
      const next = await fetchAiActivity(session, cursor);
      if (!alive.current) return;
      // An empty answer means the tail moved under us - stay put rather than
      // showing a blank page, and stop offering to go further.
      if (next.events.length === 0) {
        setMore(false);
        return;
      }
      setPages((p) => [...p, next.events]);
      setPage((n) => n + 1);
      setMore(next.hasMore);
    } catch {
      if (alive.current) setMore(false);
    } finally {
      if (alive.current) setPaging(false);
    }
  };

  const probe = async () => {
    if (!session) return;
    setProbing(true);
    try {
      const next = await probeAi(session);
      if (alive.current) setHealth(next);
    } catch (e) {
      if (alive.current) {
        setHealth({ checkedAt: Math.floor(Date.now() / 1000), reachable: false, latencyMs: null, models: [],
          error: e instanceof Error ? e.message : t('settings.aiCheckFailed') });
      }
    } finally {
      if (alive.current) setProbing(false);
    }
  };

  const start = async (what: AiRunWhat, label: string) => {
    if (!session) return;
    setRunning(true);
    try {
      await runAi(session, what);
      toast({ message: t('settings.aiStarted', { label }) });
      // Not awaited: the pass runs for minutes on the server. The poll below
      // picks it up and keeps the step line moving.
      window.setTimeout(() => { void load(); }, 800);
    } catch (e) {
      /*
       * Two refusals worth telling apart, because they mean opposite things.
       * 409 is the server saying it is already busy - not a fault, and the
       * running card below is about to explain it. 400 is a hub too old to
       * know this action at all, which the pane's 404 "needs rebuilding" path
       * does not cover because the route exists and only the word is unknown.
       */
      const status = e instanceof ServerError ? e.status : 0;
      if (status === 409) toast({ message: t('settings.aiBusy') });
      else if (status === 400) {
        toast({ message: t('settings.aiActionTooOld'), tone: 'danger' });
      } else {
        toast({
          message: t('settings.aiStartFailed', {
            why: e instanceof Error ? e.message : t('settings.aiServerRefused'),
          }),
          tone: 'danger',
        });
      }
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  if (missing) {
    return (
      <div className="prefsBody localAiPane">
        <SettingsEmpty
          icon={<Bot size={22} />}
          title={t('settings.aiMissingTitle')}
          body={t('settings.aiMissingBody')}
        />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="prefsBody localAiPane">
        {error ? (
          <SettingsCallout tone="danger" action={<Button size="sm" variant="soft" onClick={() => void load()}>{t('common.tryAgain')}</Button>}>
            {error}
          </SettingsCallout>
        ) : (
          <div className="localAi__loading"><Spinner /> <Text tone="muted" size="sm">{t('settings.aiReading')}</Text></div>
        )}
      </div>
    );
  }

  const { settings, functions, totals } = report;
  /*
   * The URL is a URL, not a model. Only the four model fields become pickers,
   * and only when the endpoint actually enumerated something.
   */
  const installed = report.installed ?? [];
  const configured = !!settings.url && !!settings.chatModel;
  const shown = pages[page] ?? [];

  return (
    <div className="prefsBody localAiPane" ref={rootRef}>
      <SubNav
        value={chunk}
        onValueChange={(id) => setChunk(id as typeof chunk)}
        options={[
          { id: 'ask', label: t('settings.aiTabAsk') },
          { id: 'taste', label: t('settings.aiTabTaste') },
          { id: 'model', label: t('settings.aiTabModel') },
          { id: 'activity', label: t('settings.aiTabActivity') },
        ]}
      />

      {chunk === 'ask' && (
      <PaneSection
        title={t('settings.aiAskTitle')}
        description={t('settings.aiAskDescription')}
      >
        {report.running ? (
          /*
           * The running card REPLACES the grid rather than sitting beside it.
           * Only one pass runs at a time, so four tiles that would all be
           * refused is not a choice, it is four ways to be told no.
           */
          <div className="aiRun" data-what={report.running.what}>
            <IconTile variant="accent" size="lg">
              {ACTIONS.find((a) => a.what === report.running?.what)?.icon ?? <Sparkles size={20} />}
            </IconTile>
            <div className="aiRun__text">
              <Text weight="medium">{report.running.label}</Text>
              <Text tone="muted" size="sm">
                {report.running.step}
              </Text>
            </div>
            <div className="aiRun__clock">
              <Spinner size="sm" aria-label="" />
              <Text tone="muted" size="xs">
                {duration(Math.max(0, Math.floor((Date.now() - report.running.startedAt) / 1000)))}
              </Text>
            </div>
          </div>
        ) : (
          <div className="aiActions">
            {ACTIONS.map((a) => (
              <button
                key={a.what}
                type="button"
                className="aiAction"
                data-setting={`ai-do-${a.what}`}
                disabled={running || !configured}
                onClick={() => void start(a.what, t(a.labelKey))}
              >
                <IconTile variant="accent" size="lg">{a.icon}</IconTile>
                <span className="aiAction__label">{t(a.labelKey)}</span>
                <span className="aiAction__patience">{t(a.patienceKey)}</span>
              </button>
            ))}
          </div>
        )}
        {!configured && (
          <Text tone="muted" size="sm">
            {t('settings.aiNotConfigured')}
          </Text>
        )}
      </PaneSection>
      )}

      {chunk === 'model' && (
      <>
      <PaneSection
        title={t('settings.aiEndpointSection')}
        description={t('settings.aiEndpointSectionDescription')}
      >
        {!configured && (
          <SettingsCallout tone="accent" icon={<Bot size={16} />}>
            {t('settings.aiNoModelCallout')}
          </SettingsCallout>
        )}

        {TEXT_FIELDS.map((field) => {
          const saved = settings[field.key] ?? '';
          const owned = settings.overrides[field.key] === true;
          const fromEnv = settings.envDefaults[field.key];
          const shown = draft[field.key] ?? saved;
          const choosable = field.key !== 'url' && installed.length > 0;
          const dirty = draft[field.key] !== undefined && draft[field.key] !== saved;
          return (
            <div className="localAi__field" key={field.key} data-setting={`ai-${field.key}`}>
              <div className="localAi__fieldHead">
                <Text weight="medium" size="sm">{t(field.labelKey)}</Text>
                {owned ? (
                  <Pill size="sm" variant="soft" tone="accent">{t('settings.aiSetHere')}</Pill>
                ) : fromEnv ? (
                  <Pill size="sm" variant="soft" tone="neutral">{t('settings.aiFromEnv')}</Pill>
                ) : null}
              </div>
              <Text tone="muted" size="xs">{t(field.hintKey)}</Text>
              <div className="localAi__fieldRow">
                {/*
                  * A PICKER when the box has told us what it has, a text field
                  * when it has not.
                  *
                  * Naming a model used to be typing a string and hoping - and
                  * the one thing that makes it fail is invisible until much
                  * later, when the feature that needed it quietly never runs.
                  * The endpoint knows the answer, so the list is the control.
                  * TYPE IT stays for the case the list cannot cover: a model
                  * pulled since the pane was opened, or an endpoint that will
                  * not enumerate.
                  */}
                {choosable && !typing[field.key] ? (
                  <Select
                    fullWidth
                    /* Resolved to the LISTED spelling, not the saved one: the
                       setting says `nomic-embed-text` where the endpoint calls
                       it `nomic-embed-text:latest`, and Select matches option
                       values exactly - so the saved model would show as
                       nothing chosen. */
                    value={installed.find((m) => sameModel(shown, m)) ?? shown}
                    placeholder={String(fromEnv ?? field.example)}
                    aria-label={t(field.labelKey)}
                    options={[
                      /*
                       * A model that is NAMED but not on the box gets its own
                       * option, said out loud. Without it the picker falls back
                       * to its placeholder and the pane quietly shows a model
                       * nobody chose - which is the precise failure this whole
                       * screen exists to catch: a name that does not match
                       * anything, and a feature that silently never runs.
                       */
                      ...(shown && !installed.some((m) => sameModel(shown, m))
                        ? [{ value: shown, label: t('settings.aiModelMissing', { model: shown }) }]
                        : []),
                      ...installed.map((m) => ({ value: m, label: m })),
                      { value: TYPE_IT, label: t('settings.aiTypeAName') },
                    ]}
                    onValueChange={(v: string) => {
                      if (v === TYPE_IT) {
                        setTyping((t) => ({ ...t, [field.key]: true }));
                        return;
                      }
                      setDraft((d) => ({ ...d, [field.key]: v }));
                      void save({ [field.key]: v } as AiSettingsPatch, field.key);
                    }}
                  />
                ) : (
                  <Input
                    value={shown}
                    placeholder={String(fromEnv ?? field.example)}
                    spellCheck={false}
                    autoCapitalize="off"
                    aria-label={t(field.labelKey)}
                    onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.currentTarget.value }))}
                  />
                )}
                {(!choosable || typing[field.key]) && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={!dirty || saving === field.key}
                    onClick={() => void save({ [field.key]: draft[field.key] } as AiSettingsPatch, field.key)}
                  >
                    {saving === field.key ? <Spinner size="sm" /> : t('common.save')}
                  </Button>
                )}
                {saving === field.key && choosable && !typing[field.key] && <Spinner size="sm" aria-label="" />}
                {owned && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('settings.aiHandBackAria', { field: t(field.labelKey) })}
                    title={t('settings.aiHandBack')}
                    disabled={saving === field.key}
                    onClick={() => void save({ [field.key]: null } as AiSettingsPatch, field.key)}
                  >
                    <RotateCcw size={15} />
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        <SettingRow
          id="ai-timeout"
          label={t('settings.aiTimeout')}
          hint={t('settings.aiTimeoutHint')}
          value={secondsLabel(settings.timeoutSecs)}
          control={
            <Input
              type="number"
              min={10}
              max={900}
              aria-label={t('settings.aiTimeoutAria')}
              defaultValue={String(settings.timeoutSecs)}
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n) && n !== settings.timeoutSecs) void save({ timeoutSecs: n }, 'timeoutSecs');
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title={t('settings.aiUsesTitle')}
        description={t('settings.aiUsesDescription')}
      >
        <SettingRow
          id="ai-chat-enabled"
          label={t('settings.aiChat')}
          hint={t('settings.aiChatHint')}
          control={
            <Switch
              checked={settings.chatEnabled}
              aria-label={t('settings.aiChat')}
              onCheckedChange={(v) => void save({ chatEnabled: v }, 'chatEnabled')}
            />
          }
        />
        <SettingRow
          id="dj-voice"
          label={t('settings.djVoice')}
          hint={t('settings.djVoiceHint')}
          control={
            <Switch
              checked={voiceOn}
              aria-label={t('settings.djVoice')}
              onCheckedChange={(v) => {
                setDjVoice(v);
                setVoiceOn(v);
              }}
            />
          }
        />
        <SettingRow
          id="dj-voice-character"
          label={t('settings.djVoiceCharacter')}
          hint={
            voices.some((v) => v.category === 'cloned')
              ? t('settings.djVoiceCharacterHintCloned')
              : t('settings.djVoiceCharacterHint')
          }
          control={
            <Select
              fullWidth
              value={settings.djVoiceId ?? voiceNow ?? DEFAULT_DJ_VOICE}
              aria-label={t('settings.djVoiceCharacter')}
              options={voiceOptions(voices, t)}
              onValueChange={(v) => void save({ djVoiceId: v }, 'djVoiceId')}
            />
          }
        />
        <SettingRow
          id="date-voice"
          label={t('settings.dateBriefing')}
          hint={t('settings.dateBriefingHint')}
          control={
            <Switch
              checked={dateVoiceOn}
              aria-label={t('settings.dateBriefing')}
              onCheckedChange={(v) => {
                setDateVoice(v);
                setDateVoiceOn(v);
              }}
            />
          }
        />
        <SettingRow
          id="ai-embeddings-enabled"
          label={t('settings.aiEmbeddings')}
          hint={t('settings.aiEmbeddingsHint')}
          control={
            <Switch
              checked={settings.embeddingsEnabled}
              aria-label={t('settings.aiEmbeddings')}
              onCheckedChange={(v) => void save({ embeddingsEnabled: v }, 'embeddingsEnabled')}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title={t('settings.aiHealth')}
        description={t('settings.aiHealthDescription')}
      >
        <div className="localAi__health" data-state={health ? (health.reachable ? 'ok' : 'bad') : 'unknown'}>
          <span className="localAi__healthMark" aria-hidden>
            {health ? (health.reachable ? <CircleCheck size={18} /> : <CircleX size={18} />) : <Activity size={18} />}
          </span>
          <div className="localAi__healthText">
            <Text weight="medium" size="sm">
              {health
                ? health.reachable
                  ? t('settings.aiHealthOk')
                  : t('settings.aiHealthBad')
                : t('settings.aiHealthUnknown')}
            </Text>
            <Text tone="muted" size="xs">
              {health?.error
                ? health.error
                : health?.reachable
                  ? t('settings.aiHealthDetail', {
                      ms: msLabel(health.latencyMs ?? 0),
                      count: health.models.length,
                    })
                  : t('settings.aiHealthIdle')}
            </Text>
          </div>
          <Button size="sm" variant="soft" disabled={probing} onClick={() => void probe()}>
            {probing ? <Spinner size="sm" /> : t('settings.aiCheckNow')}
          </Button>
        </div>
        {health?.reachable && health.models.length > 0 && (
          <div className="localAi__models">
            {health.models.map((m) => {
              // The useful reading is not the list - it is whether what you
              // NAMED is on it. A typo in a model tag otherwise shows up much
              // later as a feature that quietly never runs.
              // Compared by TAG-INSENSITIVE name. Ollama reports its default
              // tag explicitly - `nomic-embed-text:latest` - while the setting
              // that names it is almost always written bare, so an exact match
              // marked the embedding model unused on a server that was
              // embedding with it at that moment.
              const used = [
                settings.chatModel,
                settings.embedModel,
                settings.fastModel,
                settings.refinementModel,
              ].some((named) => sameModel(named, m));
              return (
                <Pill key={m} size="sm" variant={used ? 'solid' : 'soft'} tone={used ? 'accent' : 'neutral'}>{m}</Pill>
              );
            })}
          </div>
        )}
      </PaneSection>

      <PaneSection
        title={t('settings.aiFunctions')}
        description={t('settings.aiCountedSince', {
          when: formatAgo(Date.now() - totals.sinceBoot * 1000),
        })}
      >
        {functions.map((fn) => (
          <SettingRow
            key={fn.id}
            id={`ai-fn-${fn.id}`}
            icon={fn.uses === 'embed' ? <Zap size={16} /> : <Bot size={16} />}
            label={fn.label}
            // One entry rather than two joined here: the separator sits
            // BETWEEN two translated halves, and which half leads is the
            // translator's call in an RTL line.
            hint={t('settings.aiFnHint', {
              model: fn.model ?? t('settings.aiNoModel'),
              activity: activity(fn, t),
            })}
            value={
              fn.calls === 0 ? (
                <Text tone="muted" size="xs">—</Text>
              ) : (
                <span className="localAi__fnStat" data-bad={fn.failures > 0 || fn.lastOk === false ? '' : undefined}>
                  {fn.avgMs != null && (
                    <span>{fn.avgMs < 1000 ? msLabel(fn.avgMs) : secondsLabel(fn.avgMs / 1000, 1)}</span>
                  )}
                  {fn.failures > 0 && (
                    <span className="localAi__fnFail">
                      {t('settings.aiFailedCount', { count: fn.failures })}
                    </span>
                  )}
                </span>
              )
            }
          />
        ))}
        {totals.calls > 0 && (
          <Text tone="muted" size="xs">
            {totals.avgMs != null
              ? t('settings.aiTotalsWithAverage', {
                  calls: totals.calls,
                  failures: totals.failures,
                  average: secondsLabel(totals.avgMs / 1000, 1),
                })
              : t('settings.aiTotals', { calls: totals.calls, failures: totals.failures })}
          </Text>
        )}
        {/*
          * The pane names functions by the schema id each one passes when it
          * calls the model. When a prompt is renamed or versioned and this list
          * is not, its row reads "never run" forever while the work carries on -
          * which is exactly what happened to three of them. Anything recorded
          * under an unknown id is shown here rather than dropped, so the next
          * drift is visible instead of silent.
          */}
        {(totals.unattributed?.length ?? 0) > 0 && (
          <Text size="sm" className="localAi__drift">
            {t('settings.aiDrift', { ids: totals.unattributed?.map((u) => u.id).join(', ') })}
          </Text>
        )}
      </PaneSection>
      </>
      )}

      {chunk === 'taste' && <TastePage report={report} />}

      {chunk === 'activity' && (
      <PaneSection
        title={t('settings.aiActivityTitle')}
        description={t('settings.aiActivityDescription')}
        footer={
          pages.length > 0 && (shown.length > 0) && (page > 0 || more) ? (
            <div className="localAi__pager">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((n) => Math.max(0, n - 1))}
              >
                <ArrowLeft size={14} /> {t('settings.aiNewer')}
              </Button>
              <Text tone="muted" size="xs">
                {/* No total. The log is bounded and always being written to, so
                    "page 2 of 9" would be a number that changes while it is
                    read; where you are is honest, how much is left is not. */}
                {t('settings.aiPage', { page: page + 1 })}
              </Text>
              <Button
                size="sm"
                variant="ghost"
                disabled={paging || (page + 1 >= pages.length && !more)}
                onClick={() => void older()}
              >
                {paging ? <Spinner size="sm" /> : <>{t('settings.aiOlder')} <ArrowRight size={14} /></>}
              </Button>
            </div>
          ) : undefined
        }
      >
        {shown.length === 0 ? (
          <Text tone="muted" size="sm">{t('settings.aiNothingYet')}</Text>
        ) : (
          <ol className="localAi__feed">
            {shown.map((ev) => (
              <li key={ev.id} className="localAi__event" data-state={ev.state}>
                <span className="localAi__eventDot" aria-hidden />
                <div className="localAi__eventText">
                  <Text size="sm">{ev.title}</Text>
                  <Text tone="muted" size="xs">{ev.body}</Text>
                </div>
                <Text tone="muted" size="xs">{ago(ev.at, t)}</Text>
              </li>
            ))}
          </ol>
        )}
      </PaneSection>
      )}
    </div>
  );
}

/**
 * The Taste page: the machine's reading of the last three weeks, shown back.
 *
 * Everything here is measured - shares of listening weight, median tempo, mean
 * energy, the controlled mood words, the actual songs each mood is made of.
 * The one model-authored part is the names, and the page says where they came
 * from by showing the tags underneath. This replaces the old "The curator"
 * rows (phase, last pass, halves), which told an owner what the LOOP was doing
 * but nothing about what it had learned.
 */
function TastePage({ report }: { report: AiReport }) {
  const t = useT();
  const mood = report.mood ?? null;
  const curator = report.curator;

  // UTC quarter-days shifted into this device's clock, coarsely - the buckets
  // are six hours wide, so the shift rounds to the nearest bucket.
  // Keys, not words: this is inside a component, but the four names read out
  // as one phrase ("mostly evenings") and belong in the catalogue beside it.
  const bucketKeys = [
    'settings.aiWhenNights',
    'settings.aiWhenMornings',
    'settings.aiWhenAfternoons',
    'settings.aiWhenEvenings',
  ];
  const shift = Math.round(-new Date().getTimezoneOffset() / 60 / 6);
  const whenLabel = (hours: [number, number, number, number]) => {
    let best = 0;
    for (let i = 1; i < 4; i++) if (hours[i]! > hours[best]!) best = i;
    const local = (((best + shift) % 4) + 4) % 4;
    return t(bucketKeys[local]!);
  };

  const TONES = ['accent', 'success', 'warning', 'danger'] as const;

  return (
    <PaneSection
      title={t('settings.aiTasteTitle')}
      description={t('settings.aiTasteDescription')}
    >
      {/*
        * .aiTaste, because .setk__card carries NO padding of its own - the
        * rows every other section fills it with bring theirs - and clips at
        * its rounded corners. Bare content laid straight in sat flush against
        * the card edge, and the share bar's rounded ends were shaved off by
        * the corner radius.
        */}
      <div className="aiTaste" data-setting="ai-taste">
        {report.mood === undefined ? (
          // The field itself is absent: a hub from before moods existed. Saying
          // "play more" would be a lie with a wrong fix attached.
          <Text tone="muted" size="sm">
            {t('settings.aiMoodsUnsupported')}
          </Text>
        ) : !mood ? (
          <Text tone="muted" size="sm">
            {t('settings.aiMoodsNotEnough')}
          </Text>
        ) : (
          <>
            <SegmentedBar
              size="md"
              rounded
              aria-label={t('settings.aiMoodShareAria')}
              data={mood.clusters.map((c, i) => ({
                value: Math.max(0.01, c.share),
                tone: TONES[i % TONES.length],
                label: c.name,
              }))}
            />
            <div className="aiMoods">
              {mood.clusters.map((c, i) => (
                <div key={c.name + i} className="aiMood">
                  <div className="aiMood__head">
                    <Text weight="medium">{c.name}</Text>
                    <Text tone="muted" size="xs">
                      {formatNumber(c.share, { style: 'percent' })}
                    </Text>
                  </div>
                  {c.blurb && (
                    <Text tone="muted" size="sm">
                      {c.blurb}
                    </Text>
                  )}
                  <Text tone="muted" size="xs">
                    {[
                      c.bpm != null ? t('settings.aiMoodBpm', { bpm: Math.round(c.bpm) }) : null,
                      c.energy != null
                        ? t('settings.aiMoodEnergy', {
                            value: formatNumber(c.energy, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }),
                          })
                        : null,
                      t('settings.aiMoodMostly', { when: whenLabel(c.hours) }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  <div className="aiMood__tags">
                    {c.tags.map((t) => (
                      <Pill key={t} size="sm" variant="soft" tone="neutral">
                        {t}
                      </Pill>
                    ))}
                  </div>
                  {c.exemplars.length > 0 && (
                    <Text tone="muted" size="xs">
                      {t('settings.aiMoodExamples', { list: c.exemplars.join(' · ') })}
                    </Text>
                  )}
                </div>
              ))}
            </div>
            <Text tone="muted" size="xs">
              {t('settings.aiMoodEvidence', {
                count: mood.evidence,
                n: formatNumber(mood.evidence),
              })}
            </Text>
          </>
        )}
        {curator && (
          <Text tone="muted" size="xs">
            {curator.lastCurated
              ? t('settings.aiLoopPhaseWithPass', {
                  phase: curator.phase || t('settings.aiLoopIdle'),
                  when: ago(Math.floor(curator.lastCurated / 1000), t),
                })
              : t('settings.aiLoopPhase', { phase: curator.phase || t('settings.aiLoopIdle') })}
          </Text>
        )}
      </div>
    </PaneSection>
  );
}

/** The rail row's second line, for SettingsModal. */
export function localAiSummary(t: Translate): string {
  return t('settings.summaryLocalAi');
}
