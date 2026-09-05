import { Puzzle } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % plugins.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + plugins.length) % plugins.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = plugins.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = plugins[nextIndex];
    onSelect(agentPluginIdentityKey(next.identity));
    optionRefs.current[nextIndex]?.focus();
  };

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
      {plugins.map((plugin, index) => {
        const key = agentPluginIdentityKey(plugin.identity);
        const active = selectedKey === key;
        const version = plugin.version ?? t("plugins.unknown");
        const status = t(`plugins.status.${plugin.install_status}`);
        return (
          <button
            key={key}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={`${plugin.display_name} · ${plugin.identity.marketplace_name} · ${plugin.identity.plugin_id} · ${version} · ${status}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
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
              <span className="mt-0.5 block truncate text-[11px] text-tertiary">
                {plugin.identity.marketplace_name} · {version}
              </span>
            </span>
            <PluginStatusBadge status={plugin.install_status} />
          </button>
        );
      })}
    </div>
  );
}
