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

# Status and body together, so a refusal can say WHICH refusal it was. The
# first version reported every failure as "no speech recogniser", which is the
# wrong answer for much the likeliest one: a hub that predates this endpoint
# and simply 404s.
RESP=$(curl -s -w '\n%{http_code}' -X POST "${URL}" -H "Authorization: Bearer ${TOKEN}")
CODE=$(printf '%s' "$RESP" | tail -n1)
OUT=$(printf '%s' "$RESP" | sed '$d')

case "${CODE}" in
  200) : ;;
  404)
    echo "this hub does not have /api/lyrics/redo yet - it is running a build from" >&2
    echo "before re-timing existed. Update it first:" >&2
    echo "    git pull && bash server/home-install.sh" >&2
    exit 1 ;;
  412)
    echo "this hub has no speech recogniser or model, so it cannot time lyrics -" >&2
    echo "it is the same recogniser that transcribes books." >&2
    echo >&2
    echo "Check you are on the right box. A friends/mirror instance holds no" >&2
    echo "library and has no recogniser; this belongs on the hub your music" >&2
    echo "actually lives on. \`curl -s localhost:${PORT}/api/server\` names it, and" >&2
    echo "a hub with nothing to play reports \"tracks\":0." >&2
    exit 1 ;;
  403)
    echo "that account is not an admin. Re-timing the whole library needs one;" >&2
    echo "a single track does not - try: bash server/relyric.sh <track id>" >&2
    exit 1 ;;
  *)
    echo "the server answered ${CODE}: ${OUT}" >&2
    exit 1 ;;
esac

echo "${OUT}"

CLEARED=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cleared"])' 2>/dev/null || echo "?")
WAITING=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["waiting"])' 2>/dev/null || echo "?")
echo "forgot the clocks on ${CLEARED} song(s); ${WAITING} are queued."
echo "They run one at a time with a pause between, liked songs first, then most played -"
echo "so the ones you actually listen to come back first. A big library takes hours."
