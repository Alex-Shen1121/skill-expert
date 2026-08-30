// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill, ToolInfo } from "../lib/tauri";
import { AgentControlSetupCard } from "./AgentControlSetupCard";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue(null),
  setSettings: vi.fn().mockResolvedValue(undefined),
  installGit: vi.fn().mockResolvedValue(undefined),
  getManagedSkills: vi.fn(),
  syncSkillToTool: vi.fn().mockResolvedValue(undefined),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/tauri", () => apiMocks);
vi.mock("sonner", () => ({ toast: toastMocks }));

const appState = vi.hoisted(() => ({
  tools: [] as ToolInfo[],
  managedSkills: [] as ManagedSkill[],
  loading: false,
  refreshManagedSkills: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../context/AppContext", () => ({
  useApp: () => appState,
}));

function tool(key: string, displayName: string, enabled = true): ToolInfo {
  return {
    key,
    display_name: displayName,
    installed: true,
    skills_dir: `/agents/${key}/skills`,
    enabled,
    is_custom: false,
    has_path_override: false,
    project_relative_skills_dir: null,
    has_project_path_override: false,
    category: "coding",
  };
}

function managedSkill(name = "manage-skills"): ManagedSkill {
  return {
    id: "manage-skills-id",
    name,
    description: null,
    source_type: "git",
    source_ref: null,
    source_ref_resolved: null,
    source_subpath: null,
    source_branch: null,
    source_revision: null,
    remote_revision: null,
    update_status: "unknown",
    last_checked_at: null,
    last_check_error: null,
    central_path: "/library/manage-skills",
    enabled: true,
    created_at: 1,
    updated_at: 1,
    status: "ready",
    targets: [],
    preset_ids: [],
    tags: [],
    can_check_update: true,
  };
}

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("zh");
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getSettings.mockResolvedValue(null);
  apiMocks.setSettings.mockResolvedValue(undefined);
  apiMocks.installGit.mockResolvedValue(undefined);
  apiMocks.syncSkillToTool.mockResolvedValue(undefined);
  apiMocks.getManagedSkills.mockResolvedValue([managedSkill()]);
  appState.tools = [tool("codex", "Codex"), tool("claude_code", "Claude Code")];
  appState.managedSkills = [];
  appState.loading = false;
  appState.refreshManagedSkills.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("Agent 管理 Skill 设置卡片", () => {
  it("已安装 manage-skills 时不再显示", async () => {
    appState.managedSkills = [managedSkill()];
    render(<AgentControlSetupCard />);

    await waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalledOnce());
    expect(screen.queryByText("让 Agent 直接管理 Skills")).toBeNull();
  });

  it("只部署到用户明确选择的 Agent，并使用独立仓库来源", async () => {
    const user = userEvent.setup();
    render(<AgentControlSetupCard />);

    await user.click(await screen.findByRole("button", { name: "开始设置" }));
    const codex = screen.getByRole("button", { name: "Codex" });
    const claude = screen.getByRole("button", { name: "Claude Code" });
    expect(codex.getAttribute("aria-pressed")).toBe("false");
    expect(claude.getAttribute("aria-pressed")).toBe("false");

    await user.click(codex);
    await user.click(screen.getByRole("button", { name: "为 1 个 Agent 启用" }));

    await waitFor(() => {
      expect(apiMocks.installGit).toHaveBeenCalledWith(
        "https://github.com/Alex-Shen1121/skill-expert/tree/main/skills/manage-skills",
      );
      expect(apiMocks.syncSkillToTool).toHaveBeenCalledWith("manage-skills-id", "codex");
    });
    expect(apiMocks.syncSkillToTool).not.toHaveBeenCalledWith(
      "manage-skills-id",
      "claude_code",
    );
    expect(apiMocks.setSettings).toHaveBeenCalledWith(
      "agent_control_setup_prompt",
      "installed",
    );
    expect(appState.refreshManagedSkills).toHaveBeenCalledOnce();
  });

  it("关闭提示后持久化选择", async () => {
    const user = userEvent.setup();
    render(<AgentControlSetupCard />);

    await user.click(await screen.findByRole("button", { name: "不再提示" }));

    expect(apiMocks.setSettings).toHaveBeenCalledWith(
      "agent_control_setup_prompt",
      "dismissed",
    );
    expect(screen.queryByText("让 Agent 直接管理 Skills")).toBeNull();
  });
});
