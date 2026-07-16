#!/bin/bash
# Builds the native "Career-Ops Web.app" wrapper into ~/Applications.
# Requires Xcode Command Line Tools (swiftc). Re-run after moving the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(dirname "$HERE")"
APP="$HOME/Applications/Career-Ops Web.app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "Compiling…"
cp "$HERE/CareerOpsApp.swift" "$BUILD/main.swift"
# Pin the minimum OS to match LSMinimumSystemVersion in Info.plist
swiftc -O -target "$(uname -m)-apple-macos12.0" -o "$BUILD/Career-Ops Web" "$BUILD/main.swift"

# Preserve the existing icon if the old bundle had one
ICON=""
if [ -f "$APP/Contents/Resources/applet.icns" ]; then
  cp "$APP/Contents/Resources/applet.icns" "$BUILD/AppIcon.icns" && ICON="AppIcon"
elif [ -f "$APP/Contents/Resources/AppIcon.icns" ]; then
  cp "$APP/Contents/Resources/AppIcon.icns" "$BUILD/AppIcon.icns" && ICON="AppIcon"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$BUILD/Career-Ops Web" "$APP/Contents/MacOS/"
[ -n "$ICON" ] && mv "$BUILD/AppIcon.icns" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Career-Ops Web</string>
  <key>CFBundleDisplayName</key><string>Career-Ops</string>
  <key>CFBundleIdentifier</key><string>io.career-ops.web</string>
  <key>CFBundleExecutable</key><string>Career-Ops Web</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
$( [ -n "$ICON" ] && echo "  <key>CFBundleIconFile</key><string>AppIcon</string>" )
</dict>
</plist>
PLIST

# Bake the repo path in via plutil, which escapes any characters safely
plutil -insert CareerOpsWebDir -string "$WEB_DIR" "$APP/Contents/Info.plist"

codesign --force -s - "$APP" 2>/dev/null || true
echo "Built: $APP"
