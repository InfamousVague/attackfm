import { useState } from 'react';
import type { DateArtistProfile } from '../api/curator.ts';

/**
 * Who you are about to meet.
 *
 * The rule this panel is built around: **every line traces to somebody who
 * actually knows**, and a fact with no source renders nothing at all. Never
 * "Unknown", never a dash, never a model's guess dressed as data. So a huge act
 * gets a full page and a bedroom producer with one release gets three lines,
 * and both are true.
 *
 * That is why each block is gated on `sources` rather than on whether the field
 * happens to be present, and why the numbers say who counted them. "12.4M fans
 * on Deezer" is a fact about Deezer; "12.4M fans" would be a claim about the
 * world that nobody here can make.
 *
 * The one thing on this panel a model wrote is `blurb`, which is prose and one
 * sentence long by construction (lore.rs caps it). It is never the source of a
 * year, a place or a genre - those come from MusicBrainz or not at all.
 */

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** "Formed in 1998" for a band, "born" for a person - and neither unless
 *  MusicBrainz said which. */
function lifeLine(mb: NonNullable<DateArtistProfile['musicbrainz']>): string | null {
  if (!mb.began) return null;
  const verb = mb.kind === 'Person' ? 'Active since' : 'Formed in';
  return mb.ended ? `${mb.began}–${mb.ended}` : `${verb} ${mb.began}`;
}

export function DateProfile({ artist, profile }: { artist: string; profile: DateArtistProfile | null | undefined }) {
  const [more, setMore] = useState(false);
  const has = (s: string) => profile?.sources?.includes(s) ?? false;

  const mb = has('musicbrainz') ? profile?.musicbrainz : undefined;
  const dz = has('deezer') ? profile?.deezer : undefined;
  const sp = has('spotify') ? profile?.spotify : undefined;
  const lb = has('listenbrainz') ? profile?.listenbrainz : undefined;

  /*
   * Genres come from ONE vocabulary, never both merged. Spotify's tag space and
   * MusicBrainz's are different things that happen to use some of the same
   * words, and concatenating them produces a list that is half editorial and
   * half community with no way to tell which is which. MusicBrainz leads
   * because its `genres` are curated; Spotify fills in when MB has none.
   */
  const genres = (mb?.genres?.length ? mb.genres : sp?.genres) ?? [];
  const genreSource = mb?.genres?.length ? 'MusicBrainz' : sp?.genres?.length ? 'Spotify' : null;

  const facts: string[] = [];
  if (mb?.from) facts.push(mb.from);
  const life = mb ? lifeLine(mb) : null;
  if (life) facts.push(life);

  const numbers: string[] = [];
  if (dz?.fans) numbers.push(`${count(dz.fans)} fans on Deezer`);
  if (sp?.followers) numbers.push(`${count(sp.followers)} followers on Spotify`);
  if (lb?.listeners) numbers.push(`${count(lb.listeners)} listeners on ListenBrainz`);

  const releases = dz?.discography ?? profile?.discography ?? [];
  const yours = profile?.yours;
  const deep = releases.length > 0 || (dz?.top?.length ?? 0) > 0 || (dz?.related?.length ?? 0) > 0;

  return (
    <section className="dateProfile" aria-label={`About ${artist}`}>
      <h3 className="dateProfile__who">
        {artist}
        {mb?.note && <span className="dateProfile__note"> — {mb.note}</span>}
      </h3>

      {facts.length > 0 && <p className="dateProfile__facts">{facts.join(' · ')}</p>}

      {genres.length > 0 && (
        <ul className="dateProfile__genres" aria-label={`Genres, per ${genreSource}`}>
          {genres.slice(0, 3).map((g) => (
            <li key={g} className="dateProfile__genre">
              {g}
            </li>
          ))}
        </ul>
      )}

      {profile?.blurb ? (
        <p className="dateProfile__blurb">{profile.blurb}</p>
      ) : (
        <p className="dateProfile__blurb dateProfile__blurb--thin">
          {profile === undefined
            ? 'Looking them up…'
            : profile?.partial
              ? 'Still reading up on this one.'
              : facts.length === 0 && numbers.length === 0
                ? 'Nobody has written this one down yet.'
                : ''}
        </p>
      )}

      {numbers.length > 0 && <p className="dateProfile__fans">{numbers.join(' · ')}</p>}

      {/* What you already have of theirs. On a shared hub the library is
          everyone's, so this says "on this server" rather than "yours". */}
      {yours && yours.tracks > 0 && (
        <p className="dateProfile__yours">
          {yours.tracks} of theirs on this server
          {yours.hearted > 0 ? `, ${yours.hearted} hearted` : ''}
        </p>
      )}

      {deep && !more && (
        <button type="button" className="dateProfile__more" onClick={() => setMore(true)}>
          More about {artist}
        </button>
      )}

      {deep && more && (
        <div className="dateProfile__deep">
          {(dz?.top?.length ?? 0) > 0 && (
            <>
              <h4 className="dateProfile__head">Most played</h4>
              <ul className="dateProfile__disco">
                {dz!.top!.slice(0, 5).map((t) => (
                  <li key={t} className="dateProfile__release">
                    {t}
                  </li>
                ))}
              </ul>
            </>
          )}
          {releases.length > 0 && (
            <>
              <h4 className="dateProfile__head">Releases</h4>
              <ul className="dateProfile__disco">
                {releases.slice(0, 6).map((r) => (
                  <li key={r} className="dateProfile__release">
                    {r}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(dz?.related?.length ?? 0) > 0 && (
            <>
              <h4 className="dateProfile__head">Deezer puts them near</h4>
              <p className="dateProfile__related">{dz!.related!.slice(0, 5).join(', ')}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
