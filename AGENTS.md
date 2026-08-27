## Agent skills

### Issue tracker

本项目的任务和规格说明记录在 GitHub Issues 中。参见 `docs/agents/issue-tracker.md`。

### Triage labels

Issue 使用五种中文状态标签，并映射到 Agent Skills 的标准角色。参见 `docs/agents/triage-labels.md`。

### Domain docs

本项目使用 single-context 领域文档结构。参见 `docs/agents/domain.md`。

### Matt Skills 开发流程

用户明确要求使用 Matt Skills 开发时，Agent 必须按以下主流程执行：

1. **澄清需求**：在仓库中先运行 `/grill-with-docs`，通过访谈明确需求，并把稳定术语和决策写入 `CONTEXT.md` 或 ADR。
2. **验证未知项（按需）**：如果状态、业务逻辑或界面效果必须通过运行代码才能判断，使用 `/handoff` → `/prototype` → `/handoff` 完成一次原型往返，再回到原需求。
3. **确定交付规模**：单会话工作直接进入 `/implement`；多会话工作依次运行 `/to-spec` → `/to-tickets`，再为每个无阻塞 ticket 开启独立上下文运行 `/implement`。
4. **实现与验收**：`/implement` 必须逐个行为运行 `/tdd` 的红—绿循环，并在提交前运行 `/code-review`，同时通过 Standards 和 Spec 两个维度的检查。

特殊入口按以下路径汇入主流程：

- 外部提交的原始 Issue：`/triage` → `/implement`。`/to-tickets` 生成的 ticket 已经可由 Agent 处理，直接进入 `/implement`。
- 难以复现或反复出现的缺陷：`/diagnosing-bugs`，先建立能稳定复现问题的红色反馈循环，再修复并补回归测试。
- 跨多个会话且路径尚不清晰的大型工作：`/wayfinder` → `/to-spec` → `/to-tickets` → `/implement`。

从 `/grill-with-docs` 到 `/to-tickets` 保持同一上下文；完成拆票后，每个 `/implement` 使用独立上下文。只在阶段边界选择继续、`/clear`、`/handoff`、Subagent 或 `/compact`。

#### 人工确认关卡

凡 Skill 或流程要求用户选择、确认草稿、批准方案或执行人工步骤，Agent 必须在该关卡停止，并等待用户明确回复后再继续。

禁止跳过、合并或替用户回答人工确认关卡；不得把沉默、此前的概括性授权或 Agent 的推断视为确认。未收到明确确认时，该关卡未完成。

### 工作树基线边界

- detached HEAD 只可用于只读分析、Spec、拆票和审查，不得在其中进入 `/implement` 或修改代码。
- 进入 `/implement` 前，必须从当时最新的 `origin/main` 创建干净的 `codex/*` 分支或 linked worktree，并运行 `npm run worktree:baseline -- preflight --json`。
- preflight 非零退出、输出 `implementation-preflight-blocked`，或无法确认最新远端基线时，必须立即停止实现；不得在旧本地 `main`、detached HEAD、其他命名分支或脏工作树上绕过检查。
- 实现开始后 `origin/main` 前进只产生提示；提交或合并前仍需按项目流程重新评估主线变化。
- 审查视图中的分支 diff 不等于未提交修改。旧 worktree 可能已通过 squash 纳入主线，不得默认再次创建 PR。
- `recovery` 和 `sync` 是显式维护操作。Agent 必须先展示计划并取得用户明确确认，之后仍须提供 `--apply`、计划确认值和主工作目录路径；不得代替用户跨越该关卡。

### 版本通道边界

- 所有源码版本只允许稳定的 `x.y.z`，不得使用 `x.y.z-N` 或其他预发布后缀。普通功能、修复、文档和治理 PR 不修改版本号；用户可见变更继续写入双语 `Unreleased`。
- 所有开发都必须从最新 `origin/main` 建立 `codex/*` 分支，通过 PR 合入 `main`。自动化 `upstream-tracking/main` 只用于生成可审阅的上游跟踪 PR，不是开发分支，是命名空间的唯一例外。`main` Ruleset 必须保持“分支必须为最新”（`strict_required_status_checks_policy=true`），并且只要求 `GitHub Actions syntax`、`Frontend and version contract`、`Rust quality and Linux check` 三项轻量检查。
- 普通 PR 与 `main` push 不运行 macOS/Windows Rust 测试，不构建 Tauri 安装包，不创建 tag 或 GitHub Release。
- 只有用户在当前请求中明确说“发布新版本”或“发布 `vX.Y.Z`”才构成正式发布授权；“修复”“提交”“打测试包”等请求不得推断为发布授权。
- 正式发布使用 `codex/release-vX.Y.Z` 分支和 PR。只说“发布新版本”时运行 `npm run release:prepare -- patch`；明确指定版本时运行 `npm run release:prepare -- X.Y.Z`。该命令同步全部版本文件并把双语 `Unreleased` 归档到新版本。
- 用户的正式发布授权同时允许 Agent 创建发布 PR、等待轻量检查、合并 PR，并在合并提交的三项 `main` push 检查全部成功后，对该精确 SHA 手动触发 `.github/workflows/release.yml`；后续普通 PR 合入不改变已批准的发布 SHA，除非发生异常，不重复要求发布批准。
- 正式发布工作流只从精确 `main` SHA 构建一次 macOS arm64、macOS x64、Windows x64 和 Linux x64 生产包，并完成生产 Updater 签名、不可变 annotated tag、Draft、来源证明、真实下载回验和原子公开 Latest。
- 创建 tag 前失败可在修复后使用同一版本重试；一旦 tag 或 Draft 已创建，该版本不得复用，修复必须准备下一个稳定版本。
- 长期 `release` 分支是暂时保留的历史分支，任何代码、工作流、版本判断和发布操作都不得依赖它。名为 `release` 的 GitHub Environment 不是分支，继续保存生产 Updater Secret。
- 手工测试包只通过 `.github/workflows/manual-test-package.yml` 显式触发，并必须保持 `promotable: false`；无论选择多少平台都不能转为正式 Release。
