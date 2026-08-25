---
status: accepted
---

# Distribute the independent fork as Skill Expert

The independent fork will be distributed as the independent product **Skill
Expert**, with its user-facing app, CLI, packages, repository, app identity,
update channel, and release assets renamed to `Skill Expert` or `skill-expert`.
Its version line starts at 1.0.0 and it remains installable alongside the
upstream product. This separates ownership of releases, signing, and updates
while preserving the ability to incorporate selected upstream changes.

## Considered Options

- Continue the upstream product identity and 1.34.x version line.
- Create an independent product and release line while retaining upstream
  tracking.

## Consequences

- Upstream and Skill Expert releases cannot share updater signing keys or feeds.
- Skill Expert uses `com.codingshen.skill-expert` as its app bundle identifier.
- Upstream changes must be reviewed and incorporated without replacing Skill
  Expert's product identity or release history.
- The initial release matrix remains macOS arm64/x64, Windows x64, and Linux x64.
- Skill Expert offers a user-confirmed one-time import from an existing upstream
  installation instead of sharing a mutable data directory with it.
- A weekly upstream check may prepare a reviewable pull request, but upstream
  changes are never merged automatically.
