#!/usr/bin/env bash
# Besonc — restore a fresh sandbox session.
#
# Only /home/user is snapshotted. The Flutter SDK, Docker images, node_modules
# and git credentials do NOT persist. This script puts them all back.
#
#   bash infra/scripts/bootstrap.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLUTTER_VERSION="3.35.7"
FLUTTER_DIR="/opt/flutter"
COMPOSE_VERSION="v2.32.4"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }

# --- 1. Node deps ------------------------------------------------------------
log "Node dependencies"
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  (cd "$REPO_ROOT" && npm install --silent)
fi
ok "node $(node -v), npm $(npm -v)"

# --- 2. Docker engine --------------------------------------------------------
log "Docker engine"
if ! command -v docker >/dev/null 2>&1; then
  sudo -n apt-get update -qq && sudo -n apt-get install -y -qq docker.io >/dev/null
fi
if ! pgrep -x dockerd >/dev/null 2>&1; then
  sudo -n /usr/sbin/dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do sudo -n docker info >/dev/null 2>&1 && break; sleep 1; done
fi
ok "$(sudo -n docker --version)"

# --- 3. Docker Compose plugin (NOT in apt on this image) ---------------------
log "Docker Compose plugin"
if ! sudo -n docker compose version >/dev/null 2>&1; then
  sudo -n mkdir -p /usr/libexec/docker/cli-plugins
  sudo -n curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
  sudo -n chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi
ok "$(sudo -n docker compose version | head -1)"

# --- 4. Flutter SDK ----------------------------------------------------------
log "Flutter SDK"
if [ ! -x "$FLUTTER_DIR/bin/flutter" ]; then
  TARBALL="/opt/flutter_${FLUTTER_VERSION}.tar.xz"
  sudo -n curl -fsSL -o "$TARBALL" \
    "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
  sudo -n tar xf "$TARBALL" -C /opt
  sudo -n rm -f "$TARBALL"
  sudo -n chown -R "$(id -u):$(id -g)" "$FLUTTER_DIR"
fi
git config --global --add safe.directory "$FLUTTER_DIR" 2>/dev/null || true
export PATH="$FLUTTER_DIR/bin:$PATH"
ok "$(flutter --version 2>/dev/null | head -1)"

# --- 5. TMPDIR (/tmp is a 1 GB tmpfs — pub/gradle will fill it) --------------
log "TMPDIR"
mkdir -p "$HOME/.tmp"
export TMPDIR="$HOME/.tmp"
ok "TMPDIR=$TMPDIR"

# --- 6. Git remote (credentials are stripped from snapshots) -----------------
log "Git remote"
cd "$REPO_ROOT"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -q
  git config user.email "agent@besonc.local"
  git config user.name  "Besonc Agent"
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/swendaniel08-lgtm/delivery-platform.git"
fi
ok "origin = $(git remote get-url origin)"
echo "     (push needs a fresh GitHub token — ask the user)"

cat <<'EOF'

--------------------------------------------------------------------
Ready. Add this to your shell for Flutter + pub:

  export PATH=/opt/flutter/bin:$PATH
  export TMPDIR=$HOME/.tmp

Start the dev stack (RAM is ~2 GB — use profiles):

  sudo docker compose -f infra/docker/compose.dev.yml --profile core up -d

Run the tests:

  npm test                                   # money.spec
  bash infra/scripts/test-ledger.sh          # ledger.spec
--------------------------------------------------------------------
EOF
