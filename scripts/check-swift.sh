#!/bin/bash
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swiftc 'YouTube Dislike Share/VideoStatistics.swift' tests/share-statistics.swift -o "$work/share-tests"
"$work/share-tests"
swiftc Shared/BuildIdentity.swift tests/build-identity.swift -o "$work/identity-tests"
"$work/identity-tests"
