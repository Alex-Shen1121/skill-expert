// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill, SkillTarget, ToolInfo } from "../lib/tauri";
import { AgentSkillsManagementSettings } from "./AgentSkillsManagementSettings";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue(null),
  installGit: vi.fn().mockResolvedValue(undefined),
  getManagedSkills: vi.fn(),
  syncSkillToTool: vi.fn().mockResolvedValue(undefined),
  unsyncSkillFromTool: vi.fn().mockResolvedValue(undefined),
  setSettings: vi.fn().mockResolvedValue(undefined),
}));

const appState = vi.hoisted(() => ({
  tools: [] as ToolInfo[],
  managedSkills: [] as ManagedSkill[],
  refreshManagedSkills: vi.fn().mockResolvedValue(undefined),
  openSkillDetailById: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/tauri", () => apiMocks);
vi.mock("../context/AppContext", () => ({ useApp: () => appState }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

function tool(
  key: string,
  displayName: string,
  options: Partial<Pick<ToolInfo, "installed" | "enabled">> = {},
): ToolInfo {
  return {
    key,
    display_name: displayName,
    installed: options.installed ?? true,
    enabled: options.enabled ?? true,
    skills_dir: `/agents/${key}/skills`,
    is_custom: false,
    has_path_override: false,
    project_relative_skills_dir: null,
    has_project_path_override: false,
    category: "coding",
  };
}

function target(toolKey: string): SkillTarget {
  return {
    id: `target-${toolKey}`,
    skill_id: "manage-skills-id",
    tool: toolKey,
    target_path: `/agents/${toolKey}/skills/manage-skills`,
    mode: "symlink",
    status: "synced",
    synced_at: 1,
  };
}

function managementSkill(targets: SkillTarget[] = []): ManagedSkill {
  return {
    id: "manage-skills-id",
    name: "manage-skills",
    description: null,
    source_type: "git",
    source_ref:
      "https://github.com/Alex-Shen1121/skill-expert/tree/main/skills/manage-skills",
    source_ref_resolved: "https://github.com/Alex-Shen1121/skill-expert.git",
    source_subpath: "skills/manage-skills",
    source_branch: "main",
    source_revision: "abc123",
    remote_revision: "abc123",
    update_status: "up_to_date",
    last_checked_at: 1,
    last_check_error: null,
    central_path: "/library/manage-skills",
    enabled: true,
    created_at: 1,
    updated_at: 1,
    status: "ready",
    targets,
    preset_ids: [],
    tags: [],
    can_check_update: true,
  };
}

function renderModule() {
  return render(
    <MemoryRouter>
      <AgentSkillsManagementSettings />
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("zh");
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.installGit.mockResolvedValue(undefined);
  apiMocks.syncSkillToTool.mockResolvedValue(undefined);
  apiMocks.unsyncSkillFromTool.mockResolvedValue(undefined);
  apiMocks.setSettings.mockResolvedValue(undefined);
  appState.tools = [
    tool("codex", "Codex"),
    tool("warp", "Warp"),
    tool("workbuddy", "WorkBuddy", { installed: false, enabled: false }),
  ];
  appState.managedSkills = [managementSkill([target("codex"), target("workbuddy")])];
  apiMocks.getManagedSkills.mockResolvedValue([managementSkill()]);
  dialogMocks.confirm.mockResolvedValue(true);
});

afterEach(cleanup);

describe("Agent Skills 管理配置", () => {
  it("始终显示 Agent Skills 管理配置，并回显可用与残留部署目标", () => {
    renderModule();

    expect(
      screen.getByRole("heading", { name: "Agent 管理 Skills" }),
    ).toBeTruthy();
    expect(screen.getByText("2 个已部署")).toBeTruthy();
    expect(screen.getByLabelText("当前部署 2")).toBeTruthy();
    expect(screen.getByLabelText("待处理 0")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "关闭 Codex 的管理能力" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "开启 Warp 的管理能力" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "关闭 WorkBuddy 的管理能力" }),
    ).toBeTruthy();
    expect(screen.getByText("Agent 已停用或卸载，仍保留部署记录")).toBeTruthy();
  });

  it("同名异源时显示冲突、阻断 Agent 选择并提供处理入口", async () => {
    const user = userEvent.setup();
    const conflicting = managementSkill();
    conflicting.source_ref = "https://github.com/example/manage-skills";
    conflicting.source_ref_resolved = "https://github.com/example/manage-skills.git";
    conflicting.source_subpath = null;
    appState.managedSkills = [conflicting];

    renderModule();

    expect(screen.getByText("发现同名异源 Skill")).toBeTruthy();
    expect(
      screen.getByText("当前 manage-skills 不是来自固定可信来源，部署操作已暂停。"),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "开启 Codex 的管理能力" }),
    ).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "在技能库中查看" }));
    expect(appState.openSkillDetailById).toHaveBeenCalledWith("manage-skills-id");
  });

  it("官方仓库同子路径但不是 main 分支时仍视为来源冲突", () => {
    const wrongBranch = managementSkill();
    wrongBranch.source_ref = null;
    wrongBranch.source_branch = "feature/unsafe";
    appState.managedSkills = [wrongBranch];

    renderModule();

    expect(screen.getByText("发现同名异源 Skill")).toBeTruthy();
  });

  it("存在可信 Skill 时仍会阻断另一个同名异源 Skill", () => {
    const conflicting = managementSkill();
    conflicting.id = "conflicting-id";
    conflicting.source_ref = "https://github.com/example/manage-skills";
    conflicting.source_ref_resolved = "https://github.com/example/manage-skills.git";
    conflicting.source_subpath = null;
    appState.managedSkills = [managementSkill(), conflicting];

    renderModule();

    expect(screen.getByText("发现同名异源 Skill")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "开启 Codex 的管理能力" }),
    ).toHaveProperty("disabled", true);
  });

  it("先保存 Agent 选择草稿，确认撤销后再统一应用", async () => {
    const user = userEvent.setup();
    renderModule();

    await user.click(screen.getByRole("switch", { name: "开启 Warp 的管理能力" }));
    await user.click(
      screen.getByRole("switch", { name: "关闭 WorkBuddy 的管理能力" }),
    );

    expect(apiMocks.syncSkillToTool).not.toHaveBeenCalled();
    expect(apiMocks.unsyncSkillFromTool).not.toHaveBeenCalled();
    expect(screen.getByText("+ Warp")).toBeTruthy();
    expect(screen.getByText("− WorkBuddy")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "应用更改" }));

    await waitFor(() => {
      expect(apiMocks.syncSkillToTool).toHaveBeenCalledWith("manage-skills-id", "warp");
      expect(apiMocks.unsyncSkillFromTool).toHaveBeenCalledWith(
        "manage-skills-id",
        "workbuddy",
      );
    });
    expect(appState.refreshManagedSkills).toHaveBeenCalled();
  });

  it("未安装时先安装可信管理 Skill，再部署到明确选择的 Agent", async () => {
    const user = userEvent.setup();
    appState.managedSkills = [];
    renderModule();

    expect(screen.getByText(/管理 Skill 尚未安装/)).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "开启 Codex 的管理能力" }));
    await user.click(screen.getByRole("button", { name: "应用更改" }));

    await waitFor(() => {
      expect(apiMocks.installGit).toHaveBeenCalledWith(
        "https://github.com/Alex-Shen1121/skill-expert/tree/main/skills/manage-skills",
      );
      expect(apiMocks.syncSkillToTool).toHaveBeenCalledWith("manage-skills-id", "codex");
    });
    expect(apiMocks.setSettings).toHaveBeenCalledWith(
      "agent_control_setup_prompt",
      "installed",
    );
  });

  it("大量 Agent 时可以搜索并按部署状态筛选", async () => {
    const user = userEvent.setup();
    appState.tools = [
      tool("codex", "Codex"),
      tool("warp", "Warp"),
      ...Array.from({ length: 9 }, (_, index) =>
        tool(`agent-${index + 1}`, `Agent ${index + 1}`),
      ),
      tool("workbuddy", "WorkBuddy", { installed: false, enabled: false }),
    ];
    renderModule();

    const search = screen.getByPlaceholderText("搜索 12 个 Agent");
    await user.type(search, "Agent 9");
    expect(screen.getByText("Agent 9")).toBeTruthy();
    expect(screen.queryByText("Agent 1")).toBeNull();

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "已部署 2" }));
    expect(screen.getAllByRole("switch")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "需处理 1" }));
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByText("WorkBuddy")).toBeTruthy();
  });

  it("大量待应用更改会压缩摘要，保持应用操作可见", async () => {
    const user = userEvent.setup();
    appState.tools = Array.from({ length: 10 }, (_, index) =>
      tool(`agent-${index + 1}`, `Agent ${index + 1}`),
    );
    appState.managedSkills = [managementSkill()];
    renderModule();

    for (const targetSwitch of screen.getAllByRole("switch")) {
      await user.click(targetSwitch);
    }

    expect(screen.getByText("另有 7 项更改")).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用更改" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("部分失败时保留成功项，并允许只重试失败 Agent", async () => {
    const user = userEvent.setup();
    appState.tools = [tool("codex", "Codex"), tool("warp", "Warp")];
    appState.managedSkills = [managementSkill()];
    apiMocks.syncSkillToTool.mockImplementation(
      async (_skillId: string, toolKey: string) => {
        if (toolKey === "warp") throw new Error("denied");
      },
    );
    renderModule();

    await user.click(screen.getByRole("switch", { name: "开启 Codex 的管理能力" }));
    await user.click(screen.getByRole("switch", { name: "开启 Warp 的管理能力" }));
    await user.click(screen.getByRole("button", { name: "应用更改" }));

    await waitFor(() => {
      expect(apiMocks.syncSkillToTool).toHaveBeenCalledWith("manage-skills-id", "codex");
      expect(apiMocks.syncSkillToTool).toHaveBeenCalledWith("manage-skills-id", "warp");
    });
    expect(screen.getByText("Warp 配置失败，可重试。")).toBeTruthy();
    expect(screen.getByText("配置失败")).toBeTruthy();

    apiMocks.syncSkillToTool.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "重试失败项" }));
    await waitFor(() => {
      expect(
        apiMocks.syncSkillToTool.mock.calls.filter((call) => call[1] === "warp"),
      ).toHaveLength(2);
    });
  });

  it("可以从状态面板进入可信管理 Skill 详情", async () => {
    const user = userEvent.setup();
    renderModule();

    await user.click(screen.getByRole("button", { name: "在技能库中查看" }));

    expect(appState.openSkillDetailById).toHaveBeenCalledWith("manage-skills-id");
  });

  it("三种界面语言都提供完整的 Agent Skills 管理配置", async () => {
    const cases = [
      {
        language: "zh",
        title: "Agent 管理 Skills",
        search: "搜索 3 个 Agent",
        deployed: "已部署 2",
      },
      {
        language: "zh-TW",
        title: "Agent 管理 Skills",
        search: "搜尋 3 個 Agent",
        deployed: "已部署 2",
      },
      {
        language: "en",
        title: "Manage Skills with Agents",
        search: "Search 3 agents",
        deployed: "Deployed 2",
      },
    ];

    for (const testCase of cases) {
      await i18n.changeLanguage(testCase.language);
      const view = renderModule();
      expect(screen.getByRole("heading", { name: testCase.title })).toBeTruthy();
      expect(screen.getByPlaceholderText(testCase.search)).toBeTruthy();
      expect(screen.getByRole("button", { name: testCase.deployed })).toBeTruthy();
      view.unmount();
    }
    await i18n.changeLanguage("zh");
  });
});
