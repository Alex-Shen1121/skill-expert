# Skill Expert Updater 信任根

Skill Expert 独立持有自己的 Tauri Updater 信任根。仓库只在
`src-tauri/tauri.conf.json` 中保存 Base64 编码的公钥；加密私钥和密码分别保存为
`release` Environment Secret：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

不得创建仓库级 Secret 副本，也不得把 Secret 值粘贴到 Issue、拉取请求、工作流输入、
Shell 历史或日志中。只有明确授权后手动触发的 `.github/workflows/release.yml` 才会让
`build-release` 正式构建绑定 `release` Environment 并读取生产 Secret。手工测试包在每个
运行器内生成临时 Updater 密钥，不能访问生产 Environment。完整发布顺序与故障处理参见
[正式发布指南](formal-release.md)。

这是 Skill Expert 维护者执行的一次性产品配置，不是终端用户设置，也不是每次发布都要
重复的步骤。配置前，仓库使用一个有明确记录的“尚未配置”开发公钥，其私钥部分已经丢
弃。普通拉取请求和 `main` 检查只接受该占位公钥或独立生产公钥，同时仍拒绝归档的上游
公钥和更新源。正式发布工作流会运行 `npm run updater:check:production`；该命令拒绝尚未
配置状态，因此占位公钥不可能进入正式发布。

实现配置命令的代码可以在占位状态下合入 `main`，但首次正式发布和 Issue #11 的生产验
收仍必须等待一次真实配置完成。

## 初始配置

初始配置必须由维护者在可信机器上执行。备份目录和恢复口令路径是运行时输入，不会写入
仓库配置，也不得提交到仓库。两个路径都必须位于仓库之外。备份目录应位于离线可移动介
质并限制为当前用户访问；口令文件必须位于不同物理位置或不同介质，且至少包含 32 个字
符。

先设置目录和文件权限，再从仓库根目录运行交互命令：

```bash
umask 077
chmod 700 "/path/to/offline-backup-directory"
chmod 600 "/path/to/separate-medium/recovery-passphrase"
npm run updater:provision
```

命令会展示完整的非秘密计划，并要求维护者输入 `确认配置 SKILL EXPERT`。确认后，命令
会在私有临时目录中生成带密码的密钥对、创建并恢复加密离线备份、签名并验证一次性恢复
canary、创建 GitHub `release` Environment、上传两个生产 Secret、只更新
`src-tauri/tauri.conf.json` 中的公钥，最后删除所有临时明文密钥材料。

如果 Environment 或 Secret 写入在中途失败，已经完成的加密备份会保留。使用相同备份目
录和口令文件重新运行命令时，命令不会重新生成密钥，而是恢复并验证现有备份，然后覆盖
写入两个匹配的 Secret 并继续配置。因此部分外部状态不会把维护者锁死在不可重试状态。

Tauri 当前的非交互 `signer generate --ci` 接口只通过 `--password` 接收生成密码，因此
自动命令会让随机密码在子进程存活期间短暂出现在该子进程的参数中。命令不会打印或持久
化这段参数，但仍必须在不采集进程参数的可信单用户维护机器上运行。如果机器启用了跨用
户进程查看或命令参数审计，应改用 Tauri 自带的交互式密钥生成，再按本文的手动步骤完成
备份、恢复验证和 Secret 写入。

命令只输出公钥标识、备份路径与校验和、Secret 名称和验证状态。要仅验证路径并查看同一
计划，可运行：

```bash
npm run updater:provision -- \
  --plan \
  --backup-directory "/path/to/offline-backup-directory" \
  --recovery-passphrase-file "/path/to/separate-medium/recovery-passphrase"
```

该命令承担以下维护职责：

1. 创建权限为 `700` 的临时工作目录。
2. 为 Skill Expert 生成新的带密码 Tauri 签名密钥对，绝不复用上游密钥对；私钥和密码文
   件权限均为 `600`。
3. 只把生成的 `.pub` 值写入 `plugins.updater.pubkey`，更新源保持唯一值
   `https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json`。
4. 创建 GitHub `release` Environment。用户在当前请求中明确要求发布就是人工发布批准，
   发布准备 PR 合入 `main` 后不再增加第二位审查者。
5. 通过 `gh secret set --env release` 分别上传 `TAURI_SIGNING_PRIVATE_KEY` 和
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，然后只读取 Secret 名称确认二者存在；GitHub
   不会返回 Secret 值。
6. 运行 `npm run updater:check:production`，拒绝占位公钥、归档的上游公钥、上游更新源
   或格式错误的公钥。
7. 对生成的更新清单另行执行：

   ```bash
   node scripts/verify-updater-metadata.mjs \
     --file latest.json \
     --version x.y.z \
     --asset-directory /path/to/release-assets
   ```

   验证器读取已配置公钥，对列出的每个产物执行密码学签名验证，并拒绝平台缺失、Tauri
   签名缺失或格式错误、版本偏移，以及指向非 Skill Expert 仓库的下载地址。

只有完成下述加密离线恢复验证后，密钥对才算配置完成。

## 加密离线备份

加密恢复包必须保存在离线可移动介质中，恢复口令必须保存在不同物理位置或不同介质，例
如具有独立恢复方案的密码管理器。不得把恢复包和口令放在一起，也不得提交其中任何一
项。

手动准备口令文件时应限制权限：

```bash
umask 077
chmod 600 /secure/separate-medium/skill-expert-recovery-passphrase
```

如需手动创建经过认证的 AES-256-GCM 恢复包，可直接写入离线介质：

```bash
node scripts/updater-key-recovery.mjs create \
  --private-key /secure/work/skill-expert-updater.key \
  --public-key /secure/work/skill-expert-updater.key.pub \
  --signing-password-file /secure/work/skill-expert-updater.password \
  --recovery-passphrase-file /secure/separate-medium/skill-expert-recovery-passphrase \
  --output "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json"
chmod 600 "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json"
```

恢复包只在认证加密载荷中包含私钥、公钥和签名密码。工具拒绝短于 32 个字符的恢复口令，
也拒绝覆盖已有备份。在 Unix 上，工具还会拒绝组用户或其他用户可读的源凭据，并以仅所
有者可访问的权限写入文件。工具先在目标旁写入并同步临时文件，再原子发布最终恢复包；
写入失败不会在最终路径留下截断文件。

Windows 权限位不能代表实际 ACL，因此工具无法自动验证该边界。应使用可信私有目录，并
在配置或恢复前检查 Windows ACL。

## 恢复验证

删除工作副本前以及每次轮换后，都必须测试恢复。恢复到新的临时目录，不得覆盖现有密钥
目录：

```bash
verify_parent=$(mktemp -d)
node scripts/updater-key-recovery.mjs restore \
  --backup "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json" \
  --recovery-passphrase-file /secure/separate-medium/skill-expert-recovery-passphrase \
  --output-directory "$verify_parent/restored"
```

恢复验证必须满足：

1. 恢复目录权限为 `700`，私钥、公钥和密码文件权限均为 `600`。
2. 恢复公钥与 `src-tauri/tauri.conf.json` 中的 `plugins.updater.pubkey` 完全相同。
3. 使用恢复文件提供 `TAURI_SIGNING_PRIVATE_KEY_PATH` 和
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，通过 `npx tauri signer sign` 签名一次性
   canary，再使用恢复公钥执行密码学验证。非空的 `.sig` 文件本身不能证明私钥和公钥匹
   配：

   ```bash
   canary="$verify_parent/skill-expert-updater-canary.txt"
   printf 'Skill Expert updater recovery canary\n' > "$canary"
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$verify_parent/restored/skill-expert-updater.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< "$verify_parent/restored/skill-expert-updater.password")"
   npx tauri signer sign "$canary"
   unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   node scripts/verify-updater-signature.mjs \
     --file "$canary" \
     --signature "$canary.sig" \
     --public-key "$verify_parent/restored/skill-expert-updater.key.pub"
   ```

   如果签名、canary 或公钥来自不同密钥对，验证必须失败。
4. 测试后立即删除 canary 和恢复出的明文材料，弹出离线介质，只保留加密恢复包。

错误的恢复口令必须在创建输出目录之前认证失败。记录中只允许保存测试日期、公钥标识、
备份校验和和成败状态，不得保存私钥、签名密码或恢复口令。

## 两阶段密钥轮换

Tauri 客户端信任当前安装版本内嵌的公钥，因此安全轮换需要两个发布阶段。

### 阶段 1：过渡发布

旧私钥仍可用时，把客户端配置改为新公钥，但继续使用旧私钥签名过渡版本。现有客户端使
用旧信任根接受该版本；安装后，过渡客户端开始信任新公钥。采用窗口结束前必须保留新旧
两个加密恢复包。

### 阶段 2：启用新私钥

过渡版本经过约定采用窗口后，用新私钥和密码替换 `release` Environment Secret。此后
所有版本均使用新私钥签名。必须验证 `latest.json` 中的签名，并按发布保留策略保存旧加
密备份。

如果旧私钥在阶段 1 前丢失，旧客户端无法认证过渡版本。如果当前私钥与加密备份或所需口
令同时丢失，已安装客户端的自动更新能力无法恢复。此时只能发布由新密钥签名的构建，并
通知受影响用户手动重新安装；不得移动旧标签，也不得替换已经发布的产物。
