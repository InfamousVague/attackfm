#!/bin/sh
# AttackFM server installer.
#
#   curl -fsSL https://get.attackfm.app/install.sh | sudo sh
#   sudo ./install.sh --music /srv/music --domain music.example.com
#
# Everyone who uses AttackFM runs their own server - the library is your own
# files on your own machine, not a service anyone else is on. This script is the
# whole setup: it makes a service account, lays out the directories, writes the
# systemd unit, and (if you have a domain) points Caddy at it with automatic
# HTTPS. It asks before it changes anything it did not create.
#
# POSIX sh on purpose: it has to run on whatever a cheap VPS shipped with,
# which is not always bash.

set -eu

VERSION="0.1.0"
REPO="InfamousVague/attackfm"
SERVICE="attackfm"
SERVICE_USER="attackfm"
PREFIX="/opt/attackfm"
PORT="8788"

# --- how this looks -------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
	GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); CYAN=$(printf '\033[36m')
	YELLOW=$(printf '\033[33m')
else
	B=''; DIM=''; R=''; GREEN=''; RED=''; CYAN=''; YELLOW=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸%s %s%s%s\n' "$CYAN" "$R" "$B" "$*" "$R"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$R" "$*"; }
die()  { printf '\n%s✗%s %s\n\n' "$RED" "$R" "$*" >&2; exit 1; }

# Prompts default to the second argument when the answer is empty. Reads from
# the terminal rather than stdin, so `curl | sh` can still ask questions - piped
# into sh, stdin is the script itself.
ask() {
	_prompt="$1"; _default="${2:-}"
	if [ "$ASSUME_YES" = "1" ]; then printf '%s' "$_default"; return; fi
	if [ -n "$_default" ]; then
		printf '%s %s[%s]%s ' "$_prompt" "$DIM" "$_default" "$R" > /dev/tty
	else
		printf '%s ' "$_prompt" > /dev/tty
	fi
	if [ -r /dev/tty ]; then read -r _answer < /dev/tty; else _answer=''; fi
	printf '%s' "${_answer:-$_default}"
}

confirm() {
	[ "$ASSUME_YES" = "1" ] && return 0
	_a=$(ask "$1 ${DIM}(y/n)${R}" "n")
	case "$_a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- arguments ------------------------------------------------------------

MUSIC_DIR=""
DOMAIN=""
ASSUME_YES=0
QUOTA_GB=""
FROM_SOURCE=0
NO_PROXY=0

while [ $# -gt 0 ]; do
	case "$1" in
		--music)   MUSIC_DIR="${2:-}"; shift 2 ;;
		--domain)  DOMAIN="${2:-}";    shift 2 ;;
		--port)    PORT="${2:-}";      shift 2 ;;
		--quota)   QUOTA_GB="${2:-}";  shift 2 ;;
		--from-source) FROM_SOURCE=1;  shift ;;
		--no-proxy)    NO_PROXY=1;     shift ;;
		-y|--yes)  ASSUME_YES=1;       shift ;;
		-h|--help)
			cat <<EOF
${B}AttackFM server installer${R}

  --music DIR     where your music lives (default: $PREFIX/music)
  --domain HOST   public hostname; sets up HTTPS via Caddy. Omit for LAN-only.
  --port PORT     port to listen on (default: $PORT)
  --quota GB      refuse uploads past this much. 0 or omit for no limit.
  --no-proxy      install and keep it on loopback, but do not touch Caddy.
                  For fronting it yourself - Tailscale, a Cloudflare tunnel,
                  an nginx you already run.
  --from-source   build with cargo instead of downloading a release
  -y, --yes       accept every default; no questions
EOF
			exit 0 ;;
		*) die "Unknown option: $1 (try --help)" ;;
	esac
done

# --- checks ---------------------------------------------------------------

[ "$(id -u)" = "0" ] || die "Run this with sudo - it creates a system service."

command -v systemctl >/dev/null 2>&1 || \
	die "No systemd here. See server/README.md to run the binary yourself."

case "$(uname -s)" in
	Linux) ;;
	*) die "This installer is for Linux. On macOS, run the binary directly (see server/README.md)." ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
	x86_64|amd64)  ASSET_ARCH="x86_64-unknown-linux-gnu" ;;
	aarch64|arm64) ASSET_ARCH="aarch64-unknown-linux-gnu" ;;
	*) die "Unsupported architecture: $ARCH. Use --from-source." ;;
esac

say ""
say "${B}AttackFM server${R} ${DIM}v$VERSION${R}"
say "${DIM}Your music, your machine, streamed losslessly to your phone.${R}"

# --- questions ------------------------------------------------------------

# What a previous install already decided, so re-running to change one thing
# does not quietly undo the others.
#
# Re-running is the normal way to add a domain later, and without this that
# would reset the music folder to the default - pointing a freshly installed
# server at an empty directory while the user's actual library sat untouched
# somewhere else, with nothing saying so.
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
existing() {
	[ -f "$UNIT_FILE" ] || return 1
	sed -n "s/^Environment=$1=//p" "$UNIT_FILE" | tail -1
}

if [ -f "$UNIT_FILE" ]; then
	PREV_MUSIC=$(existing AFM_MUSIC_DIR || true)
	PREV_QUOTA=$(existing AFM_QUOTA_GB || true)
	PREV_PORT=$(existing AFM_PORT || true)
	[ -n "${PREV_PORT:-}" ] && PORT="$PREV_PORT"
	say ""
	say "${DIM}Found an existing install; keeping its settings unless you change them.${R}"
fi

step "Where is your music?"
say "${DIM}A folder the server will index. It can be empty - you can upload from${R}"
say "${DIM}the desktop app afterwards. Point it at a big disk if you have one.${R}"
if [ -z "$MUSIC_DIR" ]; then
	MUSIC_DIR=$(ask "Music folder" "${PREV_MUSIC:-$PREFIX/music}")
fi
case "$MUSIC_DIR" in /*) ;; *) die "The music folder must be an absolute path." ;; esac

if [ "$NO_PROXY" != "1" ]; then
	step "Will you reach this from outside your home network?"
	say "${DIM}With a domain, Caddy gets a free HTTPS certificate and your phone can${R}"
	say "${DIM}reach the server anywhere. Without one, it works on your local network${R}"
	say "${DIM}only - which is fine, and needs no domain, no port forwarding, nothing.${R}"
	if [ -z "$DOMAIN" ] && [ "$ASSUME_YES" != "1" ]; then
		DOMAIN=$(ask "Domain (blank for local network only)" "")
	fi
fi

if [ -z "$QUOTA_GB" ] && [ -n "${PREV_QUOTA:-}" ]; then
	QUOTA_GB="$PREV_QUOTA"
fi

if [ -z "$QUOTA_GB" ]; then
	# The disk the music folder is actually on, not the root filesystem - the
	# whole point of pointing it elsewhere is that it is a different disk.
	AVAIL_GB=$(df -BG --output=avail "$(dirname "$MUSIC_DIR")" 2>/dev/null | tail -1 | tr -dc '0-9' || echo "")
	if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -gt 5 ] 2>/dev/null; then
		# Leave a tenth of the disk, so filling the library never fills the disk
		# and takes the database down with it.
		QUOTA_GB=$(( AVAIL_GB * 9 / 10 ))
		say ""
		say "${DIM}$AVAIL_GB GB free; the library will stop accepting uploads at ${QUOTA_GB} GB${R}"
		say "${DIM}so a full library never becomes a full disk.${R}"
	else
		QUOTA_GB=0
	fi
fi

# --- the binary -----------------------------------------------------------

step "Getting the server"
BIN_TMP=$(mktemp)
# shellcheck disable=SC2064
trap "rm -f '$BIN_TMP'" EXIT INT TERM

fetch_release() {
	_url="https://github.com/$REPO/releases/latest/download/attackfm-server-$ASSET_ARCH"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$_url" -o "$BIN_TMP" 2>/dev/null
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$BIN_TMP" "$_url" 2>/dev/null
	else
		return 1
	fi
}

build_from_source() {
	command -v cargo >/dev/null 2>&1 || die \
		"No cargo, and no release binary available. Install Rust (https://rustup.rs) and retry."
	[ -f "Cargo.toml" ] || die "Run --from-source from inside the server/ directory."
	say "${DIM}Building. First time takes a few minutes.${R}"
	cargo build --release
	cp target/release/attackfm-server "$BIN_TMP"
}

if [ "$FROM_SOURCE" = "1" ]; then
	build_from_source
elif [ -x "./attackfm-server" ]; then
	# A binary sitting beside the script - how the deploy script and a manual
	# copy both land.
	cp ./attackfm-server "$BIN_TMP"
	ok "Using the binary next to this script"
elif fetch_release; then
	ok "Downloaded the ${ASSET_ARCH} build"
else
	warn "No published build for $ASSET_ARCH; falling back to building it."
	build_from_source
fi

[ -s "$BIN_TMP" ] || die "Ended up with an empty binary - nothing was installed."
chmod +x "$BIN_TMP"

# Prove it actually runs on this machine before making it a system service -
# a wrong-architecture download should fail here, with an explanation, rather
# than as a service that crash-loops after the installer has said "done".
#
# `--version` exits; do not be tempted to use a bare run as the check, which
# starts a music server the installer then waits on forever.
if ! BIN_VERSION=$("$BIN_TMP" --version 2>&1); then
	die "The binary will not run here: $BIN_VERSION
  This usually means the wrong architecture. Try: $0 --from-source"
fi
ok "$BIN_VERSION"

# --- install --------------------------------------------------------------

step "Installing"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
	useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
		|| adduser --system --home "$PREFIX" --no-create-home "$SERVICE_USER" 2>/dev/null \
		|| die "Could not create the $SERVICE_USER account."
	ok "Created the $SERVICE_USER service account"
fi

mkdir -p "$PREFIX/bin" "$PREFIX/data" "$MUSIC_DIR"
install -m 755 "$BIN_TMP" "$PREFIX/bin/attackfm-server.new"
# Moved into place rather than written over: a running binary cannot be
# overwritten, and a half-copied one must never be what systemd restarts on.
systemctl stop "$SERVICE" 2>/dev/null || true
mv "$PREFIX/bin/attackfm-server.new" "$PREFIX/bin/attackfm-server"
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
# The music folder may be a mount the user already owns; take it only if it is
# ours to take, so a shared media drive is not quietly reassigned.
if [ "$MUSIC_DIR" = "$PREFIX/music" ]; then
	chown -R "$SERVICE_USER:$SERVICE_USER" "$MUSIC_DIR"
else
	chown "$SERVICE_USER:$SERVICE_USER" "$MUSIC_DIR" 2>/dev/null || \
		warn "Could not take ownership of $MUSIC_DIR - make sure $SERVICE_USER can read it."
fi
ok "Installed to $PREFIX"

# Where to bind is entirely "is something else going to front this?".
#
# With a domain, Caddy does, so the server stays on loopback where nothing on
# the network can reach it directly. With --no-proxy the answer is the same -
# the user's own tunnel or nginx is the front door. Only a bare LAN install has
# nothing in front, and only then does the server itself take the network.
if [ -n "$DOMAIN" ] || [ "$NO_PROXY" = "1" ]; then
	BIND="127.0.0.1"
else
	BIND="0.0.0.0"
fi
# With a domain the server can state its public origin, which the Spotify
# account link needs for its OAuth redirect. Without one it stays unset and
# the connect endpoint explains.
if [ -n "$DOMAIN" ]; then
	PUBLIC_URL_LINE="Environment=AFM_PUBLIC_URL=https://$DOMAIN"
else
	PUBLIC_URL_LINE="# Environment=AFM_PUBLIC_URL=https://your.domain (needed for the Spotify link)"
fi

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
# Written by the AttackFM installer. Edit freely - it is only rewritten if you
# run the installer again.
[Unit]
Description=AttackFM music server
After=network-online.target
Wants=network-online.target

[Service]
Environment=AFM_BIND=$BIND
Environment=AFM_PORT=$PORT
Environment=AFM_DATA_DIR=$PREFIX/data
Environment=AFM_MUSIC_DIR=$MUSIC_DIR
Environment=AFM_SERVER_NAME=AttackFM
Environment=AFM_QUOTA_GB=$QUOTA_GB
Environment=AFM_SCAN_MINUTES=15
$PUBLIC_URL_LINE

WorkingDirectory=$PREFIX
ExecStart=$PREFIX/bin/attackfm-server
User=$SERVICE_USER
Group=$SERVICE_USER
Restart=on-failure
RestartSec=2

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$PREFIX/data $MUSIC_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
# A unit that crash-looped enough times on a previous attempt is latched into
# `failed`, and systemd will refuse to start it again until the counter is
# cleared. Re-running the installer is exactly when somebody is trying to fix
# that, so clear it rather than making them find `reset-failed` themselves.
systemctl reset-failed "$SERVICE" 2>/dev/null || true
systemctl start "$SERVICE"
ok "Service installed and started"

# --- reverse proxy --------------------------------------------------------

# Opens the ports a public server needs, if a firewall is standing in the way.
#
# This is the single most common reason a first install "doesn't work": a VPS
# image ships with ufw enabled and only SSH allowed, Caddy asks Let's Encrypt
# for a certificate, and the challenge times out because the world cannot reach
# port 80. The error surfaces buried in Caddy's log as "Timeout during connect
# (likely firewall problem)", long after the installer has said it finished.
open_web_ports() {
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "active"; then
		if ufw status 2>/dev/null | grep -qE "^(80|443)/tcp"; then
			return 0
		fi
		say "${DIM}ufw is on and blocking web traffic - a certificate cannot be issued${R}"
		say "${DIM}until ports 80 and 443 are reachable.${R}"
		if confirm "Allow 80 and 443 through ufw?"; then
			ufw allow 80/tcp >/dev/null 2>&1
			ufw allow 443/tcp >/dev/null 2>&1
			ok "Opened 80 and 443"
		else
			warn "Left the firewall alone; HTTPS will not work until 80/443 are open."
		fi
	elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
		if confirm "Allow http and https through firewalld?"; then
			firewall-cmd --permanent --add-service=http >/dev/null 2>&1
			firewall-cmd --permanent --add-service=https >/dev/null 2>&1
			firewall-cmd --reload >/dev/null 2>&1
			ok "Opened http and https"
		else
			warn "Left the firewall alone; HTTPS will not work until 80/443 are open."
		fi
	fi
}

if [ -n "$DOMAIN" ] && [ "$NO_PROXY" != "1" ]; then
	step "Setting up HTTPS for $DOMAIN"
	open_web_ports
	if ! command -v caddy >/dev/null 2>&1; then
		if confirm "Caddy is not installed. Install it now?"; then
			if command -v apt-get >/dev/null 2>&1; then
				apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
				curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
					| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
				curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
					> /etc/apt/sources.list.d/caddy-stable.list
				apt-get update -qq && apt-get install -y caddy >/dev/null
				ok "Installed Caddy"
			else
				warn "Install Caddy yourself, then re-run with --domain $DOMAIN."
			fi
		fi
	fi

	if command -v caddy >/dev/null 2>&1; then
		CADDYFILE="/etc/caddy/Caddyfile"
		mkdir -p /etc/caddy
		touch "$CADDYFILE"

		# Backed up before touching it: this file may already be serving
		# something else, and an installer that breaks an unrelated site is
		# worse than one that does nothing.
		cp "$CADDYFILE" "$CADDYFILE.before-attackfm" 2>/dev/null || true

		# The block is fenced by markers so a re-run REPLACES it rather than
		# appending a second one. Changing the domain later is the whole reason
		# somebody re-runs this, and two blocks would leave the old hostname
		# still being served and still renewing a certificate for itself.
		# Everything outside the fence is copied through untouched.
		if grep -q '^# --- AttackFM begin ---$' "$CADDYFILE" 2>/dev/null; then
			awk '
				/^# --- AttackFM begin ---$/ { skip = 1 }
				!skip { print }
				/^# --- AttackFM end ---$/   { skip = 0 }
			' "$CADDYFILE" > "$CADDYFILE.tmp" && mv "$CADDYFILE.tmp" "$CADDYFILE"
		fi

		cat >> "$CADDYFILE" <<EOF
# --- AttackFM begin ---
# Managed by the AttackFM installer: everything between these markers is
# replaced when you run it again. Edit outside them, or not at all.
#
# No 'encode': audio is already compressed, so gzip buys nothing, costs CPU per
# stream, and drops the Content-Length a media element needs in order to seek.
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT {
		transport http {
			read_timeout 6h
			write_timeout 6h
		}
		flush_interval -1
	}
	request_body {
		max_size 2GB
	}
}
# --- AttackFM end ---
EOF
		if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
			systemctl reload caddy 2>/dev/null || systemctl restart caddy
			ok "Caddy is serving https://$DOMAIN"
		else
			mv "$CADDYFILE.before-attackfm" "$CADDYFILE" 2>/dev/null || true
			warn "The new Caddy config did not validate; put the old one back."
			warn "Add the block from server/deploy/Caddyfile.snippet by hand."
		fi
	fi
fi

# --- report ---------------------------------------------------------------

sleep 1
if ! systemctl is-active --quiet "$SERVICE"; then
	say ""
	journalctl -u "$SERVICE" -n 20 --no-pager || true
	die "The service did not stay up. The log above says why."
fi

if [ -n "$DOMAIN" ] && [ "$NO_PROXY" != "1" ]; then
	ADDRESS="https://$DOMAIN"
elif [ "$NO_PROXY" = "1" ]; then
	# Nothing here knows what the user is fronting it with, so it reports the
	# only address it can vouch for rather than guessing at a public one.
	ADDRESS="http://127.0.0.1:$PORT ${DIM}(behind whatever you front it with)${R}"
else
	LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
	[ -n "$LAN_IP" ] || LAN_IP="<this machine's IP>"
	ADDRESS="http://$LAN_IP:$PORT"
fi

TRACKS=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/server" 2>/dev/null \
	| sed -n 's/.*"tracks":\([0-9]*\).*/\1/p' || echo "?")

say ""
say "${GREEN}${B}Your music server is running.${R}"
say ""
say "  ${B}Address${R}   $ADDRESS"
say "  ${B}Music${R}     $MUSIC_DIR ${DIM}(${TRACKS:-0} tracks indexed)${R}"
say ""
say "${B}Next:${R} open AttackFM, go to ${B}Settings → Server${R}, and enter"
say "the address above. The first account you make becomes the owner."
say ""
if [ -z "$DOMAIN" ]; then
	say "${DIM}This works on your local network. To reach it from anywhere, re-run${R}"
	say "${DIM}with --domain yourhost.example.com once the DNS points here.${R}"
	say ""
fi
say "${DIM}logs:    journalctl -u $SERVICE -f${R}"
say "${DIM}restart: systemctl restart $SERVICE${R}"
say ""
