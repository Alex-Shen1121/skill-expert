import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { agentPluginIdentityKey } from "../../lib/agentPlugins";
import type { AgentPluginViewItem } from "../../lib/agentPluginView";
import { cn } from "../../utils";
import { PluginStatusBadge } from "./PluginDetails";
import { PluginMark } from "./PluginMark";

interface PluginListProps {
  plugins: AgentPluginViewItem[];
  selectedKey: string | null;
  listLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  onSelect: (key: string) => void;
}

export function PluginCatalogEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center"
      role="status"
    >
      <Puzzle className="h-8 w-8 text-faint" aria-hidden="true" />
      <p className="mt-3 text-[13px] font-medium text-tertiary">{title}</p>
      <p className="mt-1 text-[11px] leading-5 text-muted">{description}</p>
    </div>
  );
}

export function PluginList({
  plugins,
  selectedKey,
  listLabel,
  emptyTitle,
  emptyDescription,
  onSelect,
}: PluginListProps) {
  const { t } = useTranslation();

  if (plugins.length === 0) {
    return (
      <div id="plugin-catalog-list" className="flex min-h-0 flex-1 flex-col">
        <PluginCatalogEmptyState
          title={emptyTitle}
          description={emptyDescription}
        />
      </div>
    );
  }

  return (
    <div
      id="plugin-catalog-list"
      role="listbox"
      aria-label={listLabel}
      className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-hide"
    >
      {plugins.map((plugin) => {
        const key = agentPluginIdentityKey(plugin.identity);
        const active = selectedKey === key;
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={`${plugin.display_name} · ${plugin.identity.marketplace_name} · ${plugin.identity.plugin_id}`}
            onClick={() => onSelect(key)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-accent/50",
              active ? "bg-surface-active" : "hover:bg-surface-hover",
            )}
          >
            <PluginMark plugin={plugin} />
            <span className="min-w-0 flex-1">
              <span className={cn(
                "block truncate text-[13px] font-medium",
                active ? "text-primary" : "text-secondary",
              )}>
                {plugin.display_name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-faint">
                {plugin.identity.marketplace_name} · {plugin.version ?? t("plugins.unknown")}
              </span>
            </span>
            <PluginStatusBadge status={plugin.install_status} />
          </button>
        );
      })}
    </div>
  );
}
