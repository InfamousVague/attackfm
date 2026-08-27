#!/bin/bash
#
# AttackFM — pull latest & redeploy the server.
# Double-click to update the server to the latest `main` and restart it.
# Safe to run anytime: it refuses to touch uncommitted work, leaves the old
# server running if the build fails, and REFUSES TO CLAIM SUCCESS unless the
# process actually answering afterwards carries the new code.
#
# Lives in the repo (server/update-server.command) so `git pull` keeps the
# updater itself current. The previous desktop copy of this script had the bug
# this one exists to kill: it built the binary but never INSTALLED it. The
# launchd agent home-install.sh creates (com.mattssoftware.attackfm-server)
# runs a COPY in ~/Library/Application Support/AttackFM/bin - so the build
# landed in target/release, the kickstart restarted a service pointing at the
# old copy, port 8788 answered from stale code, and the script printed a
# green check over it. Months of "updates" changed nothing.

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# --- optional: set the trust link while we are here --------------------------
#
# Sharing another server's members needs two values in the agent's plist, and
# the only other way to set them is home-install.sh, which asks a page of
# questions about paths that have not moved. This takes them as arguments so a
# token can be pasted in one line:
#
#   bash server/update-server.command --trust-url https://matt.attack.fm \
#                                     --trust-token <admin token on it>
#
#   bash server/update-server.command --trust-off      # stop sharing
#
# Written with PlistBuddy onto the EXISTING plist rather than by regenerating
# it: home-install.sh rewrites that file whole, and reproducing it here would
# be a second copy of the truth about what the agent needs. Nothing happens
# without the flags, so double-clicking behaves exactly as before.
TRUST_URL=""; TRUST_TOKEN=""; TRUST_OFF=""; TRUST_ASKED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --trust-url)   TRUST_URL="$2"; TRUST_ASKED=1; shift 2 ;;
    --trust-token) TRUST_TOKEN="$2"; TRUST_ASKED=1; shift 2 ;;
    --trust-off)   TRUST_OFF=1; TRUST_ASKED=1; shift ;;
    -h|--help)
      echo "usage: update-server.command [--trust-url URL --trust-token TOKEN | --trust-off]"
      exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

# home-install.sh's agent (the copied binary) and the older hand-rolled one.
INSTALL_LABEL="com.mattssoftware.attackfm-server"
LEGACY_LABEL="fm.attack.server"
BIN_DST="$HOME/Library/Application Support/AttackFM/bin/attackfm-server"

# A double-clicked .command runs WITHOUT your shell profile, so put the Rust
# toolchain (and Homebrew, for ffmpeg) on PATH explicitly.
# shellcheck disable=SC1091
source "$HOME/.cargo/env" 2>/dev/null
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { printf "\n\033[1;36m%s\033[0m\n" "$*"; }   # cyan
ok()  { printf "\033[1;32m%s\033[0m\n" "$*"; }     # green
err() { printf "\033[1;31m%s\033[0m\n" "$*"; }     # red
hold() { echo; read -n1 -s -r -p "Press any key to close this window…"; echo; }

echo "════════════════════════════════════════════"
echo "   AttackFM — pull latest & redeploy server"
echo "════════════════════════════════════════════"

cd "$REPO" || { err "✗ Repo not found at $REPO"; hold; exit 1; }

# 0) Never clobber in-progress work — but only TRACKED changes matter here.
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "✗ There are uncommitted changes to tracked files — not redeploying:"
  git status --short --untracked-files=no
  err "  Commit or stash them first, then run this again."
  hold; exit 1
fi

# 1) Pull the latest main.
say "→ Fetching latest code…"
if ! git fetch origin; then err "✗ git fetch failed (network / auth?)."; hold; exit 1; fi
git checkout main 2>/dev/null || git checkout -b main --track origin/main
if ! git merge --ff-only origin/main 2>/dev/null; then
  err "✗ Local 'main' has diverged from origin/main — can't fast-forward."
  err "  Someone committed to main locally. Resolve that, then re-run."
  hold; exit 1
fi
ok "  Now at: $(git log --oneline -1)"

# 2) Build the server. If it fails, the running server is left untouched.
say "→ Building the server (up to ~1 min)…"
if ! ( cd "$REPO/server" && cargo build --release --bin attackfm-server ); then
  err "✗ Build failed — server NOT restarted (still running the previous code)."
  hold; exit 1
fi
ok "  Build OK."
FRESH="$REPO/server/target/release/attackfm-server"

# 3) INSTALL, then restart — the step the old script skipped.
#    Whichever agent exists gets the fresh binary where ITS plist points:
#    the home-install agent runs the copy at BIN_DST, so the copy is updated
#    before the kickstart; the legacy agent (if its plist survives) is booted
#    out entirely so two services never fight over the port with different
#    generations of the code.
# Applied BEFORE the agent is booted out and back in below, because that
# bootstrap is what reads the plist - a value written after it would not reach
# the server until something restarted it again.
if [ -n "$TRUST_ASKED" ]; then
  say "→ Updating the trust link…"
  # Whichever agent this machine actually has. The legacy one counts: its env
  # is read the same way, and telling somebody to run the installer when a
  # working server is sitting right there invites a SECOND one.
  PLIST="$HOME/Library/LaunchAgents/$INSTALL_LABEL.plist"
  [ -f "$PLIST" ] || PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
  if [ ! -f "$PLIST" ]; then
    err "  ✗ No AttackFM agent for $(whoami) in ~/Library/LaunchAgents."
    err ""
    # "Run the installer" is the WRONG advice when a server is already up: it
    # would build a second one beside the first and they would fight over the
    # port. So say what is actually here before suggesting anything.
    # pgrep -x, not a grep over command lines: any shell whose arguments merely
    # MENTION attackfm-server matches the latter, so the check reported "a
    # server IS running" at a terminal that had only ever talked about one.
    pids="$(pgrep -x attackfm-server 2>/dev/null | head -3)"
    running=""
    [ -n "$pids" ] && running="$(ps -o user=,pid=,comm= -p $pids 2>/dev/null)"
    if [ -n "$running" ]; then
      err "  But a server IS running on this machine:"
      printf '%s\n' "$running" | sed 's/^/     /'
      err ""
      err "  It was not started by this script's agent, so its settings live"
      err "  somewhere else. Check, in order:"
      err "     ls ~/Library/LaunchAgents | grep -i attack     # another label?"
      err "     ls /Library/LaunchAgents /Library/LaunchDaemons | grep -i attack"
      err "  and note the USER in the first column above - if it is not"
      err "  $(whoami), run this again as them."
    else
      err "  And no attackfm-server process is running here either, so this is"
      err "  probably not the machine that serves your library. The one you"
      err "  want answers on port 8788 locally."
      err ""
      err "  If this really is a fresh box: bash server/home-install.sh"
    fi
    hold; exit 1
  fi
  set_env() {  # key, value - Set if it is there, Add if it is not
    /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$1 $2" "$PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:$1 string $2" "$PLIST" >/dev/null 2>&1
  }
  if [ -n "$TRUST_OFF" ]; then
    set_env AFM_TRUST_MEMBERS_OF ""
    set_env AFM_TRUST_TOKEN ""
    ok "  Sharing turned off."
  else
    # Half a link trusts nobody and looks exactly like a typo in the URL, so
    # say which half is missing rather than writing it and moving on.
    if [ -z "$TRUST_URL" ] || [ -z "$TRUST_TOKEN" ]; then
      err "  ✗ Both --trust-url and --trust-token are needed (or --trust-off)."
      hold; exit 1
    fi
    case "$TRUST_URL" in
      http://*|https://*) ;;
      *) TRUST_URL="https://$TRUST_URL" ;;
    esac
    TRUST_URL="${TRUST_URL%/}"
    set_env AFM_TRUST_MEMBERS_OF "$TRUST_URL"
    set_env AFM_TRUST_TOKEN "$TRUST_TOKEN"
    # The token is never echoed - this window is a screen share waiting to
    # happen, and it is an admin credential on the other box.
    ok "  Members of $TRUST_URL will be let in here too."
  fi
fi

say "→ Installing & restarting…"
if [ -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist" ] && [ -f "$HOME/Library/LaunchAgents/$INSTALL_LABEL.plist" ]; then
  err "  Both the old ($LEGACY_LABEL) and new ($INSTALL_LABEL) agents exist."
  err "  Retiring the old one so they stop fighting over the port."
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
fi
if [ -f "$HOME/Library/LaunchAgents/$INSTALL_LABEL.plist" ]; then
  launchctl bootout "gui/$(id -u)/$INSTALL_LABEL" 2>/dev/null
  mkdir -p "$(dirname "$BIN_DST")"
  cp "$FRESH" "$BIN_DST"
  chmod +x "$BIN_DST"
  xattr -d com.apple.quarantine "$BIN_DST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$INSTALL_LABEL.plist" 2>/dev/null
  launchctl kickstart "gui/$(id -u)/$INSTALL_LABEL" 2>/dev/null
  ok "  Installed to the service's own binary and restarted ($INSTALL_LABEL)."
elif [ -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist" ]; then
  # Only the legacy agent exists; restart it. If its plist runs the binary
  # straight from target/release the fresh build is already in place.
  launchctl kickstart -k "gui/$(id -u)/$LEGACY_LABEL"
  ok "  Restarted ($LEGACY_LABEL)."
else
  err "✗ No launchd agent found for either label — run server/home-install.sh once first."
  hold; exit 1
fi

# 4) Verify it came back — and that the ANSWERING process is the new code.
#    "It answers" is not enough: that is exactly how the old script blessed a
#    stale survivor. A route this checkout carries must answer non-404.
say "→ Verifying…"
up=""
for _ in $(seq 1 30); do
  if curl -s -m3 http://127.0.0.1:8788/api/server >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  err "  ✗ Server did not answer within 30s. Check the log:"
  err "     tail -f ~/Library/Logs/AttackFM/server.log"
  hold; exit 1
fi
fresh_code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:8788/api/album/tracks?artist=x&album=y" || echo 000)"
if [ "$fresh_code" = "404" ]; then
  err "  ✗ The server answers, but with OLD code (a route this checkout"
  err "    carries returned 404). Something else is holding port 8788 —"
  err "    find it:  lsof -nP -iTCP:8788 -sTCP:LISTEN"
  hold; exit 1
fi
ok "  ✅ Server is up AND current (freshness route answered $fresh_code):"
curl -s http://127.0.0.1:8788/api/server | sed 's/^/     /'
echo; ok "Done — redeployed successfully."

hold
