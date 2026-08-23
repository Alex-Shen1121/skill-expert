# Skill Expert Distribution

The product and release language used to keep Skill Expert independent from the
upstream project while retaining reviewed upstream tracking.

## Language

**Upstream project**:
The external `xingkongliang/skills-manager` project, with its own decisions,
versions, releases, and update channel.

**Independent fork**:
The `Alex-Shen1121/skills-manager` project, which owns a release line distinct
from the upstream project even when it incorporates upstream changes.

**Skill Expert**:
The product distributed by the independent fork, with its own app identity, CLI,
packages, repository, versions, releases, and update channel.

**Upstream tracking**:
The reviewed incorporation of selected upstream changes without surrendering
Skill Expert's product decisions or release line.
_Avoid_: Upstream sync

**Existing-installation import**:
A user-approved one-time copy of upstream product data into Skill Expert, not a
shared live data store between the products.
_Avoid_: Migration, shared library

**Development integration branch**:
The `main` branch into which every product change, hotfix, version change, and
reviewed upstream change is first integrated.
_Avoid_: Production branch

**Release branch**:
The long-lived `release` branch containing only candidates promoted from the
development integration branch.
_Avoid_: Deployment branch

**Release candidate**:
An exact commit on the development integration branch whose version, changelog,
tests, and packages have passed the release gates.
_Avoid_: Latest main

**Release promotion**:
The merge-commit pull request that advances a release candidate from `main` to
`release`; merging it is the approval to publish that candidate.
_Avoid_: Release merge, tag push
