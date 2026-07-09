#!/usr/bin/env bash
# Odylic Funnel Viewer — one-line installer for macOS / Linux.
# Usage: curl -fsSL https://raw.githubusercontent.com/peterquads/odylic-lens/main/install.sh | bash
set -e

REPO="${ODYLIC_LENS_REPO:-peterquads/odylic-lens}"
INSTALL_DIR="${ODYLIC_LENS_DIR:-$HOME/odylic-lens}"

echo ""
echo "  ╔═════════════════════════════════════╗"
echo "  ║   Installing Odylic Funnel Viewer   ║"
echo "  ╚═════════════════════════════════════╝"
echo ""

# 1) Prereqs
if ! command -v git >/dev/null 2>&1; then
  echo "✗ Git is required. Install: https://git-scm.com/downloads"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ Python 3.11+ is required. Install: https://www.python.org/downloads"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js 20+ is required. Install: https://nodejs.org"
  exit 1
fi

# 2) Clone or pull
#
# LENS_SKIP_GIT=1 short-circuits the clone-or-pull step. Set by CI when
# the workspace is already a checkout (potentially in a detached-HEAD
# state where `git pull --ff-only` would fail) and the installer just
# needs to set up the venv + npm build against the current tree.
if [ "${LENS_SKIP_GIT:-0}" = "1" ]; then
  echo "→ Skipping clone/pull (LENS_SKIP_GIT=1)"
elif [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "→ Cloning $REPO into $INSTALL_DIR"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# 3) Backend deps
echo "→ Installing API dependencies"
cd api
# Apple Silicon arch guard. The Python.org universal2 installer ships
# a fat binary; if pip happens to install x86_64 wheels (e.g. because
# an x86_64 shell was invoked first) the launcher will then crash with
# "incompatible architecture (have 'arm64', need 'x86_64')". Force
# arm64 explicitly on M-series so every wheel lands as arm64.
# Detect via sysctl (NOT uname -m): under Rosetta `uname -m` reports
# the EMULATED arch ("x86_64") and silently lies about the hardware;
# sysctl hw.optional.arm64 reports the real CPU regardless of mode.
ARCH_PREFIX=""
if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  ARCH_PREFIX="arch -arm64"
fi
if [ ! -d venv ]; then
  $ARCH_PREFIX python3 -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
$ARCH_PREFIX pip install --quiet --upgrade pip
$ARCH_PREFIX pip install --quiet -e .
deactivate
cd ..

# 4) Frontend deps + production build
#
# Pre-build the web bundle here so the desktop launcher can start the
# API alone and serve the SPA from `web/dist/` (FastAPI's StaticFiles
# mount in main.py). Skipping `npm run dev` at launch time turns a
# 15-30s Vite cold-start into a single-process API boot (~2s).
echo "→ Installing web dependencies"
cd web
npm install --silent --no-fund --no-audit
echo "→ Building web bundle (this takes ~5s)"
npm run build --silent
cd ..

# 5) .env
if [ ! -f .env ]; then
  cp .env.example .env
  # Auto-generate a fresh secret key
  if command -v openssl >/dev/null 2>&1; then
    SECRET=$(openssl rand -hex 32)
    # Cross-platform sed in-place: write to a temp and move
    awk -v key="$SECRET" '/^LENS_SECRET_KEY=/ {print "LENS_SECRET_KEY=" key; next} {print}' .env > .env.tmp && mv .env.tmp .env
    echo "→ Generated LENS_SECRET_KEY in .env"
  fi
  echo ""
  echo "  ⚠  Next step: edit .env and add your META_APP_ID + META_APP_SECRET"
  echo "     See docs/setup.md for the 5-minute Meta App walkthrough."
fi

# 6) start helpers
cat > "$INSTALL_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# Single port. install.sh prebuilds web/dist and the API serves the SPA
# from :8765, so everything (funnel viewer, setup wizard, OAuth) lives on
# one origin. Vite dev is only started as a fallback when the bundle is
# missing (someone deleted web/dist or is doing HMR dev work).
(cd api && source venv/bin/activate && python main.py) &
API_PID=$!
if [ -f web/dist/index.html ]; then
  echo ""
  echo "  Odylic Funnel Viewer → http://localhost:8765/funnel-demo"
  echo "  Ctrl+C to stop."
  trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
  wait
else
  (cd web && npm run dev) &
  WEB_PID=$!
  echo ""
  echo "  API: http://localhost:8765   ·   Web (dev fallback): http://localhost:5173"
  echo "  Ctrl+C to stop both."
  trap 'kill $API_PID $WEB_PID 2>/dev/null' EXIT INT TERM
  wait
fi
EOF
chmod +x "$INSTALL_DIR/start.sh"

# 7) `lens` CLI on PATH
#
# Drop the multi-command helper into the first writable bin dir on PATH so
# the user can run `lens start` / `lens update` from any terminal. Prefers
# /usr/local/bin (canonical) but falls back to ~/.local/bin on Linux setups
# that hide /usr/local from non-sudo users.
LENS_CLI_SRC="$INSTALL_DIR/scripts/lens"
chmod +x "$LENS_CLI_SRC"
INSTALLED_CLI=""
for BIN_DIR in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
    ln -sf "$LENS_CLI_SRC" "$BIN_DIR/lens"
    INSTALLED_CLI="$BIN_DIR/lens"
    break
  fi
done
if [ -z "$INSTALLED_CLI" ]; then
  echo "  ⚠  Couldn't symlink lens CLI to PATH. Add this to your shell rc:"
  echo "     alias lens='$LENS_CLI_SRC'"
fi

# 8) Desktop launcher (.app on macOS, .desktop on Linux)
chmod +x "$INSTALL_DIR/scripts/make-launcher.sh"
"$INSTALL_DIR/scripts/make-launcher.sh" || true

# 9) Auto-update check on startup.
#
# `lens start` runs a one-shot `lens update --check-only` via a 1-day
# debounce. Touches .run/last_update_check so we only hit the network
# once per 24h. The actual update is opt-in (the API surfaces a
# "Update available" notice in the UI; user runs `lens update`).
mkdir -p "$INSTALL_DIR/.run"

echo ""
echo "  ✓ Installed."
echo ""
echo "  Next:"
echo "    1) Edit $INSTALL_DIR/.env (add META_APP_ID + META_APP_SECRET)"
[ -n "$INSTALLED_CLI" ] && echo "    2) Run: lens start"
[ -z "$INSTALLED_CLI" ] && echo "    2) Run: $INSTALL_DIR/start.sh"
echo "    3) Open: http://localhost:8765/funnel-demo  (or launch from Applications)"
echo ""
echo "  Update later with:  lens update"
echo ""
