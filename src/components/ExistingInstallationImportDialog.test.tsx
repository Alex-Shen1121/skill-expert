// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import {
  ExistingInstallationImportGate,
  type ExistingInstallationImportService,
} from "./ExistingInstallationImportDialog";

const restorePrompt = <div data-testid="restore-prompt">Restore prompt</div>;

function renderGate(service: ExistingInstallationImportService) {
  return render(
    <ExistingInstallationImportGate service={service}>
      {restorePrompt}
    </ExistingInstallationImportGate>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("ExistingInstallationImportDialog", () => {
  it("stays hidden when no usable upstream installation is available", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      state: "not_available",
      should_prompt: false,
      source_path: null,
      backup_path: null,
      error: null,
    });
    const service: ExistingInstallationImportService = {
      getStatus,
      choose: vi.fn(),
      restart: vi.fn(),
    };

    renderGate(service);

    await waitFor(() => expect(getStatus).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("restore-prompt")).not.toBeNull();
  });

  it("offers the import choice when an available upstream installation has not been handled", async () => {
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "prompt",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: null,
        error: null,
      }),
      choose: vi.fn(),
      restart: vi.fn(),
    };

    renderGate(service);

    expect(
      await screen.findByRole("dialog", { name: "Import data from the upstream product?" }),
    ).not.toBeNull();
    expect(screen.queryByTestId("restore-prompt")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Import Existing Data" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start Fresh" }).disabled).toBe(false);
  });

  it("keeps keyboard focus inside the startup gate instead of reaching application controls", async () => {
    const user = userEvent.setup();
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "prompt",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: null,
        error: null,
      }),
      choose: vi.fn(),
      restart: vi.fn(),
    };

    renderGate(service);

    const startFresh = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Start Fresh",
    });
    const importExisting = screen.getByRole<HTMLButtonElement>("button", {
      name: "Import Existing Data",
    });
    expect(screen.queryByTestId("restore-prompt")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(startFresh));

    await user.tab();
    expect(document.activeElement).toBe(importExisting);
    await user.tab();
    expect(document.activeElement).toBe(startFresh);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(importExisting);
  });

  it("persists Start Fresh and closes without restarting", async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "prompt",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: null,
        error: null,
      }),
      choose,
      restart,
    };

    renderGate(service);
    await user.click(await screen.findByRole("button", { name: "Start Fresh" }));

    await waitFor(() => expect(choose).toHaveBeenCalledWith("fresh"));
    expect(restart).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("restore-prompt")).not.toBeNull();
  });

  it("stages an approved import before requesting a restart", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "prompt",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: null,
        error: null,
      }),
      choose: vi.fn().mockImplementation(async (choice, confirmedSource) => {
        calls.push(`choose:${choice}:${confirmedSource}`);
      }),
      restart: vi.fn().mockImplementation(async () => {
        calls.push("restart");
      }),
    };

    renderGate(service);
    await user.click(await screen.findByRole("button", { name: "Import Existing Data" }));

    await waitFor(() =>
      expect(calls).toEqual([
        "choose:import:/Users/alex/.skills-manager",
        "restart",
      ]),
    );
  });

  it("shows a recoverable failure and leaves both choices available", async () => {
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "failed",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: "/Users/alex/.skill-expert.pre-import-backup",
        error: "refusing to import symlink shared",
      }),
      choose: vi.fn(),
      restart: vi.fn(),
    };

    renderGate(service);

    expect((await screen.findByRole("alert")).textContent).toContain("refusing to import symlink shared");
    expect(screen.getByText("/Users/alex/.skill-expert.pre-import-backup")).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Import Existing Data" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start Fresh" }).disabled).toBe(false);
  });

  it("blocks the restore prompt and surfaces a structured status-loading failure", async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValueOnce({ kind: "internal", message: "import state is corrupt" })
      .mockResolvedValueOnce({
        state: "not_available",
        should_prompt: false,
        source_path: null,
        backup_path: null,
        error: null,
      });
    const service: ExistingInstallationImportService = {
      getStatus,
      choose: vi.fn(),
      restart: vi.fn(),
    };

    renderGate(service);

    expect((await screen.findByRole("alert")).textContent).toContain("import state is corrupt");
    expect(screen.queryByTestId("restore-prompt")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("restore-prompt")).not.toBeNull();
  });

  it("renders structured choice failures as their message instead of object text", async () => {
    const user = userEvent.setup();
    const service: ExistingInstallationImportService = {
      getStatus: vi.fn().mockResolvedValue({
        state: "prompt",
        should_prompt: true,
        source_path: "/Users/alex/.skills-manager",
        backup_path: null,
        error: null,
      }),
      choose: vi.fn().mockRejectedValue({
        kind: "invalid_input",
        message: "confirmed source is no longer available",
      }),
      restart: vi.fn(),
    };

    renderGate(service);
    await user.click(await screen.findByRole("button", { name: "Import Existing Data" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "confirmed source is no longer available",
    );
    expect(screen.queryByText("[object Object]")).toBeNull();
  });
});
