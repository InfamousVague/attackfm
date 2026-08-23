#!/usr/bin/env bash
# Re-run transcription, with word-level clocks, for every book transcribed
# before word tracking existed. Run ON the server box; it talks to the local
# instance and queues the work through the same door the app uses.
#
#   bash server/retranscribe.sh            # port 8788
#   AFM_PORT=8971 bash server/retranscribe.sh
#
# Asks for an admin sign-in; the password goes to the local API over stdin
# and is kept nowhere. Jobs run one at a time, niced - a library of books
# takes hours, and the queue survives being watched from the app's
# transcription panel meanwhile.
set -euo pipefail

PORT="${AFM_PORT:-8788}"
BASE="http://127.0.0.1:${PORT}"

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

OUT=$(curl -sf -X POST "${BASE}/api/transcribe/redo" -H "Authorization: Bearer ${TOKEN}")
echo "${OUT}"
QUEUED=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["queued"])' 2>/dev/null || echo "?")
echo "queued ${QUEUED} book(s) for word-level re-transcription; they run one at a time, niced."
echo "watch progress in the app's transcription panel, or: curl -s ${BASE}/api/transcribe/jobs -H \"Authorization: Bearer \$TOKEN\""
