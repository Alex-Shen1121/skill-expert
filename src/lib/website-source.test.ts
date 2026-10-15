import { expect, it, vi } from "vitest";
import { marketSourceRef, websiteSourceRef } from "./website-source";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

it("matches a website installed from a www link to its market card without merging other sites", () => {
  const installed = websiteSourceRef(" https://www.skills.sh/site/EXAMPLE.COM/demo ");
  expect(marketSourceRef("site/example.com", "demo")).toBe(installed);
  expect(marketSourceRef("example.com", "demo")).toBe(installed);
  expect(marketSourceRef("site/another.com", "demo")).not.toBe(installed);
  expect(marketSourceRef("owner/repo", "demo")).toBe("owner/repo/demo");
});

it("does not mark malformed or insecure website links as installed", () => {
  for (const url of ["http://skills.sh/site/example.com/demo", "https://skills.sh/site/example.com/demo/extra", "https://other.com/site/example.com/demo", "https://user@skills.sh/site/example.com/demo", "https://skills.sh/site/example.com/a%2fb"]) {
    expect(websiteSourceRef(url)).toBeNull();
  }
});

it("passes an explicit replacement acknowledgment to the desktop confirmation command", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const { confirmGitInstall } = await import("./tauri");
  await confirmGitInstall("https://skills.sh/site/example.com/demo", "preview", [{ rel_path: "skill", name: "demo" }], true);
  expect(invoke).toHaveBeenCalledWith("confirm_git_install", expect.objectContaining({ replace: true }));
});
