// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../i18n";
import { StartupGate } from "./StartupGate";
const mocks = vi.hoisted(() => ({ getSettings: vi.fn().mockResolvedValue(null), getStartupFailure: vi.fn(), restartApp: vi.fn(), appExit: vi.fn(), writeText: vi.fn() }));
vi.mock("../lib/tauri", () => mocks);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
beforeAll(async () => { await i18nReady; await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("does not mount normal application on failed startup and provides real actions", async () => {
  mocks.getStartupFailure.mockResolvedValue({ stage: "agent_configuration", code: "invalid JSON", setting: "custom_tools", retryable: false, diagnostics: "version=1.0.21" });
  mocks.restartApp.mockResolvedValue(undefined);
  mocks.appExit.mockResolvedValue(undefined);
  mocks.writeText.mockRejectedValueOnce(new Error("clipboard unavailable")).mockResolvedValue(undefined);
  const mounted = vi.fn();
  function Normal() { mounted(); return <div>normal app</div>; }
  render(<StartupGate><Normal /></StartupGate>);
  await screen.findByRole("heading", { name: "Configuration check failed; startup blocked" });
  expect(mounted).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Copy sanitized diagnostics" }));
  expect(await screen.findByText("Copy failed; you can retry")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy sanitized diagnostics" }));
  expect(mocks.writeText).toHaveBeenLastCalledWith("version=1.0.21");
  await user.click(screen.getByRole("button", { name: "Restart application" }));
  expect(mocks.restartApp).toHaveBeenCalledOnce();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Restart application" }).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Exit" }));
  expect(mocks.appExit).toHaveBeenCalledOnce();
  expect(mounted).not.toHaveBeenCalled();
});
it("mounts normal application only after confirmed successful initialization", async () => {
  mocks.getStartupFailure.mockResolvedValue(null);
  render(<StartupGate><div>normal app</div></StartupGate>);
  await waitFor(() => expect(screen.getByText("normal app")).toBeTruthy());
});
