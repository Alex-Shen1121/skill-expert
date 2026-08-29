---
status: accepted
---

# GitHub Release 只公开应用分发资产

未来正式 Release 只主动上传与桌面应用安装、应用内更新及其可信验证直接相关的 12 个资产：七个用户安装包、两个 macOS Updater archive、`latest.json`、`SHA256SUMS` 和 `build-provenance.json`。独立 CLI 继续在 runner 内构建和测试，但不上传到 Draft；四个平台实际更新入口的签名作为 Draft 临时资产生成、验证并写入 `latest.json`，随后在来源证明和公开前删除。

这项边界在精简 Release 页面的同时保留四平台应用内更新、安装包完整性检查和正式构建来源证明。GitHub 自动生成的源码归档不属于项目主动上传的公开发布资产，既有公开 Release 保持不可变。
