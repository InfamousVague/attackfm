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
  const { session } = useServerSession();
  const [source, setSource] = useState(() => readMirrorSource());
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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

  if (!session) return null;
  const here = source?.url === session.url;

  // Ask the SOURCE how big its listened-to set is, so the size is visible
  // before the copy rather than discovered during it. Best-effort: an older
  // source has no such endpoint and the switch simply describes itself.
  useEffect(() => {
    if (!source || here || !hotOnly) return;
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
  }, [source, here, hotOnly]);
  const running = status?.running === true;

  return (
    <div className="prefsSection">
      <Label>Copy a library</Label>

      {/* Half one: authorize the library you are standing in as a source. */}
      <Text tone="muted" size="sm">
        {here
          ? 'This library is authorized to be copied. Sign into the server you want to fill, and start the copy there.'
          : 'Authorize this library so another server can copy from it. The other server does the work — nothing has to change here.'}
      </Text>
      <div className="prefsActions">
        <Button
          variant={here ? 'ghost' : 'soft'}
          size="sm"
          onClick={() => setSource(authorizeMirrorSource(session, session.url))}
        >
          {here ? 'Re-authorize this library' : 'Authorize this library'}
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
            Revoke
          </Button>
        )}
      </div>

      {/* Half two: on a DIFFERENT server, offer to pull the authorized one in. */}
      {source && !here && (
        <>
          <Text size="sm">
            Ready to copy from <strong>{source.name}</strong> ({source.username}).
          </Text>
          {!session.isAdmin && (
            <Text tone="muted" size="xs">
              Only the owner of this server can fill it.
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
              label="Only songs I actually listen to"
              checked={hotOnly}
              onCheckedChange={setHotOnly}
            />
            {hotOnly && (
              <Text tone="muted" size="xs">
                {hotSize
                  ? `About ${hotSize.tracks.toLocaleString()} songs (${gbLabel(hotSize.bytes)}) of ${(
                      hotSummary?.libraryTracks ?? 0
                    ).toLocaleString()} — played twice or more, plus anything liked. Whatever will not fit is left behind, coldest first, and songs that go cold later are let go so this stays a working set rather than filling up again.`
                  : 'Played twice or more, plus anything liked. Songs that go cold are let go.'}
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
                  .then(() => setNote('Started. It will keep going with the app closed.'))
                  .catch((e: unknown) =>
                    setNote(e instanceof Error ? e.message : 'Could not start the copy.'),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {running
                ? 'Copying…'
                : hotOnly
                  ? `Copy what I listen to from ${source.name}`
                  : `Copy ${source.name} into this server`}
            </Button>
          </div>
        </>
      )}

      {status && (status.running || status.copied > 0 || status.failed > 0) && (
        <>
          <ProgressBar
            value={status.total > 0 ? (status.copied / status.total) * 100 : 0}
            aria-label="Copy progress"
          />
          <Text tone="muted" size="xs">
            {status.copied} copied · {status.skipped} already here
            {status.failed > 0 ? ` · ${status.failed} failed` : ''}
            {status.note ? ` — ${status.note}` : ''}
          </Text>
        </>
      )}

      {note && (
        <Text tone={note.startsWith('Started') ? 'muted' : 'danger'} size="sm">
          {note}
        </Text>
      )}

      {/* The keys themselves, for wiring a copy by hand. Behind a deliberate
          tap and never printed until asked: these read your whole library. */}
      {source && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setShowKeys((v) => !v)}>
            {showKeys ? 'Hide keys' : 'Show keys'}
          </Button>
          {showKeys && (
            <div className="prefsSection">
              <Text tone="danger" size="xs">
                These read your library. Treat them like a password, and Revoke when done.
              </Text>
              <Input readOnly aria-label="Source URL" value={source.url} />
              <Input readOnly aria-label="Source token" value={source.token} />
              <Input readOnly aria-label="Source stream token" value={source.streamToken} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
