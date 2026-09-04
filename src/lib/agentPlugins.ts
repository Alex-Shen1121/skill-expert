import { invoke } from "@tauri-apps/api/core";

export type AgentPluginAgent = "codex";

export interface AgentPluginIdentity {
  agent: AgentPluginAgent;
  marketplace_name: string;
  plugin_id: string;
}

export type AgentPluginInstallStatus =
  | "installed_enabled"
  | "installed_disabled"
  | "available";

export interface AgentPluginSummary {
  identity: AgentPluginIdentity;
  display_name: string;
  version: string | null;
  install_status: AgentPluginInstallStatus;
  update_available: boolean | null;
  install_policy: string | null;
  auth_policy: string | null;
}

export type AgentPluginCatalogErrorKind =
  | "cli_unavailable"
  | "command_unsupported"
  | "timed_out"
  | "command_failed"
  | "invalid_json"
  | "contract_incompatible"
  | "internal";

export interface AgentPluginCatalogError {
  kind: AgentPluginCatalogErrorKind;
  exit_code?: number;
}

export type AgentPluginProjection =
  | {
      read_status: "ready";
      agent: AgentPluginAgent;
      refreshed_at_unix_ms: number;
      installed: AgentPluginSummary[];
      available: AgentPluginSummary[];
    }
  | {
      read_status: "error";
      agent: AgentPluginAgent;
      refreshed_at_unix_ms: number;
      error: AgentPluginCatalogError;
    };

export function agentPluginIdentityKey(identity: AgentPluginIdentity): string {
  return JSON.stringify([
    identity.agent,
    identity.marketplace_name,
    identity.plugin_id,
  ]);
}

export const getAgentPluginProjection = (agent: AgentPluginAgent) =>
  invoke<AgentPluginProjection>("get_agent_plugin_projection", { agent });
