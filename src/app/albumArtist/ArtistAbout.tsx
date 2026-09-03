import { Button, ScrollArea, Text } from '@glacier/react';
import { ExternalLink } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { fetchDateArtist, type DateArtistProfile } from '../server.ts';
import type { CatalogArtist } from '../api/catalog.ts';
import type { ServerSession } from '../api/http.ts';
import { openExternal } from '../core/openExternal.ts';
import { useCardArt } from '../ux/artLoad.ts';

/** The catalogue's own name for where a link leads. */
function sourceLabel(source: string | undefined): string {
  switch ((source ?? '').toLowerCase()) {
    case 'deezer':
      return 'Deezer';
    case 'spotify':
      return 'Spotify';
    case 'tidal':
      return 'Tidal';
    case 'qobuz':
      return 'Qobuz';
    default:
      return 'the catalogue';
  }
}

/** A round related-artist chip that opens that artist's page. */
function RelatedChip({ name, picture, onOpen }: { name: string; picture: string | null; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(picture);
  return (
    <button type="button" className="relatedArtist" onClick={onOpen}>
      <img
        className="relatedArtist__art artPop"
        src={src}
        alt=""
        loading="lazy"
        data-loading={!loaded || undefined}
        onLoad={onLoad}
        onError={onError}
      />
      <span className="relatedArtist__name">{name}</span>
    </button>
  );
}

/**
 * Who the artist is, and where to go from here.
 *
 * The catalogue and the DJ both already know things about an artist the page
 * never showed: a one-line read on who they are and where they are from (the
 * same honest blurb Music Date pulls), how many people follow them, a short
 * discography, the artists near them, and a link out to their catalogue page.
 * None of it is on the disk, so it sits below the music that is - a place to
 * read and to leave from, not another shelf to play.
 */
export function ArtistAbout({
  artist,
  session,
  profile,
  onOpenArtist,
}: {
  artist: string;
  session: ServerSession | null;
  profile: CatalogArtist | null;
  onOpenArtist: (artist: string) => void;
}) {
  const [about, setAbout] = useState<DateArtistProfile | null>(null);
  useEffect(() => {
    if (!session) {
      setAbout(null);
      return;
    }
    let live = true;
    void fetchDateArtist(session, artist)
      .then((a) => {
        if (live) setAbout(a);
      })
      .catch(() => {
        // A server with no model, or unreachable: the section falls back to
        // whatever the catalogue profile alone can show, or renders nothing.
      });
    return () => {
      live = false;
    };
  }, [session, artist]);

  const blurb = about?.blurb?.trim() || '';
  const discography = about?.discography ?? [];
  const fans = about?.fans ?? profile?.fans ?? null;
  const related = profile?.related ?? [];
  const url = profile?.url || '';

  // Nothing worth a heading: no read, no numbers, no links.
  if (!blurb && discography.length === 0 && fans === null && related.length === 0 && !url) {
    return null;
  }

  return (
    <section className="homeShelf artistAbout">
      <h2 className="homeShelfTitle">About</h2>
      {blurb && (
        <Text size="sm" className="artistAbout__blurb">
          {blurb}
        </Text>
      )}
      {(fans !== null || url) && (
        <div className="artistAbout__meta">
          {fans !== null && (
            <Text size="sm" tone="muted">
              {fans.toLocaleString()} {fans === 1 ? 'follower' : 'followers'}
            </Text>
          )}
          {url && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openExternal(url)}
              aria-label={`Open ${artist} on ${sourceLabel(profile?.source)}`}
            >
              <ExternalLink size={15} />
              {sourceLabel(profile?.source)}
            </Button>
          )}
        </div>
      )}
      {discography.length > 0 && (
        <ul className="artistAbout__disc">
          {discography.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {related.length > 0 && (
        <>
          <h3 className="artistAbout__relatedTitle">Related artists</h3>
          <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
            <div className="homeShelfRow">
              {related.map((r) => (
                <RelatedChip
                  key={r.id}
                  name={r.name}
                  picture={r.picture}
                  onOpen={() => onOpenArtist(r.name)}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </section>
  );
}
