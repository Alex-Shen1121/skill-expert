---
status: accepted
supersedes: 0002-promote-main-to-release.md
---

# 单次构建候选资产并可信晋级

## 背景

旧流程会在 `main` 候选阶段和 `release` 正式阶段对相同 Git tree 各执行一次四平台完整构建，
Release PR 还会重复已经在同一 candidate SHA 上通过的完整 CI。重复工作延长发布耗时，却不
增加源码覆盖；直接搬运资产又会混淆临时 Updater 签名、候选来源与正式来源。

## 决策

正式候选 workflow 是安装包、Updater 包本体和 CLI 字节的唯一构建来源。它在 `main`
candidate SHA 上使用临时 Updater 密钥完成四平台构建和原生回验，并生成绑定 tree、run
attempt、job、artifact ID/digest 和逐文件哈希的候选清单及 build provenance。

Release PR 继续使用 merge commit，合并仍是唯一正式发布批准，但 PR 只运行稳定命名的来源
检查和高层晋级契约。可编辑正文只是精确 run 的选择入口；门禁重新读取 GitHub API、不可变
artifact、清单和 provenance。

`release` workflow 在 tag 前再次验证候选身份和 tree，相同后按 artifact ID 下载候选字节。
它不得重新编译，必须丢弃临时 `.sig`，且只有一个绑定 `release Environment` 的 job 可以用
生产密钥重新签署 Updater 包。候选来源证明指向真实构建所在的 `main` candidate SHA；正式
来源证明只覆盖在 release SHA 上生成的签名、元数据、校验和与晋级绑定证明。

手工测试包使用独立入口和 `manual-test-package` 用途；无论选择多少平台都不可晋级。

## 结果

正常发布只执行一次四平台完整构建，同时保留精确候选选择、生产密钥最小暴露、不可变 tag、
Draft 下载回验和原子公开 Latest。失败或过期候选不能回退为“最新成功”选择，必须显式产生并
批准新的 run attempt/artifact 身份。
