---
status: accepted
---

# Promote releases from main to release

Every change first integrates into `main`, while the long-lived `release` branch
starts at commit `e7ed215` and advances only through a merge-commit pull request
from `main` bound to an exact release candidate. Merging that pull request is the
approval to publish; this keeps released history distinct without allowing
release-only fixes, direct pushes, or tag-only promotion to bypass the reviewed
development history.
