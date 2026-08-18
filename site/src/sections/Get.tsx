import { useCallback, useState } from 'react';
import { Apple, Check, Copy, GitBranch, Smartphone, Terminal } from '@glacier/icons';
import { Reveal } from '../components/Reveal.tsx';

const REPO = 'https://github.com/InfamousVague/attackfm';
const RELEASES = `${REPO}/releases/latest`;
const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/InfamousVague/attackfm/main/server/install.sh | sudo sh';

/** The server one-liner, with a copy button that reports what it did. */
function InstallLine() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // Clipboard access can be refused (insecure context, denied permission);
    // failing silently would leave the button looking broken.
    navigator.clipboard
      .writeText(INSTALL)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, []);

  return (
    <div className="install">
      <span className="install__prompt" aria-hidden="true">
        <Terminal size={15} />
      </span>
      <code className="install__code">{INSTALL}</code>
      <button type="button" className="iconBtn install__copy" onClick={copy} aria-label="Copy install command">
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

export function Get() {
  return (
    <section className="section get" id="get">
      <div className="aurora" aria-hidden="true">
        <div className="aurora__blob aurora__blob--a" />
      </div>

      <div className="wrap">
        <Reveal className="stack center">
          <p className="eyebrow">Get started</p>
          <h2 className="h2">Two steps: run the server, open the app.</h2>
          <p className="lead">
            The installer sets up the service and, if you point a domain at the box, HTTPS with it.
            Then sign in from any device and your library is there.
          </p>
        </Reveal>

        <Reveal delay={100}>
          <InstallLine />
        </Reveal>

        <Reveal delay={180}>
          <div className="cluster center get__buttons">
            <a className="btn btn--primary" href={RELEASES}>
              <Smartphone size={18} />
              Download for Android
            </a>
            <a className="btn btn--ghost" href={REPO}>
              <GitBranch size={17} />
              Source on GitHub
            </a>
          </div>
        </Reveal>

        <Reveal delay={240} className="center">
          <p className="body get__note">
            <Apple size={14} /> iOS, iPadOS, macOS, Windows and Linux build from the same source.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
