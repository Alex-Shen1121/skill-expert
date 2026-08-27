# Skill Expert 正式发布

Skill Expert 只接受经过审阅的 `main → release` 晋级。Release PR 必须使用 merge commit，
且**合并即批准正式发布**。功能、修复、版本和双语 Changelog 先进入 `main`；`release` 不
接受独有修改，也不反向合并回 `main`。

## 演练切换

候选资产复用路径在真实演练通过前由仓库变量 `RELEASE_PIPELINE_MODE` 隔离：

- 变量未设置或不是 `candidate-reuse` 时，`.github/workflows/release-legacy.yml` 继续执行旧的正式重建路径；
- 变量精确设置为 `candidate-reuse` 时，`.github/workflows/release.yml` 才执行候选资产复用路径，旧路径绿色跳过；
- 两个 workflow 共用串行发布 concurrency，不能同时发布同一个 release push。

只有完成 Ruleset 回读、测试 PR 和真实测试版本演练后，才允许删除旧 workflow、旧资产契约脚本和该开关，
并把候选资产复用设为唯一默认路径。切换变量本身不替代 Release PR 合并批准。

## 首发前置条件

代码合入不代表生产环境已经完成配置。第一次正式发布前必须完成：

1. 按 [Issue #11](https://github.com/Alex-Shen1121/skill-expert/issues/11) 配置独立
   Updater 信任根。在受信任的单用户机器运行 `npm run updater:provision`，把私钥和密码写入
   GitHub `release Environment` 的 `TAURI_SIGNING_PRIVATE_KEY` 与
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，并保留经过恢复演练的加密离线备份。
2. 按 [Issue #13](https://github.com/Alex-Shen1121/skill-expert/issues/13) 配置 `main`、
   `release` 分支、`v*` tag 与 `release Environment` 治理规则。

仓库 workflow 不会自动生成生产密钥，也不会替维护者选择离线备份位置。未完成配置时，
`npm run updater:check:production` 会在上传正式资产前停止发布。

## Release PR 轻量门禁

正式候选只在 `main` 的日常 CI 中构建一次。自动创建的 Release PR 明确展示版本、candidate
SHA、tree，并在一条不可变选择记录中固定 run ID、run attempt、artifact ID 和 digest。
PR 正文只用于展示和选择，不是信任根；正文被编辑后，高层门禁仍会重新读取 GitHub API、
证据 artifact、`candidate-manifest.json` 与来源证明。

Release PR 只运行两个稳定的高层检查：`发布晋级来源` 和 `发布晋级契约`。前者验证同仓库
`main → release`，后者验证当前 `main` SHA、版本/tag、五个日常 CI job、精确候选 run、
四平台 job/artifact、清单摘要、GitHub Attestation 和 artifact 可用性。Release PR 不重新运行
已经在同一 candidate SHA 上成功的完整前端和 Rust CI，也不重新打包。

开发集成分支 Ruleset 继续要求五个完整日常 CI；发布分支 Ruleset 只要求 `发布晋级来源` 和
`发布晋级契约`。候选 artifact 被删除或过期时立即不可晋级；重跑后必须显式刷新 PR 绑定，
不能按名称挑选“最新一个”。

## 单次 Draft-to-Latest 编排

合并合法 Release PR 后，`release` 的 `push` 启动 `.github/workflows/release.yml`。tag 创建、
候选搬运、生产重签、Draft 回验和公开位于同一次 workflow。所有正式发布共享
`release-production` 并发组；后续发布排队，正在运行的发布不会被取消。

编排顺序如下：

1. 在 tag 前核对当前 `release` HEAD、唯一已合并 Release PR、双父 merge commit、第二父
   candidate SHA、candidate/release tree 完全相等，并重新验证精确 run、artifact、清单和
   provenance 仍然可用。
2. 创建指向 `release` HEAD 的 annotated `v<version>` tag 和不可见 Draft。tag 绝不覆盖、
   移动或复用；精确恢复还必须匹配 workflow run ID、release SHA、tag object 和唯一 Draft。
3. 按清单中的四个 artifact ID 下载候选包，核对 API digest、文件名、角色、大小和 SHA-256。
   正式 workflow 不运行 `cargo build`、`tauri build` 或任何等价的安装包重新编译命令。
4. 逐字节复用安装包、Updater 包本体和 CLI，丢弃全部候选临时 `.sig`。下载或搬运阶段不能
   修改候选本体。
5. 唯一的生产重签 job 绑定 `release Environment`，读取生产 Updater Secret，对稳定命名的
   Updater 包本体生成正式 `.sig`，并立即使用产品公钥和最终文件名回验。
6. 生成 `latest.json`、`SHA256SUMS` 和 `promotion-binding.json`，再为这些正式阶段产物生成
   `release-provenance.json`。
7. 把全部资产先上传到不可见 Draft，然后重新下载 GitHub 保存的真实字节，运行通用资产、
   macOS、Windows 和 Linux 四组门禁。
8. 只有精确清单、哈希、生产 Updater 签名、四平台原生包与双层 provenance 全部下载回验
   通过，才把 Draft 一次性公开并标记为 Latest。

## 公开资产与双层来源证明

公开 Release 精确包含 18 个四平台文件和 6 个生成文件，共 24 个资产：

- `candidate-manifest.json`：候选身份、run、artifact 与逐文件哈希；
- `candidate-build-provenance.json`：候选构建来源证明指向真实构建所在的 `main` candidate SHA；
- `promotion-binding.json`：绑定版本、tag、release SHA、candidate SHA、相同 tree、run
  attempt、artifact 身份、清单摘要和复用本体哈希；
- `release-provenance.json`：正式来源证明指向生成签名和元数据的 release SHA；
- `latest.json`：四平台稳定下载 URL 与生产签名；
- `SHA256SUMS`：覆盖公开契约要求的候选本体和可独立校验的生成文件。

候选构建来源证明只声明安装包、Updater 包本体和 CLI 来自候选 workflow；正式
provenance 只声明生产 `.sig`、Updater 元数据、校验和与晋级证明来自 release workflow。
不得把在 `main` 构建的候选字节伪装成在 `release` 重新构建。

最终门禁拒绝缺失或额外文件、候选临时签名、不可复算的 SHA-256、错误 URL/生产签名、
候选本体被替换、错误来源证明或 tree 绑定。macOS 继续检查应用和 CLI 的版本与 ad-hoc
签名；Windows 继续检查 NSIS、MSI 与 CLI；Linux 继续检查 AppImage、DEB、RPM、CLI、
主程序一致性和 ELF build-id。

## macOS 分发边界

macOS 包使用免费的 ad-hoc 签名，不需要 Apple Developer Program，也不声称通过 Apple
公证或被 Gatekeeper 自动接受。候选和最终下载回验都会检查应用、Updater archive、DMG
与 CLI 的签名和版本。

首次打开时，用户可能需要进入“系统设置 → 隐私与安全性 → **仍要打开**”。默认说明不
要求关闭 Gatekeeper；命令行移除 quarantine 只适合作为高级排障手段。

## 失败与坏版本

tag 建立后的任一失败都保留不可见 Draft 和审计证据，不移动 tag、不替换已上传资产，也不
复用同一版本。只允许同一次 workflow 在身份和已有字节全部精确匹配时恢复；不得静默切换
另一个 run attempt 或 artifact。

其他修复必须回到 `main`，准备一个新 patch 版本，再重新走 `main → release`。如果问题在
公开后才发现，可以取消该版本的 Latest 状态并在说明中添加警告；仍不得删除或替换原 tag
和资产。Updater 不自动降级，修复只能由更新的稳定版本取代 Latest。
