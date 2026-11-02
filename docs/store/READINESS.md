# Store draft readiness

English metadata is prepared locally in `en-US/metadata.json`. It has not been applied to Apple. Create one card with the shared app bundle ID and add both platforms, following [Apple's app-record instructions](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/). Do not create submissions or auto-release.

## Privacy declaration draft — unresolved

Apple requires disclosures for the app and its third-party partners; use [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/) and verify RYD's actual retention, linkage and purposes before filling the form. Do not select “Data Not Collected” based on the absence of a developer backend.

| Data | Observed transmission | Declaration decision still needed |
| --- | --- | --- |
| Video ID | Statistics requests; vote requests | Browsing history / product interaction classification, retention and linkage |
| Random installation ID | Registration and voting | User/device identifier classification, linkage and retention |
| Like/dislike/withdrawal | Voting only | Product interaction classification and purposes |
| IP and connection metadata | Necessarily visible to RYD | Server retention, derived location and linkage |

Vote submission defaults on. Turning it off cancels queued work; it cannot retract data already accepted by RYD. Statistics still contact RYD. The share sheet submits only a video ID for statistics. No analytics/ad SDK or tracking integration was found in the current source; this does not establish RYD's server practices.

Native source inspection found no UserDefaults, file timestamp, disk-space or uptime required-reason API usage. Re-audit the final archive and current Apple's required-reason API list before deciding whether a PrivacyInfo.xcprivacy declaration is needed. WebExtension storage and network use still require the above privacy disclosures. Standard HTTPS/URLSession is used; export-compliance answers have not been submitted.

## Screenshots and manual checks

Capture actual 2026.11.1 (3) interfaces with the new identifiers, in English: iPhone setup/share sheet, iPad setup/share sheet, Mac setup and Safari popup. Verify the relevant current Apple screenshot sizes before upload. No mock screenshots or old-build captures are included as release evidence.

The options page must be reachable in real Safari on both platforms, with opt-out persisting after close/reopen. This remains a store-readiness blocker. No new device installation or minimum-OS qualification is claimed by compilation tests.

No Apple IDs/profiles/card/pricing/declarations/build attachment or screenshot uploads have been performed by this preparation. Existing valid team certificates must not be revoked.
