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

- 普通 PR 合入 `main` 前必须运行 `npm run version:prepare-development`，并提交全部版本契约文件。开发序号严格逐次递增，例如 `1.0.3 → 1.0.3-1 → 1.0.3-2`；重复、跳号或漏改都会阻止合并。
- `main` Ruleset 必须保持“分支必须为最新”卡控（`strict_required_status_checks_policy=true`）。并发 PR 不能复用同一个开发序号；主线前进后，待合入 PR 必须更新分支、重新生成下一开发序号并重跑检查。
- 开发序号只表示同一正式版本后的集成批次，保留在 `main` 并运行完整测试，不触发四平台安装包构建，也不进入 Updater。
- 正式发布准备统一通过 `Prepare Release` 工作流发起。发布准备 PR 必须来自当前仓库，使用 `release-prep/v1.0.4` 形式的分支，把 `1.0.3-N → 1.0.4`，是普通 `main` PR 开发序号规则的唯一例外。
- 发布准备 PR 合入后，`main` 的正式版本会触发且只触发一次四平台候选构建；候选晋级完成前停止合入新的功能 PR，避免候选 SHA 失效。
- `main → release` 的晋级 PR 必须保持精确候选 SHA，并且版本只能是当前 `release` 的下一补丁版本；合并该 PR 即批准正式发布。
