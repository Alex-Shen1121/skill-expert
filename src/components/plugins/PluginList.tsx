import { Check, Download, Puzzle, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  agentPluginIdentityKey,
  type AgentPluginInstallStatus,
} from "../../lib/agentPlugins";
import type { AgentPluginViewItem } from "../../lib/agentPluginView";
import { cn } from "../../utils";

interface PluginListProps {
  plugins: AgentPluginViewItem[];
  selectedKey: string | null;
  listLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  onSelect: (key: string) => void;
}

function statusKey(status: AgentPluginInstallStatus): string {
  return `plugins.status.${status}`;
}

function StatusBadge({ status }: { status: AgentPluginInstallStatus }) {
  const { t } = useTranslation();
  const appearance = status === "installed_enabled"
    ? {
        Icon: Check,
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      }
    : status === "installed_disabled"
      ? {
          Icon: Unplug,
          className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        }
      : {
          Icon: Download,
          className: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
        };
  const { Icon } = appearance;

  return (
    <span className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
      appearance.className,
    )}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(statusKey(status))}
    </span>
  );
}

function PluginMark({ name }: { name: string }) {
  const text = name.trim().slice(0, 2).toLocaleUpperCase() || "P";
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-[12px] font-semibold text-accent"
      aria-hidden="true"
    >
      {text}
    </span>
  );
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
            <PluginMark name={plugin.display_name} />
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
            <StatusBadge status={plugin.install_status} />
          </button>
        );
      })}
    </div>
  );
}
