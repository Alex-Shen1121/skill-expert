---
name: manage-skills
description: Use when a user asks to install, update, remove, inspect, organize, deploy, or undeploy agent skills through the shared Skill Expert library.
---

# 管理共享 Skill 技能库

## 1. 解析 CLI

先按当前 Shell 选择一段命令，只执行一次。

POSIX Shell：

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

PowerShell：

```powershell
$dir = Join-Path $HOME ".skill-expert\bin"
$bin = Join-Path $dir "skill-expert-cli.exe"
$stamp = Join-Path $dir ".version"
if ((Test-Path -LiteralPath $stamp -PathType Leaf) -and
    (Get-Item -LiteralPath $stamp).Length -gt 0 -and
    (Test-Path -LiteralPath $bin -PathType Leaf)) {
  $bin
} elseif ((Test-Path -LiteralPath $stamp) -or (Test-Path -LiteralPath $bin)) {
  "BRIDGE_BROKEN"
} else {
  $command = Get-Command skill-expert-cli -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { $command.Source }
}
```

后续文档以 `{CLI}` 表示打印出的完整路径；每次执行前替换这个占位符。

- 固定目录中的路径：桌面应用已发布并验证同版本 CLI，直接使用。
- `BRIDGE_BROKEN`：停止操作，请用户打开一次 Agent 技能管家重新发布；不要回退到其他 CLI。
- `PATH` 中的路径：可用于 CLI-only 环境，并提醒它可能与另一处桌面安装版本不同。
- 无输出：本 Skill 不适用，改用 `find-skills`，或请用户先安装 Agent 技能管家。

Agent 解析结果时始终传 `--json`：

```text
{CLI} --json skills list
```

## 2. 读取状态模型

中央技能库默认位于 `~/.skill-expert/skills/`。始终区分三种状态：

- 技能库：安装或删除决定 Agent 技能管家是否管理该 Skill。
- Preset 成员关系：只组织技能库，不等于部署。
- 部署：决定某个 Agent 实际能否读取该 Skill。

内部备份协议继续使用 scenario 字段以保持兼容；CLI 和界面统一称为 Preset。

## 3. 按请求加载操作参考

- 安装、搜索、检查更新、执行更新或用 `skills set-source` 修正来源：读取 [`references/install-update.md`](references/install-update.md)。
- 部署、撤销部署、Preset、标签、Agent 启用状态或同步排查：读取 [`references/deploy-organize.md`](references/deploy-organize.md)。
- 收编现有目录、删除 Skill，或处理 `TARGET_CONFLICT`：读取 [`references/adopt-remove.md`](references/adopt-remove.md)。

只读取当前请求需要的参考页。具体参数先运行对应子命令的 `--help`，参考页负责安全顺序和不会出现在帮助文本里的数据边界。

## 4. 处理目标冲突

`TARGET_CONFLICT` 的 `details.conflicts[]` 会给出 `path` 与 `reason`。收到后：

1. 列出每个冲突路径，并说明内容未被修改。
2. 保留原目录，等待用户选择。仅需继续部署时，请用户先把冲突目录移到其他位置，再重试。
3. 用户还要保留并管理原目录内容时，按 [`references/adopt-remove.md`](references/adopt-remove.md) 的“先收编、再移开、后部署”流程执行。`adopt` 本身不会认领或删除原路径，也不会解除冲突。

## 5. 人工确认关卡

以下操作先展示预览和影响，再等待用户明确确认：

- `skills remove --yes`、Preset 删除、标签删除；
- `skills set-source --force`；
- `agents disable`；
- 移动、重命名或删除冲突目录；
- 任意批量写入或撤销部署。

未收到确认时停在关卡前，不替用户选择。

## 6. 完成标准

每次写操作后重新读取相关状态，并报告：

- 实际变更的 Skill、Preset 或 Agent；
- 中央技能库记录与目标部署是否一致；
- 所有跳过、保留、失败和冲突路径；
- 仍需用户确认的破坏性步骤。

只有目标状态读回一致、失败项已说明且没有未跨越的确认关卡时，任务才算完成。
