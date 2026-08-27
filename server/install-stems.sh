#!/usr/bin/env bash
#
# Stem separation, added to a server that is already running.
#
#   Linux (systemd):  sudo bash server/install-stems.sh
#   macOS (the home hub):   bash server/install-stems.sh
#
# Separate from install.sh on purpose: this pulls about a gigabyte of PyTorch,
# and most people running a music server never ask a song to come apart. The
# main installer stays small; this is the opt-in.
#
# The two platforms need genuinely different things, which is why this branches
# rather than pretending to be one recipe:
#
#   macOS - the server runs as you, out of a LaunchAgent, with your home
#   directory in reach. It already looks for ~/.attackfm/venvs/stems/bin/demucs
#   before it looks anywhere else, so making that venv IS the install. Metal is
#   the right device and the server picks it on its own.
#
#   Linux - the systemd unit is hardened. ProtectHome=true means the service
#   cannot see /root at all, so a venv in root's home is invisible to the thing
#   that needs it; ProtectSystem=strict makes everything read-only except the
#   paths the unit lists. So the venv goes under /opt/attackfm, the model cache
#   goes under /opt/attackfm/data (which the unit already grants), and three
#   Environment lines point the service at all of it.
#
# It is safe to re-run: the venv is reused, pip is a no-op when satisfied, and
# the unit edit is idempotent.
set -euo pipefail

# set -e dies SILENTLY on a failed command substitution - no message, no line
# number, just a script that stopped. Anything somebody else runs needs to say
# where it fell over.
trap 'echo "install-stems.sh: failed at line $LINENO" >&2' ERR

MODEL=htdemucs_6s
UNIT=/etc/systemd/system/attackfm.service

if [ "$(uname -s)" = "Darwin" ]; then
  MAC=1
  # Exactly where separator_bin() looks first. Nothing to configure afterwards.
  VENV="$HOME/.attackfm/venvs/stems"
else
  MAC=0
  VENV=/opt/attackfm/venvs/stems
  TORCH=/opt/attackfm/data/torch
  HF=/opt/attackfm/data/hf
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this with sudo - it writes to /opt and edits the systemd unit." >&2
    exit 1
  fi
  if [ ! -f "$UNIT" ]; then
    echo "No $UNIT - run server/install.sh first." >&2
    exit 1
  fi
fi

echo "==> python venv at $VENV"
mkdir -p "$(dirname "$VENV")"
python3 -m venv "$VENV"
"$VENV/bin/pip" -q install --upgrade pip wheel

echo "==> pytorch"
if [ "$MAC" = 1 ]; then
  # The default wheels carry Metal on Apple silicon, which is the whole reason
  # separation is quick here.
  "$VENV/bin/pip" -q install torch torchaudio
else
  # CPU wheels explicitly. The default index serves the CUDA build - two and a
  # half gigabytes of it - to machines with no GPU to point it at.
  "$VENV/bin/pip" -q install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi

# demucs does not drag these in on its own, and the failure lands a long way
# from the cause: the binary installs, runs, and dies on `import numpy` inside
# a transformer module. numpy is pinned under 2 because that is the pair this
# was verified against.
echo "==> demucs"
"$VENV/bin/pip" -q install demucs "numpy<2" soundfile
"$VENV/bin/pip" check

echo "==> model weights ($MODEL)"
# Fetched now rather than on the first separation, where it would look like a
# job that hung for several minutes.
#
# HF_HOME, not just TORCH_HOME: demucs 4.1 pulls its weights from the
# HuggingFace Hub, so TORCH_HOME alone sends them to ~/.cache/huggingface -
# which on Linux is a directory the service can neither read nor write.
if [ "$MAC" = 1 ]; then
  "$VENV/bin/python" -c "
from demucs.pretrained import get_model
get_model('$MODEL')
print('weights ready')
"
else
  mkdir -p "$TORCH" "$HF"
  TORCH_HOME="$TORCH" HF_HOME="$HF" "$VENV/bin/python" -c "
from demucs.pretrained import get_model
get_model('$MODEL')
print('weights ready')
"
fi

echo "==> restarting the server"
# A RESTART, not a reload, on either platform: the separator worker looks for
# demucs ONCE at startup and returns if it is missing, so a server that booted
# without it stays off however much you install underneath it.
if [ "$MAC" = 1 ]; then
  # The same label home-install.sh writes its plist under; keep them in step.
  LABEL="com.mattssoftware.attackfm-server"
  if launchctl list | grep -q "$LABEL"; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "   restarted $LABEL"
  else
    echo "   $LABEL is not loaded - start the server and it will pick this up."
  fi
else
  # Idempotent: drop any line a previous run added, then add the current set.
  sed -i '/^Environment=AFM_DEMUCS=/d;/^Environment=TORCH_HOME=/d;/^Environment=HF_HOME=/d' "$UNIT"
  sed -i "/^WorkingDirectory=/i Environment=AFM_DEMUCS=$VENV/bin/demucs\nEnvironment=TORCH_HOME=$TORCH\nEnvironment=HF_HOME=$HF" "$UNIT"
  chown -R attackfm:attackfm "$TORCH" "$HF"
  systemctl daemon-reload
  systemctl restart attackfm
fi

echo
if [ "$MAC" = 1 ]; then
  echo "Stem separation is on, using Metal."
else
  echo "Stem separation is on. On CPU a song takes about a minute per four"
  echo "minutes of music, per core-set; they are kept once made."
fi
echo "Liked songs can be separated ahead of time in Settings, under Servers."
