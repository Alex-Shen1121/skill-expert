// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import type { AgentPluginSummary } from "../../lib/agentPlugins";
import { PluginDetails } from "./PluginDetails";

const completePlugin = {
  identity: {
    agent: "codex",
    marketplace_name: "trusted-market",
    plugin_id: "safe-details@trusted-market",
  },
  display_name: "安全详情插件",
  version: "1.2.3",
  install_status: "installed_enabled",
  update_available: false,
  install_policy: "AVAILABLE",
  auth_policy: "on_install",
  details: {
    description: "只展示可信补充资料。",
    developer: "可信开发者",
    category: "效率",
    default_prompts: ["总结文档"],
    declared_capabilities: ["Read", "Write"],
    skills: [{ name: "safe-skill", description: "只读处理文档" }],
    mcp_servers: ["docs"],
    hook_events: ["SessionStart"],
    connectors: ["docs-connector"],
    browser_extensions: [],
    custom_ui: [],
    icon_data_url: null,
    screenshot_data_urls: [],
    completeness: "complete",
    issues: [],
    technical: {
      source_type: "local",
      location: "~/…/safe-details",
      command: "secret-command",
      env: { TOKEN: "secret-value" },
    },
  },
} as unknown as AgentPluginSummary;

beforeAll(async () => {
  await i18nReady;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(cleanup);

describe("PluginDetails 安全详情", () => {
  it("按方案 B 层级显示六类明确能力和固定认证措辞", () => {
    render(<PluginDetails plugin={completePlugin} />);

    const details = screen.getByRole("complementary", { name: "插件详情" });
    expect(within(details).getByRole("heading", { name: "安全详情插件" })).toBeTruthy();
    expect(within(details).getByText("只展示可信补充资料。")).toBeTruthy();
    expect(within(details).getByText("可信开发者")).toBeTruthy();
    expect(within(details).getByText("安装时可能需要认证")).toBeTruthy();
    expect(within(details).queryByText(/已授权|已连接/)).toBeNull();

    const groupLabels = [
      "Skills",
      "MCP",
      "Hooks",
      "连接器",
      "浏览器扩展",
      "自定义 UI",
    ];
    const groups = groupLabels.map((label) => within(details).getByRole("region", { name: label }));
    expect(within(groups[0]).getByText("safe-skill")).toBeTruthy();
    expect(within(groups[0]).getByText("只读处理文档")).toBeTruthy();
    expect(within(groups[1]).getByText("docs")).toBeTruthy();
    expect(within(groups[2]).getByText("SessionStart")).toBeTruthy();
    expect(within(groups[3]).getByText("docs-connector")).toBeTruthy();
    expect(within(groups[4]).getByText("未声明")).toBeTruthy();
    expect(within(groups[5]).getByText("未声明")).toBeTruthy();
  });

  it("详情不完整时使用稳定默认图标并保持技术详情默认折叠", async () => {
    const user = userEvent.setup();
    const plugin = {
      ...completePlugin,
      display_name: "Chrome 品牌名不构成声明",
      auth_policy: null,
      details: {
        ...completePlugin.details,
        description: null,
        developer: null,
        category: null,
        skills: [],
        mcp_servers: [],
        hook_events: [],
        connectors: [],
        browser_extensions: [],
        custom_ui: [],
        completeness: "incomplete",
        issues: ["manifest_missing"],
      },
    } as AgentPluginSummary;
    render(<PluginDetails plugin={plugin} />);

    expect(screen.getByRole("status").textContent).toContain("详情不完整");
    expect(screen.getByRole("img", { name: "默认插件图标" })).toBeTruthy();
    expect(screen.getAllByText("未提供").length).toBeGreaterThan(0);
    expect(screen.queryByText("浏览器扩展已提供")).toBeNull();
    const disclosure = screen.getByText("技术详情").closest("details");
    expect(disclosure?.open).toBe(false);
    await user.click(screen.getByText("技术详情"));
    expect(disclosure?.open).toBe(true);
    expect(screen.getByText("~/…/safe-details")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-command");
    expect(document.body.textContent).not.toContain("secret-value");
  });

  it("三种语言分别提供三态认证和六类能力文案", async () => {
    const cases = [
      ["zh", "on_install", "安装时可能需要认证", "连接器", "浏览器扩展", "自定义 UI"],
      ["zh-TW", "on_use", "使用時可能需要認證", "連接器", "瀏覽器擴充功能", "自訂 UI"],
      ["en", "none", "No authentication required", "Connectors", "Browser extensions", "Custom UI"],
    ] as const;

    for (const [language, policy, auth, connectors, browser, customUi] of cases) {
      await i18n.changeLanguage(language);
      const view = render(
        <PluginDetails plugin={{ ...completePlugin, auth_policy: policy }} />,
      );

      expect(screen.getByText(auth)).toBeTruthy();
      expect(screen.getByRole("region", { name: connectors })).toBeTruthy();
      expect(screen.getByRole("region", { name: browser })).toBeTruthy();
      expect(screen.getByRole("region", { name: customUi })).toBeTruthy();
      view.unmount();
    }
  });
});
