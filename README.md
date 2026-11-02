# YouTube Dislike for Safari

Safari extension for **macOS 13+ and iOS/iPadOS 16+**. It shows the Return YouTube
Dislike (RYD) estimate in YouTube's own dislike button, prefixed with `≈`. The
hover tooltip gives the exact estimated value. There is no extra votes panel.
If statistics cannot be loaded, YouTube's original button remains available.

The extension supports known desktop/mobile video and Shorts controls, SPA
navigation, replaced controls and back-forward page restoration. Unknown voting
markup is skipped. YouTube can change its markup; device checks remain essential.

## Voting and settings

Sending new votes to RYD is **on by default**. The compact popup contains two counters. The Safari extension options page provides
a switch, delivery status, an explanation of shared data and a link to RYD. Russian is used
for Russian UI language; other languages use English. The count is never changed
locally to pretend the server has counted a vote.

Only a trusted native click (including touch/keyboard activation) followed by a
stable, explicit change in both native `aria-pressed` states is eligible. Opening
a video never submits an existing vote. Synthetic clicks, unknown button states,
unchanged state, a visible dialog and stale navigation are rejected. Each intent
is bound to the video ID at activation. Values are like `1`, dislike `-1`, and
withdrawal `0`. Submission failure does not interfere with YouTube voting.

Network operations run in the non-persistent background. Registration is lazy:
`/puzzle/registration` GET → solve SHA-512 challenge → POST confirmation. Voting
uses `/interact/vote` → solve challenge → `/interact/confirmVote`. Only literal
JSON `true` from the confirmation endpoint marks a vote delivered.

The background serializes delivery, including across tabs. It stores an active
job and at most the latest waiting state per video in `browser.storage.local`
before sending. This deliberately limits simultaneous CPU/network work on phones.
Registration and attempt budgets survive unloading. Recovery uses messages,
startup/install events and a repeating alarm; there is no always-running queue
timer. Safari can delay alarms while suspended, so delivery is best effort.

- HTTP timeout: 10 seconds, including response body consumption.
- Transient vote failures: at most 3 retries after the initial attempt, with
  5/10/20-second minimum delays. HTTP 429 honors `Retry-After` across all jobs.
- HTTP 401: at most one re-registration per job, including across restarts.
- Queue: at most 100 video IDs; each job expires after 24 hours. Expiry and other
  terminal failures are visible in the options page.
- Each SHA-512 challenge: at most 250,000 hashes and 2 seconds; malformed or
  excessive challenges fail without blocking YouTube.
- Disabling submission clears pending work and aborts active requests where
  possible. A vote already accepted by RYD cannot be recalled by this switch.

After a process dies at an uncertain network boundary, an active vote may be
replayed before the next state. The API expresses a user's vote state, not an
increment; delivery is **at least once**, not a claim of exactly-once networking.

## License

Original contributions by Denis Malin are licensed under **MIT**.
This grant does not cover inherited or other third-party material. Read the
[license scope](LICENSE.md) and [full MIT license text](COPYING).

## Release status

Public CI checks source and unsigned builds. Signed tags trigger the release
pipeline after source verification; signing and Apple uploads require the
configured certificates and profiles. App Review submission is not automated.
See [release process](docs/RELEASE.md), [provenance](docs/PROVENANCE.md)
and [store draft readiness](docs/store/READINESS.md). No license is asserted over
inherited code.

## Installation

Open `YouTube Dislike.xcodeproj` in Xcode. Shared schemes are
`YouTube Dislike macOS` and `YouTube Dislike iOS`. Both extension targets package
exactly the same files from `YouTube Dislike Extension/Resources`.

On Mac, run the app and open Safari Extensions settings. Enable YouTube Dislike
and allow access to YouTube. If the toolbar button is hidden, add YouTube Dislike
using View → Customize Toolbar. Avoid registering several development builds
with the same bundle identifier in Safari simultaneously.

On iPhone/iPad, run the containing app, then enable the extension in Settings →
Apps → Safari → Extensions (Settings → Safari → Extensions on iOS 16–17). Allow
YouTube and, if requested, the RYD API. Open YouTube **in Safari**; extensions do
not run inside the native YouTube app. The containing app includes these steps.

Version is **2026.11.1 (3)**. Both containing apps use `page.malina.youtube-dislike`;
Safari extensions use `.macos-extension` and `.ios-extension`, and the share extension
uses `.ios-share`. New IDs install separately from the old development apps; local
extension data does not migrate. No developer team is committed. For local signing,
copy `Configs/Local.xcconfig.example` to the ignored `Configs/Local.xcconfig` and pass
it with `-xcconfig`. CI supplies signing settings only in its protected environment.

## Verification

```sh
npm ci
npm test
xcodebuild -project 'YouTube Dislike.xcodeproj' -scheme 'YouTube Dislike macOS' -configuration Release -destination 'generic/platform=macOS' build
xcodebuild -project 'YouTube Dislike.xcodeproj' -scheme 'YouTube Dislike iOS' -configuration Release -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project 'YouTube Dislike.xcodeproj' -scheme 'YouTube Dislike iOS' -configuration Release -destination 'generic/platform=iOS' build
```

Tests use jsdom, mocked WebExtension APIs, mocked HTTP and real SHA-512 vectors.
They never contact the live RYD voting API. They cover rendering, navigation,
trusted-intent gates, protocol confirmations, multi-tab ordering/coalescing,
restarts, storage failure, opt-out, timeout/retry budgets, 401/429, expiry,
validation and popup localization. jsdom cannot manufacture trusted native input;
the event listener is exercised with a test event, without a hook in shipped code.

Builds and mocks do not establish device compatibility or App Store readiness.
See [release verification](docs/release-verification.md) for live evidence and the
remaining matrix. App Store submission and publication are separate work.

## Privacy and protocol sources

See [PRIVACY.md](PRIVACY.md). There are no analytics or advertising SDKs.

The protocol follows the [official RYD source](https://raw.githubusercontent.com/Anarios/return-youtube-dislike/main/Extensions/UserScript/Return%20Youtube%20Dislike.user.js).
Background lifecycle design follows [Apple's Safari Web Extension guidance](https://developer.apple.com/videos/play/wwdc2021/10027/).

## iOS share-sheet experiment

Share a YouTube link from YouTube or Safari → More → YouTube Dislike. The new
Share Extension displays statistics directly, with loading, retry and Done
controls. It supports watch, Shorts, live and youtu.be links; no vote is sent.
This is the first delivery experiment. Push notifications and Live Activities
are not implemented. A Live Activity started from the foreground app would be
a different flow; APNs delivery would additionally require a server.

Native validation checks:

```sh
swiftc 'YouTube Dislike Share/VideoStatistics.swift' tests/share-statistics.swift -o /tmp/ryd-share-tests
/tmp/ryd-share-tests
```

See [share experiment](docs/share-experiment.md) for verification boundaries.
