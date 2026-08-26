import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Label, Pill, Spinner, Switch, Text } from '@glacier/react';
import { useServerSession } from '@attackfm/app/serverSession';
import {
  fetchCanvasSettings,
  resweepCanvases,
  saveCanvasSettings,
  type CanvasSettings as Settings,
  type CanvasSettingsPatch,
} from './canvas.ts';

/**
 * The plugin's one tab: the cookie the server needs, and what to do when a
 * song has no clip.
 *
 * WHY A COOKIE AT ALL. Spotify serves a Canvas only to a signed-in session, so
 * the hub has to ask as somebody. It used to ask as whatever `AFM_SPOTIFY_SP_DC`
 * happened to hold, which meant the credential lived in the thing that launched
 * the process - and vanished, silently, the first time the box was rebuilt from
 * a unit file that never carried it. A server with no cookie behaves exactly
 * like a library of songs that happen to have no Canvas, so nothing announced
 * it; every card just quietly fell back to a stand-in loop. It is kept in the
 * database now, which survives a redeploy, and set from here, which survives
 * not remembering.
 */
export function CanvasSettings() {
  const { session } = useServerSession();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session?.isAdmin) return;
    try {
      setSettings(await fetchCanvasSettings(session));
    } catch {
      // A hub that will not answer leaves the pane empty rather than shouting;
      // every control below is disabled without settings anyway.
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Canvas clips are fetched by your server &mdash; connect one under Settings &rarr; Server
          first.
        </Text>
      </div>
    );
  }

  /*
   * Owner only, and the pane says so rather than hiding.
   *
   * Every route below is admin-gated on the server, so this is a courtesy, not
   * a control. An empty tab would read as a broken plugin; a sentence explains
   * why there is nothing to do here.
   */
  if (!session.isAdmin) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Canvas is configured once, on the server, by whoever owns it. Nothing to set from this
          account.
        </Text>
      </div>
    );
  }

  const save = async (patch: CanvasSettingsPatch, which: string) => {
    setBusy(which);
    setNote(null);
    try {
      setSettings(await saveCanvasSettings(session, patch));
      if (which === 'cookie') setCookie('');
      setNote({ tone: 'ok', text: 'Saved.' });
    } catch (e) {
      setNote({
        tone: 'bad',
        text: e instanceof Error ? e.message : 'The server refused it.',
      });
    } finally {
      setBusy(null);
    }
  };

  const linked = settings?.spotifyCookieSet === true;

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>Spotify session cookie</Label>
        <Text tone="muted" size="sm">
          {linked
            ? 'A cookie is set. Paste a new one to replace it. It is never shown back, because it is a live login to your Spotify account.'
            : 'In a browser signed in to Spotify: DevTools → Application → Cookies → open.spotify.com, and copy the value of sp_dc.'}
        </Text>
        <div className="prefsActions">
          <Input
            type="password"
            value={cookie}
            placeholder={linked ? 'A cookie is set — paste to replace' : 'sp_dc value'}
            aria-label="Spotify session cookie"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCookie(e.currentTarget.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!cookie.trim() || busy != null}
            onClick={() => void save({ spotifyCookie: cookie.trim() }, 'cookie')}
          >
            {busy === 'cookie' ? <Spinner size="sm" aria-label="" /> : 'Save'}
          </Button>
          {linked && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy != null}
              onClick={() => void save({ spotifyCookie: null }, 'clear')}
            >
              Forget
            </Button>
          )}
          <Pill tone={linked ? 'success' : 'neutral'}>{linked ? 'Cookie set' : 'No cookie'}</Pill>
        </div>
        {note && (
          <Text tone={note.tone === 'ok' ? 'muted' : 'danger'} size="sm">
            {note.text}
          </Text>
        )}
      </div>

      <div className="prefsSection">
        <Label>Stand-in loops</Label>
        <Text tone="muted" size="sm">
          When a song has no Canvas, play one of five shipped clips instead of showing its cover.
          Off by default: the cover is the thing about that record.
        </Text>
        <div className="prefsActions">
          <Switch
            aria-label="Stand-in loops"
            checked={settings?.canvasStock === true}
            disabled={busy != null || !settings}
            onCheckedChange={(v: boolean) => void save({ canvasStock: v }, 'stock')}
          />
        </div>
      </div>

      <div className="prefsSection">
        <Label>Look again for every song</Label>
        <Text tone="muted" size="sm">
          Clips are collected in the background, most recently played first, and a song Spotify has
          none for is remembered so it is not asked about again for a month. This forgets every one
          of those noes and starts over; the clips already kept are not touched.
        </Text>
        <Text tone="muted" size="sm">
          {linked
            ? 'A big library takes a day of uptime. Every step is a request carrying your own cookie, and asking as fast as the network allows is how a cookie stops working.'
            : 'Nothing to sweep until a cookie is set: every lookup would be refused.'}
        </Text>
        <div className="prefsActions">
          <Button
            variant="outline"
            size="sm"
            disabled={!linked || busy != null}
            onClick={async () => {
              setBusy('resweep');
              setNote(null);
              try {
                const out = await resweepCanvases(session);
                setNote({
                  tone: 'ok',
                  text: `Sweeping again. Forgot ${out.forgotten} old answer${out.forgotten === 1 ? '' : 's'}.`,
                });
              } catch (e) {
                setNote({
                  tone: 'bad',
                  text: e instanceof Error ? e.message : 'The server refused it.',
                });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'resweep' ? <Spinner size="sm" aria-label="" /> : 'Sweep again'}
          </Button>
        </div>
      </div>
    </div>
  );
}
