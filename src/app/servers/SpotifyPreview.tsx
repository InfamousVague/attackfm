import { Button, Modal, Text } from '@glacier/react';
import { Check, ExternalLink, Heart, ListPlus } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { clearSpotifyLink, onSpotifyLink, spotifyEmbedUrl, spotifyWebUrl } from './deepLink.ts';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { planFiling, type FileDestination } from '../downloads/filePlan.ts';
import { watchIfPlaylist } from '../nav/downloadsDoor.ts';
import { ChooseDestination } from '../playlists/ChooseDestination.tsx';
import { openExternal } from '../core/openExternal.ts';

/**
 * A Spotify link, previewed.
 *
 * The phone can be told to open Spotify links here (see deepLink.ts). Before,
 * that dropped you into Search with the URL typed in - a strange place to land
 * when you tapped a song. This is the card you meant.
 *
 * The record itself comes from Spotify, not from us. An earlier version resolved
 * the link against the SERVER's catalogue search, which returned fuzzy matches
 * biased toward the library and could show a completely different song. A link
 * is an id, and an id RESOLVES where a search only guesses - so the preview is
 * Spotify's own embed player for that id: the exact sleeve, the exact artist,
 * and a 30-second preview, drawn by Spotify from a public endpoint that needs
 * no sign-in. `open.spotify.com/embed/<kind>/<id>` frames anywhere by design.
 *
 * Only the two things you came to do are ours. Like and Add cannot touch a
 * Track - the song is not downloaded yet - so they hand the ORIGINAL link to
 * the importer (which resolves the same id to a real download) and record where
 * it should land (planFiling); useFilePlan files it and walks you there when it
 * arrives, the exact path a song added from Discover takes.
 *
 * Mounted inside the providers (it needs the downloads bridge and the
 * playlists), and it owns its own open state off the link store.
 */

export function SpotifyPreview() {
  const downloads = useDownloadsOptional();
  const [link, setLink] = useState<string | null>(null);
  // The exact title, from Spotify's oEmbed (CORS-open). Only for naming the
  // download's toast and the ChooseDestination sheet - the visible record is
  // the iframe's job. Absent is fine; it falls back to a neutral label.
  const [title, setTitle] = useState<string | null>(null);
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
        setTitle(null);
        clearSpotifyLink();
      }),
    [],
  );

  // The exact name, for the toast. oEmbed is the one Spotify endpoint the app
  // CAN read cross-origin; the embed page that carries artist and duration is
  // not, which is why the artist lives in the iframe and not our own markup.
  useEffect(() => {
    const web = link ? spotifyWebUrl(link) : null;
    if (!web) return;
    const ctrl = new AbortController();
    fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(web)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { title?: string } | null) => {
        if (d?.title) setTitle(d.title);
      })
      .catch(() => {
        // No name is a fine outcome - the iframe still shows the record.
      });
    return () => ctrl.abort();
  }, [link]);

  const close = () => setLink(null);

  /** Start the download and record where it belongs. `null` is "just my
   *  library" - the file lands, unfiled, which is what Add did before plans. */
  const file = (dest: FileDestination | null) => {
    if (!downloads || !link) return;
    void Promise.resolve(downloads.enqueue(link)).then((job) => {
      if (dest) planFiling(job.id, dest, title ?? 'This song');
    });
    // A playlist is many songs over minutes; take them to the queue to watch it
    // land. A single or an album finishes before they would look - no-op there.
    watchIfPlaylist(link);
    setFiled(dest);
  };

  const embed = link ? spotifyEmbedUrl(link) : null;
  const web = link ? spotifyWebUrl(link) : null;

  return (
    <>
      <Modal open={link !== null} onClose={close} title="From Spotify" size="sm">
        <div className="spotPreview">
          {embed ? (
            <iframe
              className="spotPreview__embed"
              src={embed}
              title="Spotify preview"
              loading="lazy"
              allow="encrypted-media; clipboard-write"
            />
          ) : (
            <div className="spotPreview__pending">
              <Text tone="muted" size="sm">
                This does not look like a track, album or playlist link.
              </Text>
            </div>
          )}

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
              <Button variant="solid" fullWidth disabled={!downloads} onClick={() => file({ kind: 'liked' })}>
                <Heart size={16} />
                Like
              </Button>
              <Button variant="outline" fullWidth disabled={!downloads} onClick={() => setChoosing(true)}>
                <ListPlus size={16} />
                Add to playlist
              </Button>
              {web && (
                <Button variant="ghost" size="sm" onClick={() => void openExternal(web)}>
                  <ExternalLink size={15} />
                  Open in Spotify
                </Button>
              )}
              {!downloads && (
                <Text tone="muted" size="xs" className="spotPreview__hint">
                  Sign in to a server that can download to Like or add this.
                </Text>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ChooseDestination
        open={choosing}
        title={title ?? 'This song'}
        onClose={() => setChoosing(false)}
        onChoose={(dest) => file(dest)}
      />
    </>
  );
}
