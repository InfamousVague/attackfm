import { Button, Text } from '@glacier/react';
import { Download, LogIn } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { Trans, useT } from '../app/i18n/LocaleShell.tsx';
import { formatBytes } from '../app/ux/format.ts';
import { detectPlatform, PLATFORM_NAMES, type PlatformKey } from './platform.ts';

/**
 * The two doors every landing page offers: open the app if it is on this
 * machine, or fetch it for this machine if it is not.
 *
 * Lifted out of InviteLanding when the jam and profile links arrived. Three
 * pages asking the same question ("what is this browser running, and where is
 * that build?") is one answer, and duplicating it would mean a new platform,
 * a renamed asset or a moved releases page fixing one page and quietly leaving
 * the other two pointing at nothing.
 *
 * The scheme link is the only door a web page HAS to the app - a page cannot
 * know whether the app is installed, so it offers both and lets the tap find
 * out. That is also why the download stays visible rather than appearing only
 * on failure: nothing tells the page the scheme went nowhere.
 */

const REPO = 'InfamousVague/attackfm';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const SITE = 'https://attack.fm/#download';

/** Picks a platform's installer out of a release's asset names - the same
 *  match attack.fm's download grid uses, so both link the same file. */
const MATCH: Record<Exclude<PlatformKey, 'ios'>, (name: string) => boolean> = {
  macos: (n) => n.endsWith('.dmg'),
  windows: (n) => n.endsWith('.msi') || n.endsWith('-setup.exe'),
  linux: (n) => n.endsWith('.AppImage'),
  android: (n) => n.endsWith('.apk'),
};

export interface Installer {
  url: string;
  kind: string;
  size: string;
  version: string | null;
}

/**
 * The installer for this machine, from the latest GitHub release. Tauri
 * stamps the version into every file name, so there is no fixed URL to
 * hard-code; the API is asked once and the file matched by extension. Any
 * failure leaves the button pointing at the releases page, which always
 * works - an unauthenticated API is rate-limited per address.
 */
export function useInstaller(platform: PlatformKey): Installer | null {
  const [found, setFound] = useState<Installer | null>(null);
  useEffect(() => {
    if (platform === 'ios') return undefined;
    const controller = new AbortController();
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((release: { tag_name?: string; assets?: { name: string; browser_download_url: string; size: number }[] }) => {
        const asset = release.assets?.find((a) => MATCH[platform](a.name));
        if (!asset) return;
        setFound({
          url: asset.browser_download_url,
          kind: `.${asset.name.split('.').pop() ?? ''}`,
          size: formatBytes(asset.size),
          version: release.tag_name ?? null,
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [platform]);
  return found;
}

/**
 * @param scheme The app link this page's subject opens, e.g. `i/ABC123`.
 * @param label What the first button says, where "Open in AttackFM" is not
 *   the most useful sentence for this page's subject. Already translated by
 *   the caller - the pages that pass one own the sentence, not this file.
 */
export function AppDoors({ scheme, label }: { scheme: string; label?: string }) {
  const [platform] = useState<PlatformKey>(detectPlatform);
  const installer = useInstaller(platform);
  const t = useT();
  return (
    <div className="doors">
      <Button
        variant="solid"
        size="lg"
        className="door"
        onClick={() => (window.location.href = `attackfm://${scheme}`)}
      >
        <LogIn size={16} /> {label ?? t('landing.openInApp')}
      </Button>
      {platform === 'ios' ? (
        <Text tone="muted" size="sm" className="door__note">
          {/* One sentence with the link inside it: which half of it the link
              sits on is a translator's decision, not a layout one. */}
          <Trans i18nKey="landing.noAppStoreYet" components={{ a: <a href={SITE} /> }} />
        </Text>
      ) : (
        <>
          <Button
            variant="outline"
            size="lg"
            className="door"
            onClick={() => (window.location.href = installer?.url ?? RELEASES)}
          >
            {/* The extension and the size are not part of the sentence -
                they are two facts hung off it, joined by punctuation, so
                they stay out of the catalogue entry. */}
            <Download size={16} /> {t('landing.downloadFor', { platform: PLATFORM_NAMES[platform] })}
            {installer ? ` · ${installer.kind} · ${installer.size}` : ''}
          </Button>
          <Text tone="muted" size="xs" className="door__note">
            {installer?.version ? `${installer.version} · ` : ''}
            <a href={SITE}>{t('landing.otherPlatforms')}</a>
          </Text>
        </>
      )}
    </div>
  );
}
