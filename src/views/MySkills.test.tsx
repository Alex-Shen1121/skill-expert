// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import type { ManagedSkill, Preset } from "../lib/tauri";
import { MySkills } from "./MySkills";

const mocks = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  getPresetSkillOrder: vi.fn(),
  gitBackupPendingConflicts: vi.fn(),
  getAllTags: vi.fn(),
  getSettings: vi.fn().mockResolvedValue(""),
  gitBackupStatus: vi.fn(),
  reorderPresetSkills: vi.fn(),
}));

vi.mock("../context/AppContext", () => ({
  useApp: () => mocks.appState,
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...actual,
    getPresetSkillOrder: mocks.getPresetSkillOrder,
    gitBackupPendingConflicts: mocks.gitBackupPendingConflicts,
    getAllTags: mocks.getAllTags,
    getSettings: mocks.getSettings,
    gitBackupStatus: mocks.gitBackupStatus,
    reorderPresetSkills: mocks.reorderPresetSkills,
  };
});

const preset: Preset = {
  id: "preset-1",
  name: "工作 Preset",
  description: null,
  icon: null,
  sort_order: 0,
  skill_count: 2,
  created_at: 1,
  updated_at: 1,
};

const otherPreset: Preset = {
  ...preset,
  id: "preset-2",
  name: "另一个 Preset",
};

function skill(
  id: string,
  name: string,
  options: Partial<ManagedSkill> = {},
): ManagedSkill {
  return {
    id,
    name,
    description: null,
    source_type: "local",
    source_ref: null,
    source_ref_resolved: null,
    source_subpath: null,
    source_branch: null,
    source_revision: null,
    remote_revision: null,
    update_status: "up_to_date",
    last_checked_at: null,
    last_check_error: null,
    central_path: `/skills/${name}`,
    enabled: false,
    created_at: 1,
    updated_at: 1,
    status: "ready",
    targets: [],
    preset_ids: [preset.id],
    tags: [],
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

function renderPage(skills: ManagedSkill[], viewedPreset: Preset | null = preset) {
  mocks.appState = {
    viewedPreset,
    tools: [],
    managedSkills: skills,
    refreshPresets: vi.fn().mockResolvedValue(undefined),
    refreshManagedSkills: vi.fn().mockResolvedValue(undefined),
    detailSkillId: null,
    openSkillDetailById: vi.fn(),
    closeSkillDetail: vi.fn(),
    projects: [],
    refreshProjects: vi.fn().mockResolvedValue(undefined),
  };

  return render(
    <MemoryRouter>
      <MySkills />
    </MemoryRouter>,
  );
}

function visibleSkillNames() {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
}

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getPresetSkillOrder.mockResolvedValue([]);
  mocks.gitBackupPendingConflicts.mockResolvedValue([]);
  mocks.getAllTags.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue("");
  mocks.gitBackupStatus.mockResolvedValue(null);
  mocks.reorderPresetSkills.mockResolvedValue(undefined);
});

afterEach(() => {
  const sortField = screen.queryByRole("combobox") as HTMLSelectElement | null;
  if (sortField && sortField.value !== "custom") {
    fireEvent.change(sortField, { target: { value: "custom" } });
  }
  cleanup();
  vi.restoreAllMocks();
});

describe("MySkills 排序", () => {
  it("等待自定义顺序读取完成后再按 Preset 顺序展示完整分组", async () => {
    const order = deferred<string[]>();
    mocks.getPresetSkillOrder.mockReturnValue(order.promise);

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
    mocks.getPresetSkillOrder.mockResolvedValue([
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
    mocks.getPresetSkillOrder.mockResolvedValue([]);

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
    mocks.getPresetSkillOrder.mockResolvedValue([]);
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
    mocks.getPresetSkillOrder.mockReturnValue(unresolvedOrder.promise);
    renderPage(
      [
        skill("a", "Alpha", { preset_ids: [otherPreset.id] }),
        skill("b", "Beta", { preset_ids: [otherPreset.id] }),
      ],
      otherPreset,
    );

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("name");
    expect(visibleSkillNames()).toEqual(["Beta", "Alpha"]);
    expect(screen.queryByRole("status", { name: "Loading custom order" })).toBeNull();
  });

  it("仅在自定义顺序展示完整已启用集合时提供拖动入口", async () => {
    const user = userEvent.setup();
    mocks.getPresetSkillOrder.mockResolvedValue(["enabled-a", "enabled-b"]);
    mocks.getAllTags.mockResolvedValue(["重要"]);

    renderPage([
      skill("enabled-a", "Alpha", { tags: ["重要"] }),
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
      screen.getByText("Clear search and source or tag filters to reorder the custom order."),
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

    await user.click(screen.getByRole("button", { name: "Enabled" }));
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Available" }));
    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
  });

  it("网格和列表共享排序，并在排序后保留搜索与多选身份", async () => {
    const user = userEvent.setup();
    mocks.getPresetSkillOrder.mockResolvedValue(["beta", "alpha"]);
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
    expect(mocks.getPresetSkillOrder).not.toHaveBeenCalled();
  });

  it("自动排序不会写回手动顺序，切回后恢复原有排列", async () => {
    const user = userEvent.setup();
    mocks.getPresetSkillOrder.mockResolvedValue(["beta", "alpha"]);
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
    expect(mocks.reorderPresetSkills).not.toHaveBeenCalled();
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
    mocks.getPresetSkillOrder.mockReturnValue(unresolvedOrder.promise);
    renderPage([skill("alpha", "Alpha")]);

    expect(
      (screen.getByRole("combobox", { name: "Sort skills" }) as HTMLSelectElement).value,
    ).toBe("custom");
    expect(screen.getByRole("status", { name: "Loading custom order" })).not.toBeNull();
  });

  it("本机存储读取异常时从会话内存恢复排序", async () => {
    const user = userEvent.setup();
    mocks.getPresetSkillOrder.mockResolvedValue([]);
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
    mocks.getPresetSkillOrder.mockResolvedValue([]);
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
    mocks.getPresetSkillOrder.mockResolvedValue([]);
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
