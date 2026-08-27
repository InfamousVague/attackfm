# AttackFM server

A personal music library, streamed losslessly. One Rust binary, one SQLite
file, one folder of music — a Plex-shaped architecture with everything but
music taken out.

Everyone who uses AttackFM runs their own: the library is your own files on your
own machine, not a service anyone else is on.

## Install

On the machine that will hold the music — a spare computer, a NAS, a cheap VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/InfamousVague/attackfm/main/server/install.sh | sudo sh
```

It asks where your music lives and whether you have a domain, then does the
rest: service account, directories, systemd unit, and — if you gave it a domain
— Caddy with an automatic HTTPS certificate, opening the firewall ports the
certificate check needs. It finishes by printing the address to type into
**Settings → Server** in the app. The first account you create becomes the owner;
after that only the owner can add accounts, because a personal music server that
stayed open to registration would be a public one by the end of the week.

Without a domain it sets up for your local network, which needs no domain, no
port forwarding and no certificate. If you have no domain but want to reach it
from anywhere, `<your-ip>.sslip.io` resolves to your IP and Let's Encrypt will
issue a real certificate for it:

```sh
sudo ./install.sh --domain 203.0.113.10.sslip.io
```

Useful flags: `--music DIR`, `--port`, `--quota GB`, `--no-proxy` (install it but
front it yourself — Tailscale, a Cloudflare tunnel, your own nginx), `-y`.

## Running it by hand

```sh
cargo run                        # http://127.0.0.1:8788, music in ./music
AFM_MUSIC_DIR=~/Music cargo run  # or point it somewhere real
attackfm-server --help           # the environment variables it reads
```

## The idea

**Direct play is the point.** A lossless library streamed losslessly is just
the file, served with byte ranges — no decode, no re-encode, no per-listener CPU
beyond a file read. FLAC and ALAC both play natively in the WebViews this app
runs in, so the `<audio>` element that plays a local file plays a remote one the
same way, and the analyser graph behind the visualiser reads it the same way.

That is why the client needed no player changes to gain a server. A remote track
is modelled as a track whose `path` is an `afm://<id>` URI; every surface that
keys on path — favourites, the queue, the table, search — kept working, and the
one function that turns a path into something playable learned a new scheme.

Transcoding exists for the other case — a phone on a metered connection that
would rather have 256k AAC than 900k FLAC — and is strictly opt-in. It costs a
core per stream, which on a one-vCPU box is the whole machine.

## Configuration

Environment variables only, so the systemd unit is the whole deployment story.

| Variable | Default | What it is |
|---|---|---|
| `AFM_PORT` | `8788` | Port to bind. |
| `AFM_BIND` | `127.0.0.1` | Interface. Loopback, so Caddy is the only way in. |
| `AFM_DATA_DIR` | `./data` | Index, cover-art cache, in-flight uploads. |
| `AFM_MUSIC_DIR` | `./music` | The library. Point at a mounted volume when the disk runs out. |
| `AFM_SERVER_NAME` | `AttackFM` | Shown in the client's server settings. |
| `AFM_QUOTA_GB` | `0` | Library ceiling in GB, refused at upload. 0 = none. |
| `AFM_SCAN_MINUTES` | `15` | Re-walk interval. 0 turns the timer off. |
| `AFM_TRUST_MEMBERS_OF` | – | Another server's URL. Anyone who is a member THERE is admitted here without an invite. Needs `AFM_TRUST_TOKEN` as well; both or neither. |
| `AFM_TRUST_TOKEN` | – | An **admin** token on that server, used only to ask whether a registry account is one of its members. The answer is a bare boolean. |
| `AFM_IMPORTS` | on | Who this box downloads for. `off` refuses everyone - imports, refetch and the collector's own pulls - even with SpotiFLAC installed, so a misrouted import fails loudly instead of filing into the wrong library. `collector` refuses only pasted links: the collector still chooses what to acquire, but offers each download to a peer that has a downloader and never fetches anything itself. An offer nobody takes within a day is forgotten, so the song returns to the pool rather than being condemned. `collector` is what a hub with a separate download box wants; `off` is for a box that should take no part in downloading at all. |

## Modules

| File | Responsibility |
|---|---|
| `main.rs` | Config, state, router, the boot scan and the rescan timer. |
| `db.rs` | SQLite schema and every query. One connection behind a mutex; WAL. |
| `auth.rs` | Argon2 passwords, session tokens, and the stream-token HMAC. |
| `scan.rs` | The incremental library walk: lofty tags, cover-art extraction. |
| `api.rs` | The JSON surface: accounts, library delta, favourites, playlists, resume. |
| `stream.rs` | Range-based direct play, cover art, and the optional transcode. |
| `upload.rs` | Resumable upload, then filing the result by its own tags. |

## Two credentials, deliberately not one

- The **session token** is the account. It rides an `Authorization: Bearer`
  header, is stored server-side, and is revocable per device.
- The **stream token** is a read-only, expiring capability for media bytes. It
  *has* to travel in a query string, because `<audio src>` and `<img src>`
  cannot carry headers — so it is built to be the thing you would rather have
  leak into an access log. It is an HMAC over (user, epoch, expiry), it grants
  nothing but reads, it dies on its own after a week, and bumping a user's
  `stream_epoch` kills every one they hold at once.

Verifying it is a hash and two integer comparisons, so a range request — of
which a seeking media element issues a great many — never touches the database.

## Delta sync

Every scan that changes anything stamps its rows with one new revision.
`GET /api/library?since=N` returns everything above `N`, live rows and
tombstones alike, so a phone that has been away for a day downloads the four
tracks that arrived rather than the ten thousand it already has. Removals sync
too: a deleted file keeps its row with `deleted = 1` so clients learn to drop it.

## API

```
GET  /api/server                     the only unauthenticated call
POST /api/auth/register              open until the first account exists
POST /api/auth/login                 -> session token + stream token
POST /api/auth/logout
GET  /api/me                         -> a freshly minted stream token

GET  /api/library?since=&limit=      the delta
GET  /api/scan                       indexer progress + library size
POST /api/scan                       re-walk now

GET  /api/stream/{id}?t=             the original file, byte ranges. Lossless.
GET  /api/transcode/{id}?t=&bitrate=&seek=   live AAC. Not range-seekable.
GET  /api/art/{id}?t=                cover art, immutable (the id is its hash)

POST /api/upload/init                -> uploadId
GET  /api/upload/{id}                -> how much landed, for resuming
PUT  /api/upload/{id}?offset=        one slice
POST /api/upload/{id}/finish         file it by its tags and index it

GET/PUT    /api/favorites[/{id}]
GET/POST   /api/playlists            PUT/DELETE /api/playlists/{id}
GET/POST   /api/play-state           resume positions, per user per track
GET        /api/users                DELETE /api/users/{id}   (owner only)
POST       /api/users/{id}/revoke    kill that account's stream tokens
```

## Deploying

```sh
cp ../.env.example ../.env   # fill in AFM_DEPLOY_HOST / USER / PASS
npm run redeploy:setup       # first time: user, dirs, systemd unit
npm run redeploy             # after that
```

Then paste `deploy/Caddyfile.snippet` into the box's Caddyfile, set the
hostname, and `systemctl reload caddy`. The redeploy script deliberately does
not edit the Caddyfile itself — that file already serves another site, and a
script that rewrites a live reverse proxy is one that eventually takes the other
site down.

Two things in that snippet are not boilerplate: **no `encode`** (audio is
already compressed, and Caddy's encoder drops the `Content-Length` a media
element needs to seek) and long proxy timeouts (streaming an album is one HTTP
response held open for as long as somebody listens).
