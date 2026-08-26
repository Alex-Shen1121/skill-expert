# Skill Expert Distribution

The product and release language used to keep Skill Expert independent from the
upstream project while retaining reviewed upstream tracking.

## Language

**Upstream project**:
The external `xingkongliang/skills-manager` project, with its own decisions,
versions, releases, and update channel.

**Independent fork**:
The `Alex-Shen1121/skill-expert` project, which owns a release line distinct
from the upstream project even when it incorporates upstream changes.

**Skill Expert**:
The product distributed by the independent fork, with its own app identity, CLI,
packages, repository, versions, releases, and update channel.

**Upstream tracking**:
The reviewed incorporation of selected upstream changes without surrendering
Skill Expert's product decisions or release line.
_Avoid_: Upstream sync

**Existing-installation import**:
A user-approved one-time copy of upstream product data into Skill Expert, not a
shared live data store between the products.
_Avoid_: Migration, shared library

**Development integration branch**:
The `main` branch into which every product change, hotfix, version change, and
reviewed upstream change is first integrated.
_Avoid_: Production branch

**Release branch**:
The long-lived `release` branch containing only candidates promoted from the
development integration branch.
_Avoid_: Deployment branch

**Release candidate**:
An exact commit on the development integration branch whose version, changelog,
tests, and packages have passed the release gates.
_Avoid_: Latest main

**Release promotion**:
The merge-commit pull request that advances a release candidate from `main` to
`release`; merging it is the approval to publish that candidate.
_Avoid_: Release merge, tag push

## Compatibility-only legacy markers

The serialized backup protocol retains `.skills-manager` metadata paths,
`refs/skills-manager/*` hidden refs, and the `created_by: "skills-manager"`
schema marker so existing backups remain readable. These strings are protocol
compatibility identifiers, not user-facing product or repository identities.
Historical changelog entries remain unchanged as records of shipped releases.

## 工作树基线语言

**开发集成分支**：
远端 `origin` 的默认分支 `main`。所有实现 worktree 必须从首次校验时最新的 `origin/main` 建立。
_避免使用_：`master`、生产分支

**工作树基线**：
由公开仓库 CLI 读取的 Git 事实集合，包括主工作目录、Git common directory、全部 linked worktree、开发集成分支关系、当前工作区状态和远端刷新状态。
_避免使用_：审查页差异、未提交修改总数

**实现基线**：
实现 worktree 首次通过 preflight 时记录的 `origin/main` SHA。它保存在 worktree-local Git 配置中；后续远端前进不会改写该起点。
_避免使用_：本地 main 当前值、latest main

**本地 main 恢复点**：
安全同步前创建的本地 `codex/local-main-recovery-<date>` 分支，以及工具生成的完整性元数据和可选 tracked 内容快照。它没有 upstream，也不会自动 push。
_避免使用_：备份 tag、远端恢复分支

**已验证 recovery**：
分支、完整工具元数据、计划身份、引用与可选快照均通过同一验证契约的本地 main 恢复点。只有这种恢复点可进入自动同步。

**旧式未验证 recovery**：
符合恢复分支命名但缺少有效工具元数据的人工或旧流程恢复点。诊断将其标记为 `legacy/unverified`，只能人工审计，不能用于自动同步。

## 品牌语言

**角色标识**：
以用户提供的棕色卷发、星形元素 Q 版人物为核心的品牌识别形象。
_避免使用_：S 人物、S 吉祥物

**星际技能管理员**：
角色标识在 Skill Expert 品牌中的身份，代表对 Skills 的收集、整理与调度。
_避免使用_：技能召唤师、纯角色头像

**技能核心**：
由角色星球灯棒演化而来的品牌道具，以透明星球、粉色握柄和星形核心表达被收集与调度的 Skills。
_避免使用_：麦克风、普通灯棒

**技能核心符号**：
技能核心在 16–32px 场景中的极简图形，以星形核心与单条星环保持小尺寸辨识度。
_避免使用_：迷你角色头像、旧 S 标识

**旧 S 标识**：
上一代版本使用的 S 形品牌符号；新一代图标不以保留该符号为约束。
_避免使用_：新角色标识
