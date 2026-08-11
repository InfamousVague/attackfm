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

# Where the binary comes from: a prebuilt one beside this script (bundle
# mode), or a fresh build of the checkout this script lives in (repo mode).
if [ -f "$HERE/attackfm-server" ]; then
  BIN_SRC="$HERE/attackfm-server"
elif [ -f "$HERE/Cargo.toml" ]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "This is a repo checkout, so the server builds here - but cargo is missing."
    echo "One-time setup:  curl https://sh.rustup.rs -sSf | sh   (then re-run this script)"
    exit 1
  }
  bold "Building the server from this checkout"
  (cd "$HERE" && cargo build --release)
  BIN_SRC="$HERE/target/release/attackfm-server"
  [ -f "$BIN_SRC" ] || { echo "Build finished but no binary at $BIN_SRC."; exit 1; }
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

# --- install the binary ----------------------------------------------------
bold "Installing"
mkdir -p "$(dirname "$BIN_DST")" "$LOG_DIR"
# Stop first so the copy never races a running process.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"
xattr -d com.apple.quarantine "$BIN_DST" 2>/dev/null || true
say "binary -> $BIN_DST"

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
