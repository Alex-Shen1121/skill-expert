// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { InstallSkills } from "./InstallSkills";
import { useApp } from "../context/AppContext";
import i18n, { i18nReady } from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../context/AppContext", () => ({ useApp: vi.fn() }));
const canonical = "https://skills.sh/site/example.com/demo";
const alias = "https://www.skills.sh/site/EXAMPLE.COM/demo";
const existing = { id: "installed", name: "demo", source_type: "well-known", source_ref: canonical };

beforeAll(async () => {
  await i18nReady; await i18n.changeLanguage("zh");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  // The page only reads these context fields; the full provider owns unrelated app state.
  vi.mocked(useApp).mockReturnValue({ managedSkills: [existing], refreshPresets: vi.fn(), refreshManagedSkills: vi.fn(), openSkillDetailById: vi.fn() } as unknown as ReturnType<typeof useApp>);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "fetch_leaderboard") return [
      { id: "one", name: "demo", skill_id: "demo", source: "example.com", installs: 1 },
      { id: "two", name: "other", skill_id: "demo", source: "other.com", installs: 1 },
    ];
    if (command === "preview_git_install") return { temp_dir: "preview", skills: [{ rel_path: "skill", name: "demo", description: null }] };
    return null;
  });
});
afterEach(cleanup);
const renderPage = (tab: string) => render(<MemoryRouter initialEntries={[`/install?tab=${tab}`]}><InstallSkills /></MemoryRouter>);

it("市场按网站来源标记安装状态，不把另一个站点的同名技能标为已安装", async () => {
  renderPage("market");
  await screen.findByRole("heading", { name: "demo" });
  expect(screen.getAllByTitle(i18n.t("install.installed"))).toHaveLength(1);
  expect(screen.getAllByTitle(i18n.t("install.oneClickInstall"))).toHaveLength(1);
  await userEvent.click(screen.getByTitle(i18n.t("install.oneClickInstall")));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("install_from_skillssh", { source: "other.com", skillId: "demo" }));
});

it("重装预览显示覆盖提示，用户确认后才传递替换授权", async () => {
  renderPage("git");
  fireEvent.change(screen.getByPlaceholderText(i18n.t("install.repoUrlPlaceholder")), { target: { value: alias } });
  await userEvent.click(screen.getByRole("button", { name: i18n.t("install.gitReinstall") }));
  await screen.findByText(i18n.t("install.websiteReplace"));
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "confirm_git_install")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: i18n.t("install.gitPreview.confirm") }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("confirm_git_install", { repoUrl: alias, tempDir: "preview", items: [{ rel_path: "skill", name: "demo" }], replace: true }));
});

it("取消预览只清理下载，不提交安装；失败后允许重新下载", async () => {
  renderPage("git");
  fireEvent.change(screen.getByPlaceholderText(i18n.t("install.repoUrlPlaceholder")), { target: { value: alias } });
  await userEvent.click(screen.getByRole("button", { name: i18n.t("install.gitReinstall") }));
  await screen.findByText(i18n.t("install.websiteReplace"));
  await userEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
  expect(invoke).toHaveBeenCalledWith("cancel_git_preview", { tempDir: "preview" });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "confirm_git_install")).toBe(false);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_git_install") return { temp_dir: "new-preview", skills: [{ rel_path: "skill", name: "demo", description: null }] };
    if (command === "confirm_git_install") throw { kind: "cancelled", message: "cancelled" };
    return null;
  });
  await userEvent.click(screen.getByRole("button", { name: i18n.t("install.gitReinstall") }));
  await screen.findByText(i18n.t("install.websiteReplace"));
  await userEvent.click(screen.getByRole("button", { name: i18n.t("install.gitPreview.confirm") }));
  await waitFor(() => expect(screen.queryByText(i18n.t("install.websiteReplace"))).toBeNull());
  expect(screen.getByRole("button", { name: i18n.t("install.gitReinstall") }).hasAttribute("disabled")).toBe(false);
});
