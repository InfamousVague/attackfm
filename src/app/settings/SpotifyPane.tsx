import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Pill, Spinner, Switch, useToast } from '@glacier/react';
import { CircleCheck, CircleX, RotateCcw } from 'lucide-react';
import { PaneSection, SettingRow, SettingsCallout } from './kit/settingsKit.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchAiReport, resweepCanvases, setAiSettings } from '../api/ai.ts';
import type { AiSettings } from '../api/ai.ts';

/**
 * Spotify - the owner's pane for the one thing this server needs from Spotify:
 * a session cookie, so songs can wear their Canvas.
 *
 * WHY THIS PANE EXISTS. The cookie used to be an environment variable and
 * nothing else, which meant it lived in whatever launched the process. Rebuild
 * the box, move it, or re-run the installer and it is gone - silently, because
 * a server with no cookie behaves exactly like a library of songs that happen
 * to have no Canvas. That is precisely what happened here: the box moved, the
 * unit file was reinstalled from the template that never carried it, and every
 * card in the app quietly fell back to a stand-in loop.
 *
 * Kept in the database now, which is the thing that survives a redeploy - and
 * settable from here, which is the thing that survives not remembering.
 *
 * THE COOKIE IS WRITE-ONLY. It is a live session credential for the owner's
 * Spotify account, so there is no read path for it anywhere on the server: this
 * pane is told whether one is set and never what it is. Replacing it means
 * pasting a new one; there is nothing to reveal.
 */
export function SpotifyPane() {
  const { session } = useServerSession();
  const { toast } = useToast();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const report = await fetchAiReport(session);
      setSettings(report.settings);
    } catch {
      // A hub that will not answer leaves the pane empty rather than shouting;
      // every control below is disabled without settings anyway.
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) return null;

  const save = async (patch: Parameters<typeof setAiSettings>[1], which: string) => {
    setBusy(which);
    try {
      const next = await setAiSettings(session, patch);
      setSettings(next);
      if (which === 'cookie') setCookie('');
      toast({ message: 'Saved', tone: 'success' });
    } catch (e) {
      toast({
        message: `Could not save — ${e instanceof Error ? e.message : 'the server refused it'}`,
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  };

  const linked = settings?.spotifyCookieSet === true;

  return (
    <div className="settingsPane">
      <PaneSection
        title="Canvas"
        description="The short looping clip some songs carry. Spotify only serves it to a signed-in session, so this server needs a cookie from yours."
        footer={
          linked
            ? 'Clips are kept beside their songs, so they survive a restart and keep working if the cookie later expires.'
            : 'Without a cookie every song falls back to its cover.'
        }
      >
        <SettingRow
          id="spotify-cookie"
          label="Spotify session cookie"
          hint={
            linked
              ? 'A cookie is set. Paste a new one to replace it — it is never shown back, because it is a live login to your Spotify account.'
              : 'In a browser signed in to Spotify: DevTools → Application → Cookies → open.spotify.com → copy the value of sp_dc.'
          }
          layout="stacked"
          control={
            <div className="settingsPane__inline">
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
                variant="soft"
                disabled={!cookie.trim() || busy != null}
                onClick={() => void save({ spotifyCookie: cookie.trim() }, 'cookie')}
              >
                {busy === 'cookie' ? <Spinner size="sm" aria-label="" /> : 'Save'}
              </Button>
              {linked && (
                <Button
                  variant="ghost"
                  disabled={busy != null}
                  onClick={() => void save({ spotifyCookie: null }, 'clear')}
                >
                  Forget
                </Button>
              )}
            </div>
          }
        />

        <SettingRow
          id="spotify-canvas-status"
          label="Status"
          hint="Whether this server can ask Spotify for clips at all."
          control={
            <Pill tone={linked ? 'success' : 'neutral'}>
              {linked ? <CircleCheck size={13} /> : <CircleX size={13} />}
              {linked ? 'Cookie set' : 'No cookie'}
            </Pill>
          }
        />

        <SettingRow
          id="canvas-stock"
          label="Stand-in loops"
          hint="When a song has no Canvas, play one of five shipped clips instead of showing its cover. Off by default: the cover is the thing about that record."
          control={
            <Switch
              checked={settings?.canvasStock === true}
              disabled={busy != null || !settings}
              onCheckedChange={(v) => void save({ canvasStock: v }, 'stock')}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title="Re-fetch"
        description="Clips are collected in the background, most recently played first, and a song Spotify has none for is remembered so it is not asked about again for a month."
        // The closing note goes in the section's own footer slot rather than
        // trailing after the rows: a bare Text child sits outside the card's
        // padding and runs into the edge.
        footer="A big library takes a day of uptime: every step is a request carrying your own cookie, and asking as fast as the network allows is how a cookie stops working."
      >
        {!linked && (
          <SettingsCallout tone="warning">
            Nothing to sweep until a cookie is set — every lookup would be refused.
          </SettingsCallout>
        )}
        <SettingRow
          id="canvas-resweep"
          label="Look again for every song"
          hint="Forgets every “this one has none” answer and starts over. The clips already kept are not touched — only the noes, which are what is worth re-asking after a cookie changes or a library moves."
          control={
            <Button
              variant="soft"
              disabled={!linked || busy != null}
              onClick={async () => {
                setBusy('resweep');
                try {
                  const out = await resweepCanvases(session);
                  toast({
                    message: `Sweeping again — forgot ${out.forgotten} old answer${out.forgotten === 1 ? '' : 's'}.`,
                    tone: 'success',
                  });
                } catch (e) {
                  toast({
                    message: `Could not start — ${e instanceof Error ? e.message : 'the server refused it'}`,
                    tone: 'danger',
                  });
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'resweep' ? <Spinner size="sm" aria-label="" /> : <RotateCcw size={14} />}
              Sweep again
            </Button>
          }
        />
      </PaneSection>
    </div>
  );
}
