#!/bin/bash
# One-paste installer for the Foresite Agent Hub on macOS.
# Installs Node.js and the GitHub CLI if missing, signs in to GitHub in the browser,
# downloads the hub into ~/foresiteads3 and starts it. Safe to run again: it updates instead.
set -e
BRANCH="claude/multi-agent-interface-hub-d8ahj4"
REPO="jedi-jdogg/foresiteads3"
DEST="$HOME/foresiteads3"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pkg_install() {  # $1 = url, $2 = label
  local tmp; tmp=$(mktemp -d)
  say "Downloading $2…"
  curl -fsSL "$1" -o "$tmp/pkg.pkg"
  say "Installing $2 (your Mac password is for the installer; nothing is typed into this chat or sent anywhere)."
  sudo installer -pkg "$tmp/pkg.pkg" -target / >/dev/null
  rm -rf "$tmp"
}

if [ "$(uname)" != "Darwin" ]; then echo "This installer is for macOS."; exit 1; fi

# 1. Command-line tools (gives us git). Non-blocking if already present.
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Apple's command-line tools. Click Install in the window that opens, then run this again when it finishes."
  xcode-select --install || true
  exit 0
fi

# 2. Node.js 22 LTS
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'typeof process.loadEnvFile')" != "function" ]; then
  NODE_PKG=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22\.[0-9.]*\.pkg' | head -1)
  NODE_PKG=${NODE_PKG:-node-v22.23.4.pkg}
  pkg_install "https://nodejs.org/dist/latest-v22.x/$NODE_PKG" "Node.js"
  export PATH="/usr/local/bin:$PATH"
fi

# 3. GitHub CLI, for a browser sign-in instead of tokens. Unpacked into ~/.agent-hub, no admin password needed.
export PATH="$HOME/.agent-hub/bin:$PATH"
if ! command -v gh >/dev/null 2>&1; then
  GH_TAG=$(curl -fsSLI -o /dev/null -w '%{redirect_url}' https://github.com/cli/cli/releases/latest | grep -o 'v[0-9.]*$' | tr -d v)
  GH_TAG=${GH_TAG:-2.86.0}
  say "Downloading the GitHub tool…"
  tmp=$(mktemp -d)
  ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo amd64)
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_TAG}/gh_${GH_TAG}_macOS_${ARCH}.zip" -o "$tmp/gh.zip"
  mkdir -p "$HOME/.agent-hub/bin"
  unzip -q -o "$tmp/gh.zip" -d "$tmp"
  cp "$tmp"/gh_*/bin/gh "$HOME/.agent-hub/bin/gh"
  chmod +x "$HOME/.agent-hub/bin/gh"
  rm -rf "$tmp"
fi
if ! gh auth status >/dev/null 2>&1; then
  say "Sign in to GitHub: a code will appear below, your browser will open, paste the code there."
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git >/dev/null 2>&1 || true

# 4. Get or update the hub
if [ -d "$DEST/.git" ]; then
  say "Hub already installed. Updating…"
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" checkout --quiet "$BRANCH"
  git -C "$DEST" pull --ff-only --quiet || echo "Could not fast-forward (local edits?). Keeping the installed version."
else
  say "Downloading the hub to $DEST…"
  gh repo clone "$REPO" "$DEST" -- --branch "$BRANCH" --quiet
fi

# 5. Make the launchers double-clickable and start
chmod +x "$DEST/agent-hub/"*.command
say "Installed. Starting the Agent Hub. Next time, double-click  $DEST/agent-hub/start-mac.command"
open -a Terminal "$DEST/agent-hub/start-mac.command"
