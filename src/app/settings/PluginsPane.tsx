import { Banner, Button, Card, Label, Modal, Pill, SegmentedControl, Switch, Text } from '@glacier/react';
import { Blocks, Trash2 } from '@glacier/icons';
import { useMemo, useState } from 'react';
import type { Plugin } from '../../plugins/types.ts';
import { uninstallPlugin, type RemotePluginListing } from '../../plugins/remote.ts';
import { usePlugins } from '../../plugins/runtime.tsx';
import {
  isNewer,
  listingsOf,
  PluginBrowse,
  PluginSources,
  PluginUpdates,
  useInstaller,
  useRepoFeeds,
} from './pluginRepos.tsx';

/**
 * What a plugin adds to the app, read off the plugin object itself rather
 * than declared in its listing - contributions derived from the contract
 * cannot drift from what actually mounts.
 */
function pluginContributions(p: Plugin): string[] {
  return [
    ...(p.slots?.['titlebar-end'] ? ['A title bar button'] : []),
    ...(p.slots?.['player-trailing'] ? ['A player strip control'] : []),
    ...(p.settingsSections?.length
      ? [`A settings tab: ${p.settingsSections.map((s) => s.label).join(', ')}`]
      : []),
    ...(p.playlistTiles?.length ? ['Playlist tiles on the home strip'] : []),
    ...(p.downloads?.length ? ['A queue on the Downloads page'] : []),
    ...(p.usePaletteCommands ? ['Command palette actions'] : []),
    ...(p.Provider ? ['A background service while enabled'] : []),
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
  return (
    <Card interactive className="pluginCard">
      <button
        type="button"
        className="pluginCardOpen"
        aria-label={`About ${plugin.name}`}
        onClick={onOpen}
      />
      <div className="pluginCardTop">
        <span className="pluginCardIcon" aria-hidden="true">
          {plugin.icon ?? <Blocks size={22} />}
        </span>
        {/* Above the doorway, so a flip is a flip and never a navigation. */}
        <span className="pluginCardSwitch">
          <Switch
            aria-label={`Enable ${plugin.name}`}
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
            Crashed
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
  return (
    <Button
      variant="danger"
      onClick={() => {
        uninstallPlugin(pluginId);
        reloadRemote();
        onDone();
      }}
      aria-label={`Uninstall ${name}`}
    >
      <Trash2 size={15} /> <span>Uninstall</span>
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
        aria-label="Plugins view"
        fullWidth
        value={tab}
        onValueChange={(next) => setTab(next as typeof tab)}
        options={[
          { value: 'browse', label: 'Browse' },
          { value: 'sources', label: 'Sources' },
        ]}
      />

      {tab === 'browse' ? (
        <>
          <Text size="sm" tone="muted">
            {all.length === 1 ? '1 plugin' : `${all.length} plugins`} · {enabledCount} enabled.
            Flip one on to add what it carries, off to put it away. Plugins install
            from the repositories under Sources and run locally once installed.
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
            Toggles apply immediately; switching a plugin may briefly restart playback.
            Work a plugin already handed to the app&rsquo;s engine - queued downloads,
            say - carries on in the background without its controls until it is
            switched back on.
          </Text>

          <div className="prefsSection">
            <Label>Available</Label>
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
                {isEnabled(open.id) ? 'Disable' : 'Enable'}
              </Button>
            </>
          )
        }
      >
        {open && (
          <div className="pluginDetail">
            {openFailure !== undefined && (
              <Text size="sm" tone="danger">
                Crashed this session ({openFailure}). Disable and enable to try again.
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
            {pluginContributions(open).length > 0 && (
              <div className="pluginDetailAdds">
                <Text size="xs" tone="subtle" weight="semibold">
                  Adds to the app
                </Text>
                <ul className="pluginDetailList">
                  {pluginContributions(open).map((line) => (
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
