---
status: superseded
superseded_by: 0004-reuse-candidate-assets.md
---

# 从 main 晋级到 release

所有变更先进入 `main`；长期 `release` 分支只通过绑定精确候选的 `main → release`
merge-commit PR 前进。合并 PR 就是正式发布批准，从而保留独立发布历史，并阻止
release-only 修复、直接推送或仅靠 tag 绕过已审阅的开发历史。

本决策的分支和批准模型继续有效，但 Release PR 重复完整 CI、正式阶段重新构建四平台包的
执行方式已由 [ADR 0004](./0004-reuse-candidate-assets.md) 取代。
