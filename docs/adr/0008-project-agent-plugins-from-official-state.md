---
status: accepted
---

# 从 Agent 官方状态投影插件目录

Agent 技能管家通过每个插件支持 Agent 的已验证官方接口生成只读、内存态的插件状态投影，并以 Agent、Marketplace 与插件 ID 的组合保留安装实体身份。首版使用受控外部进程运行 `codex plugin list --available --json`；Agent 插件目录模块集中负责可执行文件解析、命令契约、状态映射和结构化错误，Tauri 命令只切换阻塞线程并序列化结果。

## 考虑过的方案

- 把插件内置 Skills 摊平成中央技能库条目。
- 扫描 Codex 内部缓存或复用开发中的 app-server 插件接口推测当前状态。
- 从 Codex 官方 CLI 的同一次目录快照生成独立插件投影。

## 结果

- 插件浏览不会建立安装数据库，也不会写入 Codex 配置、插件状态、Marketplace 或中央技能库。
- CLI 的安装与启用字段是插件安装状态的唯一事实来源；补充资料失败不得删除 CLI 已确认的身份。
- 顶层集合、必要身份或状态字段缺失，以及重复的完整身份，均作为契约不兼容整体拒绝，避免静默漏项或错误合并。
- 每个 Agent 的读取结果与错误保持隔离，未经清理的命令输出和本地绝对路径不进入前端投影。
- [OpenAI 官方 manifest 文档](https://developers.openai.com/plugins/build/plugins#manifest-fields)目前只把 `interface.capabilities` 定义为显式能力字符串列表，没有浏览器扩展或自定义 UI 专用字段；UI 由 MCP 集成在运行时声明。
- 为保留前向兼容且避免猜测，浏览器扩展和自定义 UI 只接受 `interface.capabilities` 中精确的 `browser-extension: <名称>` 与 `custom-ui: <名称>` 声明。名称必须是有限长度的非路径文本；普通能力词、插件品牌、默认文件和未知字段一律不推断。将来若 OpenAI 发布专用字段，必须先更新本 ADR 与允许列表，再读取该字段。
