---
name: manage-skills
description: Use when a user asks to install, update, remove, inspect, organize, deploy, or undeploy agent skills through the shared Skill Expert library.
---

# 管理共享 Skill 技能库

## 先解析 CLI

每次任务先运行一次以下命令：

```bash
D="$HOME/.skill-expert/bin"
B="$D/skill-expert-cli"; [ -e "$B" ] || B="$B.exe"
if [ -s "$D/.version" ] && [ -x "$B" ]; then
  echo "$B"
elif [ -s "$D/.version" ] || [ -e "$B" ]; then
  echo BRIDGE_BROKEN
else
  P="$(command -v skill-expert-cli 2>/dev/null || true)"
  [ -x "$P" ] && echo "$P"
fi
```

后续示例用 `$SM` 代表这条命令打印出的完整路径。每次调用时直接替换 `$SM`，不要依赖上一个 Shell 中的变量赋值。

- 输出 `~/.skill-expert/bin` 下的路径：桌面应用已发布并验证同版本 CLI，直接使用。
- 输出 `BRIDGE_BROKEN`：桥接发布不完整。停止操作，请用户打开一次 Agent 技能管家，让应用重新发布 CLI；此时不要回退到其他 CLI。
- 输出 `PATH` 中的路径：当前机器没有桌面桥接，可使用该独立 CLI，并提醒它可能与另一处桌面安装版本不同。
- 没有输出：本 Skill 不适用，改用 `find-skills`，或请用户先安装 Agent 技能管家。

Agent 需要解析结果时始终传 `--json`。成功结果写入标准输出；失败结果写入标准错误并以非零状态退出，包含 `ok=false`、稳定的 `code` 和 `message`。

```bash
"$SM" --json skills list
```

### 目标冲突

部署可能返回以下结构：

```json
{
  "ok": false,
  "code": "TARGET_CONFLICT",
  "kind": "target_conflict",
  "message": "目标路径不是受管部署",
  "details": {
    "conflicts": [
      { "path": "/Users/me/.codex/skills/demo", "reason": "不是受管部署" }
    ]
  }
}
```

收到 `TARGET_CONFLICT` 后，向用户列出每个 `details.conflicts[].path`，明确路径内容未被修改，并提供两种处理方式：用 `skills adopt` 收编，或由用户把目录移到其他位置后重试。保留现有目录，等待用户选择。

## 状态模型

中央技能库默认位于 `~/.skill-expert/skills/`。始终区分三种状态：

- 技能库：`skills install/remove` 决定 Agent 技能管家是否管理该 Skill。
- Preset 成员关系：`presets add-skill/remove-skill` 只组织技能库。
- 部署：`skills deploy/undeploy` 与 `presets deploy/undeploy` 决定 Agent 实际可见的 Skill。

内部备份协议仍使用 scenario 字段以保持兼容；CLI 和界面统一称为 Preset。

## 安装与搜索

```bash
# skills.sh 市场
"$SM" skills install vercel-labs/agent-skills@react-best-practices

# Git 仓库或仓库子目录
"$SM" skills install https://github.com/anthropics/skills.git
"$SM" skills install https://github.com/foo/bar/tree/main/skills/baz

# 本地目录
"$SM" skills install ./my-skill

# 来源有歧义时显式指定
"$SM" skills install foo/bar --skillssh
"$SM" skills install ./looks-like/owner-repo --local
```

安装默认只写入技能库。用户还要求 Agent 可见时，再显式部署：

```bash
"$SM" skills deploy <skill> --agent claude_code --agent codex
```

搜索时先展示最相关的 1～3 个结果及安装量，再等待用户确认安装：

```bash
"$SM" --json skills search "react performance" --limit 5
```

使用结果中的 `install_ref` 安装。安装量可作为成熟度线索，但不能替代源码审查。

## 检查与更新

```bash
# 只检查远端修订，不写入 Skill 文件
"$SM" --json skills check --all

# 更新一个 Skill
"$SM" --json skills update <skill-name-or-id>

# 更新全部可更新 Skill
"$SM" --json skills update --all
```

先 `check`，再根据结果执行 `update`。报告 `refreshed=true` 的实际更新项、已是最新的项目、失败项，以及 `held_back_removals` 中因本地修改而保留的文件。

## 修改 Git 来源

`set-source` 在原记录上修改来源，保留 Skill ID、标签、Preset 成员关系和 Agent 部署：

```bash
# 预览：解析来源并比较内容，不写技能库和数据库
"$SM" --json skills set-source <skill> \
  --git-url you/skills --subpath my-skill --dry-run

# GitHub tree URL 已携带分支与子路径
"$SM" skills set-source <skill> \
  --git-url https://github.com/you/skills/tree/main/my-skill
```

- `set-source` 使用 `--subpath`；`adopt` 才使用 `--git-subpath`。
- Skill 位于仓库根目录时显式传 `--subpath ""`，根目录必须包含 `SKILL.md`。
- `--branch` 可覆盖 URL 中携带的分支。
- `content_changed=false` 时只更新来源记录并重新对齐复制模式部署，中央副本内容保持不变。
- `content_changed=true` 时停止。说明 `--force` 会整体替换中央 Skill 目录，且没有逐文件删除保护；只有用户在看到该结果后明确批准，才能执行带 `--force` 的命令。

## 部署与撤销部署

```bash
"$SM" skills deploy <skill> --agent claude_code
"$SM" skills undeploy <skill> --agent codex
"$SM" skills deploy <skill-a> <skill-b> --agent codex --dry-run
"$SM" skills deploy <skill> --agent claude_code --agent codex
"$SM" --json skills status <skill>
```

批量部署和撤销部署先使用 `--dry-run`。`skills enable/disable` 是兼容命令，不表示部署状态。

旧式独占 Preset 同步仅用于用户明确要求切换默认 Preset 的场景：

```bash
"$SM" skills sync --dry-run
"$SM" skills sync
"$SM" skills sync --preset "Web Dev"
"$SM" skills sync --tool claude_code
```

## 收编 Agent 目录中的 Skill

```bash
# 先扫描，不写入
"$SM" --json skills adopt ~/.claude/skills --dry-run

# 用户确认后收编全部候选项
"$SM" --json skills adopt ~/.claude/skills

# 收编单个 Skill 并记录 Git 来源
"$SM" skills adopt ~/.claude/skills/react-best-practices \
  --git-url https://github.com/vercel-labs/agent-skills/tree/main/react-best-practices

# URL 只有仓库根时显式指定子路径
"$SM" skills adopt ~/.claude/skills/react-best-practices \
  --git-url https://github.com/vercel-labs/agent-skills \
  --git-subpath react-best-practices
```

`adopt` 自动跳过已经在数据库中或已经是部署目标的 Skill，可重复扫描。`--git-url` 只适用于收编当下；已在技能库中的 Skill 改用 `set-source`。

## 删除

```bash
"$SM" skills remove <skill> --dry-run
"$SM" skills remove <skill> --yes
```

删除会移除中央副本、全部受管部署和数据库记录。批量删除必须先展示 `--dry-run` 结果，并在用户明确确认后才传 `--yes`。

## 标签

```bash
"$SM" skills tag add <skill> web frontend
"$SM" skills tag remove <skill> frontend
"$SM" skills tag set <skill> web frontend
"$SM" skills tag rename frontend web
"$SM" skills tag delete obsolete --dry-run
"$SM" skills tag delete obsolete --yes
"$SM" skills tag list <skill>
"$SM" skills tag list
```

常用筛选：

```bash
"$SM" --json skills list --untagged
"$SM" --json skills list --no-preset
"$SM" --json skills list --tag frontend
"$SM" --json skills list --preset "Web Dev"
"$SM" --json skills list --deployed-to codex
```

## Preset

```bash
"$SM" presets list
"$SM" presets current
"$SM" presets show "Web Dev"
"$SM" presets create "Web Dev" --description "前端工作"
"$SM" presets update "Web Dev" --name "Frontend"
"$SM" presets delete "Old" --dry-run
"$SM" presets delete "Old" --yes

"$SM" presets add-skill <preset> <skill>...
"$SM" presets remove-skill <preset> <skill>...

"$SM" presets deploy <preset>
"$SM" presets deploy <preset> --agent codex
"$SM" presets undeploy <preset> --agent claude_code
"$SM" presets undeploy <preset>
"$SM" --json presets status <preset>
```

`add-skill/remove-skill` 只改成员关系；`deploy/undeploy` 才修改磁盘部署。Preset 删除和批量撤销部署先用 `--dry-run`，再等待用户明确确认。

## Agent 与健康检查

```bash
"$SM" --json repo status
"$SM" --json agents list
"$SM" agents enable codex
"$SM" agents disable claude_code
```

排查“Skill 为什么没有出现在 Agent 中”时，先读取 `repo status`、`agents list` 和 `skills status <skill>`。`agents disable` 会移除该 Agent 的全部受管部署，执行前说明影响并等待用户确认；`agents enable` 会恢复全局可用状态，并可能重新同步旧式 active Preset。

## 完成标准

每次写操作后重新读取相关状态，并向用户报告：

- 实际变更的 Skill、Preset 或 Agent；
- 中央技能库记录与目标部署是否一致；
- 所有跳过、保留、失败和 `TARGET_CONFLICT` 路径；
- 仍需用户确认的破坏性步骤。

只有目标状态读回一致、失败项已说明且没有未跨越的确认关卡时，任务才算完成。
