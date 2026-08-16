#!/bin/bash
# AttackFM home-hub installer (macOS).
#
# For the Mac that IS the music server - the one with the library drive
# attached. Two ways to run it, and re-running either is the normal way to
# update (it keeps the answers you gave last time as defaults):
#
#   - from a git checkout:  git pull && bash server/home-install.sh
#     Builds the server right here (needs the Rust toolchain once:
#     `curl https://sh.rustup.rs -sSf | sh`), so a push from the dev Mac is
#     the whole deploy - nothing to carry over.
#   - from an unpacked bundle (dist-home tarball, next to a prebuilt
#     attackfm-server binary): installs that binary, no toolchain needed.
#     This is the fallback for a box without Rust.
#
# What it does, in order:
#   1. installs the bundled binary to ~/Library/Application Support/AttackFM
#   2. asks where the music lives (detecting external volumes as candidates)
#   3. writes a launchd agent so the server survives reboots and crashes
#   4. (re)starts it and health-checks the port
#   5. offers to set up Ollama + the curator's model, if the bundle wants one
#
# Nothing here touches the music itself, and the index/data directory is
# preserved across re-runs - an update costs the seconds of a restart.
set -euo pipefail

LABEL="com.mattssoftware.attackfm-server"
APP_DIR="$HOME/Library/Application Support/AttackFM"
BIN_DST="$APP_DIR/bin/attackfm-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AttackFM"
HERE="$(cd "$(dirname "$0")" && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
say()  { printf '  %s\n' "$1"; }

# Where the binary comes from: a fresh build of the checkout this script lives
# in (repo mode), or a prebuilt one beside it (bundle mode).
#
# REPO MODE IS CHECKED FIRST, deliberately. This used to prefer any sibling
# `attackfm-server` file - and a stale prebuilt left over from an old bundle
# unpack then silently outranked the checkout forever: `git pull` moved the
# code, the "update" reinstalled the same old binary, and new endpoints 404ed
# while everything claimed success. A checkout with a Cargo.toml builds, full
# stop; a loose binary beside it is a leftover, and is named as one.
if [ -f "$HERE/Cargo.toml" ]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "This is a repo checkout, so the server builds here - but cargo is missing."
    echo "One-time setup:  curl https://sh.rustup.rs -sSf | sh   (then re-run this script)"
    exit 1
  }
  if [ -f "$HERE/attackfm-server" ]; then
    say "ignoring the loose attackfm-server beside this script - a repo checkout builds its own"
  fi
  bold "Building the server from this checkout"
  (cd "$HERE" && cargo build --release)
  BIN_SRC="$HERE/target/release/attackfm-server"
  [ -f "$BIN_SRC" ] || { echo "Build finished but no binary at $BIN_SRC."; exit 1; }
elif [ -f "$HERE/attackfm-server" ]; then
  BIN_SRC="$HERE/attackfm-server"
else
  echo "No attackfm-server binary next to this script and no Cargo.toml either -"
  echo "run from a repo checkout's server/ directory or an unpacked bundle."
  exit 1
fi

# --- previous answers become defaults -------------------------------------
# The plist is the memory: a re-run reads what it set last time, so updating
# never re-interrogates you about paths that have not moved.
prev() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true; }
DEF_MUSIC="$(prev AFM_MUSIC_DIR)"
DEF_DATA="$(prev AFM_DATA_DIR)"
DEF_PORT="$(prev AFM_PORT)"; DEF_PORT="${DEF_PORT:-8788}"
DEF_BIND="$(prev AFM_BIND)"; DEF_BIND="${DEF_BIND:-0.0.0.0}"
# The curator's model envs - the names curator.rs actually reads.
DEF_AI_URL="$(prev AFM_AI_URL)"; DEF_AI_URL="${DEF_AI_URL:-http://127.0.0.1:11434}"
DEF_MODEL="$(prev AFM_AI_MODEL)"; DEF_MODEL="${DEF_MODEL:-qwen3:14b}"
DEF_EMBED="$(prev AFM_AI_EMBED_MODEL)"; DEF_EMBED="${DEF_EMBED:-nomic-embed-text}"
# Spotify app credentials. Search needs a Spotify link for anything it offers
# to add - the importer takes no other kind - and a hub reaches Spotify either
# through SpotiFLAC's metadata client or, failing that, these. Blank is fine
# where SpotiFLAC is installed; without either, songs can be browsed but not
# added, and the curator finds nothing to buy.
DEF_SPOT_ID="$(prev AFM_SPOTIFY_CLIENT_ID)"
DEF_SPOT_SECRET="$(prev AFM_SPOTIFY_CLIENT_SECRET)"

# --- music dir -------------------------------------------------------------
bold "Where does the music live?"
if [ -z "$DEF_MUSIC" ]; then
  # External volumes are where an 8TB library lives; offer anything that looks
  # like one as a starting point rather than making you type a path cold.
  i=0
  for v in /Volumes/*/; do
    name="$(basename "$v")"
    [ "$name" = "Macintosh HD" ] && continue
    [ -d "$v" ] || continue
    i=$((i+1)); say "candidate: $v"
  done
  [ "$i" = 0 ] && say "(no external volumes visible right now)"
fi
read -r -p "  Music folder [${DEF_MUSIC:-required}]: " MUSIC_DIR
MUSIC_DIR="${MUSIC_DIR:-$DEF_MUSIC}"
[ -n "$MUSIC_DIR" ] && [ -d "$MUSIC_DIR" ] || { echo "  '$MUSIC_DIR' is not a directory."; exit 1; }

# Index + art cache: default beside the music so the whole library (files,
# index, covers) lives and travels on one drive.
DEF_DATA="${DEF_DATA:-$(dirname "$MUSIC_DIR")/attackfm-data}"
read -r -p "  Index/data folder [$DEF_DATA]: " DATA_DIR
DATA_DIR="${DATA_DIR:-$DEF_DATA}"
mkdir -p "$DATA_DIR"

read -r -p "  Port [$DEF_PORT]: " PORT
PORT="${PORT:-$DEF_PORT}"

# --- Spotify app (optional) --------------------------------------------------
bold "Spotify app credentials (optional)"
say "Only needed if this box has no SpotiFLAC: they are how search finds the"
say "Spotify links the importer takes. From developer.spotify.com; enter to skip."
read -r -p "  Client id [${DEF_SPOT_ID:-skip}]: " SPOT_ID
SPOT_ID="${SPOT_ID:-$DEF_SPOT_ID}"
read -r -p "  Client secret [${DEF_SPOT_SECRET:+kept}]: " SPOT_SECRET
SPOT_SECRET="${SPOT_SECRET:-$DEF_SPOT_SECRET}"

# --- install the binary ----------------------------------------------------
bold "Installing"
mkdir -p "$(dirname "$BIN_DST")" "$LOG_DIR"
# Stop first so the copy never races a running process.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"
xattr -d com.apple.quarantine "$BIN_DST" 2>/dev/null || true
say "binary -> $BIN_DST"

# --- publish the frontend to this hub's devices ----------------------------
# The hub serves whatever sits in <data>/appbundle to every signed-in phone
# (server/src/appbundle.rs) - how a TypeScript change reaches a device with
# no cable and no store. In repo mode the frontend source is right here, so
# the same `git pull` that updated the server publishes the app too. VERSION
# is removed first and written back last, alone: while it is absent the hub
# publishes nothing, so no phone can ever see a half-copied bundle.
if [ -f "$HERE/Cargo.toml" ] && [ -f "$HERE/../package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    bold "Publishing the app to this hub's devices"
    REPO="$(cd "$HERE/.." && pwd)"
    ( cd "$REPO"
      [ -d node_modules ] || npm ci --no-audit --no-fund
      # AFM_OTA=1: inline every chunk and asset into app.js/app.css. The two
      # files are all a device downloads, and a split build's relative imports
      # cannot resolve out of a bundle directory - phones quarantined every
      # bundle published without this.
      AFM_OTA=1 npm run build
    )
    # Self-contained or not published: a stray chunk beside app.js means the
    # inlining broke, and shipping it would quarantine the version on every
    # phone that downloads it.
    STRAYS="$(ls "$REPO/dist/assets" 2>/dev/null | grep -v -e '^app\.js$' -e '^app\.css$' || true)"
    if [ -n "$STRAYS" ]; then
      say "OTA build emitted extra files ($(echo "$STRAYS" | tr '\n' ' ')) - NOT publishing"
    elif [ -f "$REPO/dist/assets/app.js" ] && [ -f "$REPO/dist/assets/app.css" ]; then
      APPV="$(node -p "require('$REPO/package.json').version")"
      NATIVE="$(sed -n 's/.*NATIVE_GENERATION: u32 = \([0-9]*\).*/\1/p' "$REPO/src-tauri/src/bundle.rs" | head -1)"
      BUNDLE_DIR="$DATA_DIR/appbundle"
      mkdir -p "$BUNDLE_DIR"
      rm -f "$BUNDLE_DIR/VERSION"
      cp "$REPO/dist/assets/app.js" "$REPO/dist/assets/app.css" "$BUNDLE_DIR/"
      awk -v v="$APPV" 'index($0, "## " v) == 1 {on=1; next} /^## / {on=0} on && NF {print}' \
        "$REPO/CHANGELOG.md" > "$BUNDLE_DIR/NOTES" 2>/dev/null || true
      printf '%s' "${NATIVE:-1}" > "$BUNDLE_DIR/NATIVE"
      printf '%s' "$APPV" > "$BUNDLE_DIR/VERSION"
      say "published $APPV -> $BUNDLE_DIR (phones offer it on their next launch)"
    else
      say "frontend build made no dist/assets - the hub keeps publishing what it had"
    fi
  else
    say "npm is missing, so only the server updated. Install node to publish the app OTA from here."
  fi
fi

# --- launchd agent ---------------------------------------------------------
# KeepAlive restarts it if it crashes; RunAtLoad starts it at login. A
# LaunchAgent (not daemon) because the music drive mounts at login and the
# server should come up after it.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN_DST</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>AFM_MUSIC_DIR</key><string>$MUSIC_DIR</string>
    <key>AFM_DATA_DIR</key><string>$DATA_DIR</string>
    <key>AFM_PORT</key><string>$PORT</string>
    <key>AFM_BIND</key><string>$DEF_BIND</string>
    <key>AFM_AI_URL</key><string>$DEF_AI_URL</string>
    <key>AFM_AI_MODEL</key><string>$DEF_MODEL</string>
    <key>AFM_AI_EMBED_MODEL</key><string>$DEF_EMBED</string>
    <key>AFM_ASSETS_BAKED</key><string>$HERE/assets/artwork</string>
    <key>AFM_SPOTIFY_CLIENT_ID</key><string>$SPOT_ID</string>
    <key>AFM_SPOTIFY_CLIENT_SECRET</key><string>$SPOT_SECRET</string>
  </dict>
</dict></plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/$LABEL"
say "launchd agent -> $PLIST"

# --- health check ----------------------------------------------------------
bold "Waiting for the server"
ok=""
for _ in $(seq 1 20); do
  sleep 1
  if out="$(curl -s -m 2 "http://127.0.0.1:$PORT/api/server")" && [ -n "$out" ]; then ok="$out"; break; fi
done
if [ -n "$ok" ]; then
  say "up: $ok"
else
  echo "  Did not answer on :$PORT - check $LOG_DIR/server.log"; exit 1
fi

# The answering process must be the binary just installed, not a survivor.
# Probing a recent route is the cheapest honest proof: 404 on it means the
# RUNNING server predates this checkout - a stale prebuilt got installed, or
# launchd kept an old process - and everything above lied by omission. This
# exact failure once had a phone showing half-albums for days while every
# "update" reported success.
freshness="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/api/album/tracks?artist=x&album=y" || echo 000)"
if [ "$freshness" = "404" ]; then
  echo ""
  echo "  *** The running server is OLDER than this checkout. ***"
  echo "  A route this code carries answered 404. Likely causes:"
  echo "    - a stale prebuilt attackfm-server was installed (fixed in this script; re-run it)"
  echo "    - launchd kept an old process: launchctl bootout gui/\$(id -u)/$LABEL and re-run"
  exit 1
else
  say "freshness check: current routes answer ($freshness)"
fi

# --- Ollama (the curator's brain) ------------------------------------------
bold "Curator model (Ollama)"
if command -v ollama >/dev/null 2>&1 || [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
  OLLAMA="$(command -v ollama || echo /Applications/Ollama.app/Contents/Resources/ollama)"
  # Two models, two jobs: the embedder is small and drives the actual
  # recommendations; the chat model is big and only writes names and reasons.
  if ! "$OLLAMA" list 2>/dev/null | grep -q "${DEF_EMBED%%:*}"; then
    say "pulling the embedder ($DEF_EMBED, ~300MB) - this one is what reads your library"
    "$OLLAMA" pull "$DEF_EMBED" || say "embed pull failed - lyrics will not be read until it exists"
  fi
  if "$OLLAMA" list 2>/dev/null | grep -q "${DEF_MODEL%%:*}"; then
    say "chat model family already present"
  else
    read -r -p "  Pull $DEF_MODEL now (~9GB)? [Y/n]: " yn
    if [ "${yn:-Y}" != "n" ] && [ "${yn:-Y}" != "N" ]; then
      "$OLLAMA" pull "$DEF_MODEL" || "$OLLAMA" pull qwen2.5:14b || say "pull failed - lists keep plain names until a chat model exists"
    fi
  fi
else
  say "Ollama is not installed. The curator runs heuristics-only without it."
  say "To enable the LLM later: install from https://ollama.com/download, then:  ollama pull $DEF_MODEL"
fi

bold "Done"
say "server:   http://$(ipconfig getifaddr en0 2>/dev/null || echo '<this-mac>'):$PORT"
say "logs:     $LOG_DIR/server.log"
say "update:   unpack a newer bundle and run this script again"
