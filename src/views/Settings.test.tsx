// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import { Settings } from "./Settings";
import type { ToolInfo } from "../lib/tauri";

const appTools = vi.hoisted(() => ({ current: [] as ToolInfo[] }));

const settingsStore = vi.hoisted(() => new Map<string, string>());
const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
  setSettings: vi.fn(async (key: string, value: string) => {
    settingsStore.set(key, value);
  }),
  checkLastPanic: vi.fn().mockResolvedValue(null),
  getCentralRepoWarnings: vi.fn().mockResolvedValue([]),
  getCentralRepoPath: vi.fn().mockResolvedValue("/tmp/skills"),
  getCentralRepoPathOverride: vi.fn().mockResolvedValue(null),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  setAllToolsEnabled: vi.fn().mockResolvedValue(undefined),
  setCustomToolPath: vi.fn().mockResolvedValue(undefined),
  resetCustomToolPath: vi.fn().mockResolvedValue(undefined),
  setCustomToolProjectPath: vi.fn().mockResolvedValue(undefined),
  resetCustomToolProjectPath: vi.fn().mockResolvedValue(undefined),
  addCustomTool: vi.fn().mockResolvedValue(undefined),
  removeCustomTool: vi.fn().mockResolvedValue(undefined),
  setToolOrder: vi.fn().mockResolvedValue(undefined),
  openCentralRepoFolder: vi.fn().mockResolvedValue(undefined),
  setCentralRepoPath: vi.fn().mockResolvedValue("/tmp/skills"),
  gitBackupSanitizeRemoteUrl: vi.fn(async (value: string) => value),
  gitBackupRemoveRemote: vi.fn().mockResolvedValue(undefined),
  updateInstallBlocker: vi.fn().mockResolvedValue(null),
  getRecentLogExcerpt: vi.fn().mockResolvedValue(null),
  getDiagnosticInfo: vi.fn().mockResolvedValue(null),
  exportLogsZip: vi.fn().mockResolvedValue(null),
  clearLastPanic: vi.fn().mockResolvedValue(undefined),
  restartApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/tauri", () => apiMocks);

vi.mock("../lib/agentPlugins", () => ({
  getCodexCliConfiguration: vi.fn().mockResolvedValue({
    resolution_source: "environment",
    configured_path: null,
    facts: {
      configuration_directory: "confirmed",
      executable_resolution: "confirmed",
      command_runtime: "unchecked",
      plugin_json_contract: "unchecked",
    },
  }),
  validateCodexCliPath: vi.fn(),
  setCodexCliPath: vi.fn(),
  resetCodexCliPath: vi.fn(),
}));

vi.mock("../context/AppContext", () => ({
  useApp: () => ({
    tools: appTools.current,
    managedSkills: [],
    refreshTools: vi.fn().mockResolvedValue(undefined),
    refreshManagedSkills: vi.fn().mockResolvedValue(undefined),
    openSkillDetailById: vi.fn(),
    openHelp: vi.fn(),
    appUpdate: null,
    refreshAppUpdate: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useThemeContext: () => ({
    theme: "dark",
    setTheme: vi.fn(),
    resolvedTheme: "dark",
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  confirm: vi.fn().mockResolvedValue(false),
}));

function renderSettings(entry = "/settings") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Settings />
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18nReady;
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  settingsStore.clear();
  appTools.current = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Settings 前台批量操作并发设置", () => {
  it("缺失值采用检查 8、更新 4，并在重新打开页面后保留合法选择", async () => {
    const user = userEvent.setup();
    const firstRender = renderSettings("/settings?tab=about");

    const checkGroup = await screen.findByRole("group", { name: "检查全部并发数" });
    const updateGroup = screen.getByRole("group", { name: "全部更新并发数" });
    expect(
      within(checkGroup).getByRole("button", { name: "8" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(updateGroup).getByRole("button", { name: "4" }).getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(within(checkGroup).getByRole("button", { name: "1" }));
    await user.click(within(updateGroup).getByRole("button", { name: "8" }));

    await waitFor(() => {
      expect(apiMocks.setSettings).toHaveBeenCalledWith(
        "foreground_batch_check_concurrency",
        "1",
      );
      expect(apiMocks.setSettings).toHaveBeenCalledWith(
        "foreground_batch_update_concurrency",
        "8",
      );
    });

    firstRender.unmount();
    renderSettings("/settings?tab=about");

    const reopenedCheckGroup = await screen.findByRole("group", {
      name: "检查全部并发数",
    });
    const reopenedUpdateGroup = screen.getByRole("group", {
      name: "全部更新并发数",
    });
    await waitFor(() => {
      expect(
        within(reopenedCheckGroup).getByRole("button", { name: "1" }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        within(reopenedUpdateGroup).getByRole("button", { name: "8" }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });

  it("非法持久化值分别回退为检查 8、更新 4，且只提供 1、4、8", async () => {
    settingsStore.set("foreground_batch_check_concurrency", "32");
    settingsStore.set("foreground_batch_update_concurrency", "invalid");
    renderSettings("/settings?tab=about");

    const checkGroup = await screen.findByRole("group", { name: "检查全部并发数" });
    const updateGroup = screen.getByRole("group", { name: "全部更新并发数" });

    await waitFor(() => {
      expect(
        within(checkGroup).getByRole("button", { name: "8" }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        within(updateGroup).getByRole("button", { name: "4" }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(
      within(checkGroup).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["1", "4", "8"]);
    expect(
      within(updateGroup).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["1", "4", "8"]);
  });

  it("三种界面语言都明确说明设置只作用于前台批量操作", async () => {
    const cases = [
      {
        language: "zh",
        checkLabel: "检查全部并发数",
        updateLabel: "全部更新并发数",
        checkDescription: "只控制前台“检查全部”；批次启动后，本次并发数保持不变。",
        updateDescription:
          "只控制前台“全部更新”；后台自动更新、多选刷新和单项操作不受影响。",
      },
      {
        language: "zh-TW",
        checkLabel: "檢查全部並行數",
        updateLabel: "全部更新並行數",
        checkDescription: "只控制前台「檢查全部」；批次啟動後，本次並行數保持不變。",
        updateDescription:
          "只控制前台「全部更新」；背景自動更新、多選重新整理和單項操作不受影響。",
      },
      {
        language: "en",
        checkLabel: "Check All concurrency",
        updateLabel: "Update All concurrency",
        checkDescription:
          "Controls the foreground Check All action only. A running batch keeps the concurrency captured at startup.",
        updateDescription:
          "Controls the foreground Update All action only. Background auto-update, multi-select refresh, and single-item actions are unchanged.",
      },
    ];

    for (const testCase of cases) {
      await i18n.changeLanguage(testCase.language);
      const view = renderSettings("/settings?tab=about");
      expect(await screen.findByRole("group", { name: testCase.checkLabel })).toBeTruthy();
      expect(screen.getByRole("group", { name: testCase.updateLabel })).toBeTruthy();
      expect(screen.getByText(testCase.checkDescription)).toBeTruthy();
      expect(screen.getByText(testCase.updateDescription)).toBeTruthy();
      view.unmount();
    }
    await i18n.changeLanguage("zh");
  });
});

describe("Settings Agent Skills 管理配置", () => {
  it("首次引导已关闭时仍显示 Agent Skills 管理配置", async () => {
    settingsStore.set("agent_control_setup_prompt", "dismissed");

    renderSettings("/settings?tab=agents&agentView=management");

    expect(
      await screen.findByRole("heading", { name: "Agent 管理 Skills" }),
    ).toBeTruthy();
  });

  it("始终提供独立的 Codex CLI 路径恢复设置", async () => {
    renderSettings("/settings?tab=connections");

    expect(await screen.findByRole("heading", { name: "Codex CLI 路径" })).toBeTruthy();
  });
});


describe("设置页分类导航", () => {
  it("通过四个分类访问现有设置，更新和关于位于同一页", async () => {
    const user = userEvent.setup();
    renderSettings();
    const tabs = screen.getByRole("tablist", { name: "设置分类" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "通用", "Agent", "连接与同步", "更新与关于",
    ]);
    expect(screen.getByRole("tab", { name: "通用" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "Codex CLI 路径" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "连接与同步" }));
    expect(await screen.findByRole("heading", { name: "Codex CLI 路径" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "更新与关于" }));
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "检查全部并发数" })).toBeTruthy();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });
});


it("分类支持方向键和首尾键，切换后保留未保存路径", async () => {
  const user = userEvent.setup();
  renderSettings("/settings?tab=connections");
  const input = await screen.findByRole("textbox", { name: "Codex CLI 可执行文件" });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  await user.type(input, "/tmp/unsaved-codex");
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("tab", { name: "连接与同步" }).getAttribute("aria-selected")).toBe("true");
  const tab = screen.getByRole("tab", { name: "连接与同步" });
  tab.focus();
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "更新与关于" }));
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "通用" }));
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "更新与关于" }));
  await user.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "通用" }).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("tab", { name: "连接与同步" }));
  expect((screen.getByRole("textbox", { name: "Codex CLI 可执行文件" }) as HTMLInputElement).value).toBe("/tmp/unsaved-codex");
});


it("兼容更新分类与 CLI 深链接，并把焦点放到可见 CLI 区域", async () => {
  const oldUpdates = renderSettings("/settings?tab=updates");
  expect(screen.getByRole("tab", { name: "更新与关于" }).getAttribute("aria-selected")).toBe("true");
  oldUpdates.unmount();
  for (const entry of ["/settings?section=codex-cli", "/settings#codex-cli-settings", "/settings?tab=general&section=codex-cli"]) {
    const view = renderSettings(entry);
    expect(screen.getByRole("tab", { name: "连接与同步" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Codex CLI 路径" }));
    await userEvent.click(screen.getByRole("tab", { name: "通用" }));
    expect(screen.getByRole("tab", { name: "通用" }).getAttribute("aria-selected")).toBe("true");
    view.unmount();
  }
});


it("Agent 同步开关立即提交，目录展开后沿用原编辑保存", async () => {
  const user = userEvent.setup();
  appTools.current = [{ key: "codex", display_name: "Codex", installed: true, enabled: true,
    skills_dir: "/agents/codex/skills", is_custom: false, has_path_override: false,
    project_relative_skills_dir: ".codex/skills", has_project_path_override: false, category: "coding" }];
  renderSettings("/settings?tab=agents");
  expect(screen.getByRole("tab", { name: "同步技能到 Agent" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("heading", { name: "Agent 管理 Skills" })).toBeNull();
  await user.click(screen.getByRole("switch", { name: "禁用此 Agent" }));
  expect(apiMocks.setToolEnabled).toHaveBeenCalledWith("codex", false);
  await user.click(screen.getByLabelText("Codex 的目录设置"));
  expect(screen.getByText("/agents/codex/skills")).toBeTruthy();
  await user.click(screen.getAllByRole("button", { name: "编辑路径" })[0]);
  const input = screen.getByRole("textbox", { name: "Codex 的全局技能目录" });
  await user.clear(input);
  await user.type(input, "/tmp/new-skills");
  expect(apiMocks.setCustomToolPath).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(apiMocks.setCustomToolPath).toHaveBeenCalledWith("codex", "/tmp/new-skills");
});


it("管理选择跨用途与主分类切换保留，放弃后不提交任何部署", async () => {
  const user = userEvent.setup();
  appTools.current = [{ key: "codex", display_name: "Codex", installed: true, enabled: true,
    skills_dir: "/agents/codex/skills", is_custom: false, has_path_override: false,
    project_relative_skills_dir: ".codex/skills", has_project_path_override: false, category: "coding" }];
  renderSettings("/settings?tab=agents&agentView=management");
  await user.click(screen.getByRole("checkbox", { name: "开启 Codex 的管理能力" }));
  expect(screen.getByText("待启用 · 应用后生效")).toBeTruthy();
  const purpose = screen.getByRole("tab", { name: "Agent 管理 Skills" });
  purpose.focus();
  await user.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "同步技能到 Agent" }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{End}");
  await user.click(screen.getByRole("tab", { name: "通用" }));
  await user.click(screen.getByRole("tab", { name: "Agent" }));
  expect((screen.getByRole("checkbox", { name: "关闭 Codex 的管理能力" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("待启用 · 应用后生效")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "放弃更改" }));
  expect((screen.getByRole("button", { name: "应用更改" }) as HTMLButtonElement).disabled).toBe(true);
  expect(apiMocks.setSettings).not.toHaveBeenCalled();
});
