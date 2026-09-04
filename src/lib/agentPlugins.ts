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

export type AgentPluginAuthPolicy = "on_install" | "on_use" | "none";

export type AgentPluginDetailsCompleteness = "complete" | "incomplete";

export type AgentPluginDetailsIssue =
  | "plugin_root_unavailable"
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_incompatible"
  | "resource_rejected"
  | "component_unreadable";

export interface AgentPluginSkill {
  name: string;
  description: string | null;
}

export interface AgentPluginDetails {
  description: string | null;
  developer: string | null;
  category: string | null;
  default_prompts: string[];
  declared_capabilities: string[];
  skills: AgentPluginSkill[];
  mcp_servers: string[];
  hook_events: string[];
  connectors: string[];
  browser_extensions: string[];
  custom_ui: string[];
  icon_data_url: string | null;
  screenshot_data_urls: string[];
  completeness: AgentPluginDetailsCompleteness;
  issues: AgentPluginDetailsIssue[];
  technical: {
    source_type: string | null;
    location: string | null;
  };
}

export interface AgentPluginSummary {
  identity: AgentPluginIdentity;
  display_name: string;
  version: string | null;
  install_status: AgentPluginInstallStatus;
  update_available: boolean | null;
  install_policy: string | null;
  auth_policy: AgentPluginAuthPolicy | null;
  details: AgentPluginDetails;
}

export type AgentPluginCatalogErrorKind =
  | "cli_unavailable"
  | "configured_path_invalid"
  | "cli_not_runnable"
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

export type CodexCliFactStatus = "confirmed" | "unavailable" | "unchecked";

export interface CodexCliConfiguration {
  resolution_source: "explicit" | "environment";
  configured_path: string | null;
  facts: {
    configuration_directory: CodexCliFactStatus;
    executable_resolution: CodexCliFactStatus;
    command_runtime: CodexCliFactStatus;
    plugin_json_contract: CodexCliFactStatus;
  };
  error?: AgentPluginCatalogErrorKind;
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

export const getCodexCliConfiguration = () =>
  invoke<CodexCliConfiguration>("get_codex_cli_configuration");

export const validateCodexCliPath = (path: string) =>
  invoke<CodexCliConfiguration>("validate_codex_cli_path", { path });

export const setCodexCliPath = (path: string) =>
  invoke<CodexCliConfiguration>("set_codex_cli_path", { path });

export const resetCodexCliPath = () =>
  invoke<CodexCliConfiguration>("reset_codex_cli_path");
