#!/usr/bin/env bash
#
# A local voice for the DJ, added to a server that is already running.
#
#   Linux (systemd):  sudo bash server/install-voice.sh
#   macOS (home hub): bash server/install-voice.sh
#
# Separate from install.sh on purpose, like stems: this pulls Kokoro-82M
# (an Apache-2.0 text-to-speech model, ~350MB) and most hubs will speak
# through ElevenLabs instead (set AFM_ELEVENLABS_KEY and skip this file).
# This is the no-credits fallback: slower to install, free forever, runs
# faster than realtime on a plain CPU.
#
# What it does: makes a venv with kokoro-onnx, downloads the model files,
# writes a wrapper at <bin>/voice-say.sh with the contract voice.rs expects
# ('{text}' in, an mp3 at '{out}' out), and on Linux adds the AFM_TTS_CMD
# environment line to the systemd unit. Re-running is safe.
set -euo pipefail
trap 'echo "install-voice: failed at line $LINENO" >&2' ERR

if [[ "$(uname)" == "Darwin" ]]; then
  ROOT="$HOME/.attackfm"
else
  ROOT="/opt/attackfm"
fi
VENV="$ROOT/venvs/voice"
BIN="$ROOT/bin"
MODELS="$ROOT/data/kokoro"
mkdir -p "$VENV" "$BIN" "$MODELS"

python3 -m venv "$VENV" 2>/dev/null || true
"$VENV/bin/pip" install --quiet --upgrade kokoro-onnx soundfile

for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [[ ! -f "$MODELS/$f" ]]; then
    curl -fL -o "$MODELS/$f" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
  fi
done

cat > "$BIN/voice-say.sh" <<WRAP
#!/usr/bin/env bash
# The DJ's local mouth: text in \$1, an mp3 lands at \$2. Kokoro synthesizes
# a wav; ffmpeg (already on every hub) folds it to the mp3 voice.rs serves.
set -euo pipefail
TEXT="\$1"; OUT="\$2"; WAV="\$(mktemp -t djvoice-XXXX).wav"
"$VENV/bin/python" - "\$TEXT" "\$WAV" <<'PY'
import sys, soundfile
from kokoro_onnx import Kokoro
k = Kokoro("$MODELS/kokoro-v1.0.onnx", "$MODELS/voices-v1.0.bin")
samples, rate = k.create(sys.argv[1], voice="am_michael", speed=1.0)
soundfile.write(sys.argv[2], samples, rate)
PY
ffmpeg -y -loglevel error -i "\$WAV" -b:a 128k "\$OUT"
rm -f "\$WAV"
WRAP
chmod +x "$BIN/voice-say.sh"

if [[ "$(uname)" != "Darwin" ]]; then
  UNIT_DIR="/etc/systemd/system/attackfm.service.d"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/voice.conf" <<CONF
[Service]
Environment=AFM_TTS_CMD=bash $BIN/voice-say.sh '{text}' '{out}'
CONF
  systemctl daemon-reload
  systemctl restart attackfm
  echo "Local DJ voice installed; the service now speaks through Kokoro."
else
  echo "Local DJ voice installed. Point the server at it with:"
  echo "  AFM_TTS_CMD=\"bash $BIN/voice-say.sh '{text}' '{out}'\""
fi
