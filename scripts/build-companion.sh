#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
[[ "$(uname -s)" == Darwin ]] || { echo "The companion requires macOS 14+ on Apple Silicon."; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo "The current build targets Apple Silicon."; exit 1; }
# File-provider folders can restore FinderInfo while signing; build outside the checkout.
glance_build=$(mktemp -d "${TMPDIR:-/tmp}/jev-glance-build.XXXXXX")
trap 'rm -rf "$glance_build"' EXIT
glance_bundle="$glance_build/Glance.app"
mkdir -p "$glance_bundle/Contents/MacOS" "$glance_bundle/Contents/Resources"
cp native/Glance/Info.plist "$glance_bundle/Contents/Info.plist"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 native/Glance/Sources/*.swift -o "$glance_bundle/Contents/MacOS/Glance"
xattr -cr "$glance_bundle"
codesign --force --sign - --identifier local.glance.screenhelper "$glance_bundle"
codesign --verify --deep --strict "$glance_bundle"
mkdir -p native/build
rm -rf native/build/Glance.app
ditto --noextattr "$glance_bundle" native/build/Glance.app
bun run scripts/pair-companion.ts
echo "Built: $PWD/native/build/Glance.app"
