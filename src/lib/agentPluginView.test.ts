import { describe, expect, it } from "vitest";
import {
  agentPluginIdentityKey,
  type AgentPluginDetails,
  type AgentPluginProjection,
  type AgentPluginSummary,
} from "./agentPlugins";
import {
  getAgentPluginMarketplaces,
  getAgentPluginScopeCounts,
  getMigratedAgentPluginSelection,
  getVisibleAgentPlugins,
  type AgentPluginViewItem,
} from "./agentPluginView";

type ReadyProjection = Extract<AgentPluginProjection, { read_status: "ready" }>;

function plugin(
  marketplaceName: string,
  pluginId: string,
  displayName: string,
  installStatus: AgentPluginSummary["install_status"],
  details: Partial<Pick<AgentPluginDetails, "description" | "developer">> = {},
): AgentPluginViewItem {
  return {
    identity: {
      agent: "codex",
      marketplace_name: marketplaceName,
      plugin_id: pluginId,
    },
    display_name: displayName,
    version: "1.0.0",
    install_status: installStatus,
    update_available: null,
    install_policy: "AVAILABLE",
    auth_policy: null,
    details: {
      description: details.description ?? null,
      developer: details.developer ?? null,
      category: null,
      default_prompts: [],
      declared_capabilities: [],
      skills: [],
      mcp_servers: [],
      hook_events: [],
      connectors: [],
      browser_extensions: [],
      custom_ui: [],
      icon_data_url: null,
      screenshot_data_urls: [],
      completeness: "incomplete",
      issues: ["manifest_missing"],
      technical: { source_type: null, location: null },
    },
  };
}

const projection: ReadyProjection = {
  read_status: "ready",
  agent: "codex",
  refreshed_at_unix_ms: 1_788_537_600_000,
  installed: [
    plugin("market-z", "disabled-first", "Aardvark", "installed_disabled"),
    plugin("market-z", "enabled-last", "Zulu", "installed_enabled"),
    plugin("market-a", "enabled-first", "Alpha", "installed_enabled"),
  ],
  available: [
    plugin("market-b", "same", "Same", "available"),
    plugin("market-a", "z-last", "Same", "available"),
    plugin("market-a", "a-first", "Same", "available"),
  ],
};

describe("Agent 插件浏览投影", () => {
  it("保留同次快照的完整身份，并按状态、当前语言名称与复合身份稳定排序", () => {
    expect(getAgentPluginScopeCounts(projection)).toEqual({
      installed: 3,
      available: 3,
    });

    expect(
      getVisibleAgentPlugins({
        projection,
        scope: "installed",
        query: "",
        marketplace: "all",
        language: "en",
      }).map((item) => item.identity.plugin_id),
    ).toEqual(["enabled-first", "enabled-last", "disabled-first"]);

    expect(
      getVisibleAgentPlugins({
        projection,
        scope: "available",
        query: "",
        marketplace: "all",
        language: "en",
      }).map((item) => `${item.identity.marketplace_name}/${item.identity.plugin_id}`),
    ).toEqual([
      "market-a/a-first",
      "market-a/z-last",
      "market-b/same",
    ]);

    const projectedIdentities = [
      ...getVisibleAgentPlugins({
        projection,
        scope: "installed",
        query: "",
        marketplace: "all",
        language: "en",
      }),
      ...getVisibleAgentPlugins({
        projection,
        scope: "available",
        query: "",
        marketplace: "all",
        language: "en",
      }),
    ].map((item) => agentPluginIdentityKey(item.identity));
    expect(new Set(projectedIdentities)).toEqual(new Set([
      '["codex","market-z","disabled-first"]',
      '["codex","market-z","enabled-last"]',
      '["codex","market-a","enabled-first"]',
      '["codex","market-b","same"]',
      '["codex","market-a","z-last"]',
      '["codex","market-a","a-first"]',
    ]));
  });

  it("用五个本地字段与 Marketplace 组合筛选已加载投影", () => {
    const searchableProjection: ReadyProjection = {
      ...projection,
      available: [
        plugin("official-market", "design-tools", "视觉工具", "available", {
          description: "检查页面可访问性",
          developer: "星际工作室",
        }),
        plugin("community-market", "release-helper", "发布助手", "available", {
          description: "整理版本说明",
          developer: "社区作者",
        }),
      ],
    };

    for (const query of [
      "视觉工具",
      "DESIGN-TOOLS",
      "可访问性",
      "OFFICIAL-MARKET",
      "星际工作室",
    ]) {
      expect(
        getVisibleAgentPlugins({
          projection: searchableProjection,
          scope: "available",
          query,
          marketplace: "official-market",
          language: "zh",
        }).map((item) => item.identity.plugin_id),
      ).toEqual(["design-tools"]);
    }

    expect(
      getVisibleAgentPlugins({
        projection: searchableProjection,
        scope: "available",
        query: "发布",
        marketplace: "official-market",
        language: "zh",
      }),
    ).toEqual([]);
  });

  it("从同次投影生成 Marketplace 选项，并在当前选择不可见时迁移", () => {
    expect(getAgentPluginMarketplaces(projection, "en")).toEqual([
      "market-a",
      "market-b",
      "market-z",
    ]);

    const visible = getVisibleAgentPlugins({
      projection,
      scope: "available",
      query: "",
      marketplace: "market-b",
      language: "en",
    });
    expect(getMigratedAgentPluginSelection(visible, "missing-selection")).toBe(
      '["codex","market-b","same"]',
    );
    expect(
      getMigratedAgentPluginSelection(
        visible,
        '["codex","market-b","same"]',
      ),
    ).toBe('["codex","market-b","same"]');
    expect(getMigratedAgentPluginSelection([], "missing-selection")).toBeNull();
  });

  it("当前语言比较器认为身份等价时仍用完整复合身份确定唯一顺序", () => {
    const caseSensitiveIdentityProjection: ReadyProjection = {
      ...projection,
      available: [
        plugin("market", "alpha", "Same", "available"),
        plugin("market", "Alpha", "Same", "available"),
      ],
    };

    expect(
      getVisibleAgentPlugins({
        projection: caseSensitiveIdentityProjection,
        scope: "available",
        query: "",
        marketplace: "all",
        language: "en",
      }).map((item) => item.identity.plugin_id),
    ).toEqual(["Alpha", "alpha"]);
  });
});
