#!/bin/bash
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
xcodebuild -version
swift --version
for platform in macOS 'iOS Simulator' iOS; do
  scheme='YouTube Dislike iOS'
  if [[ "$platform" == macOS ]]; then scheme='YouTube Dislike macOS'; fi
  if ! xcodebuild -quiet -project 'YouTube Dislike.xcodeproj' -scheme "$scheme" -configuration Release \
    -destination "generic/platform=$platform" -derivedDataPath "$work/$platform" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build > "$work/build.log" 2>&1; then
    # Compiler diagnostics only; full logs stay local and are removed.
    sed -E 's@/(Users|home)/[^/ ]+/@<user>/@g' "$work/build.log" | tail -80
    exit 1
  fi
  echo "Unsigned Release build passed: $platform"
done
