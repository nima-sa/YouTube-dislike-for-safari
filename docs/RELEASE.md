# Release 2026.11.1 (3)

State: release preparation; signed-source checks enforced. No App Review submission or App Store publication is authorized by this workflow.

## Source checks

`npm ci --ignore-scripts && npm test`, `bash scripts/check-swift.sh`, `python3 -m unittest discover -s tests -p 'test_*.py'`, and `bash scripts/check-builds.sh` run without Apple secrets. CI audits the explicit `release/public-files.json` list, all reachable history for credential patterns, and every target's version and identifiers. PR code never runs with `pull_request_target`.

The planned runner is `xcode-27` with `/Applications/Xcode_27.0.app/Contents/Developer`, matching the current Slowth workflow. Runner availability must be verified by a successful GitHub run. Local Xcode 27.1 results do not establish that.

Local signing: copy `Configs/Local.xcconfig.example` to the ignored `Configs/Local.xcconfig`, set a team and pass `-xcconfig Configs/Local.xcconfig` to xcodebuild. Never publish that file. Both apps use `page.malina.youtube-dislike`; the extension IDs end in `.macos-extension`, `.ios-extension`, `.ios-share`. These install separately from the old development IDs; extension data does not migrate automatically.

## Release sequence

1. Resolve [provenance](PROVENANCE.md), App Store privacy declarations and physical Safari settings access. Licensing scope is documented separately and is not an automated release gate.
2. Register the four explicit App IDs; create separate iOS App Store, Mac App Store and Developer ID profiles for the appropriate targets. Reuse valid certificates; never revoke unrelated certificates.
3. Configure `app-store` to allow only `main`. Set `APPLE_TEAM_ID`, `ASC_APP_ID`, and the secrets enumerated in `release.yml`. The single ASC app must have bundle ID `page.malina.youtube-dislike`, English store metadata and both iOS/macOS platforms. Price is free, no in-app purchases.
4. Before upload, the tools query Apple's existing builds per platform and refuse build 3 if already consumed. An ambiguous or failed upload requires manual Apple-state inspection; do not rerun blindly. Partial uploads are not resent automatically. Recovery of an incomplete Apple upload still requires operator reconciliation and, where necessary, a new build number.
5. Sign the source commit and annotated `v2026.11.1-build.3` tag (the original `v2026.11.1` remains on its preparation commit) with the pinned public key. Never replace a tag. Before any Apple upload, a corrected source can use a new tag such as `v2026.11.1-build.3-r2`; this suffix does not change the app version/build. The tag dispatcher verifies both signatures and dispatches the workflow on main. If main moves before dispatch, preflight refuses the release; it cannot build a different commit.
6. The protected build repeats checks, builds exact source, signs IPA/PKG and universal Developer ID ZIP, notarizes and staples the ZIP's app, and waits for both Apple platforms to return `VALID`. Only the five explicit public artifacts plus verification bundles are retained. Temporary credentials, archives and private signing output stay out of artifact uploads.
7. A separate workflow with no Apple environment verifies the successful source run, commit, checksums and GitHub attestations, creates a draft, downloads and compares every byte, then publishes. Existing drafts/releases are never replaced automatically.
8. To recover GitHub publication after a successful build, dispatch `publish.yml` with `source_run`. It does not rebuild or upload to Apple. The source artifact must still be retained (30 days). If a draft already exists, inspect it instead of automatically overwriting it.

Attestations establish [build provenance](https://docs.github.com/en/actions/concepts/security/artifact-attestations), not byte-for-byte reproducibility or equivalence to Apple's processed downloads. Verify downloads with `shasum -a 256 -c SHA256SUMS` and `gh attestation verify FILE --repo skar404/youtube-dislike-for-safari`.

## Remaining qualification

Signing/export/notarization/Apple processing are untested until credentials are available. Existing device evidence in `release-verification.md` concerns older IDs/builds. New-ID installation, Safari options-page access and persistent vote opt-out require a real Mac and iPhone/iPad check. Minimum macOS 13 and iOS/iPadOS 16 remain unverified. No screenshots should imply those checks passed.
