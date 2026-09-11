import { describe, expect, it } from "vitest";
import type { ProjectAgentTarget } from "./tauri";
import { enabledInstalledAgentKeys, getDefaultExportAgents } from "./exportAgents";

function target(key: string, enabled = true, installed = true): ProjectAgentTarget {
  return { key, display_name: key, enabled, installed, is_custom: false };
}

describe("项目导出 Agent 目标", () => {
  it("默认覆盖所有已安装且已启用的 Agent，并按优先级排序", () => {
    const targets = [
      target("pi"),
      target("claude_code"),
      target("zcode"),
      target("codex", false),
      target("cursor", true, false),
    ];

    expect(enabledInstalledAgentKeys(targets)).toEqual(["pi", "claude_code", "zcode"]);
    expect(getDefaultExportAgents(targets)).toEqual(["claude_code", "pi", "zcode"]);
  });
});
