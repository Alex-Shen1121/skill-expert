# Issue tracker：GitHub

本项目的任务和规格说明记录在 GitHub Issues 中。

目标仓库：`Alex-Shen1121/skills-manager`

所有操作使用 `gh` 命令行工具。

## 常用操作

- 创建 Issue：`gh issue create --title "..." --body "..."`
- 查看 Issue：`gh issue view <编号> --comments`
- 列出 Issue：`gh issue list --state open`
- 评论：`gh issue comment <编号> --body "..."`
- 添加标签：`gh issue edit <编号> --add-label "..."`
- 删除标签：`gh issue edit <编号> --remove-label "..."`
- 关闭 Issue：`gh issue close <编号> --comment "..."`

需要输出结构化数据时，使用：

`gh issue list --state open --json number,title,body,labels,comments`

在本项目目录中运行 `gh` 时，它会根据 Git remote 自动识别仓库。

## Pull Request 是否进入待处理队列

**否。**

Pull Request 不作为功能需求或问题的默认入口。需要记录工作时，创建 GitHub Issue。

## Skill 指令对应关系

当 Skill 要求“发布到 Issue tracker”时，创建 GitHub Issue。

当 Skill 要求“读取相关任务”时，运行：

`gh issue view <编号> --comments`

## Wayfinder 约定

- Map：使用一个带有 `wayfinder:map` 标签的 Issue。
- 子任务：使用 GitHub Sub-issue；如果无法使用，则在 Map 的任务列表中添加链接。
- 子任务标签：使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- 阻塞关系：优先使用 GitHub 原生 Issue dependency。
- 认领任务：`gh issue edit <编号> --add-assignee @me`
- 完成任务：先评论处理结果，再关闭 Issue。
