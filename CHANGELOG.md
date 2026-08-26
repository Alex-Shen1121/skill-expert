# Changelog

All notable changes to Skill Expert are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upstream Skills Manager history is preserved in [the upstream history archive](docs/upstream-history/CHANGELOG.md).

## [Unreleased]

### Release Overview
- Replace the legacy S icon with the character-led Skill Expert production icon system.

### User-facing
- Show the character artwork on application icons at 64px and larger, while using the simplified Skill Core Symbol on small system surfaces for legibility.

### Developer & Governance
- Add deterministic builders, cross-platform hybrid ICO/ICNS assets, and pixel-level tests for application, tray, favicon, sidebar, and Windows tile icons.

## [1.0.2] - 2026-08-25

### Release Overview
- Restore Windows native verification in the formal Skill Expert release pipeline.

### User-facing
- No application behavior changes; release packaging and verification are more reliable on Windows.

### Developer & Governance
- Normalize Windows CRLF output and enforce a portable filename allowlist before downloading Draft Release assets, so native Windows verification reads exact names without path traversal risk.

## [1.0.1] - 2026-08-25

### Release Overview
- Add a reviewable release-preparation flow for the independent Skill Expert release line.

### User-facing
- Maintainers can choose a patch, minor, or major release and review one preparation pull request before it reaches `main`.

### Developer & Governance
- Keep every version copy and both changelogs synchronized behind public validation commands and CI.
- Allow verification jobs to read the still-private Draft Release before publication while keeping Release mutations out of those jobs.
- Accept subsequent `main → release` promotions when `release` retains the previous audited merge commit, while rejecting release-only commits and altered promotion trees.

## [1.0.0] - 2026-08-24

### Release Overview
- Establishes Skill Expert as an independent desktop product with its own 1.0.0 version line and install identity.

### User-facing
- The app, windows, tray menus, settings, diagnostics, and all three interface languages consistently present Skill Expert.
- Skill Expert uses isolated default storage locations so it can be installed alongside upstream Skills Manager.
- The supported agent-facing command is now `skill-expert-cli`; its npm/Cargo identity, help, install path, release asset, and hosted skill data path all use the Skill Expert identity.

### Developer & Governance
- The desktop bundle identifier is `com.codingshen.skill-expert`.
- Update metadata reads only from the independent `Alex-Shen1121/skill-expert` release contract.
