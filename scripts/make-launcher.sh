#!/usr/bin/env bash
# Generate a desktop launcher for Odylic Lens.
#
#   macOS  -> ~/Applications/Odylic Lens.app   (double-clickable, Spotlight-able)
#   Linux  -> ~/.local/share/applications/odylic-lens.desktop
#
# The launcher starts the API + Vite dev server in the background and
# opens the web UI in the default browser. Closing the browser does NOT
# kill the servers; use `lens stop` (installed by install.sh) to halt.
#
# Idempotent. re-running overwrites the existing launcher with the
# current version of this script.
set -e

LENS_DIR="${ODYLIC_LENS_DIR:-$HOME/odylic-lens}"
if [ ! -d "$LENS_DIR" ]; then
  echo "✗ $LENS_DIR not found. Run install.sh first."
  exit 1
fi

UNAME="$(uname -s)"

# Shared start command used by every launcher target.
#
# The API mounts `web/dist/` as a static SPA (see main.py spa_fallback),
# so launch only needs to boot one process. If web/dist is missing
# (someone deleted it or skipped the build step), fall back to the
# Vite dev server on :5173 as a safety net.
read -r -d '' START_CMD <<EOF || true
cd "$LENS_DIR"
mkdir -p .run
if [ -f .run/api.pid ]; then kill "\$(cat .run/api.pid)" 2>/dev/null || true; fi
if [ -f .run/web.pid ]; then kill "\$(cat .run/web.pid)" 2>/dev/null || true; fi
# Apple Silicon arch guard. The bundled Python is a universal
# binary; when the .app is launched from Finder/Dock its parent
# process can be x86_64 (Rosetta), which causes Python to slice as
# x86_64 too — then arm64 wheel .so files fail to load with
# "incompatible architecture (have 'arm64', need 'x86_64')". Force
# arm64 explicitly on M-series Macs so the venv resolves correctly.
# We detect with sysctl rather than uname -m because under Rosetta
# uname -m reports the EMULATED arch ("x86_64") and the guard would
# silently no-op — which is exactly the failure mode we just shipped.
ARCH_PREFIX=""
if [ "\$(uname -s)" = "Darwin" ] && [ "\$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  ARCH_PREFIX="arch -arm64"
fi
# Start API (serves the SPA bundle + /api/*)
(cd api && nohup \$ARCH_PREFIX ./venv/bin/python main.py > "$LENS_DIR/.run/api.log" 2>&1 &
  echo \$! > "$LENS_DIR/.run/api.pid")
# Fallback: if the prebuilt bundle is missing, start Vite dev too.
PORT=8765
if [ ! -f "$LENS_DIR/web/dist/index.html" ]; then
  (cd web && nohup npm run dev > "$LENS_DIR/.run/web.log" 2>&1 &
    echo \$! > "$LENS_DIR/.run/web.pid")
  PORT=5173
fi
# Wait for the chosen port to bind.
for i in {1..40}; do
  if curl -sf "http://localhost:\$PORT/api/status" >/dev/null 2>&1 \
     || curl -sf "http://localhost:\$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
EOF

case "$UNAME" in
  Darwin)
    APP="$HOME/Applications/Odylic Funnel Viewer.app"
    mkdir -p "$APP/Contents/MacOS"
    mkdir -p "$APP/Contents/Resources"

    # NOTE: $PORT must be escaped as \$PORT here so the value is taken
    # at LAUNCH time (set by START_CMD's bash) rather than substituted to
    # empty at make-launcher.sh generation time. Without the escape the
    # launcher would emit `open "http://localhost:"` which Brave opens
    # as port 80 → blank page.
    cat > "$APP/Contents/MacOS/launch" <<EOF
#!/usr/bin/env bash
$START_CMD
open "http://localhost:\$PORT/funnel-demo"
EOF
    chmod +x "$APP/Contents/MacOS/launch"

    cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.odylic.funnelviewer</string>
  <key>CFBundleName</key><string>Odylic Funnel Viewer</string>
  <key>CFBundleDisplayName</key><string>Odylic Funnel Viewer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>CFBundleVersion</key><string>0.3.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

    # App icon = the Odylic brand PNG we already ship. Build a proper
    # multi-resolution .icns via macOS sips + iconutil so Finder/Dock render
    # it crisply. Falls back to the generated icon, then a raw PNG.
    RES="$APP/Contents/Resources"
    SRC_PNG="$LENS_DIR/web/public/odylic-icon.png"
    if [ -f "$SRC_PNG" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
      TMP_ICON="$(mktemp -d)"; ICONSET="$TMP_ICON/AppIcon.iconset"; mkdir -p "$ICONSET"
      for SZ in 16 32 128 256 512; do
        sips -z $SZ $SZ "$SRC_PNG" --out "$ICONSET/icon_${SZ}x${SZ}.png" >/dev/null 2>&1 || true
        sips -z $((SZ*2)) $((SZ*2)) "$SRC_PNG" --out "$ICONSET/icon_${SZ}x${SZ}@2x.png" >/dev/null 2>&1 || true
      done
      iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" >/dev/null 2>&1 || true
      rm -rf "$TMP_ICON"
    fi
    if [ ! -f "$RES/AppIcon.icns" ]; then
      ICNS="$LENS_DIR/scripts/build/AppIcon.icns"
      if [ ! -f "$ICNS" ] && [ -x "$LENS_DIR/api/venv/bin/python" ]; then
        "$LENS_DIR/api/venv/bin/python" "$LENS_DIR/scripts/make-icon.py" >/dev/null 2>&1 || true
      fi
      [ -f "$ICNS" ] && cp "$ICNS" "$RES/AppIcon.icns"
    fi
    [ -f "$RES/AppIcon.icns" ] || { [ -f "$SRC_PNG" ] && cp "$SRC_PNG" "$RES/AppIcon.png" 2>/dev/null || true; }

    # Force Finder/LaunchServices to re-cache the icon. Without this, the
    # bundle keeps showing the previous (or generic) icon until logout.
    touch "$APP" 2>/dev/null || true
    /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
      -f "$APP" >/dev/null 2>&1 || true

    echo "  ✓ macOS launcher: $APP"
    echo "    Open from Applications, Spotlight, or 'open -a \"Odylic Funnel Viewer\"'"
    ;;

  Linux)
    DESKTOP="$HOME/.local/share/applications/odylic-lens.desktop"
    mkdir -p "$(dirname "$DESKTOP")"

    LAUNCH="$LENS_DIR/.run/launch.sh"
    mkdir -p "$LENS_DIR/.run"
    cat > "$LAUNCH" <<EOF
#!/usr/bin/env bash
$START_CMD
xdg-open "http://localhost:\$PORT/funnel-demo"
EOF
    chmod +x "$LAUNCH"

    # Generate the 512px icon if missing and Pillow is available.
    ICON="$LENS_DIR/web/public/odylic-icon.png"
    if [ ! -f "$ICON" ] && [ -x "$LENS_DIR/api/venv/bin/python" ]; then
      "$LENS_DIR/api/venv/bin/python" "$LENS_DIR/scripts/make-icon.py" >/dev/null 2>&1 || true
    fi
    # Fall back to odylic-logo.png if make-icon.py didn't run.
    [ -f "$ICON" ] || ICON="$LENS_DIR/web/public/odylic-logo.png"

    cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Odylic Funnel Viewer
Comment=Self-hosted Meta ad creative analysis
Exec=$LAUNCH
Icon=$ICON
Terminal=false
Categories=Development;Office;
StartupNotify=true
EOF
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    echo "  ✓ Linux launcher: $DESKTOP"
    ;;

  *)
    echo "  ⚠ Unsupported OS ($UNAME). Manual start: $LENS_DIR/start.sh"
    ;;
esac
