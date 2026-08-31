import type { ManagedSkill } from "./tauri";
import * as api from "./tauri";

export const MANAGEMENT_SKILL_NAME = "manage-skills";
export const MANAGEMENT_SKILL_SOURCE =
  "https://github.com/Alex-Shen1121/skill-expert/tree/main/skills/manage-skills";
export const AGENT_SKILLS_ONBOARDING_SETTING_KEY = "agent_control_setup_prompt";
const MANAGEMENT_SKILL_REPOSITORY =
  "https://github.com/Alex-Shen1121/skill-expert";
const MANAGEMENT_SKILL_SUBPATH = "skills/manage-skills";

function normalizeRepositoryUrl(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
}

export function isTrustedManagementSkill(skill: ManagedSkill): boolean {
  if (skill.name !== MANAGEMENT_SKILL_NAME || skill.source_type !== "git") return false;
  if (skill.source_ref === MANAGEMENT_SKILL_SOURCE) return true;
  return (
    normalizeRepositoryUrl(skill.source_ref_resolved) === MANAGEMENT_SKILL_REPOSITORY &&
    skill.source_subpath?.replace(/^\/+|\/+$/g, "") === MANAGEMENT_SKILL_SUBPATH &&
    skill.source_branch === "main"
  );
}

export async function ensureTrustedManagementSkill(
  managedSkills: ManagedSkill[],
): Promise<ManagedSkill | null> {
  const existing = managedSkills.find(isTrustedManagementSkill);
  if (existing) return existing;

  await api.installGit(MANAGEMENT_SKILL_SOURCE);
  const skills = await api.getManagedSkills();
  return skills.find(isTrustedManagementSkill) ?? null;
}

export async function markAgentSkillsOnboardingComplete(): Promise<void> {
  await api
    .setSettings(AGENT_SKILLS_ONBOARDING_SETTING_KEY, "installed")
    .catch(() => {});
}
