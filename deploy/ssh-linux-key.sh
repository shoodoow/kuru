#!/usr/bin/env bash
# Gives this Mac its own SSH key for the Kuru Linux server, separate from the GitHub keys.
# After it runs, `ssh linux` reaches the server with ~/.ssh/id_linux only.
# Usage: deploy/ssh-linux-key.sh [user@host]   (default aram@192.168.0.6)
set -euo pipefail

TARGET="${1:-aram@192.168.0.6}"
USER_PART="${TARGET%@*}"
HOST_PART="${TARGET#*@}"
KEY="$HOME/.ssh/id_linux"
CONFIG="$HOME/.ssh/config"

mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "$(whoami)@$(hostname -s) -> linux"
fi

# A "linux" entry that offers only this key, so the server never sees the GitHub keys
# (offering all of them is what triggered "Too many authentication failures").
if ! grep -qE '^Host linux$' "$CONFIG" 2>/dev/null; then
  cat >>"$CONFIG" <<EOF

Host linux
  HostName $HOST_PART
  User $USER_PART
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 "$CONFIG"
fi

# Puts the public key on the server. Asks for the server password once if no key works yet.
PUB="$(cat "$KEY.pub")"
ssh -o IdentitiesOnly=yes -o PubkeyAuthentication=no "$TARGET" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys)"

ssh -o BatchMode=yes linux 'echo "ssh linux works: $(hostname)"'
