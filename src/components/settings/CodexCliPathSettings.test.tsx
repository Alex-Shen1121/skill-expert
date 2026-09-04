// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import type { CodexCliConfiguration } from "../../lib/agentPlugins";
import { CodexCliPathSettings } from "./CodexCliPathSettings";

const apiMocks = vi.hoisted(() => ({
  getCodexCliConfiguration: vi.fn(),
  validateCodexCliPath: vi.fn(),
  setCodexCliPath: vi.fn(),
  resetCodexCliPath: vi.fn(),
  getAgentPluginProjection: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("../../lib/agentPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agentPlugins")>()),
  ...apiMocks,
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

const environmentConfiguration: CodexCliConfiguration = {
  resolution_source: "environment",
  configured_path: null,
  facts: {
    configuration_directory: "confirmed",
    executable_resolution: "confirmed",
    command_runtime: "unchecked",
    plugin_json_contract: "unchecked",
  },
};

const validatedConfiguration: CodexCliConfiguration = {
  resolution_source: "explicit",
  configured_path: "/Applications/Codex CLI/bin/codex",
  facts: {
    configuration_directory: "confirmed",
    executable_resolution: "confirmed",
    command_runtime: "confirmed",
    plugin_json_contract: "confirmed",
  },
};

beforeAll(async () => {
  await i18nReady;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  window.history.replaceState({}, "", "/");
  apiMocks.getCodexCliConfiguration.mockResolvedValue(environmentConfiguration);
  apiMocks.validateCodexCliPath.mockResolvedValue(validatedConfiguration);
  apiMocks.setCodexCliPath.mockResolvedValue(validatedConfiguration);
  apiMocks.resetCodexCliPath.mockResolvedValue(environmentConfiguration);
  dialogMocks.open.mockResolvedValue("/Applications/Codex CLI/bin/codex");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Codex CLI 路径设置", () => {
  it("选择文件后不运行插件命令，并支持验证、后端保存和重置", async () => {
    const user = userEvent.setup();
    render(<CodexCliPathSettings />);

    expect(await screen.findByRole("heading", { name: "Codex CLI 路径" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "选择可执行文件" }));

    const input = screen.getByRole("textbox", { name: "Codex CLI 可执行文件" });
    expect((input as HTMLInputElement).value).toBe("/Applications/Codex CLI/bin/codex");
    expect(dialogMocks.open).toHaveBeenCalledWith({ directory: false, multiple: false });
    expect(apiMocks.validateCodexCliPath).not.toHaveBeenCalled();
    expect(apiMocks.setCodexCliPath).not.toHaveBeenCalled();
    expect(apiMocks.getAgentPluginProjection).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "验证路径" }));
    await waitFor(() => {
      expect(apiMocks.validateCodexCliPath).toHaveBeenCalledWith(
        "/Applications/Codex CLI/bin/codex",
      );
    });
    expect(screen.getByText("已验证：命令可运行并支持插件 JSON 契约。")).toBeTruthy();
    expect(apiMocks.setCodexCliPath).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保存路径" }));
    await waitFor(() => {
      expect(apiMocks.setCodexCliPath).toHaveBeenCalledWith(
        "/Applications/Codex CLI/bin/codex",
      );
    });
    expect(screen.getByText("已保存明确路径。")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "恢复环境解析" }));
    await waitFor(() => {
      expect(apiMocks.resetCodexCliPath).toHaveBeenCalledTimes(1);
    });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("当前从桌面进程环境解析 Codex CLI。")).toBeTruthy();
    expect(apiMocks.getAgentPluginProjection).not.toHaveBeenCalled();
  });

  it("保存验证失败时显示分层事实，并始终保留恢复入口", async () => {
    const user = userEvent.setup();
    apiMocks.setCodexCliPath.mockResolvedValueOnce({
      resolution_source: "explicit",
      configured_path: "/missing/codex",
      facts: {
        configuration_directory: "confirmed",
        executable_resolution: "unavailable",
        command_runtime: "unavailable",
        plugin_json_contract: "unchecked",
      },
      error: "configured_path_invalid",
    } satisfies CodexCliConfiguration);
    render(<CodexCliPathSettings />);

    const input = await screen.findByRole("textbox", { name: "Codex CLI 可执行文件" });
    await user.clear(input);
    await user.type(input, "/missing/codex");
    await user.click(screen.getByRole("button", { name: "保存路径" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "所选路径不存在或不是普通文件，最后可用配置未被覆盖。",
    );
    expect(screen.getByText("可执行文件解析").parentElement?.textContent).toContain("不可用");
    expect(screen.getByText("插件 JSON 契约").parentElement?.textContent).toContain("未检查");
    expect(screen.getByRole("button", { name: "恢复环境解析" })).toBeTruthy();
  });

  it("编辑已验证但未保存的新候选时仍准确显示当前保存来源", async () => {
    const user = userEvent.setup();
    render(<CodexCliPathSettings />);
    const input = await screen.findByRole("textbox", { name: "Codex CLI 可执行文件" });
    await user.type(input, "/Applications/Codex CLI/bin/codex");
    await user.click(screen.getByRole("button", { name: "验证路径" }));
    expect(await screen.findByText("已验证：命令可运行并支持插件 JSON 契约。")).toBeTruthy();

    await user.type(input, "-candidate");

    expect(screen.getByText("当前从桌面进程环境解析 Codex CLI。")).toBeTruthy();
    expect(screen.queryByText("当前使用明确指定的 Codex CLI 路径。")).toBeNull();
  });

  it("简体中文、繁体中文和英文均提供完整的路径恢复文案", async () => {
    const cases = [
      ["zh", "Codex CLI 路径", "选择可执行文件", "恢复环境解析", "所选路径不存在或不是普通文件，最后可用配置未被覆盖。"],
      ["zh-TW", "Codex CLI 路徑", "選擇可執行檔", "恢復環境解析", "所選路徑不存在或不是一般檔案，最後可用設定未被覆蓋。"],
      ["en", "Codex CLI path", "Choose executable", "Use environment resolution", "The selected path is missing or is not a regular file. The last working configuration was not replaced."],
    ] as const;

    for (const [language, title, select, reset, error] of cases) {
      await i18n.changeLanguage(language);
      apiMocks.getCodexCliConfiguration.mockResolvedValueOnce({
        ...environmentConfiguration,
        error: "configured_path_invalid",
      } satisfies CodexCliConfiguration);
      const view = render(<CodexCliPathSettings />);
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
      expect(screen.getByRole("button", { name: select })).toBeTruthy();
      expect(screen.getByRole("button", { name: reset })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toBe(error);
      view.unmount();
    }
  });

  it("从插件错误入口跳转时聚焦并滚动到路径设置", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    window.history.replaceState(
      {},
      "",
      "/settings?section=codex-cli#codex-cli-settings",
    );

    render(<CodexCliPathSettings />);
    const heading = await screen.findByRole("heading", { name: "Codex CLI 路径" });
    const section = heading.closest("section");

    await waitFor(() => {
      expect(document.activeElement).toBe(section);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });
  });
});
