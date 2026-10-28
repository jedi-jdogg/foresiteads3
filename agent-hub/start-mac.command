#!/bin/bash
# Double-click in Finder to start the Agent Hub on a Mac.
# First run: installs packages, creates .env and opens it so you can paste in your API keys.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ "$(node -p 'typeof process.loadEnvFile')" != "function" ]; then
  echo "Node.js $(node -v) is too old. Install the LTS version from https://nodejs.org, then try again."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing packages (first run only)..."
  npm install --no-audit --no-fund
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created agent-hub/.env. It is opening in TextEdit now:"
  echo "paste in your API keys, save, then come back here and press any key."
  open -e .env
  read -n 1 -s -r -p ""
  echo
fi

port=$(grep -E '^HUB_PORT=' .env | cut -d= -f2)
port=${port:-4747}
(sleep 1.5 && open "http://localhost:$port") &
echo "Agent Hub running at http://localhost:$port. Close this window to stop it."
exec node bin/hub.js serve
