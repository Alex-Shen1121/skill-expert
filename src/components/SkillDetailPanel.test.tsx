// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SkillDetailPanel } from "./SkillDetailPanel";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill, SkillBrowserComparison, SkillBrowserDiff, SkillBrowserEntry } from "../lib/tauri";
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

// 状态语义来自 commands/skills.rs 的真实完整并集、权限失败和类型变化测试。
const comparedFile = (path: string, status: SkillBrowserComparison["status"], kind: SkillBrowserEntry["kind"] = "file", sourceKind = kind): SkillBrowserComparison => {
  const entry = (entryKind: SkillBrowserEntry["kind"]): SkillBrowserEntry => ({ path, kind: entryKind, size: 20, error: null, link_target: null });
  return { path, status, local: status === "added" ? null : entry(kind), source: status === "removed" ? null : entry(sourceKind),
    local_presence: status === "added" ? "missing" : "present", source_presence: status === "removed" ? "missing" : "present",
    content_changed: status === "unchanged" ? false : status === "added" || status === "removed" || status === "modified" ? true : null,
    exec_bits_before: status === "added" || kind === "directory" ? null : 0, exec_bits_after: status === "removed" || sourceKind === "directory" ? null : 0, reason_code: null, reason: null };
};

function mockComparison(diff: SkillBrowserDiff) {
  const sideIndex = (side: "local" | "source") => {
    const entries = diff.entries.flatMap(entry => entry[side] ? [entry[side]] : []);
    return { ...diff.index, entries, file_count: entries.filter(entry => entry.kind !== "directory").length, directory_count: entries.filter(entry => entry.kind === "directory").length };
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return sideIndex("local");
    if (command === "prepare_skill_browser_source") return { index: sideIndex("source"), revision: diff.revision, source_label: diff.source_label, location: "临时测试来源" };
    if (command === "get_skill_browser_diff") return diff;
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: "local" | "source" };
      const entry = diff.entries.find(entry => entry.path === path)?.[side];
      if (!entry) throw { kind: "not_found", message: "此版本中没有该文件" };
      return { path, kind: entry.kind === "directory" ? "directory" : "text", size: 20, text: `${side}：${path} 完整正文`, message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
}

it("只看变化默认关闭，开启保留三种变化文件与展开的祖先，隐藏当前文件不影响全文阅读", async () => {
  const user = userEvent.setup();
  const entries = [
    comparedFile("SKILL.md", "unchanged"), comparedFile(".git", null, "directory"), comparedFile(".git/cache", "not_compared"),
    comparedFile("docs", null, "directory"), comparedFile("docs/deep", null, "directory"), comparedFile("docs/deep/new.txt", "added"),
    comparedFile("local.txt", "removed"), comparedFile(".hidden", "modified"), comparedFile("denied.txt", "uncomparable"),
    comparedFile("file-to-dir", "modified", "file", "directory"), comparedFile("file-to-dir/nested.txt", "added"),
  ];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local ?? entry.source!), file_count: 8, directory_count: 3 }, entries, changed_file_count: 5, revision: "workspace", source_label: "local" });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByText("local：SKILL.md 完整正文");
  expect(screen.queryByRole("button", { name: "只看变化文件" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  const filter = within(tree).getByRole("button", { name: "只看变化文件" });
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(within(filter).getByText("5")).toBeTruthy();
  await within(screen.getByRole("region", { name: "来源版本" })).findByText("source：SKILL.md 完整正文");
  const callsBeforeFilter = vi.mocked(invoke).mock.calls.length;
  await user.click(filter);
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  expect(within(tree).getByText("已筛选")).toBeTruthy();
  for (const path of ["docs", "docs/deep", "file-to-dir"]) expect(within(tree).getByRole("button", { name: path }).getAttribute("aria-expanded")).toBe("true");
  for (const path of ["docs/deep/new.txt", "local.txt", ".hidden", "file-to-dir/nested.txt"]) expect(within(tree).getByRole("button", { name: path })).toBeTruthy();
  for (const path of ["SKILL.md", ".git", ".git/cache", "denied.txt"]) expect(within(tree).queryByRole("button", { name: path })).toBeNull();
  expect(within(tree).getByText("5 个文件 · 2 个目录")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "当前安装" })).getByText("local：SKILL.md 完整正文")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "来源版本" })).getByText("source：SKILL.md 完整正文")).toBeTruthy();
  await user.keyboard(" ");
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(within(tree).getByRole("button", { name: "SKILL.md" }).getAttribute("aria-current")).toBe("true");
  expect(within(tree).getByText("8 个文件 · 3 个目录")).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls).toHaveLength(callsBeforeFilter);
});

it("不比较的符号链接与目录混合祖先仅保留结构，筛选计数和搜索只包含真实变化文件", async () => {
  const user = userEvent.setup();
  const parent = { ...comparedFile("container", "not_compared", "symlink", "directory"), reason_code: "unsupported_type" as const };
  const entries = [comparedFile("SKILL.md", "unchanged"), parent, comparedFile("container/new.txt", "added")];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local ?? entry.source!), file_count: 3, directory_count: 0 }, entries, changed_file_count: 1, revision: "workspace", source_label: "local" });
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "read_skill_browser_file" && (args as { relativePath: string; side: string }).relativePath === "container" && (args as { side: string }).side === "local") {
      return Promise.resolve({ path: "container", kind: "symlink", size: 20, text: null, message: null });
    }
    return initial(command, args);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  await user.click(within(tree).getByRole("button", { name: "container" }));
  await within(screen.getByRole("region", { name: "当前安装" })).findByText("符号链接，仅展示信息，不读取目标");
  await within(screen.getByRole("region", { name: "来源版本" })).findByText("目录，请选择文件");
  const callsBeforeFilter = vi.mocked(invoke).mock.calls.length;
  await user.click(within(tree).getByRole("button", { name: "只看变化文件" }));
  expect(within(tree).getByText("1 个文件 · 1 个目录")).toBeTruthy();
  const container = within(tree).getByRole("button", { name: "container" });
  expect(container.getAttribute("aria-expanded")).toBe("true");
  expect(within(container).queryByText("不比较")).toBeNull();
  expect(within(container).queryByText("链接")).toBeNull();
  expect(within(tree).getByRole("button", { name: "container/new.txt" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "当前安装" })).getByText("符号链接，仅展示信息，不读取目标")).toBeTruthy();
  await user.click(container);
  expect(container.getAttribute("aria-expanded")).toBe("false");
  await user.click(container);
  expect(container.getAttribute("aria-expanded")).toBe("true");
  await user.type(within(tree).getByRole("searchbox", { name: "查找文件" }), "container");
  expect(within(tree).getByText("找到 1 个文件")).toBeTruthy();
  expect(within(tree).queryByRole("button", { name: "container" })).toBeNull();
  expect(within(tree).getByRole("button", { name: "container/new.txt" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls).toHaveLength(callsBeforeFilter);
  await user.click(within(tree).getByRole("button", { name: "container/new.txt" }));
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText("source：container/new.txt 完整正文")).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "只看变化文件" }));
  expect(within(tree).getByText("找到 2 个文件")).toBeTruthy();
  expect(within(tree).getByText("3 个文件 · 0 个目录")).toBeTruthy();
  const restored = within(tree).getByRole("button", { name: "container" });
  expect(within(restored).getByText("不比较")).toBeTruthy();
  expect(within(restored).getByText("链接")).toBeTruthy();
  expect(within(tree).getByRole("button", { name: "container/new.txt" }).getAttribute("aria-current")).toBe("true");
});

it("完整且可判定的零变化显示恢复全部入口，恢复后仍可阅读未变化与不比较文件", async () => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged"), comparedFile("generated.pyc", "not_compared"), comparedFile("empty", null, "directory")];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local!), file_count: 2, directory_count: 1 }, entries, changed_file_count: 0, revision: "workspace", source_label: "local" });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "只看变化文件" }));
  const tree = screen.getByRole("navigation", { name: "差异变化文件目录" });
  expect(within(tree).getByText("没有变化文件")).toBeTruthy();
  expect(within(tree).getByText("0 个文件 · 0 个目录")).toBeTruthy();
  expect(within(tree).queryByText("空目录")).toBeNull();
  await user.type(within(tree).getByRole("searchbox", { name: "查找文件" }), "generated");
  await user.click(within(tree).getByRole("button", { name: "恢复全部文件" }));
  expect(screen.getByRole("button", { name: "只看变化文件" }).getAttribute("aria-pressed")).toBe("false");
  expect((within(tree).getByRole("searchbox", { name: "查找文件" }) as HTMLInputElement).value).toBe("generated");
  expect(within(tree).getByRole("button", { name: "generated.pyc" })).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "清除搜索" }));
  expect(within(tree).getByRole("button", { name: "SKILL.md" })).toBeTruthy();
});

it.each([true, false])("目录完整性为 %s 时，无法比较文件不伪装为零变化，筛选中仍可重载或恢复全部", async complete => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged"), { ...comparedFile("denied.txt", "uncomparable"), reason: "Permission denied (os error 13)" }];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local!), file_count: 2, directory_count: 0, complete, issues: complete ? [] : ["restricted：Permission denied"] }, entries, changed_file_count: 0, revision: "workspace", source_label: "local" });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "只看变化文件" }));
  const tree = screen.getByRole("navigation", { name: "差异变化文件目录" });
  expect(within(tree).queryByText("没有变化文件")).toBeNull();
  expect(within(tree).getByText("暂未发现已确认的变化文件")).toBeTruthy();
  expect(within(tree).getByText("部分文件无法比较，变化结果可能不完整")).toBeTruthy();
  if (!complete) {
    expect(within(tree).getByText("目录未完整读取")).toBeTruthy();
    expect(within(tree).getByText("已读取 0 个文件 · 0 个目录")).toBeTruthy();
  }
  await user.type(within(tree).getByRole("searchbox", { name: "查找文件" }), "不存在");
  expect(within(tree).queryByText("没有匹配的文件")).toBeNull();
  expect(within(tree).queryByText("没有变化文件")).toBeNull();
  await user.click(within(tree).getByRole("button", { name: "重新加载目录" }));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "open_skill_browser")).toHaveLength(2));
});

it("搜索与变化集合取交集，清除搜索保留筛选，关闭筛选保留搜索且目录不计入匹配", async () => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged"), comparedFile("docs", null, "directory"), comparedFile("docs/same.txt", "unchanged"), comparedFile("docs/new.txt", "added"),
    comparedFile("file-to-dir", "modified", "file", "directory"), comparedFile("file-to-dir/nested.txt", "added")];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local ?? entry.source!), file_count: 5, directory_count: 1 }, entries, changed_file_count: 3, revision: "workspace", source_label: "local" });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "只看变化文件" }));
  const tree = screen.getByRole("navigation", { name: "差异变化文件目录" });
  const search = within(tree).getByRole("searchbox", { name: "查找文件" });
  await within(screen.getByRole("region", { name: "来源版本" })).findByText("source：SKILL.md 完整正文");
  const callsBeforeSearch = vi.mocked(invoke).mock.calls.length;
  await user.type(search, "docs");
  expect(within(tree).getByText("找到 1 个文件")).toBeTruthy();
  expect(within(tree).getByRole("button", { name: "docs/new.txt" })).toBeTruthy();
  expect(within(tree).queryByRole("button", { name: "docs" })).toBeNull();
  expect(within(tree).queryByRole("button", { name: "docs/same.txt" })).toBeNull();
  await user.click(within(tree).getByRole("button", { name: "只看变化文件" }));
  expect((search as HTMLInputElement).value).toBe("docs");
  expect(within(tree).getByText("找到 2 个文件")).toBeTruthy();
  expect(within(tree).getByRole("button", { name: "docs/same.txt" })).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "只看变化文件" }));
  await user.click(within(tree).getByRole("button", { name: "清除搜索" }));
  expect(within(tree).getByRole("button", { name: "只看变化文件" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(tree).getByRole("button", { name: "docs" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(tree).getByText("3 个文件 · 1 个目录")).toBeTruthy();
  await user.type(search, "file-to-dir");
  expect(within(tree).getByText("找到 2 个文件")).toBeTruthy();
  expect(within(tree).getByRole("button", { name: "file-to-dir" })).toBeTruthy();
  expect(within(tree).getByRole("button", { name: "file-to-dir/nested.txt" })).toBeTruthy();
  await user.clear(search);
  await user.type(search, "不存在");
  expect(within(tree).getByText("没有匹配的文件")).toBeTruthy();
  expect(within(tree).queryByText("没有变化文件")).toBeNull();
  await user.click(within(tree).getByRole("button", { name: "清除搜索" }));
  expect(within(tree).getByRole("button", { name: "docs/new.txt" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls).toHaveLength(callsBeforeSearch);
  expect(within(screen.getByRole("region", { name: "当前安装" })).getByText("local：SKILL.md 完整正文")).toBeTruthy();
});

it("同一 Skill 返回差异保留筛选，本地与来源范围完整，切换 Skill 重置搜索筛选和选择", async () => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged"), comparedFile(".hidden", "modified")];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local!), file_count: 2, directory_count: 0 }, entries, changed_file_count: 1, revision: "workspace", source_label: "local" });
  const initial = vi.mocked(invoke).getMockImplementation()!;
  const nextEntry = comparedFile("SKILL.md", "unchanged");
  const nextIndex = { ...index, skill_id: "second", session_id: "second-session", entries: [nextEntry.local!], file_count: 1, directory_count: 0 };
  vi.mocked(invoke).mockImplementation((command, args) => {
    if ((args as { skillId: string }).skillId !== "second") return initial(command, args);
    if (command === "open_skill_browser") return Promise.resolve(nextIndex);
    if (command === "prepare_skill_browser_source") return Promise.resolve({ index: nextIndex, revision: "workspace", source_label: "local", location: "第二份来源" });
    if (command === "get_skill_browser_diff") return Promise.resolve({ index: nextIndex, entries: [nextEntry], changed_file_count: 0, revision: "workspace", source_label: "local" });
    if (command === "read_skill_browser_file") return Promise.resolve({ path: "SKILL.md", kind: "text", text: "第二个技能的入口正文", size: 20, message: null });
    if (command === "close_skill_browser") return Promise.resolve();
    throw new Error(`不应调用 ${command}`);
  });
  const { rerender } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "只看变化文件" }));
  await user.click(screen.getByRole("button", { name: ".hidden" }));
  for (const [tab, label] of [["本地文件", "本地完整文件目录"], ["来源", "来源完整文件目录"]]) {
    await user.click(screen.getByRole("button", { name: tab }));
    const tree = await screen.findByRole("navigation", { name: label });
    expect(within(tree).queryByRole("button", { name: "只看变化文件" })).toBeNull();
    expect(within(tree).getByRole("button", { name: "SKILL.md" })).toBeTruthy();
    expect(within(tree).getByRole("button", { name: ".hidden" }).getAttribute("aria-current")).toBe("true");
    expect(within(tree).getByText("2 个文件 · 0 个目录")).toBeTruthy();
  }
  await user.click(screen.getByRole("button", { name: "差异" }));
  expect(screen.getByRole("button", { name: "只看变化文件" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "SKILL.md" })).toBeNull();
  await user.type(screen.getByRole("searchbox", { name: "查找文件" }), ".hidden");
  rerender(<SkillDetailPanel skill={{ ...skill, id: "second", name: "第二个技能" }} onClose={vi.fn()} />);
  expect(await screen.findByText("第二个技能的入口正文")).toBeTruthy();
  expect((screen.getByRole("searchbox", { name: "查找文件" }) as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "SKILL.md" }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("button", { name: ".hidden" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "差异" }));
  expect((await screen.findByRole("button", { name: "只看变化文件" })).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("0 个变化文件")).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === "prepare_skill_browser_source" && (args as { skillId: string }).skillId === "demo")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === "get_skill_browser_diff" && (args as { skillId: string }).skillId === "demo")).toHaveLength(1);
});

it("目录尚未完整读取但没有失败文件条目时，也不能把空筛选称为没有变化", async () => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged"), comparedFile("restricted", null, "directory")];
  mockComparison({ index: { ...index, entries: entries.map(entry => entry.local!), file_count: 1, directory_count: 1, complete: false, issues: ["restricted：Permission denied"] }, entries, changed_file_count: 0, revision: "workspace", source_label: "local" });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "只看变化文件" }));
  const tree = screen.getByRole("navigation", { name: "差异变化文件目录" });
  expect(within(tree).getByText("暂未发现已确认的变化文件")).toBeTruthy();
  expect(within(tree).queryByText("没有变化文件")).toBeNull();
  expect(within(tree).getByText("目录未完整读取")).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "恢复全部文件" }));
  await user.type(within(tree).getByRole("searchbox", { name: "查找文件" }), "未知文件");
  expect(within(tree).getByText("已读取的结果中没有匹配文件")).toBeTruthy();
  expect(within(tree).getByText("restricted：Permission denied")).toBeTruthy();
});

it("比较请求失败保留真实原因和重试入口，本地文件仍可阅读", async () => {
  const user = userEvent.setup();
  const entries = [comparedFile("SKILL.md", "unchanged")];
  mockComparison({ index: { ...index, entries: [entries[0].local!], file_count: 1, directory_count: 0 }, entries, changed_file_count: 0, revision: "workspace", source_label: "local" });
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === "get_skill_browser_diff" ? Promise.reject({ kind: "io", message: "比较失败：Permission denied" }) : initial(command, args));
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  expect(await screen.findByText("比较失败：Permission denied")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新准备来源" })).toBeTruthy();
  expect(screen.queryByText("没有变化文件")).toBeNull();
  await user.click(screen.getByRole("button", { name: "本地文件" }));
  expect(await screen.findByText("local：SKILL.md 完整正文")).toBeTruthy();
});
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

it("来源完整树与差异共用一次来源准备，保留相对路径并说明缺失版本", async () => {
  const user = userEvent.setup();
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "prepare_skill_browser_source") return Promise.resolve({ index: { ...index, entries: [...index.entries, { path: "source-only.md", kind: "file", size: 20, error: null }], file_count: 3 }, revision: "abc1234", source_label: "git", location: "https://example.com/skills.git · demo" });
    if (command === "get_skill_browser_diff") return Promise.resolve({ index: { ...index, entries: [...index.entries, { path: "source-only.md", kind: "file", size: 20, error: null }], file_count: 3 }, entries: [{ path: "source-only.md", status: "added", local: null, source: { path: "source-only.md", kind: "file", size: 20, error: null }, local_presence: "missing", source_presence: "present", exec_bits_before: null, exec_bits_after: 0, content_changed: true, reason: null }], changed_file_count: 1, revision: "abc1234", source_label: "git" });
    if (command === "read_skill_browser_file" && (args as { side: string }).side === "local" && (args as { relativePath: string }).relativePath === "source-only.md") return Promise.reject({ kind: "not_found", message: "此版本中没有该文件" });
    if (command === "read_skill_browser_file" && (args as { side: string }).side === "source") {
      const path = (args as { relativePath: string }).relativePath;
      return Promise.resolve({ path, kind: "text", size: 20, text: path === "source-only.md" ? "# 来源独有资料" : "# 来源入口", message: null });
    }
    return initial(command, args);
  });
  const onClose = vi.fn();
  render(<SkillDetailPanel skill={skill} onClose={onClose} />);
  await screen.findByRole("heading", { name: "阅读入口" });
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByRole("navigation", { name: "来源完整文件目录" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "来源入口" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "source-only.md" }));
  expect(await screen.findByRole("heading", { name: "来源独有资料" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "本地文件" }));
  expect(await screen.findByText("此版本中没有该文件")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "阅读入口" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "差异" }));
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText("此版本中没有该文件")).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText("# 来源独有资料")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByRole("heading", { name: "来源独有资料" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "prepare_skill_browser_source")).toHaveLength(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_skill_browser_diff", { skillId: "demo", sessionId: "session-demo" });
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledOnce();
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

it("来源准备失败后本地仍可阅读，重试只使用新会话且迟到来源不覆盖新技能", async () => {
  const user = userEvent.setup();
  const initial = vi.mocked(invoke).getMockImplementation()!;
  let attempts = 0;
  let finishOldSource: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "prepare_skill_browser_source") {
      attempts += 1;
      if (attempts === 1) return Promise.reject({ kind: "network", message: "测试来源暂时不可达" });
      return new Promise(resolve => { finishOldSource = resolve; });
    }
    if (command === "open_skill_browser" && (args as { skillId: string }).skillId === "second") return Promise.resolve({ ...index, skill_id: "second", session_id: "second-session" });
    if (command === "read_skill_browser_file" && (args as { skillId: string }).skillId === "second") return Promise.resolve({ path: "SKILL.md", kind: "text", text: "# 第二个技能", size: 20, message: null });
    return initial(command, args);
  });
  const { rerender } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByRole("heading", { name: "阅读入口" });
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByText("测试来源暂时不可达")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "本地文件" }));
  expect(await screen.findByRole("heading", { name: "阅读入口" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源" }));
  await user.click(screen.getByRole("button", { name: "重新准备来源" }));
  await waitFor(() => expect(attempts).toBe(2));
  rerender(<SkillDetailPanel skill={{ ...skill, id: "second", name: "第二个技能" }} onClose={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "第二个技能" })).toBeTruthy();
  await act(async () => { finishOldSource?.({ index, revision: "old-revision", location: "迟到的来源位置", source_label: "git" }); });
  expect(screen.queryByText("迟到的来源位置")).toBeNull();
  expect(screen.getByRole("heading", { name: "第二个技能" })).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("close_skill_browser", { skillId: "demo", sessionId: "session-demo" });
});

it("跨版本缺失路径仍由后端核验快照，变化后的来源不能伪装为缺失", async () => {
  const user = userEvent.setup();
  const initial = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "prepare_skill_browser_source") return Promise.resolve({ index: { ...index, entries: index.entries.filter(entry => entry.path !== "scripts/read.py") }, revision: "workspace", source_label: "local", location: "/original/skill" });
    if (command === "read_skill_browser_file" && (args as { side: string }).side === "source") return Promise.reject({ kind: "stale_snapshot", message: "来源文件已变化，请重新加载" });
    return initial(command, args);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "scripts" }));
  await user.click(screen.getByRole("button", { name: "scripts/read.py" }));
  await screen.findByText("print('只读')");
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByText("来源文件已变化，请重新加载")).toBeTruthy();
  expect(screen.queryByText("此版本中没有该文件")).toBeNull();
});

it("差异以完整并集导航，默认双栏阅读未变化文件并明确新增和删除的缺失侧", async () => {
  const user = userEvent.setup();
  const localFiles: Record<string, string> = { "SKILL.md": "# 一致的完整入口\n尾部正文", "local.txt": "当前安装独有全文" };
  const sourceFiles: Record<string, string> = { "SKILL.md": localFiles["SKILL.md"], "source.txt": "来源独有全文" };
  const file = (path: string) => ({ path, kind: "file", size: 40, error: null, link_target: null });
  const entries = ["SKILL.md", "local.txt", "source.txt"].map(path => ({
    path, local: path in localFiles ? file(path) : null, source: path in sourceFiles ? file(path) : null,
    local_presence: path in localFiles ? "present" : "missing", source_presence: path in sourceFiles ? "present" : "missing",
    status: path === "SKILL.md" ? "unchanged" : path === "local.txt" ? "removed" : "added",
    content_changed: path !== "SKILL.md", exec_bits_before: 0, exec_bits_after: 0, reason: null,
  }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return { ...index, entries: Object.keys(localFiles).map(file), file_count: 2, directory_count: 0 };
    if (command === "prepare_skill_browser_source") return { index: { ...index, entries: Object.keys(sourceFiles).map(file), directory_count: 0 }, revision: "abc123", source_label: "git", location: "来源快照" };
    if (command === "get_skill_browser_diff") return { index: { ...index, entries: entries.map(entry => file(entry.path)), file_count: 3, directory_count: 0 }, entries, changed_file_count: 2, revision: "abc123", source_label: "git" };
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: string };
      const files = side === "source" ? sourceFiles : localFiles;
      if (!(path in files)) throw { kind: "not_found", message: "此版本中没有该文件" };
      return { path, kind: "text", size: 40, text: files[path], message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByRole("heading", { name: "一致的完整入口" });
  await user.click(screen.getByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  expect(within(tree).getByText("未变化")).toBeTruthy();
  expect(within(tree).getByText("3 个文件 · 0 个目录")).toBeTruthy();
  expect(within(tree).getByText("2 个变化文件")).toBeTruthy();
  expect((await within(screen.getByRole("region", { name: "当前安装" })).findByLabelText("文件原文")).textContent).toBe(localFiles["SKILL.md"]);
  expect((await within(screen.getByRole("region", { name: "来源版本" })).findByLabelText("文件原文")).textContent).toBe(sourceFiles["SKILL.md"]);
  await user.click(within(tree).getByRole("button", { name: "source.txt" }));
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText("此版本中没有该文件")).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText("来源独有全文")).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "local.txt" }));
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText("当前安装独有全文")).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText("此版本中没有该文件")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源" }));
  expect(await screen.findByText("此版本中没有该文件")).toBeTruthy();
});

it("仅差异按所选文件展示片段、完整执行位和各自不可比较原因，并可恢复全文", async () => {
  const user = userEvent.setup();
  const file = (path: string) => ({ path, kind: "file", size: 30, error: null, link_target: null });
  const statuses = { "SKILL.md": "modified", "chmod.sh": "modified", ".gitignore": "not_compared", "denied.txt": "uncomparable", "same.txt": "unchanged", "failed-preview.txt": "unchanged" };
  const entries = Object.entries(statuses).map(([path, status]) => ({ path, local: file(path), source: file(path), local_presence: "present", source_presence: "present", status,
    content_changed: path === "SKILL.md", exec_bits_before: path === "chmod.sh" ? 64 : 0, exec_bits_after: path === "chmod.sh" ? 8 : 0,
    reason: path === ".gitignore" ? "此条目不参与 Skill 有效内容比较" : path === "denied.txt" ? "当前安装：权限不足" : null }));
  const all = { ...index, entries: Object.keys(statuses).map(file), file_count: 6, directory_count: 0 };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return all;
    if (command === "prepare_skill_browser_source") return { index: all, revision: "workspace", source_label: "local", location: "来源目录" };
    if (command === "get_skill_browser_diff") return { index: all, entries, changed_file_count: 2, revision: "workspace", source_label: "local" };
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: string };
      if (path === "failed-preview.txt" && side === "source") throw { kind: "io", message: "来源预览读取失败" };
      if (path === "denied.txt" && side === "local") throw { kind: "io", message: "当前安装：权限不足" };
      return { path, kind: "text", size: 30, text: path === "SKILL.md" ? `${side === "local" ? "旧入口行" : "新入口行"}\n保留的尾部` : "相同正文", message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByText("旧入口行 保留的尾部");
  await user.click(screen.getByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "仅差异" }));
  expect(await screen.findByText("新入口行")).toBeTruthy();
  expect(screen.getByText("旧入口行")).toBeTruthy();
  expect(screen.getByText(/@@ -1,/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "完整内容" }));
  expect(within(screen.getByRole("region", { name: "来源版本" })).getByLabelText("文件原文").textContent).toBe("新入口行\n保留的尾部");
  await user.click(screen.getByRole("button", { name: "仅差异" }));
  await user.click(screen.getByRole("button", { name: "chmod.sh" }));
  expect(await screen.findByText("执行位 0100 → 0010")).toBeTruthy();
  expect(screen.getByText("仅执行权限变化，文件内容相同")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: ".gitignore" }));
  expect(await screen.findByText("此条目不参与 Skill 有效内容比较")).toBeTruthy();
  expect(screen.getByText("此文件不参与比较，仍可查看完整内容")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "denied.txt" }));
  expect(await screen.findByText("无法比较此文件，请查看原因或重新加载")).toBeTruthy();
  expect(screen.getByText("当前安装：权限不足")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "same.txt" }));
  expect(await screen.findByText("文件内容和执行权限均未变化")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "failed-preview.txt" }));
  expect((await within(screen.getByRole("region", { name: "差异只读预览" })).findByRole("alert")).textContent).toContain("来源预览读取失败");
});

it.each([
  { scene: "双侧行数乘积", before: "短行\n".repeat(1500) + "左侧完整尾部", after: "短行\n".repeat(1500) + "右侧完整尾部" },
  { scene: "单侧大量短行", before: "\n".repeat(25000) + "左侧完整尾部", after: "右侧完整尾部" },
])("$scene 超过片段计算上限时明确说明，完整两侧文本仍可恢复", async ({ before, after }) => {
  const user = userEvent.setup();
  const file = { path: "SKILL.md", kind: "file", size: 18030, error: null, link_target: null };
  const all = { ...index, entries: [file], file_count: 1, directory_count: 0 };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return all;
    if (command === "prepare_skill_browser_source") return { index: all, revision: "workspace", source_label: "local", location: "来源目录" };
    if (command === "get_skill_browser_diff") return { index: all, entries: [{ path: "SKILL.md", local: file, source: file, local_presence: "present", source_presence: "present", status: "modified", content_changed: true, exec_bits_before: 0, exec_bits_after: 0, reason: null }], changed_file_count: 1, revision: "workspace", source_label: "local" };
    if (command === "read_skill_browser_file") return { ...file, kind: "text", text: (args as { side: string }).side === "source" ? after : before, message: null };
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "SKILL.md" });
  await user.click(screen.getByRole("button", { name: "差异" }));
  await user.click(await screen.findByRole("button", { name: "仅差异" }));
  expect(await screen.findByText("文本行数超过片段计算上限，请查看完整内容")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "完整内容" }));
  expect(within(screen.getByRole("region", { name: "当前安装" })).getByLabelText("文件原文").textContent).toBe(before);
  expect(within(screen.getByRole("region", { name: "来源版本" })).getByLabelText("文件原文").textContent).toBe(after);
});

it("类型变化保留文件和目录两侧信息，混合路径仍可展开子文件并保留非文本原因", async () => {
  const user = userEvent.setup();
  const file = (path: string, kind = "file") => ({ path, kind, size: 300000, error: null, link_target: null });
  const entries = [
    { path: "changed", local: file("changed"), source: file("changed", "directory"), status: "modified", local_presence: "present", source_presence: "present", reason: "文件类型变化" },
    { path: "changed/large.bin", local: null, source: file("changed/large.bin"), status: "added", local_presence: "missing", source_presence: "present", reason: null },
  ].map(entry => ({ ...entry, exec_bits_before: 0, exec_bits_after: 0, content_changed: true }));
  const all = { ...index, entry_path: "changed", entries: entries.map(entry => file(entry.path)), file_count: 2, directory_count: 0 };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return { ...all, entries: [file("changed")] };
    if (command === "prepare_skill_browser_source") return { index: { ...all, entries: [file("changed", "directory"), file("changed/large.bin")] }, revision: "workspace", source_label: "local", location: "来源目录" };
    if (command === "get_skill_browser_diff") return { index: all, entries, changed_file_count: 2, revision: "workspace", source_label: "local" };
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: string };
      if (path === "changed/large.bin" && side === "local") throw { kind: "not_found", message: "此版本中没有该文件" };
      return { path, kind: side === "local" ? "binary" : path === "changed" ? "directory" : "too_large", size: 300000, text: null, message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  await user.click(within(tree).getByRole("button", { name: "changed" }));
  expect(within(tree).getByRole("button", { name: "changed" }).getAttribute("aria-expanded")).toBe("true");
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText(i18n.t("skillBrowser.previewKind.binary"))).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText(i18n.t("skillBrowser.previewKind.directory"))).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "changed/large.bin" }));
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText(i18n.t("skillBrowser.previewKind.too_large"))).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText("此版本中没有该文件")).toBeTruthy();
});

it("差异两侧读取绑定当前路径，存在性未知保留读取原因，失效快照要求重试", async () => {
  const user = userEvent.setup();
  let finishOldSource: ((value: unknown) => void) | undefined;
  let sourceChanged = false;
  const file = (path: string) => ({ path, kind: "file", size: 30, error: null, link_target: null });
  const paths = ["SKILL.md", "next.txt", "unknown.txt"];
  const all = { ...index, entries: paths.map(file), file_count: 3, directory_count: 0 };
  const entries = paths.map(path => ({ path, local: path === "unknown.txt" ? null : file(path), source: file(path), status: path === "unknown.txt" ? "uncomparable" : "modified", local_presence: path === "unknown.txt" ? "unknown" : "present", source_presence: "present", reason: path === "unknown.txt" ? "目录未完整读取，无法确定文件是否存在" : null, content_changed: true, exec_bits_before: 0, exec_bits_after: 0 }));
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "open_skill_browser") return Promise.resolve({ ...all, complete: false, entries: paths.slice(0, 2).map(file), file_count: 2, issues: ["目录未完整读取"] });
    if (command === "prepare_skill_browser_source") return Promise.resolve({ index: all, revision: "workspace", source_label: "local", location: "来源目录" });
    if (command === "get_skill_browser_diff") return Promise.resolve({ index: { ...all, complete: false, issues: ["目录未完整读取"] }, entries, changed_file_count: 2, revision: "workspace", source_label: "local" });
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: string };
      if (path === "SKILL.md" && side === "source") return new Promise(resolve => { finishOldSource = resolve; });
      if (path === "unknown.txt" && side === "local") return Promise.reject({ kind: "io", message: "目录未完整读取，无法确定文件是否存在" });
      if (path === "next.txt" && side === "source" && sourceChanged) return Promise.reject({ kind: "stale_snapshot", message: "来源快照已变化，请重新加载" });
      return Promise.resolve({ path, kind: "text", size: 30, text: side === "source" ? "当前路径的来源全文" : "当前路径的安装全文", message: null });
    }
    if (command === "close_skill_browser") return Promise.resolve();
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await screen.findByText("当前路径的安装全文");
  await user.click(screen.getByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  await user.click(within(tree).getByRole("button", { name: "next.txt" }));
  expect(await within(screen.getByRole("region", { name: "来源版本" })).findByText("当前路径的来源全文")).toBeTruthy();
  await act(async () => { finishOldSource?.({ path: "SKILL.md", kind: "text", size: 20, text: "旧路径的迟到来源", message: null }); });
  expect(screen.queryByText("旧路径的迟到来源")).toBeNull();
  await user.click(within(tree).getByRole("button", { name: "unknown.txt" }));
  expect(await within(screen.getByRole("region", { name: "当前安装" })).findByText("目录未完整读取，无法确定文件是否存在")).toBeTruthy();
  expect(screen.queryByText("此版本中没有该文件")).toBeNull();
  sourceChanged = true;
  await user.click(within(tree).getByRole("button", { name: "next.txt" }));
  expect(await screen.findByText("来源快照已变化，请重新加载")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新准备来源" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "本地文件" }));
  expect(await screen.findByText("当前路径的安装全文")).toBeTruthy();
});

it("英文详情翻译受控差异原因与未知存在性提示，并保留真实 I/O 诊断", async () => {
  await i18n.changeLanguage("en");
  const user = userEvent.setup();
  const file = (path: string, kind = "file") => ({ path, kind, size: 20, error: null, link_target: null });
  const entries = [
    { path: ".gitignore", local: file(".gitignore"), source: file(".gitignore"), status: "not_compared", reason_code: "excluded" },
    { path: "link", local: file("link", "symlink"), source: file("link", "symlink"), status: "not_compared", reason_code: "unsupported_type" },
    { path: "changed", local: file("changed"), source: file("changed", "directory"), status: "modified", reason_code: "type_changed" },
    { path: "unknown", local: null, source: file("unknown"), status: "uncomparable", reason_code: "unknown_presence" },
    { path: "io.txt", local: file("io.txt"), source: file("io.txt"), status: "uncomparable", reason_code: null },
  ].map(entry => ({ ...entry, local_presence: entry.local ? "present" : "unknown", source_presence: "present", content_changed: null, exec_bits_before: null, exec_bits_after: null, reason: entry.path === "io.txt" ? "EACCES: fixture diagnostic" : null }));
  const all = { ...index, entry_path: ".gitignore", entries: entries.map(entry => entry.local ?? entry.source), file_count: 5, directory_count: 0 };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_skill_browser") return { ...all, entries: entries.flatMap(entry => entry.local ? [entry.local] : []), complete: false, issues: ["EACCES: fixture diagnostic"] };
    if (command === "prepare_skill_browser_source") return { index: all, revision: "workspace", source_label: "local", location: "fixture" };
    if (command === "get_skill_browser_diff") return { index: all, entries, changed_file_count: 1, revision: "workspace", source_label: "local" };
    if (command === "read_skill_browser_file") {
      const { relativePath: path, side } = args as { relativePath: string; side: string };
      if (path === "unknown" && side === "local") throw { kind: "unknown_presence", message: "目录未完整读取，无法确定此版本中是否存在该文件" };
      return { path, kind: "text", size: 20, text: "fixture", message: null };
    }
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  const { unmount } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  try {
    await user.click(await screen.findByRole("button", { name: i18n.t("mySkills.docTabs.diff") }));
    await screen.findByRole("navigation", { name: "Complete comparison file tree" });
    expect(await screen.findByText("This entry is excluded from Skill effective content comparison")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "link" }));
    expect(await screen.findByText("Symbolic links and special files show information only; their targets are not read or compared")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "changed" }));
    expect(await screen.findByText("File type changed; inspect the entry information for both versions")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "unknown" }));
    expect(await within(screen.getByRole("region", { name: "Current installation" })).findByText("The directory listing is incomplete; this entry's presence cannot be determined")).toBeTruthy();
    expect(screen.queryByText("目录未完整读取，无法确定此版本中是否存在该文件")).toBeNull();
    await user.click(screen.getByRole("button", { name: "io.txt" }));
    expect(screen.getByText("EACCES: fixture diagnostic")).toBeTruthy();
  } finally {
    unmount();
    await i18n.changeLanguage("zh");
  }
});

it("差异树保留来源目录的枚举错误，只有两侧已确认的空目录才提示空目录", async () => {
  const user = userEvent.setup();
  const directory = (path: string, error: string | null = null) => ({ path, kind: "directory", size: 0, error, link_target: null });
  const sourceError = "Permission denied (os error 13)";
  const localEntries = [directory("restricted"), directory("empty")];
  const sourceEntries = [directory("restricted", sourceError), directory("empty")];
  const all = { ...index, entry_path: null, entries: localEntries, file_count: 0, directory_count: 2 };
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "open_skill_browser") return all;
    if (command === "prepare_skill_browser_source") return { index: { ...all, entries: sourceEntries, complete: false, issues: [sourceError] }, revision: "workspace", source_label: "local", location: "来源目录" };
    if (command === "get_skill_browser_diff") return { index: { ...all, entries: sourceEntries, complete: false, issues: [sourceError] }, entries: localEntries.map((local, i) => ({ path: local.path, local, source: sourceEntries[i], local_presence: "present", source_presence: "present", status: null, reason_code: null, reason: null, content_changed: null, exec_bits_before: null, exec_bits_after: null })), changed_file_count: 0, revision: "workspace", source_label: "local" };
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "差异" }));
  const tree = await screen.findByRole("navigation", { name: "差异完整文件目录" });
  await user.click(within(tree).getByRole("button", { name: "restricted" }));
  expect(within(tree).queryByText("空目录")).toBeNull();
  expect(within(tree).getAllByText(sourceError)).toHaveLength(2);
  expect(within(tree).getByText("目录未完整读取")).toBeTruthy();
  await user.click(within(tree).getByRole("button", { name: "empty" }));
  expect(within(tree).getByText("空目录")).toBeTruthy();
});

it.each(["local", "source"] as const)("%s 祖先目录读取失败时，差异子目录使用翻译后的未知提示而非空目录", async blockedSide => {
  await i18n.changeLanguage("en");
  const user = userEvent.setup();
  const directory = (path: string, error: string | null = null) => ({ path, kind: "directory", size: 0, error, link_target: null });
  const diagnostic = "Permission denied (os error 13)";
  const completeEntries = [directory("restricted"), directory("restricted/empty"), directory("empty")];
  const incompleteEntries = [directory("restricted", diagnostic), directory("empty")];
  const complete = { ...index, entry_path: null, entries: completeEntries, file_count: 0, directory_count: 3 };
  const incomplete = { ...complete, entries: incompleteEntries, directory_count: 2, complete: false, issues: [diagnostic] };
  const localIndex = blockedSide === "local" ? incomplete : complete;
  const sourceIndex = blockedSide === "source" ? incomplete : complete;
  const entries = completeEntries.map(entry => {
    const local = localIndex.entries.find(candidate => candidate.path === entry.path) ?? null;
    const source = sourceIndex.entries.find(candidate => candidate.path === entry.path) ?? null;
    return { path: entry.path, local, source, local_presence: local ? "present" : "unknown", source_presence: source ? "present" : "unknown", status: null, reason_code: !local || !source ? "unknown_presence" : null, reason: null, content_changed: null, exec_bits_before: null, exec_bits_after: null };
  });
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "open_skill_browser") return localIndex;
    if (command === "prepare_skill_browser_source") return { index: sourceIndex, revision: "workspace", source_label: "local", location: "来源目录" };
    if (command === "get_skill_browser_diff") return { index: { ...incomplete, entries: [directory("restricted", diagnostic), ...completeEntries.slice(1)], directory_count: 3 }, entries, changed_file_count: 0, revision: "workspace", source_label: "local" };
    if (command === "close_skill_browser") return;
    throw new Error(`不应调用 ${command}`);
  });
  const { unmount } = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
  try {
    await user.click(await screen.findByRole("button", { name: i18n.t("mySkills.docTabs.diff") }));
    const tree = await screen.findByRole("navigation", { name: "Complete comparison file tree" });
    await user.click(within(tree).getByRole("button", { name: "restricted" }));
    await user.click(within(tree).getByRole("button", { name: "restricted/empty" }));
    expect(within(tree).queryByText(i18n.t("skillBrowser.emptyDirectory"))).toBeNull();
    expect(within(tree).getByText("The directory listing is incomplete; this entry's presence cannot be determined")).toBeTruthy();
    expect(within(tree).getAllByText(diagnostic)).toHaveLength(2);
    await user.click(within(tree).getByRole("button", { name: "empty" }));
    expect(within(tree).getByText(i18n.t("skillBrowser.emptyDirectory"))).toBeTruthy();
    expect(within(tree).getByText(i18n.t("skillBrowser.changedFiles", { count: 0 }))).toBeTruthy();
  } finally {
    unmount();
    await i18n.changeLanguage("zh");
  }
});
