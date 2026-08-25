# Skill Expert 正式发布

Skill Expert 只接受经过审阅的 `main → release` 晋级。Release PR 必须使用 merge
commit，且**合并即批准正式发布**。功能、修复、版本号和双语 Changelog 仍然先进入
`main`；`release` 不接受独有修改。

## 首发前置条件

代码合入并不等于生产环境已经配置完成。第一次正式发布前必须完成：

1. 按 [Issue #11](https://github.com/Alex-Shen1121/skill-expert/issues/11) 配置独立
   Updater 信任根。在受信任的单用户机器运行 `npm run updater:provision`，把私钥和密码写入
   GitHub `release Environment` 的 `TAURI_SIGNING_PRIVATE_KEY` 与
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，并保存经过恢复演练的加密离线备份。
2. 按 [Issue #13](https://github.com/Alex-Shen1121/skill-expert/issues/13) 配置 `main`、
   `release` 分支、`v*` tag 与 `release` Environment 治理规则。

仓库中的 workflow 不会自动生成生产密钥，也不会替维护者选择离线备份位置。未完成上述
配置时，`npm run updater:check:production` 会在创建 tag 前停止发布。

## 单次 Draft-to-Latest 编排

合并合法 Release PR 后，`release` 的 `push` 会启动 `.github/workflows/release.yml`。
tag 创建、正式构建和公开发布位于同一次 workflow，不依赖 tag push 再触发另一个
workflow。所有正式发布共享 `release-production` 并发组；后续发布排队，正在运行的发布
不会被取消。

编排按以下顺序执行：

1. 核对当前 `release` HEAD、唯一的同仓库 `main → release` 已合并 PR、双父 merge
   commit、candidate SHA、版本副本、双语 Changelog 和远端 tag 缺失状态。
2. 创建指向 `release` HEAD 的 annotated `v<version>` tag。tag 绝不覆盖、移动或复用；如果
   创建 tag 后 Draft API 临时失败，只允许重跑同一次 workflow。annotated tag 的 message
   会记录 GitHub workflow run id；恢复时必须同时匹配 run id、release SHA、远端 tag object
   和唯一 Draft。
3. 创建不可见 Draft Release。
4. 四平台从同一 release commit 重新构建：macOS arm64、macOS x64、Windows x64、
   Linux x64。只有正式构建 job 绑定 `release Environment` 并读取生产 Updater Secret。
5. 所有平台在稳定命名后重新签署 Updater 包，验证签名可信注释绑定最终文件名，再把桌面
   包、Updater 包/签名和 CLI 上传到同一个 Draft。
6. 从 Draft 下载真实字节，生成四平台 `latest.json`、`SHA256SUMS` 和 GitHub
   build provenance，再上传回同一个 Draft。
7. 汇总门禁再次从 Draft 下载回验精确资产清单、SHA-256、Updater URL 与密码学签名、
   provenance 来源、macOS 应用/CLI 版本与 ad-hoc 签名、Windows CLI/NSIS/MSI 版本，
   以及 Linux CLI/DEB/RPM 版本、DEB/RPM 主程序一致性和 AppImage 的可提取性与
   Tauri `APP` 身份标记，并要求三种包内主程序具有同一个 ELF build-id。AppImage 会被
   linuxdeploy 执行 strip/patchelf，因此不与 DEB/RPM 做逐字节比较；build-id 证明它来自
   同一次链接构建，正式字节再由 SHA-256、Updater 签名与 provenance 绑定。
8. 只有 Linux、Windows 原生回验和 macOS 下载回验全部通过，才把 Draft 一次性公开并
   标记为 Latest。

正式清单包含四平台安装包和 Updater 产物、四个平台的独立 CLI、`latest.json`、
`SHA256SUMS` 与 `build-provenance.json`。任何缺失文件或意外文件都会阻止公开。

## macOS 分发边界

macOS 包使用免费的 ad-hoc 签名，不需要 Apple Developer Program，也不声称通过 Apple
公证或 Gatekeeper 自动接受。编排会对构建目录、Updater archive、下载后的 DMG 内应用
和 CLI 执行严格 `codesign` 验证，并核对应用版本。

首次打开时，用户可能需要进入“系统设置 → 隐私与安全性 → **仍要打开**”。默认说明不
要求关闭 Gatekeeper；命令行移除 quarantine 只适合作为高级排障手段。

## 失败与坏版本

tag 建立后的任一失败都保持不可见 Draft 供诊断，不移动 tag、不删除审计证据，也不复用
同一版本。唯一恢复例外是 tag 已建立但 Draft API 失败：维护者可在 GitHub Actions 中重跑
同一次 workflow，门禁只接受 message 带相同 workflow run id、指向同一 release SHA 且
tag object 完全相同的远端 annotated tag，并且只能补建或继续唯一 Draft。其他修复必须回到
`main`，准备一个新 patch 版本，再重新走
`main → release`。

如果问题在公开后才发现，可以取消该版本的 Latest 状态并在说明中添加警告；仍不得删除
或替换原 tag 和资产。Updater 不自动降级，修复只能由更新的稳定版本取代 Latest。
