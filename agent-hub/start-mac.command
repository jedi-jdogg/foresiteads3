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

# Pull the latest version from GitHub when online. Fast-forward only, so a local edit is never overwritten.
if git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  before=$(git -C .. rev-parse HEAD)
  if git -C .. pull --ff-only --quiet 2>/dev/null; then
    after=$(git -C .. rev-parse HEAD)
    if [ "$before" != "$after" ]; then
      echo "Updated to the latest version:"
      git -C .. log --oneline "$before..$after" -- agent-hub | sed 's/^/  /'
      rm -rf node_modules/.package-lock.json
    fi
  else
    echo "Could not check for updates (offline, or local changes). Running the installed version."
  fi
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing packages (first run only)..."
  npm install --no-audit --no-fund
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created agent-hub/.env. Add your API keys in the Connect tab once the console opens."
fi

port=$(grep -E '^HUB_PORT=' .env | cut -d= -f2)
port=${port:-4747}
(sleep 1.5 && open "http://localhost:$port/#connect") &
echo "Agent Hub $(git -C .. rev-parse --short HEAD 2>/dev/null) running at http://localhost:$port. Close this window to stop it."
exec node bin/hub.js serve
