# Source and artwork provenance

The Git history originates at [nima-sa/YouTube-dislike-for-safari](https://github.com/nima-sa/YouTube-dislike-for-safari), through commit `3d5d3f234657881adfdac9257ba402c86be323b9`. Original commits and attribution are retained. No upstream license grant has been established for redistribution of modified binaries. No new license is asserted over upstream code.

The maintainer requested removal of the automated distribution-permission gate.
CI does not adjudicate licensing rights. This operational change is not evidence
of upstream permission and does not extend the MIT grant to inherited material.

RYD protocol behavior was informed by [Return YouTube Dislike](https://github.com/Anarios/return-youtube-dislike). This app is independent of YouTube, Google and RYD. Names and visual emblems must be reviewed before store submission; this document grants no trademark rights.

Current app images derive from a locally generated ginger fox on a mint background, selected on 2026-11-02. Toolbar images were also changed locally. Only the images actually packaged by the app are published; master files, prompts and unused variants remain local. This records their production origin, not a legal clearance of the RYD emblem visible in the artwork.

Release tooling is adapted from the maintainer's [Slowth](https://github.com/skar404/slowth) release tools: temporary signing keychains, provisioning validation, Apple processing checks, Developer ID notarization and separate publication. Model resources, app groups, blocking extensions and XcodeGen are omitted.

Historical upstream commits contain `xcuserdata` and the upstream developer's project settings. The current tree removes user data and hard-coded signing teams; history is retained rather than silently rewritten. Historical secret-pattern checks cover all reachable blobs. These checks are heuristic, not proof of absence. Any detected credential blocks push until revocation and reviewed history cleanup.

## License scope for new contributions

Denis Malin licenses his original contributions under MIT; see
[LICENSE.md](../LICENSE.md) and [COPYING](../COPYING). This limited grant does
not relicense upstream material or establish permission for the combined app.
Inherited rights remain unresolved; no automated licensing gate is enforced.
