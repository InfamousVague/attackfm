import { Banner, Button, Card, Label, Modal, Pill, SegmentedControl, Switch, Text } from '@glacier/react';
import { Blocks, Trash2 } from '@glacier/icons';
import { useMemo, useState } from 'react';
import type { Plugin } from '../../plugins/types.ts';
import { uninstallPlugin, type RemotePluginListing } from '../../plugins/remote.ts';
import { usePlugins } from '../../plugins/runtime.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import {
  PluginBrowse,
  PluginSources,
  PluginUpdates,
  useInstaller,
  useRepoFeeds,
} from './pluginRepos.tsx';
import { isNewer, listingsOf } from './pluginFeeds.ts';

/**
 * What a plugin adds to the app, read off the plugin object itself rather
 * than declared in its listing - contributions derived from the contract
 * cannot drift from what actually mounts.
 */
function pluginContributions(p: Plugin, t: ReturnType<typeof useT>): string[] {
  return [
    ...(p.slots?.['titlebar-end'] ? [t('settings.pluginAddsTitlebar')] : []),
    ...(p.slots?.['player-trailing'] ? [t('settings.pluginAddsPlayer')] : []),
    // The tab NAMES come from the plugin, not the catalogue - a plugin ships
    // its own labels - so only the sentence around them is translated.
    ...(p.settingsSections?.length
      ? [t('settings.pluginAddsSettings', { tabs: p.settingsSections.map((s) => s.label).join(', ') })]
      : []),
    ...(p.playlistTiles?.length ? [t('settings.pluginAddsTiles')] : []),
    ...(p.downloads?.length ? [t('settings.pluginAddsDownloads')] : []),
    ...(p.usePaletteCommands ? [t('settings.pluginAddsPalette')] : []),
    ...(p.Provider ? [t('settings.pluginAddsProvider')] : []),
  ];
}

/**
 * One listing on the marketplace shelf. The whole card is a doorway to the
 * detail dialog - a stretched button behind the content, so the card stays a
 * plain div and the switch a sibling above it, never a control nested inside
 * a control - while the switch flips the plugin without opening anything.
 */
function PluginCard({
  plugin,
  enabled,
  crashed,
  onToggle,
  onOpen,
}: {
  plugin: Plugin;
  enabled: boolean;
  crashed: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <Card interactive className="pluginCard">
      <button
        type="button"
        className="pluginCardOpen"
        aria-label={t('settings.pluginAbout', { name: plugin.name })}
        onClick={onOpen}
      />
      <div className="pluginCardTop">
        <span className="pluginCardIcon" aria-hidden="true">
          {plugin.icon ?? <Blocks size={22} />}
        </span>
        {/* Above the doorway, so a flip is a flip and never a navigation. */}
        <span className="pluginCardSwitch">
          <Switch
            aria-label={t('settings.pluginEnable', { name: plugin.name })}
            checked={enabled}
            onCheckedChange={onToggle}
          />
        </span>
      </div>
      <div className="pluginCardName">
        <Text weight="semibold">{plugin.name}</Text>
        {(plugin.author || plugin.version) && (
          <Text size="xs" tone="subtle">
            {[plugin.author, plugin.version].filter(Boolean).join(' · ')}
          </Text>
        )}
      </div>
      <Text size="sm" tone="muted" className="pluginCardBlurb">
        {plugin.description}
      </Text>
      <div className="pluginCardTags">
        {crashed && (
          <Pill size="sm" tone="danger">
            {t('settings.pluginCrashed')}
          </Pill>
        )}
        {(plugin.tags ?? []).map((tag) => (
          <Pill key={tag} size="sm" tone="neutral">
            {tag}
          </Pill>
        ))}
      </div>
    </Card>
  );
}

/** The detail dialog's uninstall control: removes the stored bundle. */
function UninstallButton({
  pluginId,
  name,
  onDone,
}: {
  pluginId: string;
  name: string;
  onDone: () => void;
}) {
  const { reloadRemote } = usePlugins();
  const t = useT();
  return (
    <Button
      variant="danger"
      onClick={() => {
        uninstallPlugin(pluginId);
        reloadRemote();
        onDone();
      }}
      aria-label={t('settings.pluginUninstallNamed', { name })}
    >
      <Trash2 size={15} /> <span>{t('settings.pluginUninstall')}</span>
    </Button>
  );
}

/**
 * The marketplace: every registered plugin as a card on a shelf, each opening
 * a detail dialog that says what it is, what it adds, and holds the switch.
 * Core rather than a contribution, so the shelf cannot vanish when the plugin
 * being toggled owns the selected section.
 */
export function PluginsSettings() {
  const t = useT();
  const { all, isEnabled, setEnabled, failures, remoteInstalled, reloadRemote } = usePlugins();
  // The id, not the object: a plugin pulled mid-session closes its dialog
  // instead of showing a ghost of it.
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<'browse' | 'sources'>('browse');
  const open = all.find((p) => p.id === openId) ?? null;
  const openFailure = open ? failures.get(open.id) : undefined;
  const openRemote = open ? remoteInstalled.get(open.id) : undefined;
  const enabledCount = all.filter((p) => isEnabled(p.id)).length;

  const { sources, setSources, feeds, refresh, loading } = useRepoFeeds();
  const { busyId, install, error: installError, clearError } = useInstaller(reloadRemote);

  // Installed plugins a repository is offering a higher version of. Computed
  // across every source, so a plugin that moved repositories still updates -
  // but one offer per plugin: mirrored repos would otherwise stack a banner
  // row for each copy. The highest version on offer wins.
  const updates = useMemo(() => {
    const found = new Map<string, { source: string; listing: RemotePluginListing; from: string }>();
    for (const [source, feed] of feeds) {
      for (const listing of listingsOf(feed)) {
        const installed = remoteInstalled.get(listing.id);
        if (!installed || !isNewer(listing.version, installed.version)) continue;
        const seen = found.get(listing.id);
        if (!seen || isNewer(listing.version, seen.listing.version)) {
          found.set(listing.id, { source, listing, from: installed.version });
        }
      }
    }
    return [...found.values()];
  }, [feeds, remoteInstalled]);

  return (
    <div className="prefsBody">
      {installError && (
        <Banner tone="danger" onDismiss={clearError}>
          {installError}
        </Banner>
      )}
      <PluginUpdates updates={updates} busyId={busyId} onUpdate={(s, l) => void install(s, l)} />

      <SegmentedControl
        aria-label={t('settings.pluginsView')}
        fullWidth
        value={tab}
        onValueChange={(next) => setTab(next as typeof tab)}
        options={[
          { value: 'browse', label: t('settings.pluginsBrowse') },
          { value: 'sources', label: t('settings.pluginsSources') },
        ]}
      />

      {tab === 'browse' ? (
        <>
          {/* One entry, not "N plugins" + " · " + "M enabled": the count and
              the sentence around it have to be reorderable together, and the
              plural rides on the plugin count while `enabled` is a plain
              number inside the same sentence. */}
          <Text size="sm" tone="muted">
            {t('settings.pluginsIntro', { count: all.length, enabled: enabledCount })}
          </Text>
          <div className="pluginMarket">
            {all.map((p) => (
              <PluginCard
                key={p.id}
                plugin={p}
                enabled={isEnabled(p.id)}
                crashed={failures.has(p.id)}
                // The switch is the user's setting, not the running state: a
                // crashed plugin stays checked and says so on the card, so one
                // flip OFF turns it off for good rather than retrying it first.
                // Either flip clears the crash flag, so off-and-on is the retry.
                onToggle={(on) => setEnabled(p.id, on)}
                onOpen={() => setOpenId(p.id)}
              />
            ))}
          </div>
          <Text tone="subtle" size="xs">
            {t('settings.pluginsToggleNote')}
          </Text>

          <div className="prefsSection">
            <Label>{t('settings.pluginsAvailable')}</Label>
            <PluginBrowse
              feeds={feeds}
              remoteInstalled={remoteInstalled}
              busyId={busyId}
              loading={loading}
              onInstall={(s, l) => void install(s, l)}
            />
          </div>
        </>
      ) : (
        <PluginSources
          sources={sources}
          setSources={setSources}
          feeds={feeds}
          onRefresh={refresh}
        />
      )}


      {/* The detail dialog, stacked over the settings modal - the kit's layer
          stack peels Escape one dialog at a time. */}
      <Modal
        open={open !== null}
        onClose={() => setOpenId(null)}
        size="sm"
        title={
          open && (
            <span className="pluginDetailTitle">
              <span className="pluginCardIcon" aria-hidden="true">
                {open.icon ?? <Blocks size={22} />}
              </span>
              <span>
                {open.name}
                {(open.author || open.version) && (
                  <Text as="span" size="xs" tone="subtle" className="pluginDetailByline">
                    {[open.author, open.version].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </span>
            </span>
          )
        }
        footer={
          open && (
            <>
              {openRemote && (
                <UninstallButton
                  pluginId={open.id}
                  name={open.name}
                  onDone={() => setOpenId(null)}
                />
              )}
              <Button
                variant={isEnabled(open.id) ? 'ghost' : 'solid'}
                onClick={() => setEnabled(open.id, !isEnabled(open.id))}
              >
                {isEnabled(open.id) ? t('settings.pluginTurnOff') : t('settings.pluginTurnOn')}
              </Button>
            </>
          )
        }
      >
        {open && (
          <div className="pluginDetail">
            {openFailure !== undefined && (
              <Text size="sm" tone="danger">
                {t('settings.pluginCrashedDetail', { reason: openFailure })}
              </Text>
            )}
            <div className="pluginCardTags">
              {(open.tags ?? []).map((tag) => (
                <Pill key={tag} size="sm" tone="neutral">
                  {tag}
                </Pill>
              ))}
            </div>
            <Text size="sm">{open.details ?? open.description}</Text>
            {pluginContributions(open, t).length > 0 && (
              <div className="pluginDetailAdds">
                <Text size="xs" tone="subtle" weight="semibold">
                  {t('settings.pluginAdds')}
                </Text>
                <ul className="pluginDetailList">
                  {pluginContributions(open, t).map((line) => (
                    <li key={line}>
                      <Text as="span" size="sm" tone="muted">
                        {line}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
