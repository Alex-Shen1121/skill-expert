---
status: accepted
---

# 桌面应用显示名称改为 Agent 技能管家

桌面应用及其用户可见发布表面统一显示“Agent 技能管家”。为避免破坏既有安装、自动更新、CLI 调用与公开下载链接，`Alex-Shen1121/skill-expert` 仓库、`skill-expert-cli`、包名、数据目录、Bundle ID、Updater 信任根和 Release 资产前缀继续保留 `skill-expert` 技术身份。

Windows MSI 显式使用 `zh-CN` WiX 本地化，以承载中文产品名；同时固定重命名前由“Skill Expert”派生的 `upgradeCode`，确保新安装包继续升级既有应用，而不是创建第二个安装身份。
