import { Button, Input, Label, ProgressBar, Switch, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import {
  fetchMirrorStatus,
  fetchHotSummary,
  startMirror,
  type HotBar,
  type MirrorStatus,
} from '../server.ts';
import { useServerSession } from './serverSession.tsx';
import {
  authorizeMirrorSource,
  readMirrorSource,
  revokeMirrorSource,
} from './mirrorSource.ts';
import { gbLabel } from './serverFormat.ts';
import { Trans, useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

/**
 * Copying one library into another.
 *
 * Two steps, because the app signs into one server at a time and a copy needs
 * both. While you are on the library you want to COPY FROM you authorize it,
 * which keeps its address and tokens on this device; then you sign into the
 * library you want to FILL and start the copy there. The destination does the
 * pulling, so the source needs nothing done to it - no new port, no visit.
 */
export function MirrorSection() {
  const t = useT();
  const { session } = useServerSession();
  const [source, setSource] = useState(() => readMirrorSource());
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The note carries its own tone. It used to be a bare string whose colour was
  // decided by `note.startsWith('Started')` - which is a sentence being read as
  // a flag, and the first translation would have painted every success red.
  const [note, setNote] = useState<{ tone: 'muted' | 'danger'; text: string } | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  // Carrying only the listened-to set. Default ON: a server you are filling
  // from somewhere else is nearly always the smaller box, and offering to
  // copy a library that will not fit is offering a job that ends badly.
  const [hotOnly, setHotOnly] = useState(true);
  const [hotSummary, setHotSummary] = useState<{
    bars: HotBar[];
    liked: number;
    libraryTracks: number;
  } | null>(null);
  const hotSize = hotSummary?.bars.find((b) => b.minPlays === 2) ?? null;



  // Only while something is running: a poll that never stops is a poll that
  // wakes a sleeping phone for nothing.
  useEffect(() => {
    if (!session) return;
    let live = true;
    const tick = () => {
      void fetchMirrorStatus(session)
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => {
          // An older server with no mirror endpoint: the section simply offers
          // nothing rather than showing an error nobody can act on.
          if (live) setStatus(null);
        });
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [session]);

  // Signed-out is answered AFTER the hooks, not here. An early return above a
  // useEffect is a hooks-order violation: signing out mid-open changes how many
  // hooks this component calls between renders, which is the exact crash React
  // reserves for it. `here` tolerates the null so the effect below can too.
  const here = session != null && source?.url === session.url;

  // Ask the SOURCE how big its listened-to set is, so the size is visible
  // before the copy rather than discovered during it. Best-effort: an older
  // source has no such endpoint and the switch simply describes itself.
  useEffect(() => {
    if (!session || !source || here || !hotOnly) return;
    let live = true;
    void fetchHotSummary(source)
      .then((s) => {
        if (live) setHotSummary(s);
      })
      .catch(() => {
        if (live) setHotSummary(null);
      });
    return () => {
      live = false;
    };
  }, [session, source, here, hotOnly]);
  const running = status?.running === true;

  /** "12 copied · 40 already here · 1 failed — indexing". Independent tallies
   *  joined by a middot rather than one sentence: each keeps its own plural,
   *  and the trailing note is the SERVER's word for what it is doing, passed
   *  through as it arrives. */
  const tally = (s: MirrorStatus): string => {
    const parts = [
      t('servers.mirrorCopied', { count: s.copied }),
      t('servers.mirrorSkipped', { count: s.skipped }),
    ];
    if (s.failed > 0) parts.push(t('servers.mirrorFailed', { count: s.failed }));
    const line = parts.join(' · ');
    return s.note ? `${line} — ${s.note}` : line;
  };

  if (!session) return null;

  return (
    <div className="prefsSection">
      <Label>{t('servers.mirrorTitle')}</Label>

      {/* Half one: authorize the library you are standing in as a source. */}
      <Text tone="muted" size="sm">
        {here ? t('servers.mirrorSourceReady') : t('servers.mirrorAuthorizeHint')}
      </Text>
      <div className="prefsActions">
        <Button
          variant={here ? 'ghost' : 'soft'}
          size="sm"
          onClick={() => setSource(authorizeMirrorSource(session, session.url))}
        >
          {here ? t('servers.mirrorReauthorize') : t('servers.mirrorAuthorize')}
        </Button>
        {source && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              revokeMirrorSource();
              setSource(null);
              setShowKeys(false);
            }}
          >
            {t('servers.mirrorRevoke')}
          </Button>
        )}
      </div>

      {/* Half two: on a DIFFERENT server, offer to pull the authorized one in. */}
      {source && !here && (
        <>
          <Text size="sm">
            <Trans
              i18nKey="servers.mirrorReadyToCopy"
              values={{ name: source.name, username: source.username }}
              components={{ b: <strong /> }}
            />
          </Text>
          {!session.isAdmin && (
            <Text tone="muted" size="xs">
              {t('servers.mirrorOwnerOnly')}
            </Text>
          )}
          {/* Everything, or only what gets listened to.

              The second is what a server on the internet is usually for: it
              has a fraction of the disk a hub at home does, and the songs you
              actually play are a fraction of the library. The set sizes
              itself against this box's free space, so the choice here is
              about WHAT to carry, not how much. */}
          <div className="mirrorScope">
            <Switch
              label={t('servers.mirrorHotOnly')}
              checked={hotOnly}
              onCheckedChange={setHotOnly}
            />
            {hotOnly && (
              <Text tone="muted" size="xs">
                {hotSize
                  ? t('servers.mirrorHotSize', {
                      tracks: formatNumber(hotSize.tracks),
                      size: gbLabel(hotSize.bytes),
                      total: formatNumber(hotSummary?.libraryTracks ?? 0),
                    })
                  : t('servers.mirrorHotHint')}
              </Text>
            )}
          </div>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={busy || running || !session.isAdmin}
              onClick={() => {
                setBusy(true);
                setNote(null);
                void startMirror(session, source, hotOnly ? { minPlays: 2 } : undefined)
                  .then(() => setNote({ tone: 'muted', text: t('servers.mirrorStarted') }))
                  .catch((e: unknown) =>
                    setNote({
                      tone: 'danger',
                      text: e instanceof Error ? e.message : t('servers.mirrorStartFailed'),
                    }),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {running
                ? t('servers.mirrorCopying')
                : hotOnly
                  ? t('servers.mirrorCopyHot', { name: source.name })
                  : t('servers.mirrorCopyAll', { name: source.name })}
            </Button>
          </div>
        </>
      )}

      {status && (status.running || status.copied > 0 || status.failed > 0) && (
        <>
          <ProgressBar
            value={status.total > 0 ? (status.copied / status.total) * 100 : 0}
            aria-label={t('servers.mirrorProgress')}
          />
          <Text tone="muted" size="xs">
            {tally(status)}
          </Text>
        </>
      )}

      {note && (
        <Text tone={note.tone} size="sm">
          {note.text}
        </Text>
      )}

      {/* The keys themselves, for wiring a copy by hand. Behind a deliberate
          tap and never printed until asked: these read your whole library. */}
      {source && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setShowKeys((v) => !v)}>
            {showKeys ? t('servers.mirrorHideKeys') : t('servers.mirrorShowKeys')}
          </Button>
          {showKeys && (
            <div className="prefsSection">
              <Text tone="danger" size="xs">
                {t('servers.mirrorKeysWarning')}
              </Text>
              <Input readOnly aria-label={t('servers.mirrorSourceUrl')} value={source.url} />
              <Input readOnly aria-label={t('servers.mirrorSourceToken')} value={source.token} />
              <Input
                readOnly
                aria-label={t('servers.mirrorSourceStreamToken')}
                value={source.streamToken}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
