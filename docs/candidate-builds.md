# Skill Expert 候选构建

正式候选是四平台安装包字节的唯一构建来源。日常 CI 先完成前端、版本契约、workflow
语法和 Rust 质量检查；只有候选分类器确认 `main` 上的精确提交是合法稳定版本候选后，
`.github/workflows/test.yml` 才通过 `workflow_call` 调用
`.github/workflows/candidate-build.yml`。普通开发序号版本绿色结束，不构建安装包，也不创建
Release PR。

可复用 workflow 必须收到完整 40 位 `candidate_sha`，检出该对象并确认 `HEAD` 完全相等。
正式候选固定构建 macOS arm64、macOS x64、Windows x64 和 Linux x64 四个平台；一次正常
`main` push 只产生一组候选。候选阶段不会创建 tag、GitHub Release 或 `latest.json`。

## 权限与签名边界

候选 workflow 对仓库内容只有读权限，没有 PR、Release 或生产环境写权限。每个平台在
runner 内生成临时 Updater 密钥，用它验证安装包和签名链路后随 runner 一起销毁；候选阶段
不能读取 `release Environment`、`TAURI_SIGNING_PRIVATE_KEY` 或生产密码。

临时 `.sig` 只能证明候选包具备可签名结构，不能进入公开 Release。正式发布会逐字节保留
安装包、Updater 包本体和 CLI，明确丢弃这些临时 `.sig`，再由唯一的生产重签阶段生成正式
签名。

## 不可变候选证据

四个平台全部成功后，候选证据 job 生成并保存：

- `candidate-manifest.json`：机器可验证的候选清单；
- `candidate-build-provenance.json`：由 GitHub Attestation 生成的真实候选构建来源证明；
- 一个独立候选证据 artifact，供 Release PR 和正式 workflow 按精确 ID 下载。

清单绑定仓库、版本、candidate SHA、candidate tree、source ref、workflow 路径与 revision，
并在同一条记录中固定 run ID、run attempt、job ID、artifact ID、artifact 名称和 digest。
每个候选文件还记录平台、角色、大小和 SHA-256。四个平台必须来自同一个成功 attempt；
缺少平台、失败 job、错误 SHA、过期 artifact、摘要不一致或混用 attempt 都不可晋级。

Release PR 展示这些身份，但可编辑正文不是信任根。高层晋级门禁会重新读取 GitHub API、
证据 artifact、清单和 provenance；更换重跑 attempt 必须显式刷新 PR 选择器。

候选 run 内只创建或刷新 Release PR，不立即启动晋级门禁。`Test` workflow 完整成功后，
`.github/workflows/release-promotion-dispatch.yml` 才核对 PR 选择器绑定同一个已完成 run ID/attempt，
并通过 `workflow_dispatch` 启动高层门禁。这样不会依赖 `GITHUB_TOKEN` 被抑制的 `pull_request`
事件，也不会在候选 run 仍为 `in_progress` 时提前验证。

## 精确资产清单

以版本 `1.2.3` 为例，每个目标目录只能包含下列文件，缺少或多出文件都会失败：

- macOS arm64
  - `skill-expert-v1.2.3-macos-arm64.dmg`
  - `skill-expert-v1.2.3-macos-arm64.app.tar.gz`
  - `skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig`
  - `skill-expert-cli-v1.2.3-macos-arm64`
- macOS x64
  - `skill-expert-v1.2.3-macos-x64.dmg`
  - `skill-expert-v1.2.3-macos-x64.app.tar.gz`
  - `skill-expert-v1.2.3-macos-x64.app.tar.gz.sig`
  - `skill-expert-cli-v1.2.3-macos-x64`
- Windows x64
  - `skill-expert-v1.2.3-windows-x64-setup.exe`
  - `skill-expert-v1.2.3-windows-x64-setup.exe.sig`
  - `skill-expert-v1.2.3-windows-x64.msi`
  - `skill-expert-v1.2.3-windows-x64.msi.sig`
  - `skill-expert-cli-v1.2.3-windows-x64.exe`
- Linux x64
  - `skill-expert-v1.2.3-linux-x64.AppImage`
  - `skill-expert-v1.2.3-linux-x64.AppImage.sig`
  - `skill-expert-v1.2.3-linux-x64.deb`
  - `skill-expert-v1.2.3-linux-x64.rpm`
  - `skill-expert-cli-v1.2.3-linux-x64`

实际版本始终从 `package.json` 读取；`1.2.3` 只用于演示稳定命名。

## 手工测试包

早期验证使用独立的 `.github/workflows/manual-test-package.yml`。维护者可选择一个或多个
目标，默认只构建 macOS arm64。该入口复用打包实现，但写入 `manual-test-package` 用途和
`promotable: false` 标记，不生成正式候选清单、不创建 Release PR，也不能接触生产密钥。
即使手工选择并成功构建四个平台，这组包也不能晋级为正式发布。

## macOS 首次打开

候选应用、Updater archive 中的应用和独立 CLI 都必须通过
`codesign --verify --deep --strict`，并保持无签名团队的 ad-hoc 身份。这是完整性校验，
不代表通过 Gatekeeper 或 Apple 公证。

首次打开可能被 macOS 拦截。先尝试打开 Skill Expert，再进入“系统设置 → 隐私与安全性 →
仍要打开”并确认。保持 Gatekeeper 开启；该例外只作用于 Skill Expert。
