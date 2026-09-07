import { AlertDialog, Button, Input, Label, Pill, Spinner, Text } from '@glacier/react';
import { SettingsCallout } from './kit/settingsKit.tsx';
import { useEffect, useState } from 'react';
import {
  addSource,
  DEPRECATED_PLUGINS,
  fetchManifest,
  installPlugin,
  readSources,
  removeSource,
  type RemoteManifest,
  type RemotePluginListing,
} from '../../plugins/remote.ts';
import { Trans, translate, useT } from '../i18n/LocaleShell.tsx';

/**
 * The repositories the marketplace pulls from, and what they offer.
 *
 * A repository is a URL serving a manifest of installable plugin bundles.
 * Installing downloads the code once and keeps it locally - from then on the
 * plugin loads at boot with no network - so a repository is a distribution
 * channel, not a dependency. Adding one is trusting its owner with code that
 * runs inside the app, and the confirm on Add says exactly that.
 */
/** A repository's fetched manifest, the reason it could not be read, or a wait. */
export type Feed = RemoteManifest | string | 'loading';

export function listingsOf(feed: Feed | undefined): RemotePluginListing[] {
  return typeof feed === 'object' && feed !== null && 'plugins' in feed ? feed.plugins : [];
}

/**
 * Dotted versions, newest wins. Only a STRICTLY higher version counts as an
 * update: comparing by inequality would nag forever about a repository that
 * happens to be pinned behind what is installed, and offer a "update" that
 * silently downgrades.
 */
export function isNewer(candidate: string, installed: string): boolean {
  const parts = (v: string) => v.split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The repositories and what they are offering, fetched once for the whole
 * pane. Lifted out of the sources list because three surfaces need it now -
 * the update banner, the browse shelf and the sources tab - and three
 * independent fetches of the same manifests would be three times the traffic
 * and three chances to disagree about what is available.
 */
export function useRepoFeeds() {
  const [sources, setSources] = useState<string[]>(readSources);
  const [feeds, setFeeds] = useState<Map<string, Feed>>(new Map());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setFeeds(new Map(sources.map((s) => [s, 'loading' as const])));
    for (const source of sources) {
      void fetchManifest(source, controller.signal)
        .then((manifest) => {
          if (!live) return;
          setFeeds((prev) => new Map(prev).set(source, manifest));
        })
        .catch((err) => {
          if (!live) return;
          setFeeds((prev) =>
            // The message on an Error comes from the network layer and is not
            // ours to translate; only the "we have no idea" fallback is.
            new Map(prev).set(
              source,
              err instanceof Error ? err.message : translate('settings.pluginRepoUnreachable'),
            ),
          );
        });
    }
    return () => {
      live = false;
      controller.abort();
    };
  }, [sources, nonce]);

  return {
    sources,
    setSources,
    feeds,
    refresh: () => setNonce((n) => n + 1),
    loading: [...feeds.values()].some((f) => f === 'loading'),
  };
}

/** Installing, shared by every surface that offers it. */
export function useInstaller(reloadRemote: () => void) {
  const t = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  // A failure worth reading, in the app's own voice rather than the OS's
  // alert box - which on a phone webview may not even appear.
  const [error, setError] = useState<string | null>(null);
  const install = async (source: string, listing: RemotePluginListing) => {
    setBusyId(listing.id);
    setError(null);
    try {
      await installPlugin(source, listing);
      reloadRemote();
    } catch (err) {
      setError(
        t('settings.pluginInstallFailed', {
          name: listing.name,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusyId(null);
    }
  };
  return { busyId, install, error, clearError: () => setError(null) };
}

/**
 * What is installed but out of date, above everything else. Nothing here
 * updates on its own - a plugin is code the user chose to run, so a new
 * version is an offer rather than something that happens to them - which is
 * exactly why it has to be visible without going looking for it.
 */
export function PluginUpdates({
  updates,
  busyId,
  onUpdate,
}: {
  updates: Array<{ source: string; listing: RemotePluginListing; from: string }>;
  busyId: string | null;
  onUpdate: (source: string, listing: RemotePluginListing) => void;
}) {
  const t = useT();
  if (updates.length === 0) return null;
  // Wears the kit's one tinted-banner recipe (SettingsCallout) rather than
  // the raw accent ramp steps this strip had grown - two vocabularies for
  // "tinted notice" was one too many.
  return (
    <SettingsCallout
      action={
        <Button
          variant="solid"
          size="sm"
          disabled={busyId !== null}
          onClick={() => {
            for (const u of updates) onUpdate(u.source, u.listing);
          }}
        >
          {/* "Update" for the single offer, "Update all" for several: the
              button's WORDS change with the count, so it is one plural entry
              rather than two labels picked by a ternary. */}
          {t('settings.pluginUpdateAction', { count: updates.length })}
        </Button>
      }
    >
    <div className="pluginUpdates pluginUpdates--inCallout">
      <div className="pluginUpdatesHead">
        <Label>
          {t('settings.pluginUpdatesAvailable', { count: updates.length })}
        </Label>
      </div>
      {updates.map((u) => (
        <div key={u.listing.id} className="pluginUpdateRow">
          <div className="pluginRepoRowText">
            <Text size="sm">{u.listing.name}</Text>
            <Text size="xs" tone="muted">
              {t('settings.pluginVersionBump', { from: u.from, to: u.listing.version })}
            </Text>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busyId === u.listing.id}
            onClick={() => onUpdate(u.source, u.listing)}
          >
            {busyId === u.listing.id ? t('settings.pluginUpdating') : t('settings.pluginUpdate')}
          </Button>
        </div>
      ))}
    </div>
    </SettingsCallout>
  );
}

/** Everything the repositories offer that is not installed yet. */
export function PluginBrowse({
  feeds,
  remoteInstalled,
  busyId,
  loading,
  onInstall,
}: {
  feeds: Map<string, Feed>;
  remoteInstalled: ReadonlyMap<string, { version: string }>;
  busyId: string | null;
  loading: boolean;
  onInstall: (source: string, listing: RemotePluginListing) => void;
}) {
  const t = useT();
  const offered = [...feeds.entries()].flatMap(([source, feed]) =>
    listingsOf(feed).map((listing) => ({ source, listing })),
  );
  // Two repositories offering the same plugin is one plugin, not two rows -
  // the official repo mirrors the private one, so without this every mirrored
  // plugin doubles. Newest version wins; a tie keeps the first source listed.
  const byId = new Map<string, { source: string; listing: RemotePluginListing }>();
  for (const offer of offered) {
    const seen = byId.get(offer.listing.id);
    if (!seen || isNewer(offer.listing.version, seen.listing.version)) byId.set(offer.listing.id, offer);
  }
  // Not installed, and not one this app has taken over. A retired plugin can
  // still be sitting in a repository index - dropping it from the shelf is a
  // publish step, and other people's hubs publish on their own schedule - and
  // offering Install for one is offering a round trip: it lands, registers a
  // second copy of a UI the player already has, and pruneDeprecatedPlugins
  // removes it again at the next launch.
  // What a repository is really offering: retired ids do not count, or a hub
  // that lists nothing else reads as "everything is already installed" when in
  // truth it has nothing to give.
  const offerable = offered.filter(({ listing }) => !DEPRECATED_PLUGINS.includes(listing.id));
  const available = [...byId.values()].filter(
    ({ listing }) => !remoteInstalled.has(listing.id) && !DEPRECATED_PLUGINS.includes(listing.id),
  );

  if (available.length === 0) {
    return (
      <Text size="sm" tone="subtle">
        {loading
          ? t('settings.pluginsLooking')
          : offerable.length === 0
            ? t('settings.pluginsNoneOffered')
            : t('settings.pluginsAllInstalled')}
      </Text>
    );
  }
  return (
    <div className="pluginBrowse">
      {available.map(({ source, listing }) => (
        <div key={`${source}/${listing.id}`} className="pluginRepoRow">
          <div className="pluginRepoRowText">
            <Text size="sm">
              {listing.name}{' '}
              <Text as="span" size="xs" tone="subtle">
                v{listing.version}
                {listing.author ? ` · ${listing.author}` : ''}
              </Text>
            </Text>
            <Text size="xs" tone="muted">
              {listing.description}
            </Text>
            <Text size="xs" tone="subtle">
              {source.replace(/^https?:\/\//, '')}
            </Text>
          </div>
          <Button
            variant="solid"
            size="sm"
            disabled={busyId === listing.id}
            onClick={() => onInstall(source, listing)}
          >
            {busyId === listing.id ? t('settings.pluginInstalling') : t('settings.pluginInstall')}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Where plugins come from: the addresses themselves, and whether they answer. */
export function PluginSources({
  sources,
  setSources,
  feeds,
  onRefresh,
}: {
  sources: string[];
  setSources: (next: string[]) => void;
  feeds: Map<string, Feed>;
  onRefresh: () => void;
}) {
  const t = useT();
  const [adding, setAdding] = useState('');
  // The trust question, asked in the app's own dialog. window.confirm was
  // doing this job; a kit AlertDialog keeps the same one-question shape and
  // the same copy, and actually renders everywhere the app runs.
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="pluginSources">
      <AlertDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t('settings.pluginRepoAddTitle')}
        description={t('settings.pluginRepoAddWarning')}
        actionLabel={t('settings.pluginRepoAddConfirm')}
        tone="danger"
        onAction={() => {
          if (confirming) setSources(addSource(confirming));
          setConfirming(null);
          setAdding('');
        }}
      />
      <div className="pluginSourcesHead">
        <Text size="sm" tone="muted">
          {/* The path is markup inside the sentence, so it travels as a
              component rather than a third fragment a translator cannot move. */}
          <Trans i18nKey="settings.pluginSourcesHint" components={{ code: <code /> }} />
        </Text>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t('settings.pluginRepoRefresh')}
        </Button>
      </div>

      {sources.map((source) => {
        const feed = feeds.get(source);
        const count = listingsOf(feed).filter((l) => !DEPRECATED_PLUGINS.includes(l.id)).length;
        return (
          <div key={source} className="pluginRepo">
            <div className="pluginRepoHead">
              <Text size="sm" mono className="pluginRepoUrl">
                {source.replace(/^https?:\/\//, '')}
              </Text>
              {feed === 'loading' && <Spinner size="sm" />}
              {typeof feed === 'string' && feed !== 'loading' ? (
                <Pill size="sm" tone="danger">
                  {feed}
                </Pill>
              ) : (
                feed !== 'loading' && (
                  <Pill size="sm" tone="neutral">
                    {t('settings.pluginCount', { count })}
                  </Pill>
                )
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('settings.pluginRepoRemoveNamed', { source })}
                onClick={() => setSources(removeSource(source))}
              >
                {t('settings.pluginRepoRemove')}
              </Button>
            </div>
          </div>
        );
      })}
      {sources.length === 0 && (
        <Text size="xs" tone="subtle">
          {t('settings.pluginReposEmpty')}
        </Text>
      )}

      <div className="pluginRepoAdd">
        <Input
          value={adding}
          onChange={(e) => setAdding(e.currentTarget.value)}
          placeholder={t('settings.pluginRepoPlaceholder')}
          aria-label={t('settings.pluginRepoAddress')}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!adding.trim()}
          onClick={() => {
            // Adding a repository is trusting its owner with code that runs
            // inside the app - said out loud, once, at the moment it matters.
            setConfirming(adding.trim());
          }}
        >
          {t('settings.pluginRepoAdd')}
        </Button>
      </div>
    </div>
  );
}
