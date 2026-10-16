# GitLab Duo 与自定义 Agent 注册

本页对应 GRJNGJ-83 / GRJNGJ-92，需求输入为 PRD v0.5、UI-83 v0.3、TECH-83 v0.3。它描述实现契约；通过编码输入评审不等于独立测试或产品验收通过。

## 数据与执行边界

沿用 `settings` 的 `custom_tools`、`custom_tool_paths`、`custom_tool_project_paths`、`disabled_tools`、`tool_order`，没有新增表或迁移协议。`ToolConfig` 在同一 SQLite 读取事务中解析五项，缺键与坏类型/坏 JSON/读取错误分开。专用写操作在 `BEGIN IMMEDIATE` 中重读并只保存实际改变的配置项；排序携带已展示的键顺序，前值不一致则拒绝。

有效适配器解析供列表、单键查询、扫描、项目、启停与部署共同使用。只有唯一有效的旧 custom `gitlab_duo` 覆盖同键内置；保留名称、分类、全局路径、项目 null 和 custom 身份。休眠侧表只读、正常使用时不覆盖旧定义；显式移除前才验证其将生效的值。移除旧定义与确保内置停用同事务提交，顺序与合法侧表保留，不自动部署。

同库配置与文件/目标记录操作复用 `.skill-expert.lock`。同线程嵌套调用只复用该库已经持有的文件锁，其他线程/进程仍互斥；锁顺序为库锁→数据库事务。原有直接 try-lock 仍保留忙时失败行为。SQLite 与文件系统不是跨资源事务：已写文件但目标 INSERT 未确认会报告 `unconfirmed`，不会声称回滚。

清理前完整读取所有声明，解析父目录物理身份并保留末级目录项，检查链接来源或可信 copy 摘要。共享、外来或不能确认的文件保留；I/O 失败保留待处理记录。外部进程不遵守本库锁时仍可能在检查后替换文件，本实现不承诺消除任意外部写者的竞态。

项目 `.agents/skills` 即使只有一个可见 Agent 也视为共享。已停用 Agent、linked 工作区、物理等价/嵌套路径均纳入判断；影响未知时保守拒绝。单项、批量和直接 IPC 的移动、删除、从中心替换均在执行锁内重核对。项目 null 不能解析到项目根。项目导出继续使用 NoClobber；不新增所有权表或强制删除入口。

## CLI

```sh
skill-expert-cli agents add-custom KEY --path /absolute/skills --name "Display name" --project-path .agent/skills
skill-expert-cli --json tools add-custom KEY --path /absolute/skills
```

两入口共用 `register_custom_tool`，含规范化、保留键检查、事务保存和实际 Preset 协调。KEY/path 必填；省略 name 使用 trim 后 KEY，显式空名拒绝；项目省略/空白为 null。全局路径允许平台绝对路径或 `~/`；项目拒绝原生 Prefix/RootDir/ParentDir 及非空归一到根。

成功返回：`registered=true`、规范化 `definition`、`tool`（ToolInfo 或 null）、`deployment`。ToolInfo 读取失败不抹去已经确认的保存事实。解析失败退出 2；确认提交前失败退出 1、registered=false；提交结果未知退出 1、registered=null/code=REGISTRATION_UNKNOWN。已注册且协调 complete 或可证明 not_run 退出 0；不完整退出 1/code=DEPLOYMENT_INCOMPLETE/registered=true。执行成功 stdout 一份 JSON，失败 stderr 一份 JSON，默认模式与 `--json` 相同；不会先输出成功再追加通用错误。

同库 `agents list` 后显式 `agents enable gitlab_duo` 是移除旧项后的启用流程。CLI 不证明已读、不绑定两命令之间的路径快照；并发变化后重新 list。GUI 启用单项/全部时展示当前内置路径与项目能力，并传入实际展示值，执行时变化则拒绝并要求重新查看。

## IPC 变化

| 命令 | 输入 / 返回 / 失败 |
| --- | --- |
| `add_custom_tool` | 原四字段保持；返回 RegistrationReceipt，结构如上。确认的执行错误返回 AppError，通信失败由前端保持未知。 |
| `query_custom_tool` | 输入同一规范化候选 `definition`；严格只读，返回 matches/conflict/absent 与当前 ToolInfo。匹配只证明定义，不证明协调成功。 |
| `remove_custom_tool` | key；成功返回 removed、next_tool、deployment。清理失败不删除定义；旧 Duo 成功后 next_tool 是停用内置。 |
| `set_tool_enabled` / `set_all_tools_enabled` | 原输入加可选 expectedDuo；GUI 启用停用内置 Duo 时必需匹配展示值，过期返回 stale_snapshot；CLI 内部显式启用仍读取最新配置。 |
| `set_tool_order_cmd` | order、expected；对照完整可见键顺序，拒绝并发过期提交。 |
| `set_settings` | 仍是单个 key/value；只接受这两个字段且都是字符串，五项受保护键及畸形/混合 payload 首次写入前拒绝。无新增批量 API。 |
| `get_project_root_impact` | projectId、agent；只读返回 workspace、physical_path、known_agents、shared、unknown；known_agents 不代表所有外部使用者。 |
| `get_startup_failure` | 无输入；正常启动 null，否则返回内存中的 stage/code/setting/retryable/diagnostics。 |

同步错误保持已有 kind/message，details 可携带 deployment。每份报告含 scope=global、operation=sync/remove、state、reason、total、targets、issues。state 为 complete/not_run/partial/failed/unknown；total 在完整枚举未确认时为 null。targets 含 skill_id/tool/target_path/outcome/message，outcome 为 committed/already_current/refused/failed/unconfirmed/not_attempted。issues 含已知 stage/code/tool/target_path/message。

GUI 保留注册回执与部署报告；刷新失败保留旧列表并只重试读取。保存未知固定本次 KEY 和输入：匹配→确认存在但部署未知；冲突→展示当前值不覆盖；可靠不存在且已收到原调用结束错误→允许显式重试；读取失败或通信中断导致原调用是否结束未知→继续阻止重复注册。

启动初始化失败不注册半初始化 store、不挂载正常 AppProvider、不启动 watcher/同步/备份。错误窗口复用完整进程 restart、退出与 clipboard；关闭等同退出，复制失败可重试。诊断仅从版本、OS、架构及已知阶段/配置项构造后脱敏。初始化前的 store migration/secret-key 等不属于“整个启动零写入”承诺。

## 隔离自测

固定 Rust 工具链由仓库脚本管理。不要在用户库运行 fixture：

```sh
npm ci
npm run cli:build
python3 scripts/verify-agent-registration.py --binary src-tauri/target/debug/skill-expert-cli --root /absolute/disposable-fixtures
```

脚本为每次运行创建新子目录，使用 debug 专用 `SKILL_EXPERT_ACCEPTANCE_ROOT`，先核对 repo status 的真实状态根，再测试默认/JSON/tools 别名、输入错误、进程并发、旧 Duo 两次读取及坏配置零覆盖。结果 JSON 留在打印的隔离子目录。此环境变量不在 release 构建中启用；不修改 HOME、用户真实库、厂商目录或共享参考树。

macOS 原生应用复用现有验收配置，仅用于本地自测：

```sh
npm run tauri:build -- --debug --bundles app --config src-tauri/tauri.acceptance.conf.json
SKILL_EXPERT_ACCEPTANCE_ROOT=/absolute/disposable-fixtures/gui \
  'src-tauri/target/debug/bundle/macos/Agent 技能管家 · 插件验收.app/Contents/MacOS/skill-expert'
```

这是既有独立验收身份的调试构建，不是发布包；构建配置沿用“插件验收”标题。测试 GUI 与 CLI 同库时两进程使用相同验收根；测试坏配置先在进程退出后修改该隔离库，随后验证启动失败窗口。

必要命令：`npm run lint`、`npm run typecheck`、`npm run test:frontend`、`npm run build`、版本/身份/工作流检查；Rust `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、lib 与 CLI 行为测试。宿主注入的 GIT_AUTHOR_NAME 会干扰仓库既有设备身份测试，仅对测试进程取消此覆盖，不改 Git 配置。

真实浏览器/原生交互、Windows 路径和实际 Duo 新会话加载分别记录结果；代码、单测和官方资料不能替代缺失环境的实测。独立测试、产品验收和 CEO 精确版本核对是合并发布前门禁，普通功能 PR 不修改版本号。
