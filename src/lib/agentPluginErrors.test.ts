import { describe, expect, it } from "vitest";
import {
  agentPluginErrorMessageKey,
  type AgentPluginErrorMessageScope,
} from "./agentPluginErrors";
import type { AgentPluginCatalogErrorKind } from "./agentPlugins";

describe("Agent 插件错误消息键", () => {
  it("让目录页与 CLI 设置共用同一错误种类映射", () => {
    const kinds: AgentPluginCatalogErrorKind[] = [
      "cli_unavailable",
      "configured_path_invalid",
      "cli_not_runnable",
      "command_unsupported",
      "timed_out",
      "command_failed",
      "invalid_json",
      "contract_incompatible",
      "internal",
    ];
    const expectedSuffixes = [
      "cliUnavailable",
      "configuredPathInvalid",
      "cliNotRunnable",
      "commandUnsupported",
      "timedOut",
      "commandFailed",
      "invalidJson",
      "contractIncompatible",
      "internal",
    ];

    for (const scope of ["plugins", "settings.codexCli"] satisfies AgentPluginErrorMessageScope[]) {
      expect(kinds.map((kind) => agentPluginErrorMessageKey(scope, kind))).toEqual(
        expectedSuffixes.map((suffix) => `${scope}.errors.${suffix}`),
      );
    }
  });
});
