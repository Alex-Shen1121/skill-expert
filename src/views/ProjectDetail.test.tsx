// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { Project, ProjectSkill } from "../lib/tauri";
import { ProjectDetail } from "./ProjectDetail";

const fixture = vi.hoisted(() => ({ skills: [] as ProjectSkill[] }));
const api = vi.hoisted(() => ({
  getProjectSkills: vi.fn(async () => fixture.skills),
  getProjectAgentTargets: vi.fn().mockResolvedValue([
    { key: "gitlab_duo", display_name: "GitLab Duo", installed: true, enabled: true, is_custom: false },
    { key: "qa", display_name: "独占测试 Agent", installed: true, enabled: true, is_custom: true },
  ]),
  getSettings: vi.fn().mockResolvedValue(null),
  getProjectRootImpact: vi.fn().mockResolvedValue({
    workspace: "验收项目", physical_path: "/tmp/qa/.agents/skills", known_agents: ["gitlab_duo"], shared: true, unknown: false,
  }),
  deleteProjectSkill: vi.fn(),
  toggleProjectSkill: vi.fn(),
  updateProjectSkillFromCenter: vi.fn(),
  updateProjectSkillToCenter: vi.fn(),
}));
const refreshProjects = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const project: Project = {
  id: "project", name: "验收项目", path: "/tmp/qa", workspace_type: "project", linked_agent_name: null,
  supports_skill_toggle: true, sort_order: 0, skill_count: 2,
  sync_health: { in_sync: 1, project_newer: 0, center_newer: 1, diverged: 0, project_only: 0 },
  created_at: 0, updated_at: 0,
};

vi.mock("../lib/tauri", () => api);
vi.mock("../context/AppContext", () => ({
  useApp: () => ({ projects: [project], presets: [], managedSkills: [], refreshProjects }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

beforeAll(async () => { await i18nReady; });
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh");
  fixture.skills = ["gitlab_duo", "qa"].map((agent) => ({
    name: "验收技能", dir_name: "验收技能", relative_path: "验收技能", description: "混合目标测试",
    path: `/tmp/qa/${agent}/验收技能`, files: ["SKILL.md"], enabled: true, agent,
    agent_display_name: agent === "qa" ? "独占测试 Agent" : "GitLab Duo", tags: [],
    in_center: true, sync_status: agent === "qa" ? "center_newer" : "in_sync", center_skill_id: "skill",
  }));
  api.getProjectSkills.mockImplementation(async () => fixture.skills);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderProject() {
  return render(<MemoryRouter initialEntries={["/project/project"]}>
    <Routes><Route path="/project/:id" element={<ProjectDetail />} /></Routes>
  </MemoryRouter>);
}

async function deleteSkill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTitle("删除 Skill"));
  await user.click(await screen.findByRole("button", { name: "删除" }));
}

function expectReceipts() {
  const receipt = within(screen.getByRole("region", { name: "Agent 操作回执" }));
  expect(receipt.getByText("gitlab_duo: 验收技能 — 共享目录受保护")).toBeTruthy();
  expect(receipt.getByText("qa: 验收技能 — 操作成功")).toBeTruthy();
}

describe("项目多目标操作的部分成功回读", () => {
  it.each(["删除", "停用", "中心更新"])("%s 部分成功后立即显示实际状态并保留逐目标回执", async (operation) => {
    const act = async (_project: string, _path: string, agent: string) => {
      if (agent === "gitlab_duo") throw new Error("共享目录受保护");
      fixture.skills = operation === "删除"
        ? fixture.skills.filter((skill) => skill.agent !== "qa")
        : fixture.skills.map((skill) => skill.agent !== "qa" ? skill : {
          ...skill, enabled: operation === "停用" ? false : skill.enabled,
          sync_status: operation === "中心更新" ? "in_sync" : skill.sync_status,
        });
    };
    api.deleteProjectSkill.mockImplementation(act);
    api.toggleProjectSkill.mockImplementation(act);
    api.updateProjectSkillFromCenter.mockImplementation(act);
    const user = userEvent.setup();
    renderProject();
    await screen.findByRole("button", { name: /独占测试 Agent · assigned/ });
    if (operation === "删除") await deleteSkill(user);
    else if (operation === "停用") await user.click(screen.getByRole("switch"));
    else await user.click(screen.getByTitle("更新项目"));

    await waitFor(() => {
      if (operation === "删除") expect(screen.getByRole("button", { name: /独占测试 Agent · available/ })).toBeTruthy();
      else if (operation === "停用") expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
      else expect(screen.queryByTitle("更新项目")).toBeNull();
      expect(refreshProjects).toHaveBeenCalled();
    });
    expectReceipts();
  });

  it("回读失败时保留回执，手动刷新不重复执行删除", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.deleteProjectSkill.mockImplementation(async (_project: string, _path: string, agent: string) => {
      if (agent === "gitlab_duo") throw new Error("共享目录受保护");
      fixture.skills = fixture.skills.filter((skill) => skill.agent !== "qa");
      api.getProjectSkills.mockRejectedValueOnce(new Error("模拟读取失败"));
    });
    const user = userEvent.setup();
    renderProject();
    await screen.findByRole("button", { name: /独占测试 Agent · assigned/ });
    await deleteSkill(user);
    await waitFor(() => expect(api.getProjectSkills).toHaveBeenCalledTimes(2));
    expectReceipts();
    await user.click(screen.getByTitle("common.refresh"));
    await screen.findByRole("button", { name: /独占测试 Agent · available/ });
    expect(api.deleteProjectSkill).toHaveBeenCalledTimes(2);
    expectReceipts();
  });
});
