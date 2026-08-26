import { useCallback, useState } from 'react';
import {
  Check,
  Copy,
  FolderTree,
  GitBranch,
  HardDrive,
  KeyRound,
  RefreshCw,
  Server,
  Terminal,
  Users,
} from '@glacier/icons';
import { Reveal } from '../components/Reveal.tsx';

const REPO = 'https://github.com/InfamousVague/attackfm';
const INSTALL =
  'curl -fsSL https://raw.githubusercontent.com/InfamousVague/attackfm/main/server/install.sh | sudo sh';

/**
 * The topology, drawn rather than described.
 *
 * Inline SVG so it inherits currentColor and the accent token, and therefore
 * works in both themes without a second asset. Stroke-dash animation runs on
 * the GPU and is the only thing moving.
 */
function Topology() {
  return (
    <svg
      className="topo"
      viewBox="0 0 520 240"
      role="img"
      aria-label="Your server at the centre, streaming to a phone, a desktop and a car"
    >
      <defs>
        <linearGradient id="topo-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--glacier-accent-9)" stopOpacity="0.15" />
          <stop offset="50%" stopColor="var(--glacier-accent-9)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--glacier-accent-9)" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* Links, drawn first so the nodes sit on top of them. */}
      {[
        'M260,120 C200,120 170,52 96,52',
        'M260,120 C200,120 170,120 96,120',
        'M260,120 C200,120 170,188 96,188',
        'M260,120 C320,120 350,86 424,86',
        'M260,120 C320,120 350,154 424,154',
      ].map((d, i) => (
        <path
          key={d}
          className="topo__link"
          d={d}
          fill="none"
          stroke="url(#topo-line)"
          strokeWidth="1.5"
          style={{ animationDelay: `${i * 420}ms` }}
        />
      ))}

      {/* The server. */}
      <g className="topo__hub">
        <circle cx="260" cy="120" r="34" className="topo__hubRing" />
        <circle cx="260" cy="120" r="26" className="topo__hubCore" />
      </g>

      {[
        { x: 96, y: 52, label: 'Phone' },
        { x: 96, y: 120, label: 'Desktop' },
        { x: 96, y: 188, label: 'Car' },
        { x: 424, y: 86, label: 'Your drive' },
        { x: 424, y: 154, label: 'Friends' },
      ].map((node) => (
        <g key={node.label}>
          <circle cx={node.x} cy={node.y} r="7" className="topo__node" />
          <text x={node.x} y={node.y - 15} className="topo__label" textAnchor="middle">
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

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
      <button
        type="button"
        className="iconBtn install__copy"
        onClick={copy}
        aria-label="Copy install command"
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

const FACTS = [
  {
    icon: Server,
    title: 'One binary',
    body: 'Drop it on a Mac, a Linux box or a spare machine under the desk. It scans your folder and starts serving.',
  },
  {
    icon: FolderTree,
    title: 'Your folder structure',
    body: 'It reads the folders you already keep. Nothing has to be rearranged to suit a database.',
  },
  {
    icon: HardDrive,
    title: 'Your files, untouched',
    body: 'Originals stay exactly as they are. Transcoding happens on the way out, when a device needs it.',
  },
  {
    icon: KeyRound,
    title: 'Accounts you control',
    body: 'Sign-in runs through your own registry, with invites you issue and can revoke.',
  },
  {
    icon: Users,
    title: 'Friends',
    body: 'Invite people to your server. Share a queue and listen together, in time.',
  },
  {
    icon: RefreshCw,
    title: 'Updates over the air',
    body: 'The app refreshes itself from your hub, so a fix reaches every device without a store review.',
  },
];

export function Yours() {
  return (
    <section className="section section--ruled" id="yours">
      <div className="wrap wrap--wide">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">Self-hosted</p>
          <h2 className="h2">
            You run the server. You keep the <span className="accent">files</span>.
          </h2>
          <p className="lead">
            AttackFM is a server you run and an app that connects to it. The music is the files
            already sitting on your disk, played back from where they are.
          </p>
        </Reveal>

        <Reveal delay={100} className="topoWrap">
          <Topology />
        </Reveal>

        <div className="grid yours__grid">
          {FACTS.map((item, i) => (
            <Reveal key={item.title} delay={i * 70}>
              <article className="card">
                <span className="card__icon">
                  <item.icon size={20} />
                </span>
                <h3 className="h3">{item.title}</h3>
                <p className="body">{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>

        {/* The install line lives here rather than in a section of its own: the
            claim above is "you run the server", and this is what running it
            actually looks like. */}
        <Reveal delay={80} className="stack center yours__install">
          <h3 className="h3">Start the server</h3>
          <p className="body">
            The installer sets up the service and, if you point a domain at the box, HTTPS with it.
            Then sign in from any device and your library is there.
          </p>
          <InstallLine />
          <a className="btn btn--ghost" href={REPO}>
            <GitBranch size={17} />
            Source on GitHub
          </a>
        </Reveal>
      </div>
    </section>
  );
}
