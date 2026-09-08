# gh-authenticated macOS release channel

The `gh-authenticated macOS release` workflow checks the latest stable upstream
Release every six hours. When it finds a version that has not been mirrored, it:

1. checks out the exact upstream Release tag;
2. adds authenticated GitHub CLI discovery with anonymous HTTP fallback;
3. routes Release discovery and downloads to this fork;
4. assigns the build `<upstream-version>-gh.1`;
5. runs the focused update tests and creates an ad-hoc-signed macOS arm64 DMG;
6. publishes the verified DMG as this fork's latest Release.

The first custom build must be installed manually. Later custom builds are found by
codexhost's normal updater. The workflow does not publish npm packages and does not
install or restart applications on a user's computer.

If an upstream change makes the source transformation ambiguous, the workflow fails
instead of publishing an unverified package. Update `tools/gh-auth-release/prepare.mjs`
for the new source shape and rerun the workflow manually.
