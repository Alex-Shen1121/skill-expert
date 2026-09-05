// 一次性 UI 原型：只在专用开发命令中使用示例数据，所有写入均被拒绝。
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ManagedSkill } from "../lib/tauri";

export const prototypeEnabled = import.meta.env.DEV && import.meta.env.VITE_SKILL_FILES_PROTOTYPE === "1";

export interface ExampleEntry {
  path: string;
  kind: "directory" | "text" | "binary" | "large" | "symlink" | "unreadable";
  body?: string;
  size?: string;
  note?: string;
}

export const exampleEntries: ExampleEntry[] = [
  { path: "SKILL.md", kind: "text", size: "2.4 KB", body: `---
name: document-workflow
description: 从资料收集到结构化文档，完成一篇清晰、可追溯的文章。
version: 1.2.0
---
# 文档工作流

把零散资料整理为结构清晰、来源可追溯的文档。适用于技术文章、调研摘要和团队知识沉淀。

## 什么时候使用

- 已经收集了一些资料，希望先梳理结构再开始写作。
- 需要把长文整理为便于阅读的 Markdown 文档。
- 希望每个关键结论都能追溯到原始来源。

## 工作流程

### 1. 明确读者与问题

先用一句话说明文章要回答的问题。列出读者已经知道什么，以及读完之后应当能做什么。

### 2. 整理资料

按主题组织资料，区分事实、观点和待核验的推断。写作规范见 [写作指南](references/writing-guide.md)。

### 3. 完成初稿

使用 templates/article.md 作为起点。先写核心观点，再补充论据和实例。

\`\`\`bash
python scripts/export_markdown.py draft.md
\`\`\`

## 目录说明

| 目录 | 用途 |
| --- | --- |
| scripts/ | 导出与格式检查脚本 |
| references/ | 写作规范与参考资料 |
| templates/ | 可复用的文档模板 |
| assets/ | 配图与附加素材 |

> 交付前再次检查文章标题、引用来源和待补充内容。
` },
  { path: "scripts", kind: "directory" },
  { path: "scripts/export_markdown.py", kind: "text", size: "1.1 KB", body: `"""将输入文档导出为 Markdown。示例代码仅用于界面预览。"""

from pathlib import Path
import argparse

def export_markdown(source: Path) -> Path:
    content = source.read_text(encoding="utf-8")
    target = source.with_suffix(".export.md")
    target.write_text(content.strip() + "\\n", encoding="utf-8")
    return target

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="导出 Markdown 文档")
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    print(export_markdown(args.source))
` },
  { path: "scripts/utils", kind: "directory" },
  { path: "scripts/utils/normalize.py", kind: "text", size: "126 B", body: `"""统一换行符。"""\n\ndef normalize(text: str) -> str:\n    return text.replace("\\r\\n", "\\n").rstrip() + "\\n"\n` },
  { path: "references", kind: "directory" },
  { path: "references/writing-guide.md", kind: "text", size: "892 B", body: `# 写作指南\n\n一篇文章只回答一个核心问题。\n\n## 组织内容\n\n1. 开头直接写出主要结论。\n2. 每个段落围绕一个观点展开。\n3. 使用具体例子解释抽象概念。\n\n## 检查清单\n\n- [ ] 标题准确表达内容\n- [ ] 区分事实与推断\n- [ ] 保留引用来源\n\n返回 [技能说明](../SKILL.md)。\n` },
  { path: "references/很长的参考文档文件名：跨团队技术内容写作与来源核验规范.md", kind: "text", size: "328 B", body: "# 跨团队写作规范\n\n文件名很长时，目录保持紧凑，预览标题仍能读到完整名称。\n\n使用统一术语，并标记来源及核验日期。" },
  { path: "templates", kind: "directory" },
  { path: "templates/article.md", kind: "text", size: "230 B", body: "# 文章标题\n\n一句话写出核心结论。\n\n## 背景\n\n说明需要解决的问题。\n\n## 方案与实例\n\n用具体例子说明方法。\n\n## 参考资料\n\n补充可追溯的来源。" },
  { path: "assets", kind: "directory" },
  { path: "assets/cover.png", kind: "binary", size: "184 KB", note: "图片文件。当前原型展示文件信息，暂不渲染图片。" },
  { path: "assets/examples.zip", kind: "binary", size: "3.2 MB", note: "压缩包无法作为文本预览。" },
  { path: "assets/archive.json", kind: "large", size: "8.6 MB", note: "文件超过预览大小上限，仍保留在完整目录中。" },
  { path: "outputs", kind: "directory" },
  { path: ".git", kind: "directory" },
  { path: ".git/HEAD", kind: "text", size: "21 B", body: "ref: refs/heads/main\n" },
  { path: ".gitignore", kind: "text", size: "37 B", body: "__pycache__/\n*.pyc\noutputs/\n.DS_Store\n" },
  { path: "__pycache__", kind: "directory" },
  { path: "__pycache__/export_markdown.cpython-313.pyc", kind: "binary", size: "1.8 KB", note: "Python 编译缓存，无法作为文本预览。" },
  { path: "config.json", kind: "text", size: "96 B", body: '{\n  "language": "zh-CN",\n  "output": "markdown",\n  "include_sources": true\n}\n' },
  { path: "shared-assets", kind: "symlink", note: "指向技能目录外的符号链接；展示链接信息，不读取外部内容。", size: "—" },
  { path: "restricted.txt", kind: "unreadable", note: "没有读取权限。目录项仍然保留。", size: "—" },
];

export const prototypeSkills: ManagedSkill[] = ["document-workflow", "research", "code-review", "grill-with-docs", "prototype", "domain-modeling"].map((name, i) => ({
  id: `prototype-${i}`, name, description: i === 0 ? "从资料收集到结构化文档，完成一篇清晰、可追溯的文章。" : "整理知识与协作流程中的常用技能。",
  source_type: "local", source_ref: null, source_ref_resolved: null, source_subpath: null, source_branch: null,
  source_revision: null, remote_revision: null, update_status: "up_to_date", last_checked_at: null, last_check_error: null,
  central_path: `/示例技能库/skills/${name}`, enabled: true, created_at: 1788624000000, updated_at: 1788624000000,
  status: "synced", targets: ["codex", "claude"].map(tool => ({ id: `${name}-${tool}`, skill_id: `prototype-${i}`, tool, target_path: `/示例部署/${tool}/${name}`, mode: "symlink", status: "synced", synced_at: null })),
  preset_ids: ["writing"], tags: ["内容创作"], can_check_update: false,
}));

if (prototypeEnabled) {
  const preset = { id: "writing", name: "日常工作", description: null, icon: "Layers", sort_order: 0, skill_count: 6, created_at: 0, updated_at: 0 };
  mockWindows("main");
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown> | undefined;
    switch (command) {
      case "get_managed_skills": case "get_skills_for_preset": return prototypeSkills;
      case "get_presets": return [preset];
      case "get_active_preset": return preset;
      case "get_tool_status": return ["codex", "claude"].map(key => ({ key, display_name: key === "codex" ? "Codex" : "Claude Code", installed: true, enabled: true, skills_dir: `/示例部署/${key}`, is_custom: false, has_path_override: false, project_relative_skills_dir: null, has_project_path_override: false, category: "coding" }));
      case "get_projects": case "get_preset_skill_order": case "get_skill_tool_toggles": case "git_backup_pending_conflicts": case "get_central_repo_warnings": return [];
      case "get_all_tags": return ["内容创作"];
      case "get_settings": return args?.key === "language" ? "zh-CN" : args?.key === "first_run_restore_prompt" ? "fresh" : null;
      case "get_existing_installation_import_status": return { state: "not_available", should_prompt: false, source_path: null, backup_path: null, error: null };
      case "git_backup_status": return { is_repo: false, remote_url: null, branch: null, has_changes: false, changed_skill_count: 0, ahead: 0, behind: 0, last_commit: null, last_commit_time: null, current_snapshot_tag: null, restored_from_tag: null, upstream_health: "no_remote" };
      case "check_app_update": return { has_update: false, current_version: "1.0.16", latest_version: "1.0.16", release_url: "" };
      case "log_startup_event": return null;
      default: throw new Error(`只读原型未连接此操作：${command}`);
    }
  }, { shouldMockEvents: true });
}
