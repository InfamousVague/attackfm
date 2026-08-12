#!/bin/bash
# AttackFM → TestFlight, double-clickable.
#
# The whole release ritual in one file: pick the next version (asking App Store
# Connect what is already taken, so two machines can never collide on a build
# number), bump it everywhere, force the frontend re-embed, build the
# distribution-signed IPA, run the gates that have each caught a real silent
# failure, upload, and wait for Apple to say VALID.
#
#   double-click            → next patch version, full ritual
#   ./testflight.command 0.4.0   → that version instead
#   ./testflight.command --check → preflight + version math only, no build
#
# The gates, and the failure each one caught once:
#   - version in the IPA        (a bump that missed one of the two files)
#   - Apple Distribution signing (plain `tauri ios build` dev-signs silently)
#   - iPhone-only device family  (iPad screenshots demanded at review)
#   - embedded asset map         (a stale libapp.a shipping last week's app
#                                 inside a correctly-versioned binary - the
#                                 nastiest one; see the touch below)
set -uo pipefail

# Finder starts .command files in $HOME with a bare PATH; find the repo from
# this file and the tools from their usual homes.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
cd "$ROOT"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
say()  { printf '  %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1"; read -r -p "  (return to close) "; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

MODE="${1:-}"

# --- preflight ---------------------------------------------------------------
bold "Preflight"
command -v node >/dev/null   || die "node not found on PATH"
command -v xcrun >/dev/null  || die "xcrun not found - install Xcode"
[ -f "$HOME/.config/mattssoftware/signing/asc-api.env" ] || die "asc-api.env missing"
set -a; . "$HOME/.config/mattssoftware/signing/asc-api.env"; set +a
[ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || die "asc-api.env lacks ASC_KEY_ID / ASC_ISSUER_ID"
case "${ASC_ISSUER_ID}" in REPLACE*) die "ASC_ISSUER_ID is still a placeholder" ;; esac
XCODE="$(xcode-select -p)"
case "$XCODE" in /Applications/Xcode.app/*) ok "Xcode: $XCODE" ;; *) say "warning: xcode-select points at $XCODE (beta SDKs get rejected)" ;; esac
ok "credentials loaded (key $ASC_KEY_ID)"

# --- the ASC helper ----------------------------------------------------------
# A throwaway node script that mints the ES256 JWT and asks App Store Connect
# questions. Written fresh each run so this file stays self-contained.
ASC_HELPER="$(mktemp -t afm-asc).mjs"
trap 'rm -f "$ASC_HELPER"' EXIT
cat > "$ASC_HELPER" <<'NODE'
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const keyPath = (process.env.ASC_KEY_PATH || '')
  .replace(/^~/, process.env.HOME)
  .replace(/\$\{?HOME\}?/g, process.env.HOME);
const key = readFileSync(keyPath, 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
const payload = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
const s = createSign('SHA256');
s.update(`${header}.${payload}`);
const jwt = `${header}.${payload}.${s.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
const api = async (p) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${p}`, { headers: { authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const APP = '6799765209'; // com.mattssoftware.attackfm
const cmd = process.argv[2];
if (cmd === 'latest') {
  const b = await api(`/v1/builds?filter[app]=${APP}&limit=1&sort=-uploadedDate&fields[builds]=version`);
  console.log(b.data[0]?.attributes.version ?? '0.0.0');
} else if (cmd === 'state') {
  const want = process.argv[3];
  const b = await api(`/v1/builds?filter[app]=${APP}&limit=10&sort=-uploadedDate&fields[builds]=version,processingState`);
  const hit = b.data.find((x) => x.attributes.version === want);
  console.log(hit ? hit.attributes.processingState : 'PENDING');
} else if (cmd === 'beta') {
  const want = process.argv[3];
  const b = await api(`/v1/builds?filter[app]=${APP}&limit=10&sort=-uploadedDate&fields[builds]=version`);
  const hit = b.data.find((x) => x.attributes.version === want);
  if (!hit) { console.log('unknown'); process.exit(0); }
  const d = await api(`/v1/builds/${hit.id}/buildBetaDetail`);
  console.log(`internal: ${d.data.attributes.internalBuildState}  external: ${d.data.attributes.externalBuildState}`);
}
NODE

# --- pick the version --------------------------------------------------------
bold "Version"
LOCAL="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
say "local:  $LOCAL"
ASC_LATEST="$(node "$ASC_HELPER" latest 2>/dev/null)" || die "could not reach App Store Connect (network? key?)"
say "on ASC: $ASC_LATEST"
NEXT="$(python3 - "$LOCAL" "$ASC_LATEST" <<'PY'
import sys
def parts(v):
    try: return [int(x) for x in v.split('.')]
    except ValueError: return [0, 0, 0]
a, b = parts(sys.argv[1]), parts(sys.argv[2])
top = max(a, b) + [0] * (3 - len(max(a, b)))
top[-1] += 1
print('.'.join(str(x) for x in top))
PY
)"
if [ -n "$MODE" ] && [ "$MODE" != "--check" ]; then
  NEXT="$MODE"
  say "using requested version: $NEXT"
else
  say "next:   $NEXT"
fi
if [ "$MODE" = "--check" ]; then
  bold "Check only - stopping before the build"
  exit 0
fi
read -r -p "  Ship $NEXT? [Y/n] " yn
case "${yn:-Y}" in n|N) die "stopped" ;; esac

# --- bump everywhere ---------------------------------------------------------
bold "Bumping to $NEXT"
python3 - "$NEXT" <<'PY'
import io, json, sys
# tauri.conf.json is the one that reaches the binary; package.json rides
# along so the repo's own manifest never disagrees with the app. (It sat at
# 0.1.0 through every release, and About - which read it - said so.)
for p in ('src-tauri/tauri.conf.json', 'package.json'):
    d = json.load(open(p))
    d['version'] = sys.argv[1]
    io.open(p, 'w').write(json.dumps(d, indent=2) + '\n')
PY
PLIST=src-tauri/gen/apple/app_iOS/Info.plist
plutil -replace CFBundleShortVersionString -string "$NEXT" "$PLIST"
plutil -replace CFBundleVersion -string "$NEXT" "$PLIST"
ok "tauri.conf.json + package.json + gen plist"

# THE LOAD-BEARING TOUCH. generate_context! is a proc macro: a changed dist/
# alone never recompiles the app crate, and without this the IPA ships the
# PREVIOUS frontend inside a correctly-versioned binary. Do not remove.
touch src-tauri/src/lib.rs src-tauri/build.rs
ok "forced the frontend re-embed"

# --- build -------------------------------------------------------------------
bold "Building (distribution-signed - takes ~7 minutes)"
LOG="$(mktemp -t afm-tf).log"
node scripts/ios-clean.mjs || die "ios-clean failed"
if ! npx tauri ios build --export-method app-store-connect > "$LOG" 2>&1; then
  tail -20 "$LOG"
  die "build failed - full log: $LOG"
fi
IPA="$ROOT/src-tauri/gen/apple/build/arm64/AttackFM.ipa"
[ -f "$IPA" ] || die "build finished but no IPA at $IPA"
ok "IPA built"

# --- gates -------------------------------------------------------------------
bold "Gates"
WORK="$(mktemp -d -t afm-gate)"
unzip -q "$IPA" -d "$WORK" || die "could not unzip the IPA"
APP="$WORK/Payload/AttackFM.app"
fail=0
check() { if [ "$2" = "$3" ]; then ok "$1: $2"; else printf '  \033[31m✗ %s: got [%s] want [%s]\033[0m\n' "$1" "$2" "$3"; fail=1; fi; }

check "version"       "$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")" "$NEXT"
check "build number"  "$(plutil -extract CFBundleVersion raw -o - "$APP/Info.plist")" "$NEXT"
check "device family" "$(plutil -extract UIDeviceFamily json -o - "$APP/Info.plist" | tr -d ' \n')" "[1]"
AUTH="$(codesign -dvv "$APP" 2>&1 | grep '^Authority=' | head -1 | sed 's/^Authority=//')"
check "signing" "$AUTH" "Apple Distribution: Matt Wisniewski (F6ZAL7ANAD)"

# The asset-map gate: every current dist file's PATH must appear in the binary
# (values are compressed; the content-hashed names are the proof), and no
# orphan chunk names from an older dist may linger.
STRINGS="$(mktemp -t afm-strings)"
strings "$APP/AttackFM" > "$STRINGS"
total=0; found=0
while IFS= read -r f; do
  total=$((total + 1))
  grep -q -- "$f" "$STRINGS" && found=$((found + 1))
done < <(cd dist && find assets -type f | sed 's|^assets/||')
if [ "$total" -gt 0 ] && [ "$found" = "$total" ]; then
  ok "embedded asset map: $found/$total"
else
  printf '  \033[31m✗ embedded asset map: %s/%s - stale libapp.a. Fix: cd src-tauri && cargo clean -p app, then rerun.\033[0m\n' "$found" "$total"
  fail=1
fi
ORPHANS="$(grep -o 'index-[A-Za-z0-9_-]\{8\}\.js' "$STRINGS" | sort -u | while read -r c; do [ -f "dist/assets/$c" ] || echo "$c"; done)"
if [ -z "$ORPHANS" ]; then ok "no stale chunks"; else printf '  \033[31m✗ stale chunks: %s\033[0m\n' "$ORPHANS"; fail=1; fi
rm -rf "$WORK" "$STRINGS"
[ "$fail" = 0 ] || die "gates failed - NOT uploading"

# --- upload ------------------------------------------------------------------
bold "Uploading"
xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" >/dev/null 2>&1 \
  || die "altool validate rejected the IPA"
ok "validated"
OUT="$(xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1)" \
  || { echo "$OUT" | tail -5; die "upload failed"; }
UUID="$(echo "$OUT" | grep -o 'Delivery UUID: .*' | head -1)"
ok "uploaded (${UUID:-uuid unknown})"

# --- wait for Apple ----------------------------------------------------------
bold "Waiting for processing"
STATE="PENDING"
for _ in $(seq 1 30); do
  sleep 30
  STATE="$(node "$ASC_HELPER" state "$NEXT" 2>/dev/null || echo PENDING)"
  say "$(date +%H:%M:%S)  $STATE"
  case "$STATE" in VALID|INVALID|FAILED) break ;; esac
done
[ "$STATE" = "VALID" ] || die "processing ended as: $STATE"
ok "VALID - $(node "$ASC_HELPER" beta "$NEXT" 2>/dev/null || echo 'beta state unknown')"

# --- optional: commit the bump ----------------------------------------------
bold "Done: $NEXT is on TestFlight"
read -r -p "  Commit and push 'Release $NEXT'? [Y/n] " yn
case "${yn:-Y}" in
  n|N) say "left uncommitted" ;;
  *)
    git add src-tauri/tauri.conf.json package.json src-tauri/gen/apple/app_iOS/Info.plist
    git commit -m "Release $NEXT" >/dev/null && git push origin main >/dev/null 2>&1 \
      && ok "committed and pushed" || say "commit/push did not complete - check by hand"
    ;;
esac
read -r -p "  (return to close) "
