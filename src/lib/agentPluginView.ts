import {
  agentPluginIdentityKey,
  type AgentPluginIdentity,
  type AgentPluginProjection,
  type AgentPluginSummary,
} from "./agentPlugins";

const STATUS_ORDER = {
  installed_enabled: 0,
  installed_disabled: 1,
  available: 2,
} as const;

export type AgentPluginScope = "installed" | "available";

export interface AgentPluginViewItem extends AgentPluginSummary {
  description?: string | null;
  developer?: string | null;
}

type ReadyAgentPluginProjection = Extract<
  AgentPluginProjection,
  { read_status: "ready" }
>;

export interface AgentPluginViewOptions {
  projection: ReadyAgentPluginProjection;
  scope: AgentPluginScope;
  query: string;
  marketplace: string;
  language: string;
}

export function getAgentPluginScopeCounts(
  projection: ReadyAgentPluginProjection,
): { installed: number; available: number } {
  return {
    installed: projection.installed.length,
    available: projection.available.length,
  };
}

export function getAgentPluginMarketplaces(
  projection: ReadyAgentPluginProjection,
  language: string,
): string[] {
  const collator = new Intl.Collator(language, {
    numeric: true,
    sensitivity: "base",
  });
  return Array.from(
    new Set(
      [...projection.installed, ...projection.available]
        .map((plugin) => plugin.identity.marketplace_name),
    ),
  ).sort((left, right) => collator.compare(left, right));
}

export function getMigratedAgentPluginSelection(
  visiblePlugins: AgentPluginSummary[],
  selectedKey: string | null,
): string | null {
  if (
    selectedKey
    && visiblePlugins.some(
      (plugin) => agentPluginIdentityKey(plugin.identity) === selectedKey,
    )
  ) {
    return selectedKey;
  }
  return visiblePlugins[0]
    ? agentPluginIdentityKey(visiblePlugins[0].identity)
    : null;
}

function compareIdentity(
  left: AgentPluginIdentity,
  right: AgentPluginIdentity,
  collator: Intl.Collator,
): number {
  const leftParts = [left.agent, left.marketplace_name, left.plugin_id];
  const rightParts = [right.agent, right.marketplace_name, right.plugin_id];
  for (let index = 0; index < leftParts.length; index += 1) {
    const comparison = collator.compare(leftParts[index], rightParts[index]);
    if (comparison !== 0) return comparison;
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function getVisibleAgentPlugins({
  projection,
  scope,
  query,
  marketplace,
  language,
}: AgentPluginViewOptions): AgentPluginViewItem[] {
  const collator = new Intl.Collator(language, {
    numeric: true,
    sensitivity: "base",
  });
  const items = scope === "installed"
    ? projection.installed
    : projection.available;
  const normalizedQuery = normalizeSearchValue(query, language);

  return items
    .filter((plugin) => (
      marketplace === "all"
      || plugin.identity.marketplace_name === marketplace
    ))
    .filter((plugin) => {
      if (!normalizedQuery) return true;
      const viewPlugin = plugin as AgentPluginViewItem;
      return [
        plugin.display_name,
        plugin.identity.plugin_id,
        viewPlugin.description,
        plugin.identity.marketplace_name,
        viewPlugin.developer,
      ].some((value) => normalizeSearchValue(value, language).includes(normalizedQuery));
    })
    .sort((left, right) => {
      if (scope === "installed") {
        const statusComparison = STATUS_ORDER[left.install_status]
          - STATUS_ORDER[right.install_status];
        if (statusComparison !== 0) return statusComparison;
      }

      const nameComparison = collator.compare(left.display_name, right.display_name);
      if (nameComparison !== 0) return nameComparison;
      return compareIdentity(left.identity, right.identity, collator);
    });
}

function normalizeSearchValue(
  value: string | null | undefined,
  language: string,
): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase(language).trim();
}
