// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill, Preset } from "../lib/tauri";
import { MySkills } from "./MySkills";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue(null),
  getPresetSkillOrder: vi.fn().mockResolvedValue([]),
  gitBackupPendingConflicts: vi.fn().mockResolvedValue([]),
  getAllTags: vi.fn().mockResolvedValue(["核心", "扩展"]),
  gitBackupStatus: vi.fn().mockResolvedValue(null),
  gitBackupFetch: vi.fn().mockResolvedValue(undefined),
  reorderPresetSkills: vi.fn().mockResolvedValue(undefined),
  getSkillToolToggles: vi.fn().mockResolvedValue([]),
  setSkillToolToggle: vi.fn().mockResolvedValue(undefined),
  syncSkillToTool: vi.fn().mockResolvedValue(undefined),
  unsyncSkillFromTool: vi.fn().mockResolvedValue(undefined),
  deleteManagedSkill: vi.fn().mockResolvedValue(undefined),
  deleteManagedSkills: vi.fn().mockResolvedValue({ deleted: 0, failed: [] }),
  setSkillTags: vi.fn().mockResolvedValue(undefined),
  addSkillToPreset: vi.fn().mockResolvedValue(undefined),
  removeSkillFromPreset: vi.fn().mockResolvedValue(undefined),
  batchUpdateSkills: vi.fn().mockResolvedValue({
    refreshed: 0,
    unchanged: 0,
    held_back: [],
    failed: [],
  }),
  checkAllSkillUpdates: vi.fn().mockResolvedValue(undefined),
  checkSkillUpdate: vi.fn().mockResolvedValue(undefined),
  reimportLocalSkill: vi.fn().mockResolvedValue({
    status: "updated",
    removals: [],
    approval: null,
  }),
  updateSkill: vi.fn().mockResolvedValue({
    status: "updated",
    removals: [],
    approval: null,
  }),
  relinkLocalSkillSource: vi.fn().mockResolvedValue({
    status: "updated",
    removals: [],
    approval: null,
  }),
  detachLocalSkillSource: vi.fn().mockResolvedValue(undefined),
  renameTag: vi.fn().mockResolvedValue(undefined),
  deleteTag: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/tauri", () => apiMocks);

const appState = vi.hoisted(() => ({
  viewedPreset: null as Preset | null,
  tools: [],
  managedSkills: [] as ManagedSkill[],
  refreshPresets: vi.fn().mockResolvedValue(undefined),
  refreshManagedSkills: vi.fn().mockResolvedValue(undefined),
  detailSkillId: null as string | null,
  openSkillDetailById: vi.fn(),
  closeSkillDetail: vi.fn(),
  projects: [],
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../context/AppContext", () => ({
  useApp: () => appState,
}));

type SkillFixture = {
  id: string;
  name: string;
  sourceType: ManagedSkill["source_type"];
  updateStatus: ManagedSkill["update_status"];
  sourceRef?: string | null;
  sourceRefResolved?: string | null;
  sourceSubpath?: string | null;
  sourceBranch?: string | null;
  tags?: string[];
  presetIds?: string[];
};

function createSkill({
  id,
  name,
  sourceType,
  updateStatus,
  sourceRef = null,
  sourceRefResolved = null,
  sourceSubpath = null,
  sourceBranch = null,
  tags = [],
  presetIds = [],
}: SkillFixture): ManagedSkill {
  return {
    id,
    name,
    description: `${name} 描述`,
    source_type: sourceType,
    source_ref: sourceRef,
    source_ref_resolved: sourceRefResolved,
    source_subpath: sourceSubpath,
    source_branch: sourceBranch,
    source_revision: null,
    remote_revision: null,
    update_status: updateStatus,
    last_checked_at: null,
    last_check_error: null,
    central_path: `/skills/${id}`,
    enabled: true,
    created_at: 1,
    updated_at: 1,
    status: "ready",
    targets: [],
    preset_ids: presetIds,
    tags,
  };
}

const updateContractSkills = [
  createSkill({ id: "git-ready", name: "Git 可更新", sourceType: "git", updateStatus: "update_available", tags: ["核心"], presetIds: ["preset-a"] }),
  createSkill({ id: "skillssh-ready", name: "技能站可更新", sourceType: "skillssh", updateStatus: "update_available", tags: ["扩展"] }),
  createSkill({ id: "local-ready", name: "本地可更新", sourceType: "local", sourceRef: "/来源/本地", updateStatus: "update_available", tags: ["扩展"] }),
  createSkill({ id: "import-ready", name: "导入可更新", sourceType: "import", sourceRef: "/来源/导入", updateStatus: "update_available", tags: ["核心"], presetIds: ["preset-a"] }),
  ...["up_to_date", "unknown", "error", "source_missing", "local_only", "checking", "updating"].map((updateStatus) =>
    createSkill({
      id: `状态-${updateStatus}`,
      name: `状态 ${updateStatus}`,
      sourceType: "git",
      updateStatus,
    }),
  ),
  createSkill({ id: "local-no-source", name: "本地无来源", sourceType: "local", updateStatus: "update_available" }),
  createSkill({ id: "import-no-source", name: "导入无来源", sourceType: "import", updateStatus: "update_available" }),
  createSkill({ id: "local-blank-source", name: "本地空白来源", sourceType: "local", sourceRef: "   ", updateStatus: "update_available" }),
];

const repositoryFilterSkills = [
  createSkill({
    id: "git-tools-main",
    name: "工具仓主分支",
    sourceType: "git",
    sourceRefResolved: "https://github.com/acme/tools.git/",
    sourceSubpath: "skills/main",
    sourceBranch: "main",
    updateStatus: "update_available",
    tags: ["核心"],
    presetIds: ["preset-a"],
  }),
  createSkill({
    id: "git-tools-next",
    name: "工具仓开发分支",
    sourceType: "git",
    sourceRefResolved: "https://github.com/acme/tools/",
    sourceSubpath: "skills/next",
    sourceBranch: "next",
    updateStatus: "up_to_date",
    tags: ["扩展"],
  }),
  createSkill({
    id: "git-other",
    name: "其他仓技能",
    sourceType: "git",
    sourceRefResolved: "https://gitlab.com/acme/other.git",
    updateStatus: "update_available",
    tags: ["核心"],
    presetIds: ["preset-a"],
  }),
  createSkill({
    id: "git-tools-scp",
    name: "SCP 工具仓技能",
    sourceType: "git",
    sourceRefResolved: "git@github.com:acme/tools.git",
    updateStatus: "update_available",
  }),
  createSkill({
    id: "git-tools-case",
    name: "大小写工具仓技能",
    sourceType: "git",
    sourceRefResolved: "https://github.com/Acme/Tools.git",
    updateStatus: "update_available",
  }),
  createSkill({
    id: "git-missing-repository",
    name: "缺少仓库身份的 Git Skill",
    sourceType: "git",
    updateStatus: "update_available",
  }),
  createSkill({
    id: "git-blank-repository",
    name: "空仓库身份的 Git Skill",
    sourceType: "git",
    sourceRefResolved: "   ",
    updateStatus: "update_available",
  }),
  createSkill({
    id: "skillssh-market",
    name: "技能站仓库技能",
    sourceType: "skillssh",
    sourceRefResolved: "https://github.com/acme/market.git",
    updateStatus: "update_available",
  }),
  createSkill({
    id: "local-skill",
    name: "本地技能",
    sourceType: "local",
    sourceRef: "/来源/本地技能",
    updateStatus: "update_available",
    tags: ["核心"],
    presetIds: ["preset-a"],
  }),
];

function expectOnlyRepositorySkills(names: string[]) {
  const visibleNames = new Set(names);
  for (const skill of repositoryFilterSkills) {
    expectSkillVisible(skill.name, visibleNames.has(skill.name));
  }
}

function renderPage(
  skills: ManagedSkill[] = appState.managedSkills,
  viewedPreset: Preset | null = appState.viewedPreset,
) {
  appState.managedSkills = skills;
  appState.viewedPreset = viewedPreset;
  return render(
    <MemoryRouter>
      <MySkills />
    </MemoryRouter>,
  );
}

function expectSkillVisible(name: string, visible: boolean) {
  const heading = screen.queryByRole("heading", { name, level: 3 });
  if (visible) expect(heading).not.toBeNull();
  else expect(heading).toBeNull();
}

function expectOnlySkills(names: string[]) {
  const visibleNames = new Set(names);
  for (const skill of updateContractSkills) {
    expectSkillVisible(skill.name, visibleNames.has(skill.name));
  }
}


const sortingPreset: Preset = {
  id: "preset-1",
  name: "工作 Preset",
  description: null,
  icon: null,
  sort_order: 0,
  skill_count: 2,
  created_at: 1,
  updated_at: 1,
};

const otherSortingPreset: Preset = {
  ...sortingPreset,
  id: "preset-2",
  name: "另一个 Preset",
};

function skill(
  id: string,
  name: string,
  options: Partial<ManagedSkill> = {},
): ManagedSkill {
  return {
    ...createSkill({
      id,
      name,
      sourceType: "local",
      updateStatus: "up_to_date",
      presetIds: [sortingPreset.id],
    }),
    description: null,
    central_path: `/skills/${name}`,
    enabled: false,
    ...options,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function visibleSkillNames() {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
}

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("zh");
});
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  appState.viewedPreset = null;
  appState.managedSkills = updateContractSkills;
  appState.detailSkillId = null;
  localStorage.clear();
  vi.clearAllMocks();
  apiMocks.getPresetSkillOrder.mockResolvedValue([]);
  apiMocks.gitBackupPendingConflicts.mockResolvedValue([]);
  apiMocks.getAllTags.mockResolvedValue(["核心", "扩展"]);
  apiMocks.getSettings.mockResolvedValue(null);
  apiMocks.gitBackupStatus.mockResolvedValue(null);
  apiMocks.reorderPresetSkills.mockResolvedValue(undefined);
});

afterEach(() => {
  const sortField = screen.queryByRole("combobox") as HTMLSelectElement | null;
  if (sortField && sortField.value !== "custom") {
    fireEvent.change(sortField, { target: { value: "custom" } });
  }
  cleanup();
  vi.restoreAllMocks();
});

describe("MySkills 有可用更新筛选", () => {
  it("按严格刷新契约筛选缓存状态，关闭后恢复列表且不触发更新入口", async () => {
    const user = userEvent.setup();
    renderPage();

    const filterButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "有可用更新",
    });
    expect(filterButton.getAttribute("aria-pressed")).toBe("false");
    expect(filterButton.textContent).toBe("有可用更新");

    await waitFor(() => expect(apiMocks.getAllTags).toHaveBeenCalled());
    vi.clearAllMocks();
    filterButton.focus();
    await user.keyboard("{Enter}");

    expect(filterButton.getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Git 可更新", "技能站可更新", "本地可更新", "导入可更新"]) {
      expectSkillVisible(name, true);
    }
    for (const skill of updateContractSkills.slice(4)) {
      expectSkillVisible(skill.name, false);
    }
    expect(apiMocks.checkAllSkillUpdates).not.toHaveBeenCalled();
    expect(apiMocks.checkSkillUpdate).not.toHaveBeenCalled();
    expect(apiMocks.gitBackupFetch).not.toHaveBeenCalled();
    expect(apiMocks.batchUpdateSkills).not.toHaveBeenCalled();
    expect(apiMocks.updateSkill).not.toHaveBeenCalled();
    expect(apiMocks.reimportLocalSkill).not.toHaveBeenCalled();
    expect(apiMocks.relinkLocalSkillSource).not.toHaveBeenCalled();
    expect(appState.refreshManagedSkills).not.toHaveBeenCalled();

    await user.click(filterButton);
    expect(filterButton.getAttribute("aria-pressed")).toBe("false");
    for (const skill of updateContractSkills) {
      expectSkillVisible(skill.name, true);
    }
  });

  it("与搜索、来源、标签和 Preset 条件组合，并在列表视图保持相同结果", async () => {
    const user = userEvent.setup();
    appState.viewedPreset = {
      id: "preset-a",
      name: "工作 Preset",
      description: null,
      icon: null,
      sort_order: 0,
      skill_count: 2,
      created_at: 1,
      updated_at: 1,
    };
    renderPage();

    await user.click(await screen.findByRole("button", { name: "有可用更新" }));
    expectOnlySkills(["Git 可更新", "技能站可更新", "本地可更新", "导入可更新"]);

    const search = screen.getByPlaceholderText("搜索中央仓库中的 Skills...");
    await user.type(search, "本地");
    expectOnlySkills(["本地可更新"]);
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: "Git" }));
    await user.click(screen.getByRole("button", { name: "本地" }));
    expectOnlySkills(["Git 可更新", "本地可更新"]);

    await user.click(screen.getByRole("button", { name: "核心" }));
    expectOnlySkills(["Git 可更新"]);
    await user.click(screen.getByRole("button", { name: "核心" }));

    await user.click(screen.getByRole("button", { name: "当前 Preset 已启用" }));
    expectOnlySkills(["Git 可更新"]);

    await user.click(screen.getByRole("button", { name: "列表视图" }));
    expectOnlySkills(["Git 可更新"]);
  });

  it("零结果时保留筛选入口，并可通过清除筛选恢复完整列表", async () => {
    const user = userEvent.setup();
    appState.managedSkills = [
      createSkill({
        id: "already-current",
        name: "已经最新",
        sourceType: "git",
        updateStatus: "up_to_date",
      }),
    ];
    renderPage();

    const filterButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "有可用更新",
    });
    await user.click(filterButton);

    expect(filterButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("heading", { name: "已经最新", level: 3 })).toBeNull();
    expect(screen.getByText("没有符合当前搜索或筛选条件的 Skills")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(filterButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: "已经最新", level: 3 })).not.toBeNull();
  });

  it("离开后重新进入页面会重置更新条件", async () => {
    const user = userEvent.setup();
    const firstPage = renderPage();
    const firstButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "有可用更新",
    });
    await user.click(firstButton);
    expect(firstButton.getAttribute("aria-pressed")).toBe("true");

    firstPage.unmount();
    renderPage();

    const nextButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "有可用更新",
    });
    expect(nextButton.getAttribute("aria-pressed")).toBe("false");
    for (const skill of updateContractSkills) {
      expectSkillVisible(skill.name, true);
    }
  });

  it("在三种界面语言中提供独立的筛选文案", async () => {
    for (const [language, label] of [
      ["zh", "有可用更新"],
      ["zh-TW", "有可用更新"],
      ["en", "Updates available"],
    ] as const) {
      await i18n.changeLanguage(language);
      const page = renderPage();
      expect(screen.getByRole("button", { name: label }).textContent).toBe(label);
      page.unmount();
    }
  });
});

describe("MySkills Git 来源仓库筛选", () => {
  beforeEach(() => {
    appState.managedSkills = repositoryFilterSkills;
  });

  it("只在明确选择 Git 来源后显示可访问的仓库多选，并保守归组来源仓库", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByRole("button", { name: "Git 仓库" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Git" }));

    const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Git 仓库" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");

    trigger.focus();
    await user.keyboard("{Enter}");

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const repositoryListbox = screen.getByRole("listbox", { name: "Git 仓库" });
    expect(repositoryListbox.getAttribute("aria-multiselectable")).toBe("true");
    const options = within(repositoryListbox).getAllByRole("option");
    expect(options).toHaveLength(4);
    expect(new Set(options.map((option) => option.textContent))).toEqual(new Set([
      "https://github.com/acme/tools",
      "git@github.com:acme/tools",
      "Acme/Tools",
      "acme/other",
    ]));
    for (const option of options) {
      expect(option.getAttribute("aria-selected")).toBe("false");
    }
    expect(within(repositoryListbox).queryByRole("option", { name: /market/ })).toBeNull();
  });

  it("仓库内部使用 OR，并且仓库条件只收窄直接 Git 来源分支", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Git" }));
    expectOnlyRepositorySkills([
      "工具仓主分支",
      "工具仓开发分支",
      "其他仓技能",
      "SCP 工具仓技能",
      "大小写工具仓技能",
      "缺少仓库身份的 Git Skill",
      "空仓库身份的 Git Skill",
    ]);

    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    const otherRepository = screen.getByRole("option", { name: "acme/other" });
    otherRepository.focus();
    await user.keyboard(" ");
    expect(otherRepository.getAttribute("aria-selected")).toBe("true");
    expectOnlyRepositorySkills(["其他仓技能"]);

    await user.click(screen.getByRole("button", { name: "本地" }));
    expectOnlyRepositorySkills(["其他仓技能", "本地技能"]);

    const toolsRepository = screen.getByRole("option", {
      name: "https://github.com/acme/tools",
    });
    await user.click(toolsRepository);
    expect(toolsRepository.getAttribute("aria-selected")).toBe("true");
    expectOnlyRepositorySkills([
      "工具仓主分支",
      "工具仓开发分支",
      "其他仓技能",
      "本地技能",
    ]);
  });

  it("取消并重新选择 Git 来源时不会恢复隐藏的仓库条件", async () => {
    const user = userEvent.setup();
    renderPage();

    const gitSource = await screen.findByRole("button", { name: "Git" });
    await user.click(gitSource);
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.click(screen.getByRole("option", { name: "acme/other" }));
    expectOnlyRepositorySkills(["其他仓技能"]);

    await user.click(gitSource);
    expect(screen.queryByRole("button", { name: "Git 仓库" })).toBeNull();
    for (const skill of repositoryFilterSkills) {
      expectSkillVisible(skill.name, true);
    }

    await user.click(gitSource);
    const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Git 仓库" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expectOnlyRepositorySkills([
      "工具仓主分支",
      "工具仓开发分支",
      "其他仓技能",
      "SCP 工具仓技能",
      "大小写工具仓技能",
      "缺少仓库身份的 Git Skill",
      "空仓库身份的 Git Skill",
    ]);
  });

  it("来源仓库从技能库消失时清理失效选择", async () => {
    const user = userEvent.setup();
    const page = renderPage();

    await user.click(await screen.findByRole("button", { name: "Git" }));
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.click(screen.getByRole("option", { name: "acme/other" }));
    expectOnlyRepositorySkills(["其他仓技能"]);
    await user.keyboard("{Escape}");

    appState.managedSkills = repositoryFilterSkills.filter((skill) => skill.id !== "git-other");
    page.rerender(
      <MemoryRouter>
        <MySkills />
      </MemoryRouter>,
    );

    await waitFor(() => expectSkillVisible("工具仓主分支", true));
    for (const skill of appState.managedSkills) {
      expectSkillVisible(skill.name, skill.source_type === "git");
    }
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    expect(screen.queryByRole("option", { name: "acme/other" })).toBeNull();
  });

  it("与更新、搜索、标签和 Preset 条件组合，并在列表视图保持相同结果", async () => {
    const user = userEvent.setup();
    appState.viewedPreset = {
      id: "preset-a",
      name: "工作 Preset",
      description: null,
      icon: null,
      sort_order: 0,
      skill_count: 3,
      created_at: 1,
      updated_at: 1,
    };
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Git" }));
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.click(screen.getByRole("option", { name: "https://github.com/acme/tools" }));
    await user.keyboard("{Escape}");
    expectOnlyRepositorySkills(["工具仓主分支", "工具仓开发分支"]);

    await user.click(screen.getByRole("button", { name: "有可用更新" }));
    expectOnlyRepositorySkills(["工具仓主分支"]);

    const search = screen.getByPlaceholderText("搜索中央仓库中的 Skills...");
    await user.type(search, "工具仓");
    expectOnlyRepositorySkills(["工具仓主分支"]);

    await user.click(await screen.findByRole("button", { name: "核心" }));
    expectOnlyRepositorySkills(["工具仓主分支"]);

    await user.click(screen.getByRole("button", { name: "当前 Preset 已启用" }));
    expectOnlyRepositorySkills(["工具仓主分支"]);

    await user.click(screen.getByRole("button", { name: "列表视图" }));
    expectOnlyRepositorySkills(["工具仓主分支"]);
  });

  it("清除筛选和重新进入页面都会重置仓库条件", async () => {
    const user = userEvent.setup();
    const firstPage = renderPage();

    const gitSource = await screen.findByRole("button", { name: "Git" });
    await user.click(gitSource);
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.click(screen.getByRole("option", { name: "acme/other" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByPlaceholderText("搜索中央仓库中的 Skills..."), "不存在");

    expect(screen.getByText("没有符合当前搜索或筛选条件的 Skills")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.queryByRole("button", { name: "Git 仓库" })).toBeNull();
    for (const skill of repositoryFilterSkills) {
      expectSkillVisible(skill.name, true);
    }

    await user.click(screen.getByRole("button", { name: "Git" }));
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.click(screen.getByRole("option", { name: "acme/other" }));
    firstPage.unmount();
    renderPage();

    expect(screen.queryByRole("button", { name: "Git 仓库" })).toBeNull();
    for (const skill of repositoryFilterSkills) {
      expectSkillVisible(skill.name, true);
    }
  });

  it("在三种界面语言中提供仓库筛选文案和可访问名称", async () => {
    for (const [language, label] of [
      ["zh", "Git 仓库"],
      ["zh-TW", "Git 倉庫"],
      ["en", "Git repositories"],
    ] as const) {
      await i18n.changeLanguage(language);
      const user = userEvent.setup();
      const page = renderPage();
      await user.click(screen.getByRole("button", { name: "Git" }));

      const trigger = screen.getByRole("button", { name: label });
      await user.click(trigger);
      expect(screen.getByRole("listbox", { name: label })).not.toBeNull();
      page.unmount();
    }
  });
});

describe("MySkills 排序", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    appState.viewedPreset = sortingPreset;
    appState.managedSkills = [];
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);
    apiMocks.gitBackupPendingConflicts.mockResolvedValue([]);
    apiMocks.getAllTags.mockResolvedValue([]);
    apiMocks.getSettings.mockResolvedValue("");
    apiMocks.gitBackupStatus.mockResolvedValue(null);
    apiMocks.reorderPresetSkills.mockResolvedValue(undefined);
  });
  it("等待自定义顺序读取完成后再按 Preset 顺序展示完整分组", async () => {
    const order = deferred<string[]>();
    apiMocks.getPresetSkillOrder.mockReturnValue(order.promise);

    renderPage([
      skill("available", "Available", { preset_ids: [] }),
      skill("enabled-b", "Enabled B"),
      skill("enabled-a", "Enabled A"),
    ]);

    expect(
      screen.getByRole("status", { name: "Loading custom order" }),
    ).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();

    order.resolve(["enabled-a", "enabled-b"]);

    await waitFor(() =>
      expect(visibleSkillNames()).toEqual([
        "Enabled A",
        "Enabled B",
        "Available",
      ]),
    );
  });

  it("按可见名称进行忽略大小写的自然排序，并支持反向浏览", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue([
      "same-a",
      "same-b",
      "beta-b",
      "beta-a",
    ]);

    renderPage([
      skill("available", "Available 0", { preset_ids: [] }),
      skill("same-a", "Duplicate", { central_path: "/skills/Skill 10" }),
      skill("same-b", "Duplicate", { central_path: "/skills/skill 2" }),
      skill("beta-b", "Beta"),
      skill("beta-a", "beta"),
    ]);

    await waitFor(() => expect(visibleSkillNames()).toHaveLength(5));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "name",
    );

    expect(visibleSkillNames()).toEqual([
      "beta",
      "Beta",
      "skill 2",
      "Skill 10",
      "Available 0",
    ]);

    const direction = screen.getByRole("button", {
      name: "Switch to descending",
    });
    expect((direction as HTMLButtonElement).disabled).toBe(false);
    await user.click(direction);

    expect(visibleSkillNames()).toEqual([
      "Skill 10",
      "skill 2",
      "beta",
      "Beta",
      "Available 0",
    ]);
  });

  it("按添加和更新时间排序，并让缺失时间始终位于有效时间之后", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);

    renderPage([
      skill("missing", "Missing", { created_at: 0, updated_at: 0 }),
      skill("old", "Old", { created_at: 100, updated_at: 900 }),
      skill("new", "New", { created_at: 300, updated_at: 100 }),
      skill("tie-z", "Same", { created_at: 200, updated_at: 500 }),
      skill("tie-a", "Same", { created_at: 200, updated_at: 500 }),
    ]);

    await waitFor(() => expect(visibleSkillNames()).toHaveLength(5));
    const field = screen.getByRole("combobox", { name: "Sort skills" });

    await user.selectOptions(field, "created");
    expect(visibleSkillNames()).toEqual([
      "New",
      "Same",
      "Same",
      "Old",
      "Missing",
    ]);

    await user.click(screen.getByRole("button", { name: "Switch to ascending" }));
    expect(visibleSkillNames()).toEqual([
      "Old",
      "Same",
      "Same",
      "New",
      "Missing",
    ]);

    await user.selectOptions(field, "updated");
    expect(visibleSkillNames()).toEqual([
      "Old",
      "Same",
      "Same",
      "New",
      "Missing",
    ]);

    await user.click(screen.getByRole("button", { name: "Switch to ascending" }));
    expect(visibleSkillNames()).toEqual([
      "New",
      "Same",
      "Same",
      "Old",
      "Missing",
    ]);
  });

  it("离开后在其他 Preset 的第一次可见结果中恢复字段和方向", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);
    const first = renderPage([
      skill("a", "Alpha"),
      skill("b", "Beta"),
    ]);

    await waitFor(() => expect(visibleSkillNames()).toHaveLength(2));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "name",
    );
    await user.click(screen.getByRole("button", { name: "Switch to descending" }));
    expect(visibleSkillNames()).toEqual(["Beta", "Alpha"]);
    first.unmount();

    const unresolvedOrder = deferred<string[]>();
    apiMocks.getPresetSkillOrder.mockReturnValue(unresolvedOrder.promise);
    renderPage(
      [
        skill("a", "Alpha", { preset_ids: [otherSortingPreset.id] }),
        skill("b", "Beta", { preset_ids: [otherSortingPreset.id] }),
      ],
      otherSortingPreset,
    );

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("name");
    expect(visibleSkillNames()).toEqual(["Beta", "Alpha"]);
    expect(screen.queryByRole("status", { name: "Loading custom order" })).toBeNull();
  });

  it("仅在自定义顺序展示完整已启用集合时提供拖动入口", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue(["enabled-a", "enabled-b"]);
    apiMocks.getAllTags.mockResolvedValue(["重要"]);

    renderPage([
      skill("enabled-a", "Alpha", {
        source_type: "git",
        update_status: "update_available",
        tags: ["重要"],
      }),
      skill("enabled-b", "Beta"),
      skill("available", "Gamma", { preset_ids: [] }),
    ]);

    await waitFor(() =>
      expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2),
    );

    const field = screen.getByRole("combobox", { name: "Sort skills" });
    await user.selectOptions(field, "name");
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();

    await user.selectOptions(field, "custom");
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);

    const search = screen.getByPlaceholderText("Search skills in the central library...");
    await user.type(search, "Alpha");
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
    expect(
      screen.getByText("Clear the current filters to reorder the custom order."),
    ).not.toBeNull();

    await user.clear(search);
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);

    await user.type(search, " ");
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Local" }));

    await user.click(await screen.findByRole("button", { name: "重要" }));
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重要" }));

    const updateFilter = screen.getByRole("button", { name: "Updates available" });
    await user.click(updateFilter);
    expect(updateFilter.getAttribute("aria-pressed")).toBe("true");
    expect(visibleSkillNames()).toEqual(["Alpha"]);
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();

    await user.selectOptions(field, "name");
    await user.selectOptions(field, "custom");
    expect(updateFilter.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();

    await user.click(updateFilter);
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Enabled" }));
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Available" }));
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
  });

  it("网格和列表共享排序，并在排序后保留搜索与多选身份", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue(["beta", "alpha"]);
    renderPage([
      skill("beta", "Beta", { updated_at: 100 }),
      skill("alpha", "Alpha", { updated_at: 200 }),
    ]);

    await waitFor(() => expect(visibleSkillNames()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("heading", { level: 3, name: "Beta" }));
    expect(screen.getByText("1 selected")).not.toBeNull();

    const search = screen.getByPlaceholderText("Search skills in the central library...");
    await user.type(search, "a");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "updated",
    );
    expect((search as HTMLInputElement).value).toBe("a");
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta"]);
    expect(screen.getByText("1 selected")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta"]);
    expect(screen.getByText("1 selected")).not.toBeNull();
  });

  it("没有可用 Preset 时以名称升序稳定回退且不允许拖动", () => {
    renderPage([
      skill("ten", "Skill 10", { preset_ids: [] }),
      skill("two", "skill 2", { preset_ids: [] }),
    ], null);

    expect(visibleSkillNames()).toEqual(["skill 2", "Skill 10"]);
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Custom order has no direction" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(apiMocks.getPresetSkillOrder).not.toHaveBeenCalled();
  });

  it("自动排序不会写回手动顺序，切回后恢复原有排列", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue(["beta", "alpha"]);
    renderPage([
      skill("alpha", "Alpha"),
      skill("beta", "Beta"),
    ]);

    await waitFor(() => expect(visibleSkillNames()).toEqual(["Beta", "Alpha"]));
    const field = screen.getByRole("combobox", { name: "Sort skills" });
    await user.selectOptions(field, "name");
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta"]);
    await user.selectOptions(field, "custom");
    expect(visibleSkillNames()).toEqual(["Beta", "Alpha"]);
    expect(apiMocks.reorderPresetSkills).not.toHaveBeenCalled();
  });

  it("损坏或未知的本机偏好静默回退到自定义顺序", async () => {
    const user = userEvent.setup();
    const first = renderPage([skill("alpha", "Alpha")]);
    await waitFor(() => expect(visibleSkillNames()).toEqual(["Alpha"]));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "updated",
    );
    first.unmount();

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) localStorage.setItem(key, "{unknown preference");
    }

    const unresolvedOrder = deferred<string[]>();
    apiMocks.getPresetSkillOrder.mockReturnValue(unresolvedOrder.promise);
    renderPage([skill("alpha", "Alpha")]);

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("custom");
    expect(screen.getByRole("status", { name: "Loading custom order" })).not.toBeNull();
  });

  it("本机存储读取异常时从会话内存恢复排序", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);
    const first = renderPage([
      skill("beta", "Beta"),
      skill("alpha", "Alpha"),
    ]);
    await waitFor(() => expect(visibleSkillNames()).toHaveLength(2));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "name",
    );
    first.unmount();

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage read failed");
    });
    renderPage([
      skill("beta", "Beta"),
      skill("alpha", "Alpha"),
    ]);

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("name");
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta"]);
    getItem.mockRestore();
  });

  it("本机存储写入异常时让最新会话排序覆盖旧存储值", async () => {
    const user = userEvent.setup();
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);
    const first = renderPage([
      skill("beta", "Beta"),
      skill("alpha", "Alpha"),
    ]);
    await waitFor(() => expect(visibleSkillNames()).toHaveLength(2));

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage write failed");
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort skills" }),
      "name",
    );
    first.unmount();

    renderPage([
      skill("beta", "Beta"),
      skill("alpha", "Alpha"),
    ]);

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("name");
    expect(visibleSkillNames()).toEqual(["Alpha", "Beta"]);
    setItem.mockRestore();
  });

  it("简体中文、繁体中文和英文都提供可理解的排序控件名称", async () => {
    apiMocks.getPresetSkillOrder.mockResolvedValue([]);
    const cases = [
      { language: "zh", label: "排序 Skills", custom: "自定义顺序" },
      { language: "zh-TW", label: "排序 Skills", custom: "自訂順序" },
      { language: "en", label: "Sort skills", custom: "Custom order" },
    ];

    for (const testCase of cases) {
      await i18n.changeLanguage(testCase.language);
      const page = renderPage([skill("alpha", "Alpha")]);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: testCase.label })).not.toBeNull(),
      );
      expect(screen.getByRole("option", { name: testCase.custom })).not.toBeNull();
      page.unmount();
    }
  });
});
