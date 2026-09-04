import type { AgentPluginCatalogErrorKind } from "./agentPlugins";

const ERROR_MESSAGE_SUFFIXES: Record<AgentPluginCatalogErrorKind, string> = {
  cli_unavailable: "cliUnavailable",
  configured_path_invalid: "configuredPathInvalid",
  cli_not_runnable: "cliNotRunnable",
  command_unsupported: "commandUnsupported",
  timed_out: "timedOut",
  command_failed: "commandFailed",
  invalid_json: "invalidJson",
  contract_incompatible: "contractIncompatible",
  internal: "internal",
};

export type AgentPluginErrorMessageScope = "plugins" | "settings.codexCli";

export function agentPluginErrorMessageKey(
  scope: AgentPluginErrorMessageScope,
  kind: AgentPluginCatalogErrorKind,
): string {
  return `${scope}.errors.${ERROR_MESSAGE_SUFFIXES[kind]}`;
}
