import {
  BadgeCheck,
  FolderTree,
  HardDrive,
  KeyRound,
  RefreshCw,
  Server,
  Share2,
  Users,
} from '@glacier/icons';
import { Reveal } from '../components/Reveal.tsx';

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
          <text
            x={node.x}
            y={node.y - 15}
            className="topo__label"
            textAnchor="middle"
          >
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Yours() {
  return (
    <section className="section section--ruled" id="yours">
      <div className="wrap wrap--wide">
        <Reveal className="stack center sectionHead">
          <p className="eyebrow">Self-hosted</p>
          <h2 className="h2">
            No subscription. No catalogue that can be <span className="accent">taken back</span>.
          </h2>
          <p className="lead">
            AttackFM is a server you run and an app that talks to it. The music is your files on your
            disk — nothing here rents you access to a library somebody else controls.
          </p>
        </Reveal>

        <Reveal delay={100} className="topoWrap">
          <Topology />
        </Reveal>

        <div className="grid yours__grid">
          {[
            {
              icon: Server,
              title: 'One binary',
              body: 'Drop it on a Mac, a Linux box or a spare machine under the desk. It scans your folder and starts serving.',
            },
            {
              icon: FolderTree,
              title: 'Your folder structure',
              body: 'It reads what you already have. No re-organising your disk to suit a database.',
            },
            {
              icon: HardDrive,
              title: 'Your files, untouched',
              body: 'Originals stay exactly as they are. Transcoding happens on the way out when a device needs it.',
            },
            {
              icon: KeyRound,
              title: 'Accounts you control',
              body: 'Sign-in runs through your own registry, with invites you issue and can revoke.',
            },
            {
              icon: Users,
              title: 'Friends, not followers',
              body: 'Invite people to your server. Share a queue and listen together, in time.',
            },
            {
              icon: RefreshCw,
              title: 'Updates over the air',
              body: 'The app refreshes itself from your hub, so a fix reaches every device without a store review.',
            },
          ].map((item, i) => (
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

        <Reveal delay={80}>
          <div className="stats">
            {[
              { value: '8', label: 'Audio formats read' },
              { value: '3', label: 'Platforms' },
              { value: '15 GB', label: 'On-device cache' },
              { value: '0', label: 'Monthly fee' },
            ].map((stat) => (
              <div className="stat" key={stat.label}>
                <div className="stat__value">{stat.value}</div>
                <div className="stat__label">{stat.label}</div>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={140} className="center">
          <p className="pill" style={{ marginTop: '1.5rem' }}>
            <BadgeCheck size={15} />
            Bring your own music
            <Share2 size={15} />
          </p>
        </Reveal>
      </div>
    </section>
  );
}
