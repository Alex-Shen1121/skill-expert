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
