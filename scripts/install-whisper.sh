#!/usr/bin/env bash
# Install local voice-transcription dependencies for the Agent Runtime:
#   - whisper-cpp (provides `whisper-cli`) + ffmpeg, via Homebrew
#   - the whisper large-v3-turbo ggml model (~1.6 GB) into ~/.agent-runtime/models
# Safe to re-run: skips anything already present. See INSTALL.md §Voice messages.
set -euo pipefail

MODEL_DIR="$HOME/.agent-runtime/models"
MODEL_FILE="$MODEL_DIR/ggml-large-v3-turbo.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

echo "==> Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install it from https://brew.sh and re-run." >&2
  exit 1
fi

echo "==> Installing whisper-cpp and ffmpeg (skips if present)"
for pkg in whisper-cpp ffmpeg; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    echo "    $pkg already installed"
  else
    brew install "$pkg"
  fi
done

echo "==> Ensuring whisper model at $MODEL_FILE"
mkdir -p "$MODEL_DIR"
# large-v3-turbo is ~1.62 GB; treat a clearly-too-small file as incomplete and refetch.
if [ -f "$MODEL_FILE" ] && [ "$(stat -f%z "$MODEL_FILE" 2>/dev/null || echo 0)" -gt 1000000000 ]; then
  echo "    model already present ($(stat -f%z "$MODEL_FILE") bytes)"
else
  echo "    downloading model (~1.6 GB) — this can take a few minutes…"
  curl -L --fail -o "$MODEL_FILE" "$MODEL_URL"
fi

echo "==> Verifying"
command -v whisper-cli >/dev/null && echo "    whisper-cli: $(command -v whisper-cli)"
command -v ffmpeg >/dev/null && echo "    ffmpeg: $(command -v ffmpeg)"
echo "    model: $MODEL_FILE ($(stat -f%z "$MODEL_FILE") bytes)"
echo
echo "Done. Restart the Agent Runtime to pick up voice transcription."
