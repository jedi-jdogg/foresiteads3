#!/bin/bash
# Builds "Agent Hub.app" from app/main.swift and installs it in /Applications (or ~/Applications).
# Needs Apple's command-line tools (swiftc). Run by the installer, and by start-mac.command when main.swift changed.
set -e
cd "$(dirname "$0")"
HUB_DIR=$(cd .. && pwd)
REPO_DIR=$(cd ../.. && pwd)
NAME="Agent Hub"
if [ -w /Applications ]; then APP="/Applications/$NAME.app"; else mkdir -p "$HOME/Applications"; APP="$HOME/Applications/$NAME.app"; fi
QUIET=${1:-}

log() { [ "$QUIET" = "--quiet" ] || echo "$1"; }

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Apple's command-line tools (xcode-select --install) and run again."; exit 1
fi

BUILD=$(mktemp -d)
mkdir -p "$BUILD/$NAME.app/Contents/MacOS" "$BUILD/$NAME.app/Contents/Resources"
log "Compiling…"
swiftc -O -o "$BUILD/$NAME.app/Contents/MacOS/AgentHub" main.swift -framework Cocoa -framework WebKit 2>&1 | grep -v "^$" || true
[ -x "$BUILD/$NAME.app/Contents/MacOS/AgentHub" ] || { echo "Compile failed."; exit 1; }

printf '%s\n' "$REPO_DIR" > "$BUILD/$NAME.app/Contents/Resources/hub.path"
cat > "$BUILD/$NAME.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.foresiteads.agenthub</string>
  <key>CFBundleVersion</key><string>$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 1)</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>AgentHub</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSMicrophoneUsageDescription</key><string>Agent Hub uses the microphone so you can speak a request instead of typing it.</string>
</dict></plist>
PLIST

# Icon: build an .icns from the 1024px PNG.
if command -v iconutil >/dev/null 2>&1 && [ -f icon-1024.png ]; then
  ICONSET="$BUILD/AppIcon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s*2)); sips -z $d $d icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/$NAME.app/Contents/Resources/AppIcon.icns" || true
fi

codesign --force --deep --sign - "$BUILD/$NAME.app" >/dev/null 2>&1 || true

rm -rf "$APP"
mv "$BUILD/$NAME.app" "$APP"
rm -rf "$BUILD"
touch "$APP"
log "Installed $APP"
