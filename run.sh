#!/usr/bin/env bash
# Starts Lewisis' Music. The first run sets up a private Python environment and
# installs everything (about 900 MB, mostly the AI separation engine).
set -euo pipefail
cd "$(dirname "$0")"

install_requirements() {
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python .venv/bin/python -r requirements.txt
  else
    .venv/bin/python -m pip install -r requirements.txt
  fi
  cp requirements.txt .venv/.installed-requirements.txt
}

if [ ! -x .venv/bin/python ]; then
  echo "First run: installing dependencies for Lewisis' Music (this takes a few minutes)…"
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv
  else
    python3 -m venv .venv
    .venv/bin/python -m pip install --upgrade pip
  fi
  install_requirements
elif ! cmp -s requirements.txt .venv/.installed-requirements.txt; then
  # requirements.txt changed since the last install (a new feature needs something new).
  echo "Updating dependencies for Lewisis' Music…"
  install_requirements
fi

exec .venv/bin/python server.py "$@"
