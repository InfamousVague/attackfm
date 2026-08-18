import { useEffect, useState } from 'react';
import { AppWindow, Apple, Download, Smartphone, Terminal } from '@glacier/icons';
import { Reveal } from '../components/Reveal.tsx';

const REPO = 'InfamousVague/attackfm';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

interface Platform {
  key: string;
  icon: typeof Apple;
  name: string;
  detail: string;
  /** Picks this platform's asset out of a release. */
  match: (assetName: string) => boolean;
  /** What the file is, when no asset has been resolved yet. */
  kind: string;
}

const PLATFORMS: Platform[] = [
  {
    key: 'macos',
    icon: Apple,
    name: 'macOS',
    detail: 'Apple silicon and Intel, in one build',
    match: (n) => n.endsWith('.dmg'),
    kind: '.dmg',
  },
  {
    key: 'windows',
    icon: AppWindow,
    name: 'Windows',
    detail: 'Windows 10 and 11, 64-bit',
    match: (n) => n.endsWith('.msi') || n.endsWith('-setup.exe'),
    kind: '.msi',
  },
  {
    key: 'linux',
    icon: Terminal,
    name: 'Linux',
    detail: 'AppImage, or a .deb for Debian and Ubuntu',
    match: (n) => n.endsWith('.AppImage'),
    kind: '.AppImage',
  },
  {
    key: 'android',
    icon: Smartphone,
    name: 'Android',
    detail: 'Sideload the APK, or add it to Android Auto',
    match: (n) => n.endsWith('.apk'),
    kind: '.apk',
  },
];

interface Resolved {
  url: string;
  size: string;
  /** Extension of the asset actually linked, so the label cannot contradict it. */
  kind: string;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Resolve each platform's file from the latest GitHub release.
 *
 * Tauri stamps the version into every bundle name, so there is no stable
 * `releases/latest/download/<name>` URL to hard-code. Asking the API once and
 * matching on extension keeps the buttons correct across version bumps.
 *
 * Every failure path leaves the buttons pointing at the releases page, which is
 * always a working destination: an unauthenticated API is rate-limited per IP,
 * and a landing page must not depend on it.
 */
function useReleaseAssets(): { assets: Record<string, Resolved>; version: string | null } {
  const [assets, setAssets] = useState<Record<string, Resolved>>({});
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((release: { tag_name?: string; assets?: { name: string; browser_download_url: string; size: number }[] }) => {
        const found: Record<string, Resolved> = {};
        for (const platform of PLATFORMS) {
          const asset = release.assets?.find((a) => platform.match(a.name));
          if (asset) {
            found[platform.key] = {
              url: asset.browser_download_url,
              size: megabytes(asset.size),
              // Read the extension off the file being linked. Windows publishes
              // both an .msi and an NSIS -setup.exe, and whichever the API lists
              // first is the one linked; a hard-coded label said ".msi" while
              // pointing at the .exe.
              kind: `.${asset.name.split('.').pop() ?? ''}`,
            };
          }
        }
        setAssets(found);
        setVersion(release.tag_name ?? null);
      })
      .catch(() => {
        /* Buttons keep their fallback href. */
      });
    return () => controller.abort();
  }, []);

  return { assets, version };
}

export function Downloads() {
  const { assets, version } = useReleaseAssets();

  return (
    <section className="section section--ruled" id="download">
      <div className="wrap wrap--wide">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">Download</p>
          <h2 className="h2">Pick your machine.</h2>
          <p className="lead">
            The same app on every platform, built from one source tree.
            {version ? ` Currently ${version}.` : ''}
          </p>
        </Reveal>

        <div className="grid downloads__grid">
          {PLATFORMS.map((platform, index) => {
            const resolved = assets[platform.key];
            return (
              <Reveal key={platform.key} delay={index * 70}>
                <a className="card card--lit download" href={resolved?.url ?? RELEASES}>
                  <span className="card__icon">
                    <platform.icon size={20} />
                  </span>
                  <h3 className="h3">{platform.name}</h3>
                  <p className="body download__detail">{platform.detail}</p>
                  <span className="download__cta">
                    <Download size={16} />
                    {resolved ? `${resolved.kind} · ${resolved.size}` : platform.kind}
                  </span>
                </a>
              </Reveal>
            );
          })}
        </div>

        {/* Nothing to install, so it does not belong in the grid of installers
            above - but it is the fastest way to try the thing this whole page
            is about, and burying it under the fold would be a strange choice. */}
        <Reveal delay={100} className="center">
          <p className="body downloads__note">
            Or don’t install anything:{' '}
            <a className="downloads__link" href="/listen/">
              open AttackFM in your browser
            </a>
            . Same app, same server, nothing to download — you’ll want a desktop-sized
            window, and offline downloads stay with the installed builds.
          </p>
        </Reveal>

        <Reveal delay={120} className="center">
          <p className="body downloads__note">
            Linux also ships a <code>.deb</code> and an <code>.rpm</code>, and Windows an{' '}
            <code>.msi</code>, all on the{' '}
            <a className="downloads__link" href={RELEASES}>
              releases page
            </a>
            . iPhone and iPad build from the same source; there is no App Store listing yet.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
