---
status: accepted
---

# 以单一公开 CLI 管理工作树基线与本地 main 安全同步

Skill Expert 使用 `npm run worktree:baseline -- <命令>` 作为仓库级工作树基线的唯一公开行为接缝。该能力必须在应用编译前可用，因此属于 Node.js 仓库工具，不进入 Tauri 产品 CLI，也不修改 Codex 桌面应用的 worktree 创建逻辑。

CLI 把行为分成四个安全阶段：

1. `diagnose` 读取 Git 事实；默认只允许刷新 `origin/main` 的 remote-tracking ref，`--offline` 完全使用缓存。
2. `preflight` 在实现前校验干净的 `codex/*` worktree，并把首次通过时的 `origin/main` SHA 记录到 worktree-local 配置。
3. `recovery` 先输出绑定仓库、主工作目录、旧 `main`、目标 SHA 和 tracked 状态的计划；只有显式 apply 与人工确认一致时，才创建本地恢复分支及可选快照，但不移动 `main`。
4. `sync` 只接受由工具创建且完整验证的 recovery，再次刷新和复核全部安全条件，通过带旧值的 `git update-ref` 移动 `main`，最后验证 `main === origin/main`、ahead/behind 为 `0/0` 且 upstream 为 `origin/main`。

recovery 完整性元数据存放在 Git common directory，不写入 tracked 文件、全局 Git 配置、tag 或远端。诊断与同步必须复用同一验证契约：完整有效的记录标记为 `verified`；只有恢复分支但没有有效工具元数据的记录标记为 `legacy/unverified`，绝不能自动同步。

任何阶段都不得自动删除、prune 或改写既有 linked worktree，不得 add、stash、clean、move 或 delete untracked 内容，也不得修改 `release`、tag、GitHub Release 或远端 ref。分支历史差异与工作区修改是不同事实；可能已通过 squash 纳入的旧 worktree 只报告，不自动创建重复 PR。
