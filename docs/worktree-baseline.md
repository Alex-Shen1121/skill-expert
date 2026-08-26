# 工作树基线诊断与本地 main 安全同步

本工具帮助维护者区分三类经常混在审查界面里的状态：未提交修改、本地与远端分支历史差异、旧 linked worktree。它只服务 Skill Expert 仓库，远端默认分支必须为 `main`，领域名称为“开发集成分支”。它不是通用 Git worktree 管理器，也不会改动 Codex 桌面应用。

## 稳定入口

```bash
npm run worktree:baseline -- help
```

所有命令都支持简体中文人类输出；自动化应增加 `--json`，读取 `schemaVersion: 1` 的单一 JSON 文档。退出码含义固定：

- `0`：请求完成且安全条件满足；
- `1`：已完成判断，但被安全门阻止；
- `2`：参数错误或无法安全判断。

## 只读诊断

```bash
npm run worktree:baseline -- diagnose
npm run worktree:baseline -- diagnose --json
npm run worktree:baseline -- diagnose --offline --json
```

默认诊断先解析 `origin` 的符号引用，再只 fetch 默认分支到对应 remote-tracking ref；它不会切换分支、移动本地 ref、修改索引或文件，也不会 push。`--offline` 不访问远端，并明确把缓存标记为未确认最新基线。联网 fetch 失败时仍输出缓存快照，但以退出码 `1` 阻止把缓存当成最新事实。

诊断列出主工作目录、当前和全部 linked worktree、detached 状态、精确 SHA 与 merge base、ahead/behind、staged/unstaged/untracked（含 ignored）、远端刷新事实以及 recovery 记录：

- `verified`：工具元数据、计划身份、引用和快照完整，可以继续由 `sync` 复核；
- `legacy/unverified`：只识别到恢复分支，没有可验证的完整工具元数据，只能人工审计，绝不能自动同步。

审查页显示的大量分支 diff 不等于未提交修改。历史分叉且内容可能已通过 squash 纳入时，工具只给诊断提示，不会建议再次创建 PR，也不会自动判断旧提交可以删除。

## 实现前 preflight

开始 `/implement` 前，从当时最新的 `origin/main` 创建干净的 `codex/*` 分支或 linked worktree，然后运行：

```bash
npm run worktree:baseline -- preflight --json
```

首次通过会在 worktree-local Git 配置记录实现基线，不修改全局配置。当前 worktree 为 `main`、detached HEAD、其他命名分支，存在 staged/unstaged/untracked 内容，远端无法刷新，或 `origin/main` 不是当前 HEAD 祖先时都会阻止实现。实现期间 `origin/main` 后续前进只产生提示，不会改写已记录起点。

detached HEAD 可继续用于只读分析、Spec、拆票和审查；切换到实现阶段前必须新建合规 worktree 并通过 preflight。

## 创建本地 main 恢复点

先预览计划，不要直接 apply：

```bash
npm run worktree:baseline -- recovery --json
```

把输出中的 `plan.id`、`plan.primaryWorktree`、旧本地 `main`、目标 `origin/main`、tracked、untracked 与 ignored 清单展示给用户。得到针对该计划的明确确认后，才可原样执行：

```bash
npm run worktree:baseline -- recovery \
  --apply \
  --confirm <plan.id> \
  --primary-worktree <plan.primaryWorktree> \
  --json
```

recovery 创建唯一的 `codex/local-main-recovery-<date>` 本地分支。tracked 变更会保存为最终内容快照，但不保留原先 staged 与 unstaged 的分界；untracked 与 ignored 内容的目录树、路径、类型和内容哈希会绑定进 `plan.id` 与完整性元数据，但不会被 add、stash、clean、移动或删除。本阶段不会移动 `main`，不会设置 upstream，也不会 push 或创建 PR。

## 显式同步本地 main

只有上一阶段产生且仍为 `verified` 的 recovery 才能进入同步。同步命令再次解析并 fetch 远端默认分支，确认计划目标、主工作目录、全部 worktree、进行中的 Git 操作、tracked/untracked/ignored 完整状态和 recovery 引用均未变化：

```bash
npm run worktree:baseline -- sync \
  --apply \
  --confirm <plan.id> \
  --primary-worktree <plan.primaryWorktree> \
  --json
```

成功后必须同时满足：主工作目录位于 `main`；本地 `main`、`origin/main` 和 HEAD SHA 相同；ahead/behind 为 `0/0`；upstream 为 `origin/main`；recovery 仍可解析；既有 linked worktree 以及 untracked/ignored 内容保持不变。

## 安全停止与恢复

- fetch 失败：不要继续 preflight、recovery 或 sync；修复远端连接后重新生成计划。只需分析缓存时使用 `diagnose --offline`。
- recovery 中断：`main` 尚未由该阶段移动。按 JSON 中的 `error.details.stage`、`recoveryRefSha` 和 `guidance` 核验恢复分支；不要手工伪造元数据后重试。
- recovery 后远端目标变化：旧确认范围已失效。保留 recovery，重新诊断并生成新计划。
- `sync` 在移动 `main` 前中断：已验证 recovery 仍是恢复入口，`main` 保持原值。
- `sync` 在移动 `main` 后切换失败：不要删除 recovery；根据 JSON 的 `mainMoved`、`mainRefSha`、`recoveryRefSha` 和中文 `guidance` 人工核验现场。
- untracked 或 ignored 完整状态在 recovery 后变化，或其路径与目标 checkout 冲突：工具安全停止，不会覆盖文件。由维护者另行决定内容去向，再从新的诊断计划开始。

工具不会自动处理或清理旧 worktree、旧分支、stash、`.superpowers/`、嵌套 `.worktrees/`、其他 untracked 内容、`release`、tag、GitHub Release 或任何远端 ref。是否保留、归档或删除这些资源必须另行审计和确认。
