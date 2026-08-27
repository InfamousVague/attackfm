#!/usr/bin/env bash
#
# Stem separation, added to a server that is already running.
#
#   sudo bash server/install-stems.sh
#
# Separate from install.sh on purpose: this pulls about a gigabyte of PyTorch
# and another of model weights, and most people running a music server never
# ask a song to come apart. The main installer stays small; this is the opt-in.
#
# WHAT THE SERVER NEEDS, and why each piece is where it is:
#
#   * demucs, in a venv at /opt/attackfm/venvs/stems. Not in root's home,
#     because the unit sets ProtectHome=true - the service literally cannot see
#     /root, so a venv installed there is invisible to the thing that needs it.
#   * The htdemucs_6s weights, under /opt/attackfm/data. ProtectSystem=strict
#     makes everything read-only except the paths the unit lists, and data is
#     one of them; the default cache in ~/.cache is neither readable nor
#     writable from in there.
#   * Three Environment lines in the unit pointing at all of it.
#
# Note HF_HOME rather than TORCH_HOME: demucs 4.1 fetches its weights from the
# HuggingFace Hub, so TORCH_HOME alone sends the model to ~/.cache/huggingface
# and the service - which cannot see root's home - re-downloads on every job
# into a directory it is not allowed to write.
#
# It is safe to re-run: the venv is reused, pip is a no-op when satisfied, and
# the unit edit is idempotent.
set -euo pipefail

# set -e dies SILENTLY on a failed command substitution - no message, no line
# number, just a script that stopped. Anything somebody else runs needs to say
# where it fell over.
trap 'echo "install-stems.sh: failed at line $LINENO" >&2' ERR

VENV=/opt/attackfm/venvs/stems
UNIT=/etc/systemd/system/attackfm.service
TORCH=/opt/attackfm/data/torch
HF=/opt/attackfm/data/hf
MODEL=htdemucs_6s

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo - it writes to /opt and edits the systemd unit." >&2
  exit 1
fi
if [ ! -f "$UNIT" ]; then
  echo "No $UNIT - run server/install.sh first." >&2
  exit 1
fi

echo "==> python venv at $VENV"
mkdir -p "$(dirname "$VENV")"
python3 -m venv "$VENV"
"$VENV/bin/pip" -q install --upgrade pip wheel

# CPU wheels explicitly. The default index serves the CUDA build - two and a
# half gigabytes of it - to machines that have no GPU to point it at.
echo "==> pytorch (cpu build)"
"$VENV/bin/pip" -q install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# demucs does not drag these in on its own here, and the failure is a long way
# from the cause: the binary installs, runs, and dies on `import numpy` inside
# a transformer module. numpy is pinned under 2 because that is the pair this
# was verified against.
echo "==> demucs"
"$VENV/bin/pip" -q install demucs "numpy<2" soundfile
"$VENV/bin/pip" check

echo "==> model weights ($MODEL)"
mkdir -p "$TORCH" "$HF"
# Fetched now rather than on the first separation, where it would look like a
# job that hung for several minutes.
TORCH_HOME="$TORCH" HF_HOME="$HF" "$VENV/bin/python" -c "
from demucs.pretrained import get_model
get_model('$MODEL')
print('weights ready')
"

echo "==> unit"
# Idempotent: drop any line we previously added, then add the current pair.
sed -i '/^Environment=AFM_DEMUCS=/d;/^Environment=TORCH_HOME=/d;/^Environment=HF_HOME=/d' "$UNIT"
sed -i "/^WorkingDirectory=/i Environment=AFM_DEMUCS=$VENV/bin/demucs\nEnvironment=TORCH_HOME=$TORCH\nEnvironment=HF_HOME=$HF" "$UNIT"
chown -R attackfm:attackfm "$TORCH" "$HF"

systemctl daemon-reload
# A restart, not a reload: the separator worker checks for demucs ONCE at
# startup and returns if it is missing, so a server that booted without it
# stays off however much you install underneath it.
systemctl restart attackfm

echo
echo "Stem separation is on. The first song takes a few minutes on CPU;"
echo "after that they are kept, and Liked can be separated ahead in Settings."
