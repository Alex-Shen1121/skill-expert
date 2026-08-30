import { reimportLocalSkill, updateSkill } from "./tauri";
import type { ManagedSkill, PendingRemoval } from "./tauri";

export type SkillRefreshOutcome =
  | { status: "updated" | "unchanged" }
  | {
      status: "needs_confirmation";
      pendingRemovals: PendingRemoval[];
      removalApproval: string | null;
    };

export function canRefreshSkill(skill: ManagedSkill) {
  return (
    skill.source_type === "git"
    || skill.source_type === "skillssh"
    || (
      (skill.source_type === "local" || skill.source_type === "import")
      && Boolean(skill.source_ref?.trim())
    )
  );
}

export function hasAvailableUpdate(skill: ManagedSkill) {
  return skill.update_status === "update_available" && canRefreshSkill(skill);
}

export async function refreshManagedSkill(
  skill: ManagedSkill,
  approvedRemovals?: string,
): Promise<SkillRefreshOutcome> {
  if (skill.source_type === "local" || skill.source_type === "import") {
    const result = await reimportLocalSkill(skill.id, approvedRemovals);
    return result.pending_removals.length > 0
      ? {
          status: "needs_confirmation",
          pendingRemovals: result.pending_removals,
          removalApproval: result.removal_approval,
        }
      : { status: "updated" };
  }

  const result = await updateSkill(skill.id, approvedRemovals);
  return result.pending_removals.length > 0
    ? {
        status: "needs_confirmation",
        pendingRemovals: result.pending_removals,
        removalApproval: result.removal_approval,
      }
    : { status: result.content_changed ? "updated" : "unchanged" };
}
