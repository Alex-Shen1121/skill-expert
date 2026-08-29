# Changelog

All notable changes to Agent 技能管家 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upstream Skills Manager history is preserved in [the upstream history archive](docs/upstream-history/CHANGELOG.md).

## [Unreleased]

### Release Overview
- 修复桌面显示名称改为“Agent 技能管家”后 Windows MSI 打包失败的问题。

### User-facing
- Windows x64 正式版本恢复同时提供 NSIS 与 MSI 安装包；MSI 升级继续识别既有 Skill Expert 安装。

### Developer & Governance
- 显式使用 `zh-CN` WiX 本地化并固定旧版 `upgradeCode`，避免中文产品名落入默认 `en-US` MSI 代码页和重命名导致安装身份漂移；同时补齐手工测试包稳定文件名重新签名所需的临时私钥路径。

## [1.0.6] - 2026-08-29

### Release Overview
- 将桌面应用显示名称统一改为“Agent 技能管家”。
- 为技能库增加可记忆的自定义、名称、最近添加和最近更新排序。
- Selectively incorporate the Kimi path correction and multi-agent data protection from upstream `6e32c3a` while retaining the independent product and four-platform release boundary.

### User-facing
- 应用包、窗口、托盘、界面文案、诊断信息和发布标题统一显示“Agent 技能管家”。
- 技能库新增按 Git 来源仓库和“有可用更新”筛选：仓库支持多选并仅收窄 Git 来源，可与搜索、来源、标签和 Preset 条件组合，网格与列表视图保持一致。
- 排序始终保留当前 Preset 已启用项优先，自动排序不会覆盖手动顺序，筛选后的部分集合也不会误写回 Preset。
- Kimi Code now uses the directories read by the current CLI: `~/.kimi-code/skills` and project-level `.kimi-code/skills`. Eligible normal syncs deploy to the new location while preserving the old directory and refusing unmanaged content at the new target.
- Multi-agent projects update the Skills Center only from the single variant proven to contain the change. When several variants may hold independent content, nothing is written; after a successful push, the remaining safe variants are realigned serially.

### Developer & Governance
- 仓库、CLI、包名、数据目录、Bundle ID、Updater 信任根和 Release 资产前缀继续保留 `skill-expert` 技术身份，避免破坏既有安装与自动更新兼容性。
- Full-scenario sync, single-skill sync, and custom agent path changes preserve deployments still claimed by another tool. Upstream tracking now handles protected modify/delete conflicts and records the reviewed but excluded ZCode, OS-language detection, and Linux ARM64 release changes.

## [1.0.5] - 2026-08-28

### Release Overview
- Complete the `main`-based production release path after correcting the GitHub `release` Environment branch policy.

### User-facing
- No additional application behavior changes; this patch publishes the maintenance changes originally prepared for v1.0.4.

### Developer & Governance
- Allow the exact `main` release commit to access production Updater signing secrets while retaining the historical `release` branch rule for audit compatibility.

## [1.0.4] - 2026-08-28

### Release Overview
- Simplify maintenance around a single `main` release source and explicit release authorization.

### User-facing
- No application behavior changes; ordinary development now keeps the latest stable version until a release is explicitly requested.

### Developer & Governance
- Keep all development behind `codex/*` pull requests while reducing required checks to workflow syntax, frontend contracts, and Linux Rust quality.
- Remove development-suffix versions and the `main → release` promotion chain; formal releases now build, sign, verify, and publish once from an exact `main` SHA.
- Preserve on-demand test packages as isolated `promotable: false` artifacts.

## [1.0.3] - 2026-08-26

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
