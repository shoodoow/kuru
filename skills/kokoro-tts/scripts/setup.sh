#!/usr/bin/env bash
# setup.sh: installs Kokoro text to speech into /shared/kokoro, once per computer, for every agent on the account.
set -euo pipefail
ROOT="${KOKORO_HOME:-/shared/kokoro}"
BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
if [ -x "$ROOT/venv/bin/python" ] && [ -s "$ROOT/kokoro-v1.0.onnx" ] && [ -s "$ROOT/voices-v1.0.bin" ] && [ -f "$ROOT/.ready" ]; then
  echo "kokoro ready: $ROOT"; exit 0
fi
mkdir -p "$ROOT"
echo "== python environment"
python3 -m venv "$ROOT/venv"
"$ROOT/venv/bin/pip" install --quiet --upgrade pip
"$ROOT/venv/bin/pip" install --quiet kokoro-onnx soundfile
echo "== model (about 350 MB)"
# Downloaded under another name and moved, so a download cut short is never taken for the model.
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s "$ROOT/$f" ] || { curl -fSL --retry 3 -o "$ROOT/$f.part" "$BASE/$f" && mv "$ROOT/$f.part" "$ROOT/$f"; }
done
"$ROOT/venv/bin/python" -c "from kokoro_onnx import Kokoro; Kokoro('$ROOT/kokoro-v1.0.onnx', '$ROOT/voices-v1.0.bin')"
touch "$ROOT/.ready"
# Other agents on this account read it; only the one who installed it can change it.
chmod -R a+rX "$ROOT"
echo "kokoro ready: $ROOT"
