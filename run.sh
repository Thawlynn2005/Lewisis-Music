#!/usr/bin/env bash
# Starts Lewisis' Music. The first run sets up a private Python environment and
# installs everything (about 900 MB, mostly the AI separation engine).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "First run: installing dependencies for Lewisis' Music (this takes a few minutes)…"
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv
    uv pip install --python .venv/bin/python -r requirements.txt
  else
    python3 -m venv .venv
    .venv/bin/python -m pip install --upgrade pip
    .venv/bin/python -m pip install -r requirements.txt
  fi
fi

exec .venv/bin/python server.py "$@"
