// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import { Sidebar } from "./Sidebar";

const appContext = vi.hoisted(() => ({
  presets: [],
  viewedPreset: null,
  setViewedPresetId: vi.fn(),
  refreshPresets: vi.fn(),
  refreshManagedSkills: vi.fn(),
  projects: [],
  refreshProjects: vi.fn(),
  tools: [],
  managedSkills: [],
  appUpdate: null,
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => children,
  Droppable: () => null,
  Draggable: () => null,
}));

vi.mock("../context/AppContext", () => ({
  useApp: () => appContext,
}));

beforeAll(async () => {
  await i18nReady;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("Sidebar 插件入口", () => {
  it("把插件作为顶层导航并正确表达当前页面", () => {
    render(
      <MemoryRouter initialEntries={["/plugins"]}>
        <Sidebar />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "插件" });
    expect(link.getAttribute("href")).toBe("/plugins");
    expect(link.className).toContain("bg-surface-active");
  });
});
