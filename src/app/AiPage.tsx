import { Skeleton, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useLibrary } from './library.tsx';
import {
  fetchCollectorStatus,
  fetchCurator,
  type CollectorStatus,
  type CuratorFeed,
} from './server.ts';
import { EmptyArt } from './EmptyArt.tsx';

/**
 * What the machine did while you were not looking - the owner's window on it.
 *
 * The AI on this server is not a feature you invoke; it runs on its own clock,
 * reads the library, forms an opinion about your taste, and SPENDS DISK buying
 * music it thinks you will keep. Everything it does was already recorded and
 * everything it did was already visible in pieces (a shelf here, a Settings
 * pane there) - this is the one page that answers "what has it actually been
 * doing", in the order it did it.
 *
 * Owner-only, and gated twice: the nav row is hidden without `session.isAdmin`
 * and the tab falls through to the library if it is reached anyway. The numbers
 * are per-account (every curator endpoint answers for its caller), which on a
 * one-listener hub is the whole story and on a shared one is honestly labelled
 * as yours rather than pretending to be everyone's.
 */

function ago(ms: number): string {
  if (!ms) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function gb(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 10) return `${Math.round(g)} GB`;
  if (g >= 0.1) return `${g.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** One headline number with its caption. */
/**
 * One headline number.
 *
 * `pending` matters more than it looks: every value here is derived with `?? 0`
 * off a feed that starts null, so without it each tile confidently reads ZERO
 * while the request is still out - and "0 songs it went and got" is a claim
 * about the machine, not a loading state. The label stays real (it never
 * changes) and only the figure is held.
 */
function Stat({ value, label, pending }: { value: string; label: string; pending?: boolean }) {
  return (
    <div className="aiStat">
      <span className="aiStat__value">
        {pending ? <Skeleton variant="text" width="2rem" /> : value}
      </span>
      <span className="aiStat__label">{label}</span>
    </div>
  );
}

const PULL_STATE: Record<CollectorStatus['recent'][number]['state'], string> = {
  queued: 'Fetching',
  landed: 'Waiting for a listen',
  promoted: 'Kept',
  failed: 'Failed',
};

export function AiPage() {
  const { session } = useServerSession();
  const { forYou } = useLibrary();
  const [curator, setCurator] = useState<CuratorFeed | null>(null);
  const [collector, setCollector] = useState<CollectorStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!session) return;
    let live = true;
    void Promise.allSettled([fetchCurator(session), fetchCollectorStatus(session)]).then(
      ([c, p]) => {
        if (!live) return;
        if (c.status === 'fulfilled') setCurator(c.value);
        if (p.status === 'fulfilled') setCollector(p.value);
        setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [session]);

  if (!session) {
    return (
      <div className="homePage aiPage">
        <h1 className="pageHeading">AI</h1>
        <Text tone="muted" size="sm">
          The AI runs on your server — connect one to see what it has been doing.
        </Text>
      </div>
    );
  }

  // Null means "not answered yet", which is NOT the same as "it has fetched
  // nothing" - and the empty state below says the second out loud. Kept
  // separate so a slow request cannot tell someone their machine has been
  // idle when it simply has not reported in.
  const loading = collector === null;
  const pulls = collector?.recent ?? [];
  const kept = pulls.filter((p) => p.state === 'promoted').length;
  const waiting = forYou.length;
  const read = curator?.progress;
  const stillReading = read && read.checked < read.total;

  return (
    <div className="homePage aiPage">
      <header className="aiPage__head">
        <h1 className="pageHeading">AI</h1>
        <Text tone="muted" size="sm">
          What your server has been doing on its own — reading your library, building
          mixes, and fetching music it thinks you will keep.
        </Text>
      </header>

      {!loaded ? null : (
        <>
          <section className="aiStats">
            <Stat
              value={String(curator?.lists.length ?? 0)}
              label="mixes built for you"
              pending={curator === null}
            />
            <Stat value={String(pulls.length)} label="songs it went and got" pending={loading} />
            <Stat value={String(kept)} label="you kept" pending={loading} />
            <Stat value={String(waiting)} label="waiting for a listen" pending={loading} />
          </section>

          {/* What it is doing right now, in one line each - the two loops that
              actually run, said plainly rather than as engine phases. */}
          <section className="aiSection">
            <h2 className="homeShelfTitle">Right now</h2>
            <ul className="aiFacts">
              <li>
                {stillReading
                  ? `Reading your library — ${read!.checked.toLocaleString()} of ${read!.total.toLocaleString()} songs.`
                  : `Finished reading your library${read ? ` — all ${read.total.toLocaleString()} songs` : ''}.`}
              </li>
              <li>
                {curator?.status.ai
                  ? 'A language model on this server names and shapes the mixes.'
                  : 'No language model configured — mixes are built from measurements alone.'}
              </li>
              <li>
                {curator?.status.embeddings
                  ? 'Lyrics are being read, so songs can be matched by what they say.'
                  : 'Lyrics are not being read on this server.'}
              </li>
              <li>Last built a set of mixes {ago(curator?.status.lastCurated ?? 0)}.</li>
              {collector && (
                <li>
                  {!collector.enabled
                    ? 'Buying is switched off, so it only ever suggests.'
                    : collector.halted === 'cap'
                      ? `Buying has stopped: it has filled its ${gb(collector.capBytes)} budget.`
                      : `Buying is on, ${gb(collector.ledgerBytes)} of ${gb(collector.capBytes)} spent on music nobody has played yet.`}
                </li>
              )}
            </ul>
          </section>

          {/* The ledger: every song it bought, newest first, WITH ITS REASON.
              A machine that spends disk on your behalf should have to say why,
              and this is the only place that shows it. */}
          <section className="aiSection">
            <h2 className="homeShelfTitle">What it fetched</h2>
            {loading ? (
              <ul className="aiPulls" aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <li key={i} className="aiPull">
                    <Skeleton variant="text" width="60%" />
                    <Skeleton variant="text" width="40%" />
                  </li>
                ))}
              </ul>
            ) : pulls.length === 0 ? (
              <div className="emptyState">
                <EmptyArt name="discovery" />
                <p className="emptyState__text">
                  Nothing fetched yet. Once it has heard enough of your listening to have an
                  opinion, what it picks shows up here — with the reason it picked it.
                </p>
              </div>
            ) : (
              <ul className="aiPulls">
                {pulls.map((p, i) => (
                  <li key={`${p.title}-${p.artist}-${i}`} className="aiPull">
                    <div className="aiPull__main">
                      <span className="aiPull__title">{p.title}</span>
                      <span className="aiPull__artist">{p.artist}</span>
                      {p.reason && <span className="aiPull__reason">{p.reason}</span>}
                    </div>
                    <div className="aiPull__meta">
                      <span className="aiPull__state" data-state={p.state}>
                        {PULL_STATE[p.state]}
                      </span>
                      <span className="aiPull__at">{ago(p.at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
