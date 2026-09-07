import { useState } from 'react';
import type { DateArtistProfile } from '../api/curator.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

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

type T = ReturnType<typeof useT>;

/**
 * "12.4M", "8.1k".
 *
 * Intl's own compact notation, which knows that the short form of a million is
 * "M" here, "Mio." in German and "万" (a DIFFERENT boundary, at ten thousand)
 * in Japanese. The hand-rolled version this replaced divided by 1e6 and glued
 * on a Latin letter, which is wrong in most of the world.
 */
function count(n: number): string {
  return formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });
}

/** "Formed in 1998" for a band, "born" for a person - and neither unless
 *  MusicBrainz said which. Two different sentences rather than one with the
 *  verb swapped inside it: a language that inflects around the year cannot
 *  build the second from a verb and a number. */
function lifeLine(mb: NonNullable<DateArtistProfile['musicbrainz']>, t: T): string | null {
  if (!mb.began) return null;
  if (mb.ended) return `${mb.began}–${mb.ended}`;
  return mb.kind === 'Person'
    ? t('date.activeSince', { year: mb.began })
    : t('date.formedIn', { year: mb.began });
}

export function DateProfile({ artist, profile }: { artist: string; profile: DateArtistProfile | null | undefined }) {
  const t = useT();
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
  // The two source names are brands, not prose - they stay as they are spelt.
  const genreSource = mb?.genres?.length ? 'MusicBrainz' : sp?.genres?.length ? 'Spotify' : null;

  const facts: string[] = [];
  if (mb?.from) facts.push(mb.from);
  const life = mb ? lifeLine(mb, t) : null;
  if (life) facts.push(life);

  // Each number says who counted it, and pluralises on the RAW count while
  // printing the compact one - "1.0M fans" needs the plural of a million, not
  // the plural of the string "1.0M".
  const numbers: string[] = [];
  if (dz?.fans) numbers.push(t('date.fansOnDeezer', { count: dz.fans, value: count(dz.fans) }));
  if (sp?.followers)
    numbers.push(t('date.followersOnSpotify', { count: sp.followers, value: count(sp.followers) }));
  if (lb?.listeners)
    numbers.push(t('date.listenersOnListenBrainz', { count: lb.listeners, value: count(lb.listeners) }));

  const releases = dz?.discography ?? profile?.discography ?? [];
  const yours = profile?.yours;
  const deep = releases.length > 0 || (dz?.top?.length ?? 0) > 0 || (dz?.related?.length ?? 0) > 0;

  return (
    <section className="dateProfile" aria-label={t('date.aboutArtist', { artist })}>
      <h3 className="dateProfile__who">
        {artist}
        {mb?.note && <span className="dateProfile__note"> — {mb.note}</span>}
      </h3>

      {facts.length > 0 && <p className="dateProfile__facts">{facts.join(' · ')}</p>}

      {genres.length > 0 && (
        <ul className="dateProfile__genres" aria-label={t('date.genresPer', { source: genreSource })}>
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
            ? t('date.lookingThemUp')
            : profile?.partial
              ? t('date.stillReadingUp')
              : facts.length === 0 && numbers.length === 0
                ? t('date.nobodyWroteThisDown')
                : ''}
        </p>
      )}

      {numbers.length > 0 && <p className="dateProfile__fans">{numbers.join(' · ')}</p>}

      {/* What you already have of theirs. On a shared hub the library is
          everyone's, so this says "on this server" rather than "yours".
          Two whole sentences rather than one with a tail appended, because the
          tail is not optional punctuation in every language. And the hearted
          half is pluralised on its OWN key before it goes in: i18next selects
          one plural form per call, from `count`, so a sentence carrying two
          independent counts has to count the second one somewhere else. */}
      {yours && yours.tracks > 0 && (
        <p className="dateProfile__yours">
          {yours.hearted > 0
            ? t('date.yoursHereHearted', {
                count: yours.tracks,
                hearted: t('date.heartedCount', { count: yours.hearted }),
              })
            : t('date.yoursHere', { count: yours.tracks })}
        </p>
      )}

      {deep && !more && (
        <button type="button" className="dateProfile__more" onClick={() => setMore(true)}>
          {t('date.moreAbout', { artist })}
        </button>
      )}

      {deep && more && (
        <div className="dateProfile__deep">
          {(dz?.top?.length ?? 0) > 0 && (
            <>
              <h4 className="dateProfile__head">{t('date.mostPlayed')}</h4>
              <ul className="dateProfile__disco">
                {dz!.top!.slice(0, 5).map((song) => (
                  <li key={song} className="dateProfile__release">
                    {song}
                  </li>
                ))}
              </ul>
            </>
          )}
          {releases.length > 0 && (
            <>
              <h4 className="dateProfile__head">{t('date.releases')}</h4>
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
              <h4 className="dateProfile__head">{t('date.deezerPutsThemNear')}</h4>
              <p className="dateProfile__related">{dz!.related!.slice(0, 5).join(', ')}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
