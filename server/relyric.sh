#!/usr/bin/env bash
# Re-time the lyrics of every song, for a library aligned before the current
# matcher - or against a lyric sheet that has since been corrected. Run ON the
# server box; it talks to the local instance through the same door the app uses.
#
#   bash server/relyric.sh                 # port 8788, whole library
#   AFM_PORT=8971 bash server/relyric.sh   # a different instance
#   bash server/relyric.sh 4213            # one track id, nothing else touched
#
# Asks for an admin sign-in; the password goes to the local API over stdin and
# is kept nowhere.
#
# What it does NOT do is throw away lyrics. Only the derived word clocks go, so
# the words themselves are still there while the hub works out their timing
# again - a song reads as it did a moment ago, it just stops lighting up until
# its turn comes round.
set -euo pipefail

PORT="${AFM_PORT:-8788}"
BASE="http://127.0.0.1:${PORT}"
TRACK="${1:-}"

curl -sf -m 5 "${BASE}/api/server" >/dev/null || {
  echo "no server answering on ${BASE} - is it running, or is AFM_PORT different?" >&2
  exit 1
}

read -r -p "admin username: " USER
read -r -s -p "password: " PASS; echo

# Credentials travel via stdin, never argv.
TOKEN=$(printf '{"username":"%s","password":"%s"}' "$USER" "$PASS" \
  | curl -sf -X POST "${BASE}/api/auth/login" -H 'Content-Type: application/json' -d @- \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') || {
  echo "sign-in refused" >&2
  exit 1
}

URL="${BASE}/api/lyrics/redo"
[ -n "${TRACK}" ] && URL="${URL}?id=${TRACK}"

OUT=$(curl -sf -X POST "${URL}" -H "Authorization: Bearer ${TOKEN}") || {
  echo "the server refused - it may have no speech recogniser or model installed" >&2
  exit 1
}
echo "${OUT}"

CLEARED=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cleared"])' 2>/dev/null || echo "?")
WAITING=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["waiting"])' 2>/dev/null || echo "?")
echo "forgot the clocks on ${CLEARED} song(s); ${WAITING} are queued."
echo "They run one at a time with a pause between, liked songs first, then most played -"
echo "so the ones you actually listen to come back first. A big library takes hours."
