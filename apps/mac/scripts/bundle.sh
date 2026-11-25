#!/usr/bin/env bash
# phase47: release 빌드 → dist/FinClaw.app 조립 → ad-hoc 서명. 마지막 줄에 .app 경로를 출력한다.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
APP=dist/FinClaw.app
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
cp .build/release/FinClawMac "$APP/Contents/MacOS/FinClawMac"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.finclaw.mac</string>
  <key>CFBundleName</key><string>FinClaw</string>
  <key>CFBundleExecutable</key><string>FinClawMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "$APP"
