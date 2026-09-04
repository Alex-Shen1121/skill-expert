// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInfo } from "../lib/tauri";
import { SettingsHierarchyPrototype } from "./SettingsHierarchyPrototype";

const tools: ToolInfo[] = [
  {
    key: "codex",
    display_name: "Codex",
    installed: true,
    skills_dir: "/tmp/codex/skills",
    enabled: true,
    is_custom: false,
    has_path_override: false,
    project_relative_skills_dir: ".codex/skills",
    has_project_path_override: false,
    category: "coding",
  },
  {
    key: "claude-code",
    display_name: "Claude Code",
    installed: true,
    skills_dir: "/tmp/claude/skills",
    enabled: true,
    is_custom: false,
    has_path_override: false,
    project_relative_skills_dir: ".claude/skills",
    has_project_path_override: false,
    category: "coding",
  },
];

afterEach(() => cleanup());

describe("设置页信息分层原型开关", () => {
  it("使用固定左右位置移动滑块，而不是从未锚定的位置做变换", async () => {
    window.history.replaceState(null, "", "/settings?variant=A");
    const user = userEvent.setup();
    render(<SettingsHierarchyPrototype tools={tools} />);

    await user.click(screen.getByRole("button", { name: /Agent 管理 Skills/ }));

    const enabledSwitch = screen.getByRole("switch", {
      name: "关闭 Codex 的管理能力",
    });
    const disabledSwitch = screen.getByRole("switch", {
      name: "开启 Claude Code 的管理能力",
    });

    expect(enabledSwitch.firstElementChild?.classList.contains("left-[16px]")).toBe(true);
    expect(disabledSwitch.firstElementChild?.classList.contains("left-0.5")).toBe(true);

    await user.click(disabledSwitch);
    expect(disabledSwitch.getAttribute("aria-checked")).toBe("true");
    expect(disabledSwitch.firstElementChild?.classList.contains("left-[16px]")).toBe(true);
  });
});
