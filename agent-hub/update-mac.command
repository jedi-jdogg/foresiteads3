#!/bin/bash
# Double-click to update the Agent Hub to the latest version without starting it.
set -e
cd "$(dirname "$0")"
before=$(git -C .. rev-parse HEAD)
git -C .. pull --ff-only
after=$(git -C .. rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "Already up to date ($(git -C .. rev-parse --short HEAD))."
else
  echo "Updated:"; git -C .. log --oneline "$before..$after" -- agent-hub | sed 's/^/  /'
  npm install --no-audit --no-fund
fi
echo
read -n 1 -s -r -p "Press any key to close."
