# AttackFM — Home Server Setup (goals & handoff)

This file is the running plan for **moving AttackFM's main server off the VPS and
onto a home MacBook Air**, so a Claude session on the target machine can pick up
mid-stream. Update it as steps complete.

---

## Objective

Self-host the AttackFM **main** server (the one behind `matt.attack.fm` today) on
a home **Apple-silicon MacBook Air, 24 GB RAM**, running **24/7**. Start **fresh** —
do **not** migrate the old VPS library/DB. The Air also has enough headroom to run
**local AI models for the DJ / discovery** (Ollama), which the VPS could not.

We are **decommissioning the current big VPS** (`155.138.231.189`) for this app.
The **identity registry** (`registry.attack.fm`) will move to a separate **small,
cheap** server (it is tiny and stateless-ish; it does not belong on the home box).

## The one hard constraint: CGNAT

The home network is behind **carrier-grade NAT** — there is **no public IP** and
**port-forwarding is impossible**. The home Mac therefore cannot be reached from
the internet on its own. Something with a public presence must accept the inbound
connection and pass it down an **outbound-initiated tunnel** to the Mac. Dropping
the VPS does not remove this requirement; it only changes *what* is the front door.

## Front door — DECISION PENDING (pick one before wiring DNS)

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Cloudflare Tunnel** | `cloudflared` on the Mac dials out to Cloudflare; `home.attack.fm` (our domain) resolves to the tunnel. | Free. No server to run. Branded domain + auto-HTTPS. Simplest. | Cloudflare free-tier ToS restricts proxying large amounts of audio/video — a music streamer is exactly that pattern. Low-but-nonzero risk of throttling. |
| **B. Tiny relay VPS + WireGuard** | A small cheap box runs Caddy + WireGuard; the Mac dials out over WG; Caddy reverse-proxies `matt.attack.fm` → Mac. | No media ToS. Keeps the exact `matt.attack.fm` setup we have now. **Can also host the registry** we're moving anyway → one box, one bill. | Still one (small) VPS to pay for and manage. Stream bandwidth flows through it. |
| **C. Tailscale (+ Funnel)** | Mesh VPN; Mac + phone join a tailnet; app connects to the Mac's `100.x`/MagicDNS name. Funnel exposes a public `*.ts.net` URL. | Free for personal use. No media ToS (it's a VPN, not a CDN). Dead simple. | Plain Tailscale = only devices running the Tailscale client can connect (fine for personal, awkward for friends). Funnel = `ts.net` hostname, not our domain; bandwidth-limited. |

**Recommendation:** Because a small server is being provisioned for the registry
regardless, **Option B** consolidates registry + front-door on one cheap box, keeps
our own domain, and avoids the streaming-ToS question entirely. **Option A** is the
right pick if the goal is truly *zero* servers and the ToS risk is acceptable.

## Status

- [x] Rust toolchain present on the Mac (`cargo` / `rustc` 1.94+).
- [x] Server builds **natively** on arm64 macOS:
      `cd server && cargo build --release --bin attackfm-server`
- [x] Server **runs and serves** `/api/server` against home dirs; ffmpeg/transcode
      detected; empty library (`needsSetup: true`, 0 tracks).
- [x] Home data layout created: `~/AttackFM/data`, `~/AttackFM/music`.
- [ ] **Pick the front door** (A / B / C above).
- [ ] Install the tunnel/relay and get a public hostname resolving to the Mac.
- [ ] Run the server under **launchd** so it survives logout/reboot and restarts on
      crash (bind to loopback or the tunnel interface — never the raw LAN).
- [ ] Create the admin user + first library import; verify from **outside** the house
      (phone on cellular).
- [ ] Point the iOS/desktop app's server URL at the new host; confirm login/pairing.
- [ ] Move the **registry** to its own small server; repoint `registry.attack.fm`.
- [ ] Wire **Ollama** on the Mac for the DJ/discovery (`AFM_AI_URL`,
      `AFM_AI_EMBED_MODEL`).

## Run command (local smoke test)

```bash
cd server
AFM_BIND=127.0.0.1 \
AFM_PORT=8788 \
AFM_DATA_DIR="$HOME/AttackFM/data" \
AFM_MUSIC_DIR="$HOME/AttackFM/music" \
AFM_SERVER_NAME="AttackFM (home)" \
AFM_PUBLIC_URL="https://matt.attack.fm" \
./target/release/attackfm-server
# then: curl -s http://127.0.0.1:8788/api/server
```

## Environment reference (read in `server/src/main.rs`)

| Var | Default | Meaning |
|---|---|---|
| `AFM_BIND` | `127.0.0.1` | Interface to bind. Keep on loopback (or the tunnel iface) so only the front door reaches it — never the open LAN. |
| `AFM_PORT` | `8788` | Listen port. |
| `AFM_DATA_DIR` | `./data` | SQLite DB, art cache, in-flight uploads, import scratch. |
| `AFM_MUSIC_DIR` | `./music` | The library. Point at an external volume when the SSD fills. |
| `AFM_SERVER_NAME` | `AttackFM` | Shown in the client's server settings. |
| `AFM_QUOTA_GB` | `0` | Library ceiling in GB (0 = none). |
| `AFM_SCAN_MINUTES` | `15` | Rescan interval (0 = off). |
| `AFM_PUBLIC_URL` | *(empty)* | Public origin, e.g. `https://matt.attack.fm` — needed for Spotify OAuth redirect. |
| `AFM_PLUGINS_DIR` | `<data>/plugins` | Plugin repo served at `/plugins`. |
| `AFM_AI_URL` | — | Local AI endpoint for discovery/DJ, e.g. `http://127.0.0.1:11434` (Ollama). |
| `AFM_AI_EMBED_MODEL` | — | Embedding model, e.g. `nomic-embed-text`. |
| `AFM_SPOTIFY_CLIENT_ID` / `_SECRET` | — | Hub Spotify app (import + OAuth). |
| `AFM_SPOTIFY_SP_DC` | — | Logged-in Spotify cookie for Canvas (a **secret**; set via env only, never commit). |

> Secrets (`AFM_SPOTIFY_SP_DC`, client secret, any deploy creds) live only in the
> gitignored `.env` / the launchd plist on the box — never in this repo.

## Notes for the on-machine session

- The binary is `server/target/release/attackfm-server`; rebuild with the cargo
  command above after pulling.
- "Start fresh" is the intent — leave `~/AttackFM/{data,music}` empty and create the
  admin user through the app's first-run setup.
- A laptop lid-close/sleep drops the tunnel; set the Air to never sleep on AC
  (`caffeinate`, or Energy settings) once it's the permanent host.
