import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Pill,
  Button,
  Input,
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
  CloudDownload,
  Compass,
  HeartHandshake,
  Hourglass,
  Play,
  RotateCcw,
  Shuffle,
  Sparkles,
  Zap,
} from '@glacier/icons';
import { IconTile, PaneSection, SettingRow, SettingsCallout, SettingsEmpty } from './kit/settingsKit.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchAiActivity, fetchAiReport, probeAi, runAi, setAiSettings } from '../api/ai.ts';
import type { AiHealth, AiReport, AiRunWhat, AiSettingsPatch } from '../api/ai.ts';
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

/** Fields that are a plain line of text, in the order they read. */
const TEXT_FIELDS = [
  {
    key: 'url' as const,
    label: 'Endpoint',
    hint: 'The origin only — the server appends /v1/chat/completions itself.',
    placeholder: 'http://127.0.0.1:11434',
  },
  {
    key: 'chatModel' as const,
    label: 'Chat model',
    hint: 'Writes playlist names and the DJ’s analysis. Not defaulted on purpose — a guess costs every cycle a timeout.',
    placeholder: 'qwen3.5:9b',
  },
  {
    key: 'embedModel' as const,
    label: 'Embedding model',
    hint: 'Reads lyrics into vectors. The half that drives recommendations.',
    placeholder: 'nomic-embed-text',
  },
  {
    key: 'fastModel' as const,
    label: 'Fast profile model',
    hint: 'The first pass over a new song. Small and quick — it runs on everything.',
    placeholder: 'qwen3.5:9b',
  },
  {
    key: 'refinementModel' as const,
    label: 'Audit model',
    hint: 'Removes what the evidence does not support. Bigger and slower on purpose.',
    placeholder: 'gemma4:12b',
  },
];

function ago(seconds: number | null): string {
  if (!seconds) return 'never';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
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
const ACTIONS: {
  what: AiRunWhat;
  label: string;
  patience: string;
  icon: ReactNode;
}[] = [
  {
    what: 'discover',
    label: 'Find me new music',
    patience: 'Looks for artists around what you play, then listens to what it finds. A minute or two.',
    icon: <Compass size={20} />,
  },
  {
    what: 'mix',
    label: 'Make me a new mix',
    patience: 'Rereads your last month and rebuilds the mixes on your home screen.',
    icon: <Shuffle size={20} />,
  },
  {
    what: 'dates',
    label: 'Top up Music Date',
    patience: 'Finds something you do not own and asks for it. The card appears once it has downloaded.',
    icon: <HeartHandshake size={20} />,
  },
  {
    what: 'curate',
    label: 'Full pass',
    patience: 'Everything at once: reads the library, rebuilds the lists, looks for more. The long one.',
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
function activity(fn: { calls: number; lastAt: number | null; everAt: number | null }): string {
  if (fn.calls > 0) {
    return `${fn.calls} call${fn.calls === 1 ? '' : 's'}, ${ago(fn.lastAt)}`;
  }
  if (fn.everAt) return `last used ${ago(fn.everAt)}, before this restart`;
  return 'never run';
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

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
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
export function LocalAiPane() {
  const { session } = useServerSession();
  const { toast } = useToast();
  const [report, setReport] = useState<AiReport | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [running, setRunning] = useState(false);
  // What is in the boxes, which is not what is saved until it is. Keyed by
  // field so a save in flight on one does not blank another being typed in.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
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

  useEffect(() => () => { alive.current = false; }, []);

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
      else setError(e instanceof Error ? e.message : 'Could not read the report.');
    }
  }, [session]);

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
      toast({ message: `Could not save — ${e instanceof Error ? e.message : 'the server refused it'}`, tone: 'danger' });
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
          error: e instanceof Error ? e.message : 'The check failed.' });
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
      toast({ message: `${label} — follow it below` });
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
      if (status === 409) toast({ message: 'Already working on something — one at a time' });
      else if (status === 400) {
        toast({ message: 'This server is too old for that one — rebuild the hub', tone: 'danger' });
      } else {
        toast({ message: `Could not start it — ${e instanceof Error ? e.message : 'the server refused it'}`, tone: 'danger' });
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
          title="This server does not have Local AI settings yet"
          body="The app updates over the air and the server does not. Rebuild the hub and this pane fills in."
        />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="prefsBody localAiPane">
        {error ? (
          <SettingsCallout tone="danger" action={<Button size="sm" variant="soft" onClick={() => void load()}>Try again</Button>}>
            {error}
          </SettingsCallout>
        ) : (
          <div className="localAi__loading"><Spinner /> <Text tone="muted" size="sm">Reading the report…</Text></div>
        )}
      </div>
    );
  }

  const { settings, functions, totals, curator } = report;
  const configured = !!settings.url && !!settings.chatModel;
  const shown = pages[page] ?? [];

  return (
    <div className="prefsBody localAiPane">
      <PaneSection
        title="Ask for something"
        description="Each of these already runs on its own schedule. This is the door to doing it now."
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
                onClick={() => void start(a.what, a.label)}
              >
                <IconTile variant="accent" size="lg">{a.icon}</IconTile>
                <span className="aiAction__label">{a.label}</span>
                <span className="aiAction__patience">{a.patience}</span>
              </button>
            ))}
          </div>
        )}
        {!configured && (
          <Text tone="muted" size="sm">
            Name an endpoint and a chat model below to switch these on.
          </Text>
        )}
      </PaneSection>

      <PaneSection
        title="Endpoint"
        description="Usually Ollama, on this machine or your network. Nothing here leaves it."
      >
        {!configured && (
          <SettingsCallout tone="accent" icon={<Bot size={16} />}>
            No model is configured, so the curator runs on tempo and genre alone. Point this at an
            endpoint and name a chat model to switch the rest on.
          </SettingsCallout>
        )}

        {TEXT_FIELDS.map((field) => {
          const saved = settings[field.key] ?? '';
          const owned = settings.overrides[field.key] === true;
          const fromEnv = settings.envDefaults[field.key];
          const shown = draft[field.key] ?? saved;
          const dirty = draft[field.key] !== undefined && draft[field.key] !== saved;
          return (
            <div className="localAi__field" key={field.key} data-setting={`ai-${field.key}`}>
              <div className="localAi__fieldHead">
                <Text weight="medium" size="sm">{field.label}</Text>
                {owned ? (
                  <Pill size="sm" variant="soft" tone="accent">Set here</Pill>
                ) : fromEnv ? (
                  <Pill size="sm" variant="soft" tone="neutral">From the server’s environment</Pill>
                ) : null}
              </div>
              <Text tone="muted" size="xs">{field.hint}</Text>
              <div className="localAi__fieldRow">
                <Input
                  value={shown}
                  placeholder={String(fromEnv ?? field.placeholder)}
                  spellCheck={false}
                  autoCapitalize="off"
                  aria-label={field.label}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.currentTarget.value }))}
                />
                <Button
                  size="sm"
                  variant="soft"
                  disabled={!dirty || saving === field.key}
                  onClick={() => void save({ [field.key]: draft[field.key] } as AiSettingsPatch, field.key)}
                >
                  {saving === field.key ? <Spinner size="sm" /> : 'Save'}
                </Button>
                {owned && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Hand ${field.label} back to the environment`}
                    title="Hand this back to the server’s environment"
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
          label="Request timeout"
          hint="How long one model call may take. A big model on a CPU-only box legitimately needs minutes."
          value={`${settings.timeoutSecs}s`}
          control={
            <Input
              type="number"
              min={10}
              max={900}
              aria-label="Request timeout in seconds"
              defaultValue={String(settings.timeoutSecs)}
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n) && n !== settings.timeoutSecs) void save({ timeoutSecs: n }, 'timeoutSecs');
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title="What the model is used for" description="Turn a half off and whatever needs it stands down cleanly.">
        <SettingRow
          id="ai-chat-enabled"
          label="Chat"
          hint="Playlist names, song profiles, the DJ’s analysis."
          control={
            <Switch
              checked={settings.chatEnabled}
              aria-label="Chat"
              onCheckedChange={(v) => void save({ chatEnabled: v }, 'chatEnabled')}
            />
          }
        />
        <SettingRow
          id="ai-embeddings-enabled"
          label="Embeddings"
          hint="Lyric and descriptor vectors — the half the recommendations actually run on."
          control={
            <Switch
              checked={settings.embeddingsEnabled}
              aria-label="Embeddings"
              onCheckedChange={(v) => void save({ embeddingsEnabled: v }, 'embeddingsEnabled')}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Health" description="Asked on demand — a cold model can take seconds to answer.">
        <div className="localAi__health" data-state={health ? (health.reachable ? 'ok' : 'bad') : 'unknown'}>
          <span className="localAi__healthMark" aria-hidden>
            {health ? (health.reachable ? <CircleCheck size={18} /> : <CircleX size={18} />) : <Activity size={18} />}
          </span>
          <div className="localAi__healthText">
            <Text weight="medium" size="sm">
              {health ? (health.reachable ? 'The endpoint answered' : 'The endpoint did not answer') : 'Not checked yet'}
            </Text>
            <Text tone="muted" size="xs">
              {health?.error
                ? health.error
                : health?.reachable
                  ? `${health.latencyMs}ms · ${health.models.length} model${health.models.length === 1 ? '' : 's'} available`
                  : 'Nothing is asked of the model until you press the button.'}
            </Text>
          </div>
          <Button size="sm" variant="soft" disabled={probing} onClick={() => void probe()}>
            {probing ? <Spinner size="sm" /> : 'Check now'}
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
        title="Functions"
        description={`Counted since the server started, ${duration(totals.sinceBoot)} ago.`}
      >
        {functions.map((fn) => (
          <SettingRow
            key={fn.id}
            id={`ai-fn-${fn.id}`}
            icon={fn.uses === 'embed' ? <Zap size={16} /> : <Bot size={16} />}
            label={fn.label}
            hint={`${fn.model ?? 'no model'} · ${activity(fn)}`}
            value={
              fn.calls === 0 ? (
                <Text tone="muted" size="xs">—</Text>
              ) : (
                <span className="localAi__fnStat" data-bad={fn.failures > 0 || fn.lastOk === false ? '' : undefined}>
                  {fn.avgMs != null && <span>{fn.avgMs < 1000 ? `${fn.avgMs}ms` : `${(fn.avgMs / 1000).toFixed(1)}s`}</span>}
                  {fn.failures > 0 && <span className="localAi__fnFail">{fn.failures} failed</span>}
                </span>
              )
            }
          />
        ))}
        {totals.calls > 0 && (
          <Text tone="muted" size="xs">
            {totals.calls} calls, {totals.failures} failed
            {totals.avgMs != null ? `, ${(totals.avgMs / 1000).toFixed(1)}s average` : ''}.
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
            Work recorded under {totals.unattributed?.map((u) => u.id).join(', ')}, which no
            function above claims — the list of names has drifted from the code.
          </Text>
        )}
      </PaneSection>

      <PaneSection
        title="The curator"
        description="The loop that listens to the library. It stands down while anybody is playing."
        footer={
          <Button
            size="sm"
            variant="soft"
            disabled={running || !configured || report.running != null}
            onClick={() => void start('curate', 'Full pass')}
          >
            {running ? <Spinner size="sm" /> : <><Play size={14} /> Run a pass now</>}
          </Button>
        }
      >
        <SettingRow id="ai-curator-phase" label="Doing" value={curator?.phase || 'idle'} />
        <SettingRow
          id="ai-curator-last"
          label="Last full pass"
          value={curator?.lastCurated ? ago(Math.floor(curator.lastCurated / 1000)) : 'never'}
        />
        <SettingRow
          id="ai-curator-halves"
          label="Halves in play"
          hint="Embeddings drive the recommendations; chat writes the words. A server can do the first without ever doing the second."
          value={[curator?.embeddings ? 'embeddings' : null, curator?.chat ? 'chat' : null].filter(Boolean).join(' + ') || 'neither'}
        />
      </PaneSection>

      <PaneSection
        title="Recent activity"
        description="What the model has been doing, newest first."
        footer={
          pages.length > 0 && (shown.length > 0) && (page > 0 || more) ? (
            <div className="localAi__pager">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((n) => Math.max(0, n - 1))}
              >
                <ArrowLeft size={14} /> Newer
              </Button>
              <Text tone="muted" size="xs">
                {/* No total. The log is bounded and always being written to, so
                    "page 2 of 9" would be a number that changes while it is
                    read; where you are is honest, how much is left is not. */}
                Page {page + 1}
              </Text>
              <Button
                size="sm"
                variant="ghost"
                disabled={paging || (page + 1 >= pages.length && !more)}
                onClick={() => void older()}
              >
                {paging ? <Spinner size="sm" /> : <>Older <ArrowRight size={14} /></>}
              </Button>
            </div>
          ) : undefined
        }
      >
        {shown.length === 0 ? (
          <Text tone="muted" size="sm">Nothing yet.</Text>
        ) : (
          <ol className="localAi__feed">
            {shown.map((ev) => (
              <li key={ev.id} className="localAi__event" data-state={ev.state}>
                <span className="localAi__eventDot" aria-hidden />
                <div className="localAi__eventText">
                  <Text size="sm">{ev.title}</Text>
                  <Text tone="muted" size="xs">{ev.body}</Text>
                </div>
                <Text tone="muted" size="xs">{ago(ev.at)}</Text>
              </li>
            ))}
          </ol>
        )}
      </PaneSection>
    </div>
  );
}

/** The rail row's second line, for SettingsModal. */
export function localAiSummary(): string {
  return 'Model, health and what it has been doing';
}
