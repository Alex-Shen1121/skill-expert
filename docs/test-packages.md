# Agent 技能管家手工测试包

手工测试包用于在正式发布前按需验证安装结果，不是候选版本，也不能转为正式 Release。只有维护者手动触发 `.github/workflows/manual-test-package.yml` 时才会构建，普通 PR 和 `main` push 不会调用它。

## 构建入口

维护者可以选择 macOS arm64、macOS x64、Windows x64 和 Linux x64，默认只选择 macOS arm64。入口把当前精确提交 SHA 和平台矩阵传给 `.github/workflows/test-package-build.yml`；复用工作流必须确认检出的 `HEAD` 与完整 40 位 `source_sha` 相同。

每个平台在隔离的运行器中生成临时 Updater 密钥，构建 CLI 和桌面包，完成平台回验后上传 Actions Artifact。临时密钥随运行器销毁，工作流不能访问 GitHub `release` Environment 或生产 Updater Secret。

## 跨平台进程验证入口

同一手工入口选择 `validation_only=true` 时，只在原生 Windows 与 Linux 运行器执行受控进程公共 fixture 和 `cargo check --all-targets`。该模式固定记录 `promotable: false`，并跳过平台选择、Tauri/CLI 打包、签名、Artifact 上传、tag、Draft 与 Release；它只为指定提交提供条件编译和进程生命周期证据，不改变普通 PR 仍只运行三项轻量检查的边界。

## 不可晋级标记

每个平台的 Artifact 都包含 `TEST-PACKAGE.json`：

```json
{
  "schemaVersion": 1,
  "purpose": "manual-test-package",
  "sourceSha": "<40 位提交 SHA>",
  "target": "<平台>",
  "promotable": false
}
```

无论选择一个还是四个平台，这些 Artifact 都不能用于 `.github/workflows/release.yml`，也不会创建 tag、Draft、`latest.json` 或公开 Release。

## macOS 首次打开

测试应用、Updater archive 中的应用和独立 CLI 都会接受 ad-hoc 完整性回验，但这不代表通过 Apple 公证或被 Gatekeeper 自动接受。首次打开可能需要前往“系统设置 → 隐私与安全性 → 仍要打开”；请保持 Gatekeeper 启用。
