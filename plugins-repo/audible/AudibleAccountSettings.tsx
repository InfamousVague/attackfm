import { Button, Field, Input, Label, Select, Spinner, Text } from '@glacier/react';
import { Check, ExternalLink, Unplug } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from '@attackfm/app/serverSession';
import { openExternal } from '@attackfm/app/openExternal';
import {
  audibleLoginComplete,
  audibleLoginStart,
  audibleLogout,
  audibleStatus,
  MissingEndpointError,
  type AudibleStatus,
} from './audibleAccount.ts';

/**
 * The Audible tab: connect the owner's account to the hub, in the one way that
 * keeps a password off our server entirely. The sign-in happens on Amazon's own
 * page; Amazon then bounces the browser to a page that will not load, and its
 * URL - carrying a one-time code, not a password - is what the user pastes back.
 * The server turns that into device tokens. So this pane is a two-step door:
 * open the sign-in, then take the URL it left you on.
 */

/**
 * What Amazon leaves you on: the maplanding page, carrying a one-time
 * authorization code. Checked here because the server can only try a pasted URL
 * ONCE - handing it to the waiting login child consumes the whole session,
 * wrong URL or right - so a paste that obviously is not it should never cost
 * the sign-in.
 */
function looksLikeResponseUrl(url: string): boolean {
  return /openid\.oa2\.authorization_code=/.test(url);
}

/** Audible's regional stores; an account belongs to exactly one. */
const MARKETPLACES = [
  { value: 'us', label: 'United States (.com)' },
  { value: 'uk', label: 'United Kingdom (.co.uk)' },
  { value: 'ca', label: 'Canada (.ca)' },
  { value: 'au', label: 'Australia (.com.au)' },
  { value: 'de', label: 'Germany (.de)' },
  { value: 'fr', label: 'France (.fr)' },
  { value: 'it', label: 'Italy (.it)' },
  { value: 'es', label: 'Spain (.es)' },
  { value: 'jp', label: 'Japan (.co.jp)' },
  { value: 'in', label: 'India (.in)' },
  { value: 'br', label: 'Brazil (.com.br)' },
];

export function AudibleAccountSettings() {
  const { session } = useServerSession();
  const [status, setStatus] = useState<AudibleStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [locale, setLocale] = useState('us');
  // The parked login: once started, we hold its token and wait for the paste.
  const [login, setLogin] = useState<{ token: string; locale: string } | null>(null);
  const [responseUrl, setResponseUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      setStatus(await audibleStatus(session));
      setMissing(false);
    } catch (e) {
      if (e instanceof MissingEndpointError) setMissing(true);
    } finally {
      setLoaded(true);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Step one: ask the server to start a login, then hand its URL to Amazon. */
  const connect = async () => {
    if (!session) return;
    setConnecting(true);
    setError(null);
    try {
      const started = await audibleLoginStart(session, locale);
      setLogin({ token: started.token, locale: started.locale });
      await openExternal(started.loginUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  /** Step two: hand the pasted URL back; the server registers and stores tokens. */
  const finish = async () => {
    if (!session || !login) return;
    const url = responseUrl.trim();
    if (!url) {
      setError('Paste the URL of the page you landed on after signing in.');
      return;
    }
    if (!looksLikeResponseUrl(url)) {
      setError(
        'That does not look like the page Amazon left you on — it should be a long address ' +
          'containing “openid.oa2.authorization_code”. Copy the whole thing from the address bar.',
      );
      return;
    }
    setFinishing(true);
    setError(null);
    try {
      const done = await audibleLoginComplete(session, login.token, url, login.locale);
      setStatus({ toolsInstalled: true, connected: done.connected, name: done.name });
      setLogin(null);
      setResponseUrl('');
      // Believe the server, not this optimistic write: a connect that half
      // worked (tokens saved, name not) should read the way the next visit
      // will.
      void refresh();
    } catch (e) {
      // The parked login is spent WHATEVER went wrong - the server takes it out
      // of its store to answer at all, and kills the child with it. Staying on
      // this step would leave the Finish button holding a dead token, which is
      // why a second attempt used to fail forever with "that login has
      // expired". Go back to the door instead, and say so.
      setLogin(null);
      setResponseUrl('');
      const why = e instanceof Error ? e.message : String(e);
      setError(`${why} — start the sign-in again.`);
      void refresh();
    } finally {
      setFinishing(false);
    }
  };

  const cancelLogin = () => {
    setLogin(null);
    setResponseUrl('');
    setError(null);
  };

  const disconnect = async () => {
    if (!session) return;
    setError(null);
    try {
      await audibleLogout(session);
      setStatus((prev) => (prev ? { ...prev, connected: false, name: null } : prev));
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Audible downloads run on your server — connect one under Settings → Server first.
        </Text>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="prefsBody">
        <Spinner />
      </div>
    );
  }

  // No tools on the hub: a plain instruction, not a dead button.
  if (missing || (status && !status.toolsInstalled)) {
    return (
      <div className="prefsBody">
        <div className="prefsSection">
          <Label>Audible</Label>
          <Text tone="muted" size="sm">
            Your hub doesn’t have the Audible tools yet. On the server, run{' '}
            <code>pipx install audible-cli</code> (ffmpeg is already required), then reopen this
            tab.
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {status?.connected && !login ? (
        <div className="prefsSection">
          <Label>Account</Label>
          <Text size="sm">
            Connected{status.name ? ` as ${status.name}` : ''}. Your server can download the
            books you own.
          </Text>
          <div className="prefsActions">
            <Button variant="soft" size="sm" disabled={connecting} onClick={() => void connect()}>
              {connecting ? 'Opening Amazon…' : <><ExternalLink size={15} /> Sign in again</>}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
              <Unplug size={15} /> Disconnect
            </Button>
          </div>
          <Text tone="muted" size="sm">
            Your Audible library shows up under the Books tab — anything you own can be pulled in
            with its chapters and cover. Sign in again if downloads start failing: being
            “connected” only means the hub still holds tokens, and Amazon can retire those at its
            own end without telling us.
          </Text>
        </div>
      ) : !login ? (
        <div className="prefsSection">
          <Label>Connect Audible</Label>
          <Text tone="muted" size="sm">
            Sign in with your own Audible account so your server can download the audiobooks you
            already own. You sign in on Amazon’s own page — your password never touches this app or
            your server.
          </Text>
          <Field label="Marketplace">
            <Select
              aria-label="Audible marketplace"
              fullWidth
              value={locale}
              onValueChange={setLocale}
              options={MARKETPLACES}
            />
          </Field>
          <div className="prefsActions">
            <Button variant="solid" size="sm" disabled={connecting} onClick={() => void connect()}>
              {connecting ? (
                'Opening Amazon…'
              ) : (
                <>
                  <ExternalLink size={15} /> Sign in with Amazon
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="prefsSection">
          <Label>Finish connecting</Label>
          <Text tone="muted" size="sm">
            A sign-in page opened in your browser. After you sign in, Amazon sends you to a page
            that <strong>won’t load</strong> — that’s expected. Copy that page’s full address from
            your browser’s address bar and paste it here.
          </Text>
          <Field label="The URL you landed on">
            <Input
              value={responseUrl}
              onChange={(e) => setResponseUrl(e.currentTarget.value)}
              placeholder="https://www.amazon.com/ap/maplanding?..."
              aria-label="Audible response URL"
            />
          </Field>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={finishing || !responseUrl.trim()}
              onClick={() => void finish()}
            >
              {finishing ? (
                'Connecting…'
              ) : (
                <>
                  <Check size={15} /> Finish connecting
                </>
              )}
            </Button>
            <Button variant="ghost" size="sm" disabled={finishing} onClick={cancelLogin}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <Text tone="danger" size="sm">
          {error}
        </Text>
      )}
    </div>
  );
}
