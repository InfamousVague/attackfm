import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pill,
  Button,
  Input,
  Spinner,
  Switch,
  Text,
  useToast,
} from '@glacier/react';
import { Activity, Bot, CircleCheck, CircleX, Play, RotateCcw, Zap } from 'lucide-react';
import { PaneSection, SettingRow, SettingsCallout, SettingsEmpty } from './kit/settingsKit.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchAiReport, probeAi, runAi, setAiSettings } from '../api/ai.ts';
import type { AiHealth, AiReport, AiSettingsPatch } from '../api/ai.ts';
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
    hint: 'Writes playlist names and the DJ’s analysis. Deliberately not defaulted: assuming one means every cycle waits out a timeout against a model nobody pulled.',
    placeholder: 'qwen3.5:9b',
  },
  {
    key: 'embedModel' as const,
    label: 'Embedding model',
    hint: 'Reads lyrics and descriptors into vectors. This is the half that actually drives recommendations.',
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
    hint: 'Goes back over a profile and removes what the evidence does not support. Bigger and slower on purpose.',
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

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

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
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const next = await fetchAiReport(session);
      if (!alive.current) return;
      setReport(next);
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

  const curateNow = async () => {
    if (!session) return;
    setRunning(true);
    try {
      await runAi(session, 'curate');
      toast({ message: 'Curation pass started — it reports into Recent activity below' });
      // Not awaited to completion - the pass runs for minutes on the server and
      // reports through the feed. One refresh a beat later picks up the start.
      window.setTimeout(() => { void load(); }, 1500);
    } catch (e) {
      toast({ message: `Could not start it — ${e instanceof Error ? e.message : 'the server refused it'}`, tone: 'danger' });
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

  return (
    <div className="prefsBody localAiPane">
      <PaneSection
        title="Endpoint"
        description="An OpenAI-compatible server, usually Ollama, on this machine or your network. Nothing here leaves it."
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

      <PaneSection title="What the model is used for" description="Turn a half off and the features that need it stand down cleanly rather than waiting out timeouts.">
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

      <PaneSection title="Health" description="Asked on demand, not on the way in — a cold model can take seconds to answer and this pane should not.">
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
              const used = [settings.chatModel, settings.embedModel, settings.fastModel, settings.refinementModel].includes(m);
              return (
                <Pill key={m} size="sm" variant={used ? 'solid' : 'soft'} tone={used ? 'accent' : 'neutral'}>{m}</Pill>
              );
            })}
          </div>
        )}
      </PaneSection>

      <PaneSection
        title="Functions"
        description={`Since the server last started — ${duration(totals.sinceBoot)} ago. Live readings, not a lifetime average: a box that was healthy for a month should not hide an endpoint failing this morning.`}
      >
        {functions.map((fn) => (
          <SettingRow
            key={fn.id}
            id={`ai-fn-${fn.id}`}
            icon={fn.uses === 'embed' ? <Zap size={16} /> : <Bot size={16} />}
            label={fn.label}
            hint={`${fn.model ?? 'no model'}${fn.calls ? ` · ${fn.calls} call${fn.calls === 1 ? '' : 's'}, ${ago(fn.lastAt)}` : ' · never run'}`}
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
      </PaneSection>

      <PaneSection
        title="The curator"
        description="The loop that listens to the library. It stands down whenever anybody is playing, which is why a pass can sit unfinished for a long time on a busy hub."
        footer={
          <Button size="sm" variant="soft" disabled={running || !configured} onClick={() => void curateNow()}>
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

      <PaneSection title="Recent activity" description="What the model has been doing, newest first.">
        {report.recent.length === 0 ? (
          <Text tone="muted" size="sm">Nothing yet.</Text>
        ) : (
          <ol className="localAi__feed">
            {report.recent.map((ev) => (
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
