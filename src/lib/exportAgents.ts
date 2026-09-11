import type { ProjectAgentTarget } from "./tauri";

const PROJECT_EXPORT_AGENT_PRIORITY = ["claude_code", "codex", "cursor", "gemini_cli", "github_copilot"];

/** 只有已安装且已启用的 Agent 才能接收项目 Skill。 */
export function enabledInstalledAgentKeys(targets: ProjectAgentTarget[]): string[] {
  return targets.filter((target) => target.installed && target.enabled).map((target) => target.key);
}

/** 按固定优先级排列，并保留其余可用 Agent 的检测顺序。 */
export function getDefaultExportAgents(targets: ProjectAgentTarget[]): string[] {
  const enabledKeys = enabledInstalledAgentKeys(targets);
  const availableKeys = new Set(enabledKeys);
  const prioritized = PROJECT_EXPORT_AGENT_PRIORITY.filter((key) => availableKeys.has(key));
  const rest = enabledKeys.filter((key) => !prioritized.includes(key));
  return Array.from(new Set([...prioritized, ...rest]));
}
