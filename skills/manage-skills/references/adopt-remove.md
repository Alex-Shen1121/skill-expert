# 收编、冲突处置与删除

## 收编现有目录

`adopt` 把现有 Skill 复制进中央技能库，但不会删除、认领或同步原目录。

```text
{CLI} --json skills adopt <agent-skills-dir> --dry-run
{CLI} --json skills adopt <agent-skills-dir>
```

先展示 `candidates` 与 `skipped`，再等待用户确认写入。收编后读取返回的 Skill ID 和实际名称：中央库存在同名内容时，安装器可能使用带序号的新名称，不能假定原名称不变。

收编时记录 Git 来源只适用于单个候选项；参数以 `skills adopt --help` 为准。已经在中央库中的 Skill 改用 [`install-update.md`](install-update.md) 的 `set-source`。

## 处理 TARGET_CONFLICT

冲突目录内容保持不变。按用户目标选择完整流程：

### 只需要部署原请求的 Skill

1. 列出冲突路径与原因。
2. 触发主文件的冲突目录移动确认关卡。
3. 用户处理完成后重试部署，并读回 `skills status`。

### 还要保留并管理冲突目录中的 Skill

1. 对冲突目录运行 `adopt --dry-run`，展示候选与跳过项。
2. 用户确认后执行 `adopt`，读回新 Skill 的 ID、实际名称和 `synced=false` 状态。
3. 说明收编只完成中央副本，原路径仍未受管；触发主文件的冲突目录移动确认关卡。
4. 根据用户意图部署“已收编 Skill”或“原请求 Skill”，使用精确 Skill ID，最后读回状态。

`adopt` 单独执行不会解除冲突；省略第 3 步会让重试再次返回 `TARGET_CONFLICT`。

## 删除 Skill

删除会移除中央副本、全部受管部署和数据库记录。先预览，再触发主文件的删除确认关卡：

```text
{CLI} --json skills remove <skill> --dry-run
{CLI} --json skills remove <skill> --yes
```

完成后重新读取技能库与相关 Agent 状态，确认只删除了用户批准的精确 Skill。
