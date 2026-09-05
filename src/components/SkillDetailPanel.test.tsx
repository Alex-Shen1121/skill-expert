// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SkillDetailPanel } from "./SkillDetailPanel";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill } from "../lib/tauri";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
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
