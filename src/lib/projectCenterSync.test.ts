import { describe, expect, it } from "vitest";
import {
  updateProjectGroupToCenter,
  type ProjectCenterAdapter,
  type ProjectCenterVariant,
} from "./projectCenterSync";

describe("updateProjectGroupToCenter", () => {
  it("多个副本都可能包含独立内容时拒绝写入", async () => {
    const calls: string[] = [];
    const adapter: ProjectCenterAdapter = {
      updateToCenter: async () => {
        calls.push("to-center");
      },
      updateFromCenter: async () => {
        calls.push("from-center");
      },
    };
    const variants: ProjectCenterVariant[] = [
      { agent: "claude", relativePath: ".claude/skills/demo", syncStatus: "project_newer" },
      { agent: "codex", relativePath: ".codex/skills/demo", syncStatus: "diverged" },
    ];

    const result = await updateProjectGroupToCenter("project-1", variants, adapter);

    expect(result).toEqual({ status: "conflict", conflicting: 2 });
    expect(calls).toEqual([]);
  });

  it("选择真正有修改的副本并依次对齐其余副本", async () => {
    const calls: string[] = [];
    const adapter: ProjectCenterAdapter = {
      updateToCenter: async (_projectId, _relativePath, agent) => {
        calls.push(`to:${agent}`);
      },
      updateFromCenter: async (_projectId, _relativePath, agent) => {
        calls.push(`from:${agent}`);
      },
    };
    const variants: ProjectCenterVariant[] = [
      { agent: "claude", relativePath: ".claude/skills/demo", syncStatus: "in_sync" },
      { agent: "codex", relativePath: ".codex/skills/demo", syncStatus: "project_newer" },
      { agent: "gemini", relativePath: ".gemini/skills/demo", syncStatus: "in_sync" },
    ];

    const result = await updateProjectGroupToCenter("project-1", variants, adapter);

    expect(result).toEqual({ status: "success" });
    expect(calls).toEqual(["to:codex", "from:claude", "from:gemini"]);
  });

  it("一个副本对齐失败后继续处理其余副本并返回失败数", async () => {
    const calls: string[] = [];
    const adapter: ProjectCenterAdapter = {
      updateToCenter: async (_projectId, _relativePath, agent) => {
        calls.push(`to:${agent}`);
      },
      updateFromCenter: async (_projectId, _relativePath, agent) => {
        calls.push(`from:${agent}`);
        if (agent === "claude") throw new Error("对齐失败");
      },
    };
    const variants: ProjectCenterVariant[] = [
      { agent: "codex", relativePath: ".codex/skills/demo", syncStatus: "project_newer" },
      { agent: "claude", relativePath: ".claude/skills/demo", syncStatus: "in_sync" },
      { agent: "gemini", relativePath: ".gemini/skills/demo", syncStatus: "in_sync" },
    ];

    const result = await updateProjectGroupToCenter("project-1", variants, adapter);

    expect(result).toEqual({ status: "partial", alignFailed: 1 });
    expect(calls).toEqual(["to:codex", "from:claude", "from:gemini"]);
  });
});
