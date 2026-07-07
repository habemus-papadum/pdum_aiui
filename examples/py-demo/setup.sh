#!/usr/bin/env bash
#
# Create a uv-managed virtualenv with numpy installed, so a language server
# (pyright) can resolve the real third-party dependency. Idempotent: re-running
# just re-syncs the environment.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Creating virtualenv (.venv) with uv"
uv venv

echo "==> Installing project + numpy into .venv"
# Install the local package (editable) which pulls in numpy>=1.26 from
# pyproject.toml. `uv pip install` writes into the .venv created above.
uv pip install -e .

echo
echo "OK: .venv is ready. Run the demo with:  uv run python -m pydemo"
