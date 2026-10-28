#!/bin/bash
# Prepares this Mac as an Agent Hub worker. Paste into Terminal on the worker Mac (not the hub Mac).
# Turns on Remote Login, trusts the hub's SSH key, installs Claude Code, and creates the jobs folder.
# Nothing here opens the Mac to anyone except the hub Mac holding the matching private key.
set -e
HUB_PUBKEY='__HUB_PUBKEY__'
HUB_HOST='__HUB_HOST__'

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ "$(uname)" != "Darwin" ]; then echo "This is for a Mac."; exit 1; fi

# 1. Tailscale must already be on and signed in.
TS=""
for b in /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do [ -x "$b" ] && TS="$b" && break; done
if [ -z "$TS" ] || ! "$TS" status >/dev/null 2>&1; then
  say "Tailscale is not running or not signed in on this Mac. Install it from https://tailscale.com/download, sign in, then paste this again."
  exit 1
fi
MY_HOST=$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
say "This Mac on Tailscale: $MY_HOST  (user: $(whoami))"

# 2. Remote Login (SSH). Needs your Mac password once.
if ! sudo systemsetup -getremotelogin 2>/dev/null | grep -qi on; then
  say "Turning on Remote Login (your Mac password is for this step)."
  sudo systemsetup -setremotelogin on
fi

# 3. Trust the hub's key, and only that key, for this user.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qF "$HUB_PUBKEY" ~/.ssh/authorized_keys || echo "$HUB_PUBKEY" >> ~/.ssh/authorized_keys
say "Hub key trusted."

# 4. Jobs folder: scripts you put here are the only scripts the hub may run on this Mac.
mkdir -p ~/agent-hub-jobs/work
[ -f ~/agent-hub-jobs/README.txt ] || cat > ~/agent-hub-jobs/README.txt <<'TXT'
Scripts (.sh) in this folder can be run from the Agent Hub by name.
Claude Code tasks sent from the hub work inside ./work.
TXT

# 5. Claude Code, so this Mac can take tasks on its own.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
# Make sure non-interactive SSH sessions find it too.
grep -q 'agent-hub' ~/.zshenv 2>/dev/null || printf '\n# agent-hub\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' >> ~/.zshenv
grep -q 'agent-hub' ~/.bashrc 2>/dev/null || printf '\n# agent-hub\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' >> ~/.bashrc

say "Done. Two things left to do by hand on this Mac:"
echo "  1. Run:  claude   (once) and sign in with your Claude account, so headless tasks work."
echo "  2. Optional: in the Claude desktop app, Settings → Claude Code → Remote Control, add ~/agent-hub-jobs/work"
echo "     so Claude in a chat can reach this Mac directly too."
echo
echo "Then on the hub Mac, in Agent Hub → Machines, register this Mac as:"
echo "  host: $MY_HOST    user: $(whoami)"
