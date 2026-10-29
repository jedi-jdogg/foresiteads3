#!/bin/bash
# Builds a downloadable copy of the hub (no git, no keys) for someone without GitHub access.
# Output: dist/agent-hub-<build>.zip with start-windows.cmd / start-mac.command inside.
set -e
cd "$(dirname "$0")/.."
build=$(git rev-parse --short HEAD 2>/dev/null || echo local)
out="dist/agent-hub-$build.zip"
mkdir -p dist
stage=$(mktemp -d)
mkdir -p "$stage/agent-hub"
tar --exclude=./node_modules --exclude=./.env --exclude='./logs/*' --exclude=./machines.json --exclude=./dist --exclude=./app -cf - . | tar -xf - -C "$stage/agent-hub"
mkdir -p "$stage/agent-hub/logs"
cp README-DOWNLOAD.txt "$stage/" 2>/dev/null || true
echo "$build" > "$stage/agent-hub/BUILD"
(cd "$stage" && zip -qr "$OLDPWD/$out" .)
rm -rf "$stage"
echo "wrote $out"
