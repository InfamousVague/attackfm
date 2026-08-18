#!/bin/bash
# Generate a fresh Play upload key and wire it up, without the password ever
# leaving this terminal. Safe to re-run: the old keystore is renamed, never
# deleted.
set -euo pipefail

JDK=/opt/homebrew/opt/openjdk@21
KEYTOOL="$JDK/bin/keytool"
KS="$HOME/.attackfm/android-release.jks"
PROPS="$(cd "$(dirname "$0")/../.." && pwd)/src-tauri/gen/android/keystore.properties"
ALIAS=attackfm

[ -x "$KEYTOOL" ] || { echo "✗ JDK 21 not found at $JDK"; exit 1; }

# The old key is set aside rather than destroyed: if it turns out Play already
# knows it, it is the only thing that can prove that, and it is 4KB.
if [ -f "$KS" ]; then
  BAK="$KS.superseded-$(date +%Y%m%d-%H%M%S)"
  mv "$KS" "$BAK"
  echo "→ old keystore kept at: $BAK"
fi

mkdir -p "$(dirname "$KS")"

# Read once, confirm once, never echoed and never written to history.
read -r -s -p "New keystore password (min 6 chars): " PW; echo
read -r -s -p "Again to confirm: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "✗ passwords did not match — nothing changed"; exit 1; }
[ ${#PW} -ge 6 ] || { echo "✗ too short — Java requires 6+"; exit 1; }

"$KEYTOOL" -genkeypair -v \
  -keystore "$KS" -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW" -keypass "$PW" \
  -dname "CN=AttackFM, OU=MattsSoftware, O=MattsSoftware, L=, ST=, C=US" \
  >/dev/null

chmod 600 "$KS"

umask 077
cat > "$PROPS" <<EOF
storeFile=$KS
storePassword=$PW
keyAlias=$ALIAS
keyPassword=$PW
EOF
chmod 600 "$PROPS"

unset PW PW2

echo "✓ keystore:   $KS"
echo "✓ properties: $PROPS  (gitignored)"
echo
"$KEYTOOL" -list -keystore "$KS" -storepass:env NONE 2>/dev/null || true
echo "Now tell Claude it's done — the signed AAB build reads the file directly."
