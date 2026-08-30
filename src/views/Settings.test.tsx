// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import { Settings } from "./Settings";

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

vi.mock("../context/AppContext", () => ({
  useApp: () => ({
    tools: [],
    refreshTools: vi.fn().mockResolvedValue(undefined),
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

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18nReady;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  settingsStore.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Settings 前台批量操作并发设置", () => {
  it("缺失值采用检查 8、更新 4，并在重新打开页面后保留合法选择", async () => {
    const user = userEvent.setup();
    const firstRender = renderSettings();

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
    renderSettings();

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
    renderSettings();

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
      const view = renderSettings();
      expect(await screen.findByRole("group", { name: testCase.checkLabel })).toBeTruthy();
      expect(screen.getByRole("group", { name: testCase.updateLabel })).toBeTruthy();
      expect(screen.getByText(testCase.checkDescription)).toBeTruthy();
      expect(screen.getByText(testCase.updateDescription)).toBeTruthy();
      view.unmount();
    }
    await i18n.changeLanguage("zh");
  });
});
