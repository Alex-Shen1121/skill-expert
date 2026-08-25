# 更新日志

本项目所有显著变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
上游 Skills Manager 的历史记录保存在[上游历史归档](docs/upstream-history/CHANGELOG-zh.md)中。

## [Unreleased]

### 发布概览
-

### 用户可见更新
-

### 开发者与治理更新
-

## [1.0.1] - 2026-08-25

### 发布概览
- 为 Skill Expert 独立发布线增加可审核的版本准备流程。

### 用户可见更新
- 维护者可以选择 patch、minor 或 major 版本，并在进入 `main` 前审核一份版本准备 Pull Request。

### 开发者与治理更新
- 通过公开校验命令与 CI，保持全部版本副本和双语 Changelog 同步。
- 允许回验任务在公开前读取仍不可见的 Draft Release，同时禁止这些任务修改 Release。
- 当 `release` 保留上一次经审计的晋级 merge commit 时，允许后续 `main → release` 晋级，同时拒绝 release 独有提交和被篡改的晋级树。

## [1.0.0] - 2026-08-24

### 发布概览
- 建立 Skill Expert 独立桌面产品及其单独的 1.0.0 版本线与安装身份。

### 用户可见更新
- 应用、窗口、托盘菜单、设置、诊断与三种语言界面统一显示 Skill Expert。
- Skill Expert 使用隔离的默认存储位置，可与上游 Skills Manager 同时安装。
- 面向 Agent 的受支持命令现为 `skill-expert-cli`；其 npm/Cargo 包身份、帮助、安装路径、Release 资产和托管 Skill 数据路径均使用 Skill Expert 身份。

### 开发者与治理更新
- 桌面 bundle identifier 为 `com.codingshen.skill-expert`。
- 更新元数据只读取独立的 `Alex-Shen1121/skill-expert` Release 契约。
