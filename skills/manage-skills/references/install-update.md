# 安装、搜索与更新

## 安装

根据用户给出的来源选择安装方式；来源有歧义时显式传 `--git`、`--local` 或 `--skillssh`，不要猜测。

```text
{CLI} --json skills install vercel-labs/agent-skills@react-best-practices
{CLI} --json skills install https://github.com/foo/bar/tree/main/skills/baz
{CLI} --json skills install ./my-skill --local
```

安装默认只写入中央技能库。用户还要求某个 Agent 可见时，再转到 [`deploy-organize.md`](deploy-organize.md) 显式部署。安装后运行 `skills show <name-or-id>` 或 `skills list`，读回 Skill ID、实际名称、来源和部署状态。

## 搜索

```text
{CLI} --json skills search "react performance" --limit 5
```

展示最相关的 1～3 个结果、`install_ref` 与安装量。安装量只是成熟度线索；陌生来源先审查 Skill 内容、脚本、依赖、凭据与副作用，再等待用户确认安装。

## 检查与更新

先检查，再更新：

```text
{CLI} --json skills check --all
{CLI} --json skills update <skill-name-or-id>
{CLI} --json skills update --all
```

`check` 只探测来源修订。更新会整体替换 Skill 目录，并重新对齐受管部署；报告实际更新、内容未变化、失败和跳过项。

### 本地修改边界

`held_back_removals` 只保护“新版本中已经消失”的路径：字段存在时，本次更新没有写入，列出的中央库或 Agent 路径保持旧版本。这不是可重试失败，CLI 也没有绕过开关；展示路径并让用户到桌面应用确认。

字段缺失不代表本地修改安全。远端新版本仍包含同名文件时，该文件路径虽然“存活”，内容却会覆盖本地编辑。发现用户在中央 Skill 或复制模式部署中维护本地修改时，更新前必须明确提醒并先备份或迁出这些修改。

## 原地修正 Git 来源

`set-source` 保留 Skill ID、标签、Preset 成员关系和部署：

```text
{CLI} --json skills set-source <skill> --git-url you/skills --subpath my-skill --dry-run
{CLI} --json skills set-source <skill> --git-url https://github.com/you/skills/tree/main/my-skill
```

- 这里使用 `--subpath`；`adopt` 使用 `--git-subpath`。
- Skill 位于仓库根目录时显式传 `--subpath ""`，根目录必须包含 `SKILL.md`。
- `--branch` 可覆盖 URL 中携带的分支。
- `content_changed=false` 时中央副本保持不变，来源记录原地更新。
- `content_changed=true` 时停止并触发主文件的 `--force` 人工确认关卡。`--force` 会整体替换中央 Skill 目录，没有逐文件删除保护。

完成后重新读取该 Skill，确认来源、ID、标签、Preset 和部署关系符合预期。
