// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { AgentPluginProjection } from "../lib/agentPlugins";
import { Plugins } from "./Plugins";

const apiMocks = vi.hoisted(() => ({
  getAgentPluginProjection: vi.fn(),
}));

vi.mock("../lib/agentPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agentPlugins")>()),
  getAgentPluginProjection: apiMocks.getAgentPluginProjection,
}));

const projection: AgentPluginProjection = {
  read_status: "ready",
  agent: "codex",
  refreshed_at_unix_ms: 1_788_537_600_000,
  installed: [
    {
      identity: {
        agent: "codex",
        marketplace_name: "market-one",
        plugin_id: "same-name@first",
      },
      display_name: "同名插件",
      version: "1.2.3",
      install_status: "installed_enabled",
      update_available: false,
      install_policy: "AVAILABLE",
      auth_policy: "ON_INSTALL",
    },
    {
      identity: {
        agent: "codex",
        marketplace_name: "market-two",
        plugin_id: "same-name@second",
      },
      display_name: "同名插件",
      version: "2.0.0",
      install_status: "installed_disabled",
      update_available: null,
      install_policy: null,
      auth_policy: "ON_USE",
    },
  ],
  available: [
    {
      identity: {
        agent: "codex",
        marketplace_name: "market-three",
        plugin_id: "available-only",
      },
      display_name: "可安装插件",
      version: "3.0.0",
      install_status: "available",
      update_available: null,
      install_policy: "AVAILABLE",
      auth_policy: null,
    },
  ],
};

beforeAll(async () => {
  await i18nReady;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  apiMocks.getAgentPluginProjection.mockResolvedValue(projection);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Plugins 可信基础快照", () => {
  it("默认逐身份呈现已安装插件，并让右侧详情跟随键盘选择", async () => {
    const user = userEvent.setup();
    render(<Plugins />);

    expect(await screen.findByRole("heading", { name: "Codex 插件检查器" })).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.getAgentPluginProjection).toHaveBeenCalledTimes(1);
      expect(apiMocks.getAgentPluginProjection).toHaveBeenCalledWith("codex");
    });
    const list = screen.getByRole("listbox", { name: "已安装插件" });
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "同名插件 · market-one · same-name@first",
      "同名插件 · market-two · same-name@second",
    ]);
    expect(screen.queryByText("可安装插件")).toBeNull();
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("complementary", { name: "插件详情" })).getByText("same-name@first")).toBeTruthy();

    options[1].focus();
    await user.keyboard("{Enter}");

    expect(options[1].getAttribute("aria-selected")).toBe("true");
    const details = screen.getByRole("complementary", { name: "插件详情" });
    expect(within(details).getByText("same-name@second")).toBeTruthy();
    expect(within(details).getAllByText("已安装但停用")).toHaveLength(2);
  });

  it("逐类显示结构化错误，且不把失败呈现为空插件快照", async () => {
    const cases = [
      ["cli_unavailable", "插件 CLI 不可用"],
      ["command_unsupported", "当前 Codex CLI 不支持插件目录命令"],
      ["timed_out", "读取插件状态超时"],
      ["command_failed", "Codex CLI 返回失败"],
      ["invalid_json", "Codex CLI 返回了无法解析的数据"],
      ["contract_incompatible", "数据契约与当前版本不兼容"],
    ] as const;

    for (const [kind, message] of cases) {
      apiMocks.getAgentPluginProjection.mockResolvedValueOnce({
        read_status: "error",
        agent: "codex",
        refreshed_at_unix_ms: 1_788_537_600_000,
        error: { kind },
      } satisfies AgentPluginProjection);
      const view = render(<Plugins />);

      expect(await screen.findByText((text) => text.includes(message))).toBeTruthy();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.queryByText("没有已安装插件")).toBeNull();
      view.unmount();
    }
  });

  it("成功的空快照与错误状态保持可区分", async () => {
    apiMocks.getAgentPluginProjection.mockResolvedValueOnce({
      ...projection,
      installed: [],
      available: [],
    });

    render(<Plugins />);

    expect(await screen.findByText("没有已安装插件")).toBeTruthy();
    expect(screen.getByText("Codex CLI 已成功返回当前空快照。")).toBeTruthy();
    expect(screen.queryByText("无法读取插件状态")).toBeNull();
  });

  it("基础页面文案在简体中文、繁体中文和英文中均完整", async () => {
    const cases = [
      ["zh", "Codex 插件检查器", "只读状态", "已安装插件"],
      ["zh-TW", "Codex 外掛檢查器", "唯讀狀態", "已安裝外掛"],
      ["en", "Codex Plugin Inspector", "Read-only status", "Installed plugins"],
    ] as const;

    for (const [language, title, readOnly, listLabel] of cases) {
      await i18n.changeLanguage(language);
      const view = render(<Plugins />);

      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
      expect(screen.getByText(readOnly)).toBeTruthy();
      expect(screen.getByRole("listbox", { name: listLabel })).toBeTruthy();
      view.unmount();
    }
  });
});
