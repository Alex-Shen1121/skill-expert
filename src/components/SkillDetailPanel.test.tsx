// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SkillDetailPanel } from "./SkillDetailPanel";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill } from "../lib/tauri";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
const skill: ManagedSkill = {
  id: "demo", name: "文档技能", description: "完整技能目录", source_type: "git", source_ref: "https://example.com/skills.git", source_ref_resolved: null,
  source_subpath: null, source_branch: null, source_revision: null, remote_revision: null,
  update_status: "up_to_date", last_checked_at: null, last_check_error: null, central_path: "/skills/demo", enabled: true,
  created_at: 1, updated_at: 1, status: "ok", targets: [], preset_ids: [], tags: [], can_check_update: true,
};
const index = {
  skill_id: "demo", session_id: "session-demo", entry_path: "SKILL.md", complete: true, file_count: 2, directory_count: 2,
  entries: [
    { path: "SKILL.md", kind: "file", size: 12, error: null },
    { path: "scripts", kind: "directory", size: 0, error: null },
    { path: "scripts/read.py", kind: "file", size: 14, error: null },
    { path: ".git", kind: "directory", size: 0, error: null },
  ], issues: [],
};
beforeAll(async () => { await i18nReady; await i18n.changeLanguage("zh"); });
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openUrl).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return index;
    if (command === "read_skill_browser_file") {
      const path = (args as { relativePath: string }).relativePath;
      return { path, kind: "text", size: 14, text: path === "SKILL.md" ? "# 阅读入口" : "print('只读')\n", message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
});
afterEach(cleanup);
it("本地完整目录按需读取，折叠和恢复保留文件且不提前请求来源", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "阅读入口" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "scripts/read.py" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "scripts" }));
  await user.click(screen.getByRole("button", { name: "scripts/read.py" }));
  expect(await screen.findByText("print('只读')")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "收起目录树" }));
  expect(screen.queryByRole("navigation", { name: "本地完整文件目录" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "展开目录树" }));
  expect(screen.getByRole("button", { name: "scripts/read.py" }).getAttribute("aria-current")).toBe("true");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name.includes("source"))).toBe(false);
  unmount();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("close_skill_browser", { skillId: "demo", sessionId: "session-demo" });
});

it("入口缺失和局部失败不会伪装为空目录，重新加载后可以继续选择文件", async () => {
  const user = userEvent.setup();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "open_skill_browser") return { ...index, entry_path: null, entries: [], file_count: 0, directory_count: 0, complete: false, issues: ["references：权限不足"] };
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  expect(await screen.findByText("目录未完整读取")).toBeTruthy();
  expect(screen.queryByText("空目录")).toBeNull();
  expect(screen.getByText("references：权限不足")).toBeTruthy();
  expect(screen.getByText("已读取 0 个文件 · 0 个目录")).toBeTruthy();
  expect(screen.getAllByText("请选择文件").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "重新加载目录" }));
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "open_skill_browser")).toHaveLength(2);
});

it("快速选择文件时迟到正文不覆盖当前路径，切换 Skill 后释放旧会话", async () => {
  const user = userEvent.setup();
  let finishOldRead: ((value: unknown) => void) | undefined;
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "read_skill_browser_file" && (args as { relativePath: string }).relativePath === "SKILL.md") return new Promise(resolve => { finishOldRead = resolve; });
    return initial(command, args);
  });
  const { rerender } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "scripts" }));
  await user.click(screen.getByRole("button", { name: "scripts/read.py" }));
  expect(await screen.findByText("print('只读')")).toBeTruthy();
  finishOldRead?.({ path: "SKILL.md", kind: "text", text: "# 迟到的入口", size: 12, message: null });
  await user.click(screen.getByRole("button", { name: "技能信息" }));
  expect(screen.queryByRole("heading", { name: "迟到的入口" })).toBeNull();
  expect(screen.getByText("print('只读')")).toBeTruthy();
  rerender(<SkillDetailPanel skill={null} onClose={vi.fn()} />);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("close_skill_browser", { skillId: "demo", sessionId: "session-demo" });
});

it("来源和差异仍可按需访问，关闭按钮保留原有回调", async () => {
  const user = userEvent.setup();
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "get_source_skill_document") return Promise.resolve({ skill_id: "demo", filename: "SKILL.md", content: "# 来源入口", revision: "abc1234", source_label: "来源" });
    if (command === "get_skill_source_diff") return Promise.resolve({ skill_id: "demo", entries: [], revision: "abc1234", source_label: "来源" });
    return initial(command, args);
  });
  const onClose = vi.fn();
  const { unmount } = render(<SkillDetailPanel skill={skill} onClose={onClose} />);
  await screen.findByRole("heading", { name: "阅读入口" });
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByRole("heading", { name: "来源入口" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "差异" }));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_skill_source_diff", { skillId: "demo" });
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
});


it("详情关闭后才完成的索引会话也会被释放", async () => {
  let finishOpen: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation(command => {
    if (command === "open_skill_browser") return new Promise(resolve => { finishOpen = resolve; });
    return Promise.resolve();
  });
  const { unmount } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  unmount();
  await act(async () => { finishOpen?.(index); });
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("close_skill_browser", { skillId: "demo", sessionId: "session-demo" }));
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "read_skill_browser_file")).toBe(false);
});


it("重复选择当前文件保持已读正文", async () => {
  const user = userEvent.setup();
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByRole("heading", { name: "阅读入口" });
  await user.click(screen.getByRole("button", { name: "SKILL.md" }));
  expect(screen.getByRole("heading", { name: "阅读入口" })).toBeTruthy();
});


it("搜索完整相对路径区分同名文件，清除后展开选中文件的父目录", async () => {
  const user = userEvent.setup();
  const paths = ["资料/中文长名称的工作流程与边界说明/指南.md", "参考/指南.md"];
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "open_skill_browser") return Promise.resolve({ ...index, entries: [...index.entries,
      ...["资料", "资料/中文长名称的工作流程与边界说明", "参考"].map(path => ({ path, kind: "directory", size: 0, error: null })),
      ...paths.map(path => ({ path, kind: "file", size: 14, error: null })),
    ], file_count: 4, directory_count: 5 });
    if (command === "read_skill_browser_file" && paths.includes((args as { relativePath: string }).relativePath)) {
      const path = (args as { relativePath: string }).relativePath;
      return Promise.resolve({ path, kind: "text", size: 14, text: `# ${path === paths[0] ? "中文目录指南" : "参考目录指南"}`, message: null });
    }
    return initial(command, args);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  const search = await screen.findByRole("searchbox", { name: "查找文件" });
  await user.type(search, "指南.md");
  expect(screen.getByText("找到 2 个文件")).toBeTruthy();
  expect(screen.getByRole("button", { name: paths[1] })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: paths[0] }));
  expect(await screen.findByRole("heading", { name: "中文目录指南" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "本地文件只读预览" })).getByText(paths[0])).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(screen.getByRole("button", { name: "资料" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: paths[0] }).getAttribute("aria-current")).toBe("true");
  await user.type(search, "不存在的文件");
  expect(screen.getByText("没有匹配的文件")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "中文目录指南" })).toBeTruthy();
  await user.clear(search);
  await user.type(search, "参考/指南");
  expect(screen.getByText("找到 1 个文件")).toBeTruthy();
  expect(screen.queryByRole("button", { name: paths[0] })).toBeNull();
});


it("Markdown 正文和原文切换保留 frontmatter、标记与当前路径", async () => {
  const user = userEvent.setup();
  const content = "---\nname: 原始元数据\n---\n# 正文标题\n\n**原始标记**\n";
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === "read_skill_browser_file"
    ? Promise.resolve({ path: "SKILL.md", kind: "text", size: 90, text: content, message: null }) : initial(command, args));
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "正文标题" })).toBeTruthy();
  expect(screen.queryByText("name: 原始元数据")).toBeNull();
  await user.click(screen.getByRole("button", { name: "原文" }));
  expect(screen.getByLabelText("文件原文").textContent).toBe(content);
  expect(screen.getByRole("button", { name: "SKILL.md" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: "原文" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "正文" }));
  expect(screen.getByRole("heading", { name: "正文标题" })).toBeTruthy();
});


it("Markdown 相对链接从当前文档目录导航并展开父目录，保留精确路径", async () => {
  const user = userEvent.setup();
  const files: Record<string, string> = {
    "SKILL.md": "# 链接入口\n[阅读说明](docs/说明.md)",
    "docs/说明.md": "# 当前目录说明\n[继续阅读](../资料/中文%20指南.md#用法)",
    "资料/中文 指南.md": "# 中文关联文档",
  };
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "open_skill_browser") return Promise.resolve({ ...index, entries: [
      ...["docs", "资料"].map(path => ({ path, kind: "directory", size: 0, error: null })),
      ...Object.keys(files).map(path => ({ path, kind: "file", size: 100, error: null })),
    ], file_count: 3, directory_count: 2 });
    if (command === "read_skill_browser_file") {
      const path = (args as { relativePath: string }).relativePath;
      return Promise.resolve({ path, kind: "text", size: 100, text: files[path], message: null });
    }
    return initial(command, args);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("link", { name: "阅读说明" }));
  expect(await screen.findByRole("heading", { name: "当前目录说明" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "docs" }).getAttribute("aria-expanded")).toBe("true");
  await user.click(screen.getByRole("link", { name: "继续阅读" }));
  expect(await screen.findByRole("heading", { name: "中文关联文档" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "资料/中文 指南.md" }).getAttribute("aria-current")).toBe("true");
  expect(within(screen.getByRole("region", { name: "本地文件只读预览" })).getByText("资料/中文 指南.md")).toBeTruthy();
});


it("缺失、越界和符号链接目标明确报错且不读取其他文件，外链交给既有安全打开器", async () => {
  const user = userEvent.setup();
  const content = "# 安全阅读入口\n[缺失文件](docs/missing.md)\n[根外文件](../outside.md)\n[编码越界](%2e%2e/outside.md)\n[绝对文件](/etc/passwd)\n[本地协议](file:///etc/passwd)\n[链接目标](shared/outside.md)\n[外部资料](https://example.com/docs)";
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "open_skill_browser") return Promise.resolve({ ...index, entries: [...index.entries,
      { path: "missing.md", kind: "file", size: 9, error: null },
      { path: "shared", kind: "symlink", size: 0, error: null, link_target: "/outside" },
    ] });
    if (command === "read_skill_browser_file") return Promise.resolve({ path: "SKILL.md", kind: "text", text: content, size: 300, message: null });
    return initial(command, args);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("link", { name: "缺失文件" }));
  expect(screen.getByRole("alert").textContent).toContain("此版本中没有该文件：docs/missing.md");
  for (const label of ["根外文件", "编码越界", "绝对文件", "本地协议"]) {
    await user.click(screen.getByRole("link", { name: label }));
    expect(screen.getByRole("alert").textContent).toContain("链接必须指向当前 Skill 目录内的文件");
  }
  await user.click(screen.getByRole("link", { name: "链接目标" }));
  expect(screen.getByRole("alert").textContent).toContain("此版本中没有该文件：shared/outside.md");
  expect(screen.getByRole("heading", { name: "安全阅读入口" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_skill_browser_file")).toHaveLength(1);
  await user.click(screen.getByRole("link", { name: "外部资料" }));
  expect(vi.mocked(openUrl)).toHaveBeenCalledWith("https://example.com/docs");
});


it("搜索结果可用键盘阅读，切换 Skill 重置搜索并忽略迟到的正文", async () => {
  const user = userEvent.setup();
  let finishOldRead: ((value: unknown) => void) | undefined;
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "open_skill_browser" && (args as { skillId: string }).skillId === "second") return Promise.resolve({ ...index, skill_id: "second", session_id: "session-second" });
    if (command === "read_skill_browser_file" && (args as { relativePath: string }).relativePath === "scripts/read.py") return new Promise(resolve => { finishOldRead = resolve; });
    if (command === "read_skill_browser_file" && (args as { skillId: string }).skillId === "second") return Promise.resolve({ path: "SKILL.md", kind: "text", text: "# 另一个技能的入口", size: 20, message: null });
    return initial(command, args);
  });
  const { rerender } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  const search = await screen.findByRole("searchbox", { name: "查找文件" });
  await user.type(search, "scripts/read");
  screen.getByRole("button", { name: "scripts/read.py" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "scripts/read.py" }).getAttribute("aria-current")).toBe("true");
  rerender(<SkillDetailPanel skill={{ ...skill, id: "second", name: "另一个技能" }} onClose={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "另一个技能的入口" })).toBeTruthy();
  expect((screen.getByRole("searchbox", { name: "查找文件" }) as HTMLInputElement).value).toBe("");
  await act(async () => { finishOldRead?.({ path: "scripts/read.py", kind: "text", text: "旧技能的迟到代码", size: 20, message: null }); });
  expect(screen.queryByText("旧技能的迟到代码")).toBeNull();
  expect(screen.getByRole("heading", { name: "另一个技能的入口" })).toBeTruthy();
});

it("预览上限内的大量短行仍保留全部原文", async () => {
  const user = userEvent.setup();
  const content = "\n".repeat(256 * 1024);
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === "read_skill_browser_file" && (args as { relativePath: string }).relativePath === "scripts/read.py"
    ? Promise.resolve({ path: "scripts/read.py", kind: "text", text: content, size: 256 * 1024, message: null }) : initial(command, args));
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.type(await screen.findByRole("searchbox", { name: "查找文件" }), "read.py");
  await user.click(screen.getByRole("button", { name: "scripts/read.py" }));
  expect((await screen.findByLabelText("文件原文")).textContent).toBe(content);
});
