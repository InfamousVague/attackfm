import { Button, Modal, Spinner, Text } from '@glacier/react';
import { Check, ExternalLink, Heart, ListPlus, Music } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { clearSpotifyLink, onSpotifyLink, spotifyWebUrl } from './deepLink.ts';
import { searchCatalog, type SearchResult } from '../server.ts';
import { useServerSession } from './serverSession.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { planFiling, type FileDestination } from '../downloads/filePlan.ts';
import { ChooseDestination } from '../playlists/ChooseDestination.tsx';
import { openExternal } from '../core/openExternal.ts';

/**
 * A Spotify link, previewed.
 *
 * The phone can be told to open Spotify links here (see deepLink.ts). Before,
 * that dropped you into Search with the URL typed in - honest, but a search box
 * is a strange thing to land on when you tapped a song. This is the card you
 * meant: the record itself, its art, and the two things you actually came to do
 * - keep it, or file it - without the library in the way.
 *
 * A record rather than the raw link, because the link is an id and nothing
 * else. The server resolves it against the same catalogue Search uses (it can
 * read Spotify), so what you see is the real title, artist and sleeve - matched
 * on YOUR server, which is also the thing that will download it.
 *
 * The song is not in the library yet, so Like and Add cannot touch a Track:
 * they start the download and RECORD where it should land (planFiling), and
 * useFilePlan files it and walks you there when it arrives - the exact path a
 * song added from Discover takes.
 *
 * Mounted inside the providers (it needs the session, the downloads bridge and
 * the playlists), and it owns its own open state off the link store, so nothing
 * upstream has to thread it.
 */

type Resolved =
  | { state: 'loading' }
  | { state: 'ready'; result: SearchResult }
  | { state: 'empty' }
  | { state: 'error' };

export function SpotifyPreview() {
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const [link, setLink] = useState<string | null>(null);
  const [res, setRes] = useState<Resolved>({ state: 'loading' });
  const [choosing, setChoosing] = useState(false);
  // What the last action filed it into, so the card can say so rather than
  // sitting there as if nothing happened - the download runs unwatched.
  const [filed, setFiled] = useState<FileDestination | null | undefined>(undefined);

  // A link arriving from outside opens the card. Taken once (clearSpotifyLink),
  // so a later remount does not re-open it behind the user.
  useEffect(
    () =>
      onSpotifyLink((url) => {
        setLink(url);
        setFiled(undefined);
        clearSpotifyLink();
      }),
    [],
  );

  // Resolve the link to a record. Re-runs if the session arrives after the link
  // (a cold launch straight from the tap can beat the sign-in restore).
  useEffect(() => {
    if (!link) return;
    if (!session) {
      setRes({ state: 'error' });
      return;
    }
    setRes({ state: 'loading' });
    const ctrl = new AbortController();
    searchCatalog(session, link, ctrl.signal)
      .then((rows) => {
        const track = rows.find((r) => r.kind === 'track') ?? rows[0];
        setRes(track ? { state: 'ready', result: track } : { state: 'empty' });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setRes({ state: 'error' });
      });
    return () => ctrl.abort();
  }, [link, session]);

  const close = () => setLink(null);

  /** Start the download and record where it belongs. `null` is "just my
   *  library" - the file lands, unfiled, which is what Add did before plans. */
  const file = (dest: FileDestination | null) => {
    if (res.state !== 'ready' || !downloads) return;
    const { result } = res;
    void Promise.resolve(downloads.enqueue(result.url)).then((job) => {
      if (dest) planFiling(job.id, dest, result.title);
    });
    setFiled(dest);
  };

  const webUrl = link ? spotifyWebUrl(link) : null;
  const canAdd = res.state === 'ready' && !!downloads;

  return (
    <>
      <Modal open={link !== null} onClose={close} title="From Spotify" size="sm">
        <div className="spotPreview">
          {res.state === 'loading' && (
            <div className="spotPreview__pending">
              <Spinner size="sm" aria-label="Looking it up" />
              <Text tone="muted" size="sm">
                Finding this on your server…
              </Text>
            </div>
          )}

          {res.state === 'error' && (
            <div className="spotPreview__pending">
              <Text tone="muted" size="sm">
                {session
                  ? 'Could not reach your server to look this up.'
                  : 'Sign in to your server to preview and add this.'}
              </Text>
              {webUrl && (
                <Button variant="ghost" size="sm" onClick={() => void openExternal(webUrl)}>
                  <ExternalLink size={15} />
                  Open in Spotify
                </Button>
              )}
            </div>
          )}

          {res.state === 'empty' && (
            <div className="spotPreview__pending">
              <Text tone="muted" size="sm">
                Your server's sources don't have this one.
              </Text>
              {webUrl && (
                <Button variant="ghost" size="sm" onClick={() => void openExternal(webUrl)}>
                  <ExternalLink size={15} />
                  Open in Spotify
                </Button>
              )}
            </div>
          )}

          {res.state === 'ready' && (
            <>
              <div className="spotPreview__head">
                <div className="spotPreview__art" aria-hidden>
                  {res.result.cover ? (
                    <img src={res.result.cover} alt="" loading="lazy" />
                  ) : (
                    <Music size={40} />
                  )}
                </div>
                <div className="spotPreview__meta">
                  <Text weight="bold" className="spotPreview__title">
                    {res.result.title}
                  </Text>
                  <Text tone="muted" size="sm" className="spotPreview__artist">
                    {res.result.subtitle}
                  </Text>
                </div>
              </div>

              {filed !== undefined ? (
                <div className="spotPreview__done">
                  <span className="spotPreview__check" aria-hidden>
                    <Check size={16} />
                  </span>
                  <Text size="sm">
                    {filed === null
                      ? 'Added to your library — downloading now'
                      : filed.kind === 'liked'
                        ? 'Liked — downloading now'
                        : `Added to ${filed.name} — downloading now`}
                  </Text>
                </div>
              ) : (
                <div className="spotPreview__actions">
                  <Button
                    variant="solid"
                    fullWidth
                    disabled={!canAdd}
                    onClick={() => file({ kind: 'liked' })}
                  >
                    <Heart size={16} />
                    Like
                  </Button>
                  <Button
                    variant="outline"
                    fullWidth
                    disabled={!canAdd}
                    onClick={() => setChoosing(true)}
                  >
                    <ListPlus size={16} />
                    Add to playlist
                  </Button>
                  {webUrl && (
                    <Button variant="ghost" size="sm" onClick={() => void openExternal(webUrl)}>
                      <ExternalLink size={15} />
                      Open in Spotify
                    </Button>
                  )}
                  {!downloads && (
                    <Text tone="muted" size="xs" className="spotPreview__hint">
                      Adding needs the music importer and a server that can download.
                    </Text>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>

      {res.state === 'ready' && (
        <ChooseDestination
          open={choosing}
          title={res.result.title}
          onClose={() => setChoosing(false)}
          onChoose={(dest) => file(dest)}
        />
      )}
    </>
  );
}
