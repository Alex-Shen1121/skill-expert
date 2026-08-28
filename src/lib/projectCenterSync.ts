import type { ProjectSkill } from "./tauri";

export interface ProjectCenterVariant {
  agent: string;
  relativePath: string;
  syncStatus: ProjectSkill["sync_status"];
}

export interface ProjectCenterAdapter {
  updateToCenter: (projectId: string, relativePath: string, agent: string) => Promise<void>;
  updateFromCenter: (projectId: string, relativePath: string, agent: string) => Promise<void>;
}

export type ProjectCenterSyncResult =
  | { status: "success" }
  | { status: "conflict"; conflicting: number }
  | { status: "partial"; alignFailed: number };

export async function updateProjectGroupToCenter(
  projectId: string,
  variants: ProjectCenterVariant[],
  adapter: ProjectCenterAdapter
): Promise<ProjectCenterSyncResult> {
  const unproven = variants.filter((variant) => variant.syncStatus !== "in_sync");
  if (unproven.length > 1) {
    return { status: "conflict", conflicting: unproven.length };
  }

  const winner = unproven[0] ?? variants[0];
  if (!winner) {
    throw new Error("项目 Skill 至少需要一个 Agent 副本");
  }

  await adapter.updateToCenter(projectId, winner.relativePath, winner.agent);
  let alignFailed = 0;
  for (const variant of variants) {
    if (variant === winner) continue;
    try {
      await adapter.updateFromCenter(projectId, variant.relativePath, variant.agent);
    } catch {
      alignFailed += 1;
    }
  }
  return alignFailed > 0 ? { status: "partial", alignFailed } : { status: "success" };
}
