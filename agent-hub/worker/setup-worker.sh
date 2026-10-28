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

# 2. Remote Login (SSH). Needs your Mac password once; nothing shows while you type it.
if ! sudo systemsetup -getremotelogin 2>/dev/null | grep -qi on; then
  say "Turning on Remote Login. Type your Mac password and press Enter (nothing appears while you type)."
  if ! sudo systemsetup -setremotelogin on; then
    say "Could not turn on Remote Login here. Turn it on by hand: System Settings → General → Sharing → Remote Login (on), then paste this again."
    open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" 2>/dev/null || true
    exit 1
  fi
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

# 6. Tell the hub about this Mac, so nothing has to be typed on the hub side.
HUB_URL="http://__HUB_HOST__:__HUB_PORT__/register"
MY_NAME=$(scutil --get ComputerName 2>/dev/null || hostname -s)
if [ -n "__HUB_HOST__" ] && curl -fsS -m 8 -X POST "$HUB_URL" -H 'content-type: application/json' \
     -d "{\"host\":\"$MY_HOST\",\"user\":\"$(whoami)\",\"name\":\"$MY_NAME\"}" >/dev/null 2>&1; then
  say "Registered with the hub as $MY_HOST (login $(whoami)). It now shows under Registered Macs."
else
  say "Could not reach the hub to register automatically. On the hub Mac, Machines tab, this Mac's card: enter the login name  $(whoami)  and click Register."
fi

say "One thing left on this Mac: run   claude   once and sign in with your Claude account, so it can take tasks."
echo "Optional: Claude desktop app → Settings → Claude Code → Remote Control → add ~/agent-hub-jobs/work, so Claude in a chat can reach this Mac directly too."
