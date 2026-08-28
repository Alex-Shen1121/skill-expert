# Agent 技能管家正式发布

Agent 技能管家的普通开发和正式发布都通过 PR 合入 `main`，但只有用户在当前请求中明确说“发布新版本”或“发布 `vX.Y.Z`”才构成发布授权。普通更新、修复、提交和手工测试包都不能触发正式发布。

## 普通更新

普通开发从最新 `origin/main` 创建 `codex/*` 分支，通过 PR 合入 `main`。源码版本始终保持最近一次正式稳定版本，用户可见变更写入双语 `Unreleased`。

`main` PR 只要求三项轻量检查：

- `GitHub Actions syntax`；
- `Frontend and version contract`；
- `Rust quality and Linux check`。

普通 PR 和 `main` push 不运行 macOS/Windows Rust 测试，不构建安装包，不创建 tag 或 GitHub Release。

## 发布准备 PR

收到正式发布授权后，Agent 从最新 `origin/main` 创建 `codex/release-vX.Y.Z`：

1. 用户只说“发布新版本”时运行 `npm run release:prepare -- patch`；
2. 用户明确指定稳定版本时运行 `npm run release:prepare -- X.Y.Z`；
3. 命令同步 npm、Cargo、Tauri 和三种界面语言中的版本，并把双语 `Unreleased` 归档到新版本；
4. Agent 创建 PR、等待三项轻量检查并合入 `main`；
5. Agent 取得发布 PR 的合并 SHA，等待该 SHA 的三项 `main` push 检查全部成功，再手动触发 `.github/workflows/release.yml`，把它作为 `release_sha` 输入。

用户的发布指令同时批准上述发布 PR 和正式工作流；正常路径不再增加第二次批准。发布工作流不读取或修改历史 `release` 分支。

## 单次正式发布工作流

所有正式发布共享 `release-production` 并发组，运行中的发布不会被后续请求取消。工作流依次执行：

1. 验证 `release_sha` 是完整 40 位 SHA、检出结果与之相同、已合入 `main`，并且对应唯一的 `codex/release-vX.Y.Z → main` PR；后续普通 PR 可以让 `main` 前进，不改变已批准的发布提交；
2. 验证该提交的三项轻量检查全部成功、源码只使用稳定 `x.y.z`、全部版本副本一致、双语 Changelog 已归档，并确认 tag 和 GitHub Release 尚不存在；
3. 创建不可变 annotated `vX.Y.Z` tag 和不可见 Draft；
4. 在 GitHub `release` Environment 中读取生产 Updater Secret，在 macOS 与 Windows 运行 Rust 测试，并为 macOS arm64、macOS x64、Windows x64 和 Linux x64 构建 CLI 与 Tauri 安装包、完成生产签名和原生包回验；
5. 生成四平台 `latest.json`、`SHA256SUMS` 和 `build-provenance.json`；
6. 从 Draft 重新下载 GitHub 保存的真实字节，验证精确资产清单、SHA-256、Updater 签名、来源证明，以及 macOS、Windows、Linux 原生版本；
7. 只有所有门禁通过后，才一次性公开 Draft 并标记为 Latest。

## 生产密钥边界

生产私钥和密码只保存在 GitHub `release` Environment：

- `TAURI_SIGNING_PRIVATE_KEY`；
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

普通 PR、手工测试包和仓库级 Secret 都不能读取生产密钥。初次配置使用 `npm run updater:provision`，完整边界参见[Updater 信任根](updater-trust-root.md)。名为 `release` 的 Environment 与历史 `release` 分支没有关系。

## 公开资产

每个公开 Release 精确包含 18 个四平台产品文件和 3 个生成文件，共 21 个资产：

- macOS arm64 与 x64：DMG、Updater archive、`.sig` 和 CLI；
- Windows x64：NSIS、NSIS `.sig`、MSI、MSI `.sig` 和 CLI；
- Linux x64：AppImage、AppImage `.sig`、DEB、RPM 和 CLI；
- `latest.json`：四平台稳定下载地址与生产签名；
- `SHA256SUMS`：产品资产和 `latest.json` 的 SHA-256；
- `build-provenance.json`：正式发布提交和 `.github/workflows/release.yml` 的 GitHub 来源证明。

## 失败与版本身份

tag 创建前失败时，可以修复后继续使用同一版本。不可变 tag 或 Draft 一旦创建，该版本即被占用，不得移动 tag、覆盖资产或复用版本；修复必须回到 `main` 并准备下一个稳定版本。

公开后发现问题时，可以取消 Latest 状态并在说明中警告，但不得删除或替换历史 tag 与资产。Updater 不自动降级，只能由更高的稳定版本取代。

## macOS 分发边界

macOS 包使用 ad-hoc 签名，不经过 Apple 公证，也不声称被 Gatekeeper 自动接受。首次打开可能需要进入“系统设置 → 隐私与安全性 → 仍要打开”；默认说明不要求关闭 Gatekeeper。
