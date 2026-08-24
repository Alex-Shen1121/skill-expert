# Release candidate builds

The `Build Release Candidate` workflow packages one exact development integration commit
for review before release promotion. It accepts `candidate_sha` as a required, full
40-character commit SHA through both `workflow_dispatch` and `workflow_call`, checks out
that exact object, and fails if `HEAD` differs.

Run the manual workflow from GitHub Actions, paste the reviewed SHA into `candidate_sha`,
and download the four short-lived Actions artifacts after all matrix jobs pass. The same
workflow can be reused from a later release-candidate guard through `workflow_call`.

This workflow never creates a tag, GitHub Release, or updater metadata. It has read-only
repository permissions. Each matrix job creates an ephemeral candidate updater signing key
inside the runner and discards it with the runner; it never reads the production updater
private key. The resulting signatures prove that updater-shaped files were generated, but
they are not valid production updates.

## Targets and exact asset names

For version `1.2.3`, each uploaded target directory must contain exactly the following
files. The inventory verifier rejects both missing and additional files.

- macOS arm64
  - `skill-expert-v1.2.3-macos-arm64.dmg`
  - `skill-expert-v1.2.3-macos-arm64.app.tar.gz`
  - `skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig`
  - `skill-expert-cli-v1.2.3-macos-arm64`
- macOS x64
  - `skill-expert-v1.2.3-macos-x64.dmg`
  - `skill-expert-v1.2.3-macos-x64.app.tar.gz`
  - `skill-expert-v1.2.3-macos-x64.app.tar.gz.sig`
  - `skill-expert-cli-v1.2.3-macos-x64`
- Windows x64
  - `skill-expert-v1.2.3-windows-x64-setup.exe`
  - `skill-expert-v1.2.3-windows-x64-setup.exe.sig`
  - `skill-expert-v1.2.3-windows-x64.msi`
  - `skill-expert-v1.2.3-windows-x64.msi.sig`
  - `skill-expert-cli-v1.2.3-windows-x64.exe`
- Linux x64
  - `skill-expert-v1.2.3-linux-x64.AppImage`
  - `skill-expert-v1.2.3-linux-x64.AppImage.sig`
  - `skill-expert-v1.2.3-linux-x64.deb`
  - `skill-expert-v1.2.3-linux-x64.rpm`
  - `skill-expert-cli-v1.2.3-linux-x64`

The workflow derives the real version from `package.json`; `1.2.3` above only demonstrates
the stable naming contract.

## macOS signing and first launch

The built app, the app extracted from the updater archive, and the standalone CLI must each
pass `codesign --verify --deep --strict` and report an ad-hoc identity with no signing team.
This is an integrity check, not a Gatekeeper acceptance or notarization claim.

Because candidate apps are ad-hoc signed and not notarized, macOS can block the first launch.
Try opening Skill Expert once, then choose **System Settings → Privacy & Security → Open Anyway**
and confirm the app. Keep Gatekeeper enabled; the exception applies only to Skill Expert.
