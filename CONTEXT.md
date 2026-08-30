# Agent 技能管家发行

用于区分 Agent 技能管家的显示品牌、独立技术身份、上游项目与发布边界的统一语言。

## Language

**Upstream project**:
The external `xingkongliang/skills-manager` project, with its own decisions,
versions, releases, and update channel.

**Independent fork**:
The `Alex-Shen1121/skill-expert` project, which owns a release line distinct
from the upstream project even when it incorporates upstream changes.

**Agent 技能管家**：
独立 fork 面向用户展示的桌面应用名称，覆盖应用包、窗口、托盘、界面文案、诊断、下载说明与发布标题。
_避免使用_：Skill Expert、Skills Manager

**Skill Expert 技术身份**：
为兼容既有安装与发布链而保留的 `skill-expert` 仓库、CLI、包名、数据目录、Bundle ID、Updater 信任根和 Release 资产前缀；它不是当前应用显示名称。
_避免使用_：Agent 技能管家仓库、Agent 技能管家 CLI

**上游跟踪**：
对可信上游的完整变更进行审阅，只引入 Agent 技能管家需要的部分，同时保留独立的产品决策与发行线。
_避免使用_：上游同步、整包合并、自动合并

**Existing-installation import**:
A user-approved one-time copy of upstream product data into Agent 技能管家, not a
shared live data store between the products.
_Avoid_: Migration, shared library

**主分支**：
唯一接收产品变更和正式版本提交的 `main` 分支；所有开发变更都通过 `codex/*` PR 合入，上游评审分支是唯一自动化例外。
_避免使用_：生产分支、发布分支

**开发分支**：
从最新 `origin/main` 建立、通过轻量检查后以 PR 合入主分支的 `codex/*` 分支。
_避免使用_：直接提交分支

**上游评审分支**：
自动化生成上游变更审阅 PR 的固定 `upstream-tracking/main` 分支；它不是开发分支，也不会自动合入主分支。
_避免使用_：开发分支、自动同步分支

**发布授权**：
用户在当前请求中明确提出“发布新版本”或指定 `vX.Y.Z`；普通更新和测试打包均不构成发布授权。
_避免使用_：版本变化、main push

**发布准备 PR**：
只负责稳定版本号与双语更新日志归档的 `codex/release-vX.Y.Z → main` PR。
_避免使用_：Release PR、晋级 PR

**历史 release 分支**：
暂时保留但不再被代码、工作流、版本策略或正式发布依赖的旧 `release` 分支。
_避免使用_：发布源、生产分支

## 更新语言

**应用更新**：
Agent 技能管家应用本体从一个稳定版本升级到更高稳定版本的过程；它属于独立发行线，不包含任何 Skill 内容更新。
_避免使用_：自动更新、Skill 自动更新

**Skill 自动更新**：
用户已安装的 Skill 从各自来源升级到新修订的过程；它独立于 Agent 技能管家应用版本。
_避免使用_：应用更新、软件更新

**可检查更新 Skill**：
来源仍可追踪的 Skill，包括直接 Git 来源、skills.sh 来源，以及保留有效原始路径的本地或导入来源；失去来源的本地副本不属于此集合。
_避免使用_：所有 Skill、有可用更新

**检查全部**：
面向整个中央技能库检查所有可检查更新 Skill 的前台批量操作，不受当前 Preset、搜索或筛选条件限制；它只刷新更新状态，不修改 Skill 内容。
_避免使用_：检查当前结果、全部更新

**全部更新**：
从中央技能库已缓存的有可用更新 Skill 中选择并明确确认后执行更新的前台批量操作，不受当前 Preset、搜索或筛选条件限制。
_避免使用_：检查全部、Skill 自动更新

**有可用更新**：
技能库中的视图条件；仅匹配缓存状态为 `update_available` 且来源允许刷新的 Skill。切换该条件不会发起联网检查或执行更新。
_避免使用_：检查更新、全部更新

**来源仓库**：
直接 Git Skill 解析后的克隆仓库身份；不包含来源分支、Skill 子目录、skills.sh 来源或技能库备份仓库。筛选入口按规格使用“Git 仓库”“Git 倉庫”和“Git repositories”界面标签，以强调其仅适用于直接 Git 来源；这些标签不是独立领域概念。
_避免使用_：分支来源、Skill 子目录、技能库备份仓库

## 版本通道语言

**稳定源码版本**：
源码全部版本副本共同使用的 `x.y.z`；普通 PR 保持不变，只有发布准备 PR 才更新。
_避免使用_：开发序号、预发布版本

**正式发布提交**：
发布准备 PR 合入后位于 `main` 的精确提交，也是正式工作流唯一允许打包和标记的源码身份。
_避免使用_：最新 main、release HEAD

**正式发布工作流**：
显式绑定正式发布提交、一次构建四平台生产资产并在全部回验通过后公开 Latest 的手动工作流。
_避免使用_：候选晋级、tag push

**正式构建来源证明**：
`build-provenance.json`。证明公开资产来自正式发布提交和 `.github/workflows/release.yml`。
_避免使用_：候选来源证明、晋级证明

**应用安装包**：
供用户按操作系统和架构直接下载、安装或运行的桌面应用分发文件。
_避免使用_：Updater 包、CLI 包、全部 Release 附件

**应用更新资产**：
供 Agent 技能管家发现、验证并安装更高稳定版本的机器消费文件；它们是应用分发的一部分，但不是用户安装包。
_避免使用_：CLI 资产、Skill 自动更新资产

**公开发布资产**：
正式 Release 主动上传的应用安装包、应用更新资产、完整性清单和正式构建来源证明；不包含独立 CLI 下载或单独公开的 Updater 签名文件。
_避免使用_：所有构建产物、GitHub 自动生成的源码归档

**Draft 临时资产**：
只在不可见 Draft 中短暂保存、对应四个平台实际更新入口，并在生成应用更新元数据后、来源证明和公开前删除的独立 Updater 签名文件；独立 CLI 不属于此集合且不上传。
_避免使用_：内部资产、公开发布资产

**手工测试包**：
由独立手工入口生成、带 `manual-test-package` 与 `promotable: false` 标记的测试资产；默认只构建 macOS arm64，无论平台数量都不能转为正式 Release。
_避免使用_：正式版本、可发布包

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

**角色 App 图标**：
由角色标识构成的唯一产品身份图标，覆盖所有非系统状态区的应用、安装、启动、品牌和平台资产，不因尺寸缩小而替换图形。
_避免使用_：小尺寸技能核心图标、混合应用图标

**星际技能管理员**：
角色标识在 Agent 技能管家品牌中的身份，代表对 Skills 的收集、整理与调度。
_避免使用_：技能召唤师、纯角色头像

**技能核心**：
由角色星球灯棒演化而来的品牌道具，以透明星球、粉色握柄和星形核心表达被收集与调度的 Skills。
_避免使用_：麦克风、普通灯棒

**技能核心符号**：
技能核心在系统状态区中的极简图形，以星形核心与单条星环表达常驻的应用状态；它不属于角色 App 图标体系。
_避免使用_：小尺寸 App 图标、旧 S 标识

**系统状态区图标**：
操作系统提供的常驻状态入口，包括 macOS 菜单栏和 Windows、Linux 系统托盘；这是唯一使用技能核心符号的产品表面。
_避免使用_：窗口侧边栏图标、Finder 图标、任务栏应用图标

**旧 S 标识**：
上一代版本使用的 S 形品牌符号；新一代图标不以保留该符号为约束。
_避免使用_：新角色标识
