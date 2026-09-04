// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { AgentPluginProjection } from "../lib/agentPlugins";
import type { AgentPluginViewItem } from "../lib/agentPluginView";
import { Plugins } from "./Plugins";

type ReadyProjection = Extract<AgentPluginProjection, { read_status: "ready" }>;
type ReadyProjectionWithViewItems = Omit<
  ReadyProjection,
  "installed" | "available"
> & {
  installed: AgentPluginViewItem[];
  available: AgentPluginViewItem[];
};

const apiMocks = vi.hoisted(() => ({
  getAgentPluginProjection: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

vi.mock("../lib/agentPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agentPlugins")>()),
  getAgentPluginProjection: apiMocks.getAgentPluginProjection,
}));

const projection: ReadyProjectionWithViewItems = {
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
      description: "检查页面可访问性",
      developer: "星际工作室",
    } satisfies AgentPluginViewItem,
    {
      identity: {
        agent: "codex",
        marketplace_name: "market-four",
        plugin_id: "other-available",
      },
      display_name: "发布助手",
      version: "4.0.0",
      install_status: "available",
      update_available: null,
      install_policy: "AVAILABLE",
      auth_policy: null,
      description: "整理版本说明",
      developer: "社区作者",
    } satisfies AgentPluginViewItem,
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

    expect(await screen.findAllByText("没有已安装插件")).toHaveLength(2);
    expect(screen.getAllByText("Codex CLI 已成功返回当前空快照。")).toHaveLength(2);
    expect(screen.queryByText("无法读取插件状态")).toBeNull();
  });

  it("基础页面文案在简体中文、繁体中文和英文中均完整", async () => {
    const cases = [
      ["zh", "Codex 插件检查器", "只读状态", "已安装插件", "刷新", "搜索插件", "全部 Marketplace", "可安装 2 个"],
      ["zh-TW", "Codex 外掛檢查器", "唯讀狀態", "已安裝外掛", "重新整理", "搜尋外掛", "全部 Marketplace", "可安裝 2 個"],
      ["en", "Codex Plugin Inspector", "Read-only status", "Installed plugins", "Refresh", "Search plugins", "All Marketplaces", "Available 2"],
    ] as const;

    for (const [language, title, readOnly, listLabel, refresh, search, allMarketplaces, availableTab] of cases) {
      await i18n.changeLanguage(language);
      const view = render(<Plugins />);

      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
      expect(screen.getByText(readOnly)).toBeTruthy();
      expect(screen.getByRole("button", { name: refresh })).toBeTruthy();
      expect(screen.getByRole("searchbox", { name: search })).toBeTruthy();
      expect(screen.getByRole("option", { name: allMarketplaces })).toBeTruthy();
      expect(screen.getByRole("tab", { name: availableTab })).toBeTruthy();
      expect(screen.getByRole("listbox", { name: listLabel })).toBeTruthy();
      view.unmount();
    }
  });

  it("切换同次快照中的可安装视图，并用五个字段与 Marketplace 本地组合筛选", async () => {
    const user = userEvent.setup();
    render(<Plugins />);

    const installedTab = await screen.findByRole("tab", { name: "已安装 2 个" });
    const availableTab = screen.getByRole("tab", { name: "可安装 2 个" });
    expect(installedTab.getAttribute("aria-selected")).toBe("true");
    await user.click(availableTab);

    expect(availableTab.getAttribute("aria-selected")).toBe("true");
    const search = screen.getByRole("searchbox", { name: "搜索插件" });
    const marketplace = screen.getByRole("combobox", { name: "Marketplace" });

    for (const query of [
      "可安装插件",
      "AVAILABLE-ONLY",
      "可访问性",
      "MARKET-THREE",
      "星际工作室",
    ]) {
      await user.clear(search);
      await user.type(search, query);
      expect(screen.getByRole("option", { name: /available-only/ })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /other-available/ })).toBeNull();
    }

    await user.clear(search);
    await user.selectOptions(marketplace, "market-three");
    await user.type(search, "发布");

    expect(apiMocks.getAgentPluginProjection).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("没有匹配的插件")).toHaveLength(2);
    expect(screen.getAllByText("调整搜索词、Marketplace 或视图后重试。")).toHaveLength(2);
  });

  it("筛选隐藏当前选择后迁移到首个可见身份，清除筛选也不恢复隐藏选择", async () => {
    const user = userEvent.setup();
    render(<Plugins />);

    const list = await screen.findByRole("listbox", { name: "已安装插件" });
    await user.click(within(list).getByRole("option", { name: /same-name@second/ }));
    expect(within(screen.getByRole("complementary", { name: "插件详情" })).getByText("same-name@second")).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "搜索插件" });
    await user.type(search, "same-name@first");
    expect(within(screen.getByRole("complementary", { name: "插件详情" })).getByText("same-name@first")).toBeTruthy();

    await user.clear(search);
    expect(screen.getByRole("option", { name: /same-name@first/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: /same-name@second/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("首次读取和手动刷新提供状态反馈，连续刷新只提交最新请求", async () => {
    const user = userEvent.setup();
    const initial = deferred<AgentPluginProjection>();
    apiMocks.getAgentPluginProjection.mockReturnValueOnce(initial.promise);
    render(<Plugins />);

    expect(screen.getByRole("status").textContent).toContain("正在读取 Codex 插件状态");
    initial.resolve(projection);
    expect(await screen.findByRole("listbox", { name: "已安装插件" })).toBeTruthy();

    const stale = deferred<AgentPluginProjection>();
    const newest = deferred<AgentPluginProjection>();
    apiMocks.getAgentPluginProjection
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(newest.promise);
    const refresh = screen.getByRole("button", { name: "刷新" });
    await user.click(refresh);
    await user.click(refresh);

    expect(screen.getByRole("status").textContent).toContain("正在刷新插件状态");
    newest.resolve({
      ...projection,
      installed: [{
        ...projection.installed[0],
        identity: {
          agent: "codex",
          marketplace_name: "market-newest",
          plugin_id: "newest-result",
        },
        display_name: "最新结果",
      }],
    });
    expect(await screen.findByRole("option", { name: /newest-result/ })).toBeTruthy();

    stale.resolve({
      ...projection,
      installed: [{
        ...projection.installed[0],
        identity: {
          agent: "codex",
          marketplace_name: "market-stale",
          plugin_id: "stale-result",
        },
        display_name: "旧请求结果",
      }],
    });
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /stale-result/ })).toBeNull();
      expect(screen.getByRole("option", { name: /newest-result/ })).toBeTruthy();
    });
    expect(apiMocks.getAgentPluginProjection).toHaveBeenCalledTimes(3);
  });

  it("最新刷新失败时清除旧快照并呈现可区分的错误状态", async () => {
    const user = userEvent.setup();
    render(<Plugins />);
    expect(await screen.findByRole("listbox", { name: "已安装插件" })).toBeTruthy();

    apiMocks.getAgentPluginProjection.mockResolvedValueOnce({
      read_status: "error",
      agent: "codex",
      refreshed_at_unix_ms: 1_788_537_600_100,
      error: { kind: "timed_out" },
    } satisfies AgentPluginProjection);
    await user.click(screen.getByRole("button", { name: "刷新" }));

    const error = await screen.findByRole("alert");
    expect(within(error).getByText("读取插件状态超时，请稍后再试。")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("same-name@first")).toBeNull();
  });
});
