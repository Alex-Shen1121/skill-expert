# 部署、组织与 Agent 状态

文中的 `{CLI}` 必须替换为主文件已解析出的完整 CLI 路径。先用对应子命令的 `--help` 核对当前参数。

## Skill 部署

部署与撤销部署都显式指定 Agent。多个 Skill 或 Agent 先运行 `--dry-run`，展示目标后触发主文件的批量写入确认关卡。

```text
{CLI} --json skills deploy <skill> --agent codex
{CLI} --json skills undeploy <skill> --agent claude_code
{CLI} --json skills deploy <skill-a> <skill-b> --agent codex --dry-run
{CLI} --json skills status <skill>
```

`skills enable/disable` 是兼容命令，不表示部署状态。操作后读取 `skills status`，确认每个目标记录和磁盘部署一致。

## Preset

Preset 成员关系只负责组织；`presets deploy/undeploy` 才修改实际部署。先用 `presets --help` 与子命令帮助获取当前参数。

```text
{CLI} --json presets list
{CLI} --json presets status <preset>
{CLI} presets add-skill <preset> <skill>...
{CLI} presets remove-skill <preset> <skill>...
{CLI} presets deploy <preset> --agent codex
{CLI} presets undeploy <preset> --agent claude_code
```

Preset 删除和批量撤销部署先预览，再触发主文件对应确认关卡。旧式 `skills sync` 只用于用户明确要求切换或修复默认 active Preset 的场景；先运行 `skills sync --dry-run`。

## 标签

标签只组织 Skill，不改变来源、Preset 或部署。用 `skills tag --help` 选择 `add`、`remove`、`set`、`rename`、`delete` 或 `list`；标签删除先预览并触发主文件确认关卡。

## Agent 状态与排查

```text
{CLI} --json repo status
{CLI} --json agents list
{CLI} --json skills status <skill>
```

排查“Agent 看不到 Skill”时依次核对中央库、Agent 是否已安装并启用、目标目录及该 Skill 的部署记录。

`agents disable` 会移除该 Agent 的全部受管部署，执行前触发主文件确认关卡。`agents enable` 会恢复全局可用状态，并可能重新同步旧式 active Preset；完成后重新读取 Agent 和 Skill 状态。
