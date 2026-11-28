#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "ERROR: $PYTHON_BIN was not found. Install python3 first."
  exit 1
fi

PY_VERSION="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "Using Python $PY_VERSION"

if [[ ! -d .venv ]]; then
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --only-binary=:all: -r requirements-ai.txt

mkdir -p models temp

echo
echo "Downloading and preparing the local AI models."
echo "This is a one-time download; it can take a while and needs free disk space."
.venv/bin/python subtitle_ai.py download-models

echo
echo "AI setup completed."
echo "The Node.js worker will automatically use .venv/bin/python."
