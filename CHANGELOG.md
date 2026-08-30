# Changelog

All notable changes to Agent 技能管家 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Upstream Skills Manager history is preserved in [the upstream history archive](docs/upstream-history/CHANGELOG.md).

## [Unreleased]

### Release Overview
- 修复 Windows 正式构建可能被并发契约测试时序误报阻断的问题。

### User-facing
- 本次不改变应用运行时行为；提高跨平台发布验证的稳定性。

### Developer & Governance
- 将并发测试探针从固定 20ms 睡眠改为带超时的确定性首波同步，慢设置写入仍会被准确计入并发峰值，worker 不足时则快速失败。

## [1.0.11] - 2026-08-30

### Release Overview
- 让已安装的 Agent 通过受版本保护的内置 CLI 管理共享技能库。
- 为技能库“检查全部”增加逐项进度与结构化结果窗口。
- 为“全部更新”增加勾选确认、逐项安全进度与完成摘要。
- 为两种前台批量操作增加可持久化的并发设置。
- 为前台批量任务增加安全停止与失败项重试。

### User-facing
- 首页新增一次性设置入口，可明确选择让哪些 Agent 安装和部署 Skill；选择默认留空，关闭或安装完成后不再提示。
- 桌面应用启动后把同版本 `skill-expert-cli` 安全发布到 `~/.skill-expert/bin`，并用版本印记拒绝半完成或过期桥接。
- CLI 的部署拒绝现在以 `TARGET_CONFLICT` 返回具体路径，现有目录保持不变，Agent 可准确说明需要收编或移开的内容。
- “检查全部”现在展示全库可检查 Skill、稳定进度、跳过数量、失败详情和可用更新结果，并隔离不同批次与单项失败。
- “全部更新”现在只使用缓存的可用更新，默认全选并允许取消选择；更新过程中区分已更新、内容未变化、失败与需要单独确认，可能删除文件的项目仍进入既有精确授权流程。
- 设置页可分别把前台“检查全部”和“全部更新”的并发数设为 1、4 或 8；默认值为 8 和 4，重启后仍会保留。
- 检查或更新运行时会阻止意外关闭；用户可停止后续调度，等待在途任务安全收尾，并只重试失败项。

### Developer & Governance
- 精选引入上游 `50da461` 的 Agent 控制能力与结构化冲突修复，同时保留 `skill-expert-cli`、`~/.skill-expert`、独立仓库、版本和发布边界。
- `manage-skills` 统一解析桌面桥接 CLI，补充 `set-source` 原地修正来源、目标冲突处置和破坏性操作确认关卡。
- 检查批次沿用远端去重和默认并发 8，新增批次标识、逐项事件与 Rust 结构化结果契约。
- 前台更新默认并发 4，联网与准备任务可并发，中央技能库关键写入继续由仓库锁保护；后台自动更新与既有多选刷新语义保持不变。
- 两种前台批次在启动时快照合法并发值，缺失或非法设置安全回退到各自默认值；运行中修改只影响下一批，后台、多选和单项路径不读取这些设置。
- 停止令牌只截断未调度任务，结构化结果明确区分未开始项；重试创建独立批次标识，避免旧批次、后台或托盘事件串扰。

## [1.0.10] - 2026-08-29

### Release Overview
- 统一角色 App 图标，并把技能核心符号限制在系统状态区。
- 将未来正式 Release 精简为 12 个应用分发与可信验证资产。

### User-facing
- Finder、Dock、应用列表、窗口品牌标识、安装包及全平台应用资产在所有尺寸下使用同一角色图标；macOS 菜单栏和 Windows/Linux 系统托盘继续使用技能核心符号。
- GitHub Release 不再提供独立 CLI 和单独 `.sig` 下载，同时保留四平台应用内更新、SHA-256 完整性清单和正式构建来源证明。

### Developer & Governance
- 图标契约从角色源图重新生成桌面与移动端资产，并逐帧验证 ICO、ICNS 和应用内品牌 Logo，防止小尺寸图标再次混入技能核心符号。
- 正式工作流继续在 runner 内构建并验证 CLI，但不再上传；四个平台实际更新入口的签名作为 Draft 临时资产生成元数据后删除，再对最终 12 个公开资产执行来源证明和下载回验。

## [1.0.9] - 2026-08-29

### Release Overview
- 修复 macOS 上 CLI 拒绝待处理导入时的低概率进程锁释放竞态。

### User-facing
- CLI 遇到必须由 GUI 完成的待处理导入时，会在返回提示前显式释放临时共享锁，不再短暂阻塞应用恢复。

### Developer & Governance
- 待处理导入锁测试连续执行 100 次即时独占重获断言；本地使用 Rust 1.98.0 完成 511 项全量测试与 10 万次锁循环压力验证。

## [1.0.8] - 2026-08-29

### Release Overview
- 修复中文桌面显示名称导致 Linux DEB 技术包名无效的问题。

### User-facing
- Linux DEB、RPM 与 AppImage 使用兼容的 `skill-expert` 技术包名，同时继续在应用窗口和桌面入口显示“Agent 技能管家”。

### Developer & Governance
- 新增 Linux 平台专用 Tauri 配置与共享 desktop 模板，并在正式回验中锁定 DEB/RPM 包名、三种包的中文桌面显示名和技术执行入口。

## [1.0.7] - 2026-08-29

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
